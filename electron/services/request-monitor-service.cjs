const crypto = require('node:crypto')
const { StringDecoder } = require('node:string_decoder')
const { z } = require('zod')

const MAX_DETECTION_BUFFER_BYTES = 64 * 1024
/**
 * 单行上限。SSE 的一个 data 行可以很大（整个 response.completed 都在里面），
 * 但不能无限——超过就放弃精确解析，退回结束时的尾部扫描。
 */
const MAX_LINE_BYTES = 1024 * 1024
const LINE_PART_BLOCK_SIZE = 1024
const TAIL_PENDING_HEADROOM_BYTES = 4096
/** 终止/错误标记跨 chunk 被劈开时的重叠窗口。标记本身最长不过几十个字符。 */
const MARKER_OVERLAP = 64
/**
 * 首字定了之后就只剩 usage 值得解析了。这两个键正是 extractTokenUsage 认的全部
 * 入口——Anthropic/OpenAI 用 usage，Gemini 用 usageMetadata。
 */
const USAGE_HINT = /"usage"|"usageMetadata"/
/** 保留窗口：按时间保留最近三天，首页再按本地 0 点截取当天缓存率。 */
const RETENTION_WINDOW_MS = 3 * 24 * 60 * 60_000

function utf8Suffix(text, maxBytes) {
  let index = text.length
  let bytes = 0
  while (index > 0) {
    const code = text.charCodeAt(index - 1)
    if (code >= 0xDC00 && code <= 0xDFFF && index >= 2) {
      const high = text.charCodeAt(index - 2)
      if (high >= 0xD800 && high <= 0xDBFF) {
        if (bytes + 4 > maxBytes) break
        bytes += 4
        index -= 2
        continue
      }
    }
    const width = code <= 0x7F ? 1 : code <= 0x7FF ? 2 : 3
    if (bytes + width > maxBytes) break
    bytes += width
    index -= 1
  }
  return { text: text.slice(index), bytes }
}

const RequestLogEntrySchema = z.object({
  id: z.string(),
  client: z.string(),
  profileId: z.string().optional(),
  profileName: z.string(),
  keyHint: z.string().optional(),
  upstreamUrl: z.string(),
  protocol: z.string().optional(),
  state: z.string(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  durationMs: z.number().optional(),
  firstTokenLatencyMs: z.number().optional(),
  firstByteLatencyMs: z.number().optional(),
  statusCode: z.number().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  streaming: z.boolean().optional(),
  outcome: z.string().optional(),
  tokenUsage: z.object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    /** 缓存命中（读）。缓存写入不算命中，单独记在 cacheWriteTokens。 */
    cachedTokens: z.number().optional(),
    cacheWriteTokens: z.number().optional(),
    reasoningTokens: z.number().optional(),
    totalTokens: z.number().optional(),
  }).optional(),
  receivedBytes: z.number().optional().default(0),
})

const RequestLogStoreSchema = z.object({
  version: z.literal(1),
  entries: z.array(RequestLogEntrySchema),
})
const PROGRESS_NOTIFY_INTERVAL_MS = 200
const MAX_MODEL_METADATA_LENGTH = 240
const MAX_REASONING_METADATA_LENGTH = 32

function nonEmptyText(value) {
  if (typeof value === 'string') return value.trim().length > 0
  if (!Array.isArray(value)) return false
  return value.some((item) => (
    nonEmptyText(item)
    || nonEmptyText(item?.text)
    || nonEmptyText(item?.content)
  ))
}

const OPENAI_VISIBLE_CONTENT_TYPES = new Set(['output_text', 'refusal', 'text'])
const OPENAI_REASONING_CONTENT_TYPES = new Set(['reasoning_text', 'summary_text'])

function isOpenAiVisibleContent(value) {
  if (typeof value === 'string') return nonEmptyText(value)
  if (Array.isArray(value)) return value.some(isOpenAiVisibleContent)
  if (!value || typeof value !== 'object') return false
  if (value.type && !OPENAI_VISIBLE_CONTENT_TYPES.has(value.type)) return false
  return nonEmptyText(value.text) || nonEmptyText(value.refusal)
}

function isOpenAiVisibleOutput(value) {
  if (!value || typeof value !== 'object') return false
  if (value.type && value.type !== 'message'
    && !OPENAI_VISIBLE_CONTENT_TYPES.has(value.type)) return false
  return nonEmptyText(value.output_text)
    || nonEmptyText(value.text)
    || nonEmptyText(value.refusal)
    || isOpenAiVisibleContent(value.content)
}

function isOpenAiReasoningContent(value) {
  if (typeof value === 'string') return nonEmptyText(value)
  if (Array.isArray(value)) return value.some(isOpenAiReasoningContent)
  if (!value || typeof value !== 'object') return false
  if (value.type && !OPENAI_REASONING_CONTENT_TYPES.has(value.type)) return false
  return nonEmptyText(value.text)
}

function isOpenAiGeneratedOutput(value) {
  if (isOpenAiVisibleOutput(value)) return true
  if (!value || typeof value !== 'object' || value.type !== 'reasoning') return false
  return isOpenAiReasoningContent(value.summary)
    || isOpenAiReasoningContent(value.content)
}

function isAnthropicVisibleContent(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && (!value.type || value.type === 'text')
    && nonEmptyText(value.text),
  )
}

function isAnthropicGeneratedContent(value) {
  return isAnthropicVisibleContent(value) || Boolean(
    value
    && typeof value === 'object'
    && (!value.type || value.type === 'thinking')
    && nonEmptyText(value.thinking),
  )
}

function isFirstTokenPayload(protocol, payload, eventName = '') {
  if (!payload || typeof payload !== 'object') return false
  if (protocol === 'openai-responses') {
    const textEventTypes = [
      'response.output_text.delta',
      'response.output_text.done',
      'response.refusal.delta',
      'response.refusal.done',
    ]
    const reasoningEventTypes = [
      'response.reasoning_summary_text.delta',
      'response.reasoning_summary_text.done',
    ]
    const toolArgumentEventTypes = [
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
    ]
    if (textEventTypes.includes(eventName) || textEventTypes.includes(payload.type)) {
      return nonEmptyText(payload.delta)
        || nonEmptyText(payload.text)
        || nonEmptyText(payload.refusal)
    }
    if (reasoningEventTypes.includes(eventName) || reasoningEventTypes.includes(payload.type)) {
      return nonEmptyText(payload.delta) || nonEmptyText(payload.text)
    }
    if (toolArgumentEventTypes.includes(eventName)
      || toolArgumentEventTypes.includes(payload.type)) {
      return nonEmptyText(payload.delta) || nonEmptyText(payload.arguments)
    }
    const reasoningPartEventTypes = [
      'response.reasoning_summary_part.added',
      'response.reasoning_summary_part.done',
    ]
    if (reasoningPartEventTypes.includes(eventName)
      || reasoningPartEventTypes.includes(payload.type)) {
      return isOpenAiReasoningContent(payload.part)
    }
    const contentPartTypes = ['response.content_part.added', 'response.content_part.done']
    if (contentPartTypes.includes(eventName) || contentPartTypes.includes(payload.type)) {
      return isOpenAiVisibleContent(payload.part) || isOpenAiReasoningContent(payload.part)
    }
    const outputItemTypes = ['response.output_item.added', 'response.output_item.done']
    if (outputItemTypes.includes(eventName) || outputItemTypes.includes(payload.type)) {
      if ((eventName === 'response.output_item.added'
        || payload.type === 'response.output_item.added')
        && (payload.item?.type === 'reasoning'
          || payload.item?.type === 'function_call')) return true
      return isOpenAiGeneratedOutput(payload.item)
    }
    const response = payload.response || payload
    return nonEmptyText(response.output_text)
      || isOpenAiVisibleContent(response.content)
      || (Array.isArray(response.output) && response.output.some(isOpenAiGeneratedOutput))
  }
  if (protocol === 'openai-chat') {
    return Array.isArray(payload.choices) && payload.choices.some((choice) => {
      const delta = choice?.delta || choice?.message || {}
      return nonEmptyText(delta.content)
        || nonEmptyText(delta.refusal)
        || nonEmptyText(delta.reasoning_content)
        || nonEmptyText(delta.reasoning)
        || nonEmptyText(delta.thinking)
        || delta.tool_calls?.some((tool) => (
          nonEmptyText(tool?.function?.name) || nonEmptyText(tool?.function?.arguments)
        ))
    })
  }
  if (protocol === 'anthropic') {
    const type = payload.type || eventName
    const delta = payload.delta || {}
    if (type === 'content_block_delta') {
      return nonEmptyText(delta.thinking)
        || ((!delta.type || delta.type === 'text_delta') && nonEmptyText(delta.text))
        || (delta.type === 'input_json_delta' && nonEmptyText(delta.partial_json))
    }
    if (type === 'content_block_start') {
      return isAnthropicGeneratedContent(payload.content_block)
        || (payload.content_block?.type === 'tool_use'
          && nonEmptyText(payload.content_block.name))
    }
    const content = payload.message?.content || payload.content
    return Array.isArray(content) && content.some(isAnthropicGeneratedContent)
  }
  if (protocol === 'gemini') {
    return Array.isArray(payload.candidates) && payload.candidates.some((candidate) => (
      candidate?.content?.parts?.some((part) => (
        nonEmptyText(part?.text) || Boolean(part?.functionCall?.name)
      ))
      || nonEmptyText(candidate?.text)
    ))
  }
  return false
}

function parsedJson(value) {
  if (!value || value === '[DONE]') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }
}

/**
 * 增量流扫描器：只看新到的那一片字节，绝不回头重扫。
 *
 * 这段代码同步跑在网关的转发热路径上——它不算完，客户端的字节就出不去。老写法
 * 每来一个 chunk 就把整个 64KB 累积缓冲区重新 split + JSON.parse 一遍（而且先按
 * 空行切一遍、再按换行切一遍，每行 parse 两次），是彻头彻尾的 O(n²)。实测首字之前
 * 有 800 个非有效事件时，网关给首字硬加了 1.4 秒；两千个增量的响应总耗时多 387ms。
 *
 * 现在按行增量喂：残缺的半行留到下一片，完整的块当场解析一次就丢。
 */
class StreamScanner {
  constructor() {
    // chunk 可能从一个多字节字符中间劈开，交给 StringDecoder 兜着，别解出替换字符
    this.decoder = new StringDecoder('utf8')
    this.lineBlocks = []
    this.lineParts = []
    this.lineBytes = 0
    this.discardingLine = false
    this.discardFrame = false
    this.jsonStarted = false
    this.jsonCandidate = true
    this.jsonDepth = 0
    this.jsonInString = false
    this.jsonEscaped = false
    this.jsonComplete = false
    this.eventName = ''
    this.dataLines = []
    this.dataBytes = 0
    this.sawSse = false
    /** 首字已经认出来了——之后除了 usage，什么都不必再解析。 */
    this.settled = false
    this.markerCarry = ''
    this.sawTerminal = false
    this.sawErrorEvent = false
    /**
     * 正文尾巴，按片存着，只在结束时 join 一次。
     * 每个 chunk 拼一个 64KB 字符串正是要除掉的那笔开销。
     */
    this.tailParts = []
    this.tailStart = 0
    this.tailPendingParts = []
    this.tailPendingBytes = 0
    this.tailBytes = 0
  }

  /** @returns {Array<{eventName: string, payload: unknown}>} 这一片里新解析出来的。 */
  push(bytes, probeBody = false) {
    const text = this.decoder.write(bytes)
    if (!text) return []
    return this._consume(text, false, probeBody)
  }

  /** 流结束：把残留的半行和未闭合的块也吐出来。 */
  end() {
    const tail = this.decoder.end()
    const out = this._consume(tail, true)
    this._flushBlock(out)
    return out
  }

  /** 结束时的兜底源：非 SSE 正文（尤其是被换行拆开的）只能靠它捞 usage。 */
  tailSource() {
    return [
      ...this.tailParts.slice(this.tailStart).map((part) => part.text),
      this.tailPendingParts.join(''),
    ].join('')
  }

  _consume(text, final = false, probeBody = false) {
    const out = []
    if (text) {
      this._scanMarkers(text)
      this._appendTail(text)
    }
    let start = 0
    for (let newline = text.indexOf('\n', start); newline >= 0; newline = text.indexOf('\n', start)) {
      this._appendLine(text.slice(start, newline))
      this._finishLine(out)
      start = newline + 1
    }
    this._appendLine(text.slice(start))
    if (!final && probeBody && this.jsonComplete) {
      const payloads = parsedJson(this._appendLineSource().trim())
      if (payloads.length > 0) {
        this._resetLine()
        for (const payload of payloads) out.push({ eventName: '', payload })
      }
    }
    if (final) {
      if (this.discardingLine) this._resetLine()
      else if (this.lineBytes > 0) this._finishLine(out)
      if (this.discardFrame) this._resetFrameDiscard()
    }
    return out
  }

  _appendTail(text) {
    const incoming = utf8Suffix(text, MAX_DETECTION_BUFFER_BYTES)
    if (!incoming.text) return
    if (incoming.bytes >= MAX_DETECTION_BUFFER_BYTES) {
      const suffix = utf8Suffix(
        incoming.text,
        MAX_DETECTION_BUFFER_BYTES - TAIL_PENDING_HEADROOM_BYTES,
      )
      this.tailParts = [{ text: suffix.text, bytes: suffix.bytes }]
      this.tailStart = 0
      this.tailPendingParts = []
      this.tailPendingBytes = 0
      this.tailBytes = suffix.bytes
      return
    }
    this.tailPendingParts.push(incoming.text)
    this.tailPendingBytes += incoming.bytes
    this.tailBytes += incoming.bytes
    if (this.tailPendingParts.length >= LINE_PART_BLOCK_SIZE
      || this.tailPendingBytes >= TAIL_PENDING_HEADROOM_BYTES) {
      const block = utf8Suffix(
        this.tailPendingParts.join(''),
        MAX_DETECTION_BUFFER_BYTES - TAIL_PENDING_HEADROOM_BYTES,
      )
      this.tailParts.push({
        text: block.text,
        bytes: block.bytes,
      })
      this.tailPendingParts = []
      this.tailBytes -= this.tailPendingBytes - block.bytes
      this.tailPendingBytes = 0
    }
    while (this.tailStart < this.tailParts.length - 1
      && this.tailBytes > MAX_DETECTION_BUFFER_BYTES) {
      this.tailBytes -= this.tailParts[this.tailStart].bytes
      this.tailStart += 1
    }
    if (this.tailStart >= 1024) {
      this.tailParts = this.tailParts.slice(this.tailStart)
      this.tailStart = 0
    }
  }

  _appendLine(text) {
    if (!text || this.discardingLine) return
    this.lineBytes += Buffer.byteLength(text, 'utf8')
    if (this.lineBytes > MAX_LINE_BYTES) {
      this.lineBlocks = []
      this.lineParts = []
      this.lineBytes = 0
      this.discardingLine = true
      this._discardFrame()
      return
    }
    this.lineParts.push(text)
    if (this.lineParts.length >= LINE_PART_BLOCK_SIZE) {
      this.lineBlocks.push(this.lineParts.join(''))
      this.lineParts = []
    }
    this._scanJson(text)
  }

  _scanJson(text) {
    if (!this.jsonCandidate) return
    for (const character of text) {
      if (!this.jsonStarted) {
        if (/\s/.test(character)) continue
        if (character !== '{' && character !== '[') {
          this.jsonCandidate = false
          return
        }
        this.jsonStarted = true
        this.jsonDepth = 1
        continue
      }
      if (this.jsonComplete) {
        if (!/\s/.test(character)) this.jsonCandidate = false
        continue
      }
      if (this.jsonInString) {
        if (this.jsonEscaped) this.jsonEscaped = false
        else if (character === '\\') this.jsonEscaped = true
        else if (character === '"') this.jsonInString = false
        continue
      }
      if (character === '"') this.jsonInString = true
      else if (character === '{' || character === '[') this.jsonDepth += 1
      else if (character === '}' || character === ']') {
        this.jsonDepth -= 1
        if (this.jsonDepth === 0) this.jsonComplete = true
        else if (this.jsonDepth < 0) this.jsonCandidate = false
      }
    }
  }

  _appendLineSource() {
    return [...this.lineBlocks, this.lineParts.join('')].join('')
  }

  _resetLine() {
    this.lineBlocks = []
    this.lineParts = []
    this.lineBytes = 0
    this.discardingLine = false
    this.jsonStarted = false
    this.jsonCandidate = true
    this.jsonDepth = 0
    this.jsonInString = false
    this.jsonEscaped = false
    this.jsonComplete = false
  }

  _takeLine() {
    const source = this._appendLineSource()
    this._resetLine()
    return source
  }

  _finishLine(out) {
    if (this.discardingLine) {
      this._resetLine()
      return
    }
    this._line(this._takeLine(), out)
  }

  _resetFrameDiscard() {
    this.discardFrame = false
    this.dataLines = []
    this.dataBytes = 0
    this.eventName = ''
  }

  _discardFrame() {
    this.discardFrame = true
    this.dataLines = []
    this.dataBytes = 0
    this.eventName = ''
  }

  _line(raw, out) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (this.discardFrame) {
      if (line.trim() === '') this._resetFrameDiscard()
      return
    }
    if (line.startsWith('data:')) {
      this.sawSse = true
      const value = line.slice(5).replace(/^ /, '')
      const bytes = Buffer.byteLength(value, 'utf8')
      if (this.dataBytes + bytes <= MAX_LINE_BYTES) {
        this.dataLines.push(value)
        this.dataBytes += bytes
      } else {
        this._discardFrame()
      }
      return
    }
    if (line.startsWith('event:')) {
      this.sawSse = true
      this.eventName = line.slice(6).trim()
      return
    }
    if (line.startsWith(':')) return // SSE 注释，中转常拿它当心跳
    if (line.trim() === '') {
      this._flushBlock(out)
      return
    }
    // 不是 SSE：可能是 JSON-lines，也可能是被换行拆开的一整个正文
    this._emit('', line.trim(), out)
  }

  _flushBlock(out) {
    if (this.dataLines.length === 0) {
      this.eventName = ''
      return
    }
    const eventName = this.eventName
    const value = this.dataLines.join('\n').trim()
    this.dataLines = []
    this.dataBytes = 0
    this.eventName = ''
    this._emit(eventName, value, out)
  }

  /**
   * 首字认出来之后，剩下的事件里只有 usage 还值得看一眼。
   *
   * 绝大多数增量事件里压根没有 usage，照样 JSON.parse 一遍纯属白烧 CPU——一个
   * 两千增量的回复就是两千次无用的解析，而这活是同步卡在转发路径上的。先用一次
   * 正则筛掉，命中了才解析。
   */
  _emit(eventName, value, out) {
    if (!value) return
    if (this.settled && !USAGE_HINT.test(value)) return
    for (const payload of parsedJson(value)) out.push({ eventName, payload })
  }

  _scanMarkers(text) {
    if (this.sawTerminal && this.sawErrorEvent) return
    const window = this.markerCarry + text
    if (!this.sawTerminal && hasTerminalMarker(window)) this.sawTerminal = true
    if (!this.sawErrorEvent && hasErrorEvent(window)) this.sawErrorEvent = true
    this.markerCarry = window.slice(-MARKER_OVERLAP)
  }
}

function numberOrUndefined(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : undefined
}

/**
 * 把各家的 usage 归一化成同一套口径。
 *
 * 三家对「输入 token」的定义并不一致，直接拿去算比率会得出垃圾数：
 *
 * - Anthropic：`input_tokens` 只是**未命中缓存的新输入**，缓存读写是两个独立字段
 *   （`cache_read_input_tokens` / `cache_creation_input_tokens`），都不含在里面。
 * - OpenAI：`prompt_tokens`（或 Responses 的 `input_tokens`）**已经包含**
 *   `cached_tokens`；没有单独的「写缓存」计数。
 * - Gemini：`promptTokenCount` **已经包含** `cachedContentTokenCount`。
 *
 * 归一化后 inputTokens 一律是「这次请求的全部提示 token，含缓存读写」，
 * 于是 cacheReadTokens / inputTokens 在三家都是同一个含义的命中率。
 *
 * 另外两点：
 * - 缓存**写入**不是命中。它按 1.25× 计费——是最贵的一次请求，不能算进命中里。
 * - reasoning token 已经含在 output 里（OpenAI 的 reasoning_tokens、Gemini 的
 *   thoughtsTokenCount 都是如此），单独拿出来只为显示，**不再加总**。
 */
function extractTokenUsage(payload) {
  const container = payload?.response || payload?.message || payload
  const usage = container?.usage || payload?.usageMetadata
  if (!usage || typeof usage !== 'object') return undefined

  const outputTokens = numberOrUndefined(
    usage.output_tokens ?? usage.completion_tokens ?? usage.candidatesTokenCount,
  )
  const reasoningTokens = numberOrUndefined(
    usage.output_tokens_details?.reasoning_tokens
      ?? usage.completion_tokens_details?.reasoning_tokens
      ?? usage.thoughtsTokenCount,
  )

  // 只有 Anthropic 会发这两个键，拿它们当判别式
  const anthropicRead = numberOrUndefined(usage.cache_read_input_tokens)
  const anthropicWrite = numberOrUndefined(usage.cache_creation_input_tokens)
  const anthropicStyle = anthropicRead !== undefined || anthropicWrite !== undefined

  const rawInput = numberOrUndefined(
    usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokenCount,
  )
  const cacheReadTokens = anthropicStyle
    ? anthropicRead
    : numberOrUndefined(
      usage.input_tokens_details?.cached_tokens
        ?? usage.prompt_tokens_details?.cached_tokens
        ?? usage.cachedContentTokenCount,
    )
  const cacheWriteTokens = anthropicWrite

  // Anthropic 的 input 不含缓存，补回来；其余两家本来就含
  const inputTokens = anthropicStyle && rawInput !== undefined
    ? rawInput + (anthropicRead ?? 0) + (anthropicWrite ?? 0)
    : rawInput

  const explicitTotal = numberOrUndefined(usage.total_tokens ?? usage.totalTokenCount)
  if ([inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, explicitTotal]
    .every((value) => value === undefined)) return undefined

  /*
   * Anthropic 不发 total_tokens，而它的 input 又不含缓存——按老写法
   * total = input + output，一个读了 3.2 万缓存 token 的请求只会被记成 305 个。
   * 归一化后的 inputTokens 已经含缓存，这里加起来才是真实用量。
   */
  const totalTokens = explicitTotal ?? (
    inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined
  )
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cachedTokens: cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  }
}

function extractJsonObjectProperty(source, propertyName) {
  const needle = `"${propertyName}"`
  let searchFrom = source.length
  while (searchFrom > 0) {
    const propertyIndex = source.lastIndexOf(needle, searchFrom - 1)
    if (propertyIndex < 0) return undefined
    const colonIndex = source.indexOf(':', propertyIndex + needle.length)
    if (colonIndex < 0) return undefined
    let start = colonIndex + 1
    while (/\s/.test(source[start] || '')) start += 1
    if (source[start] !== '{') {
      searchFrom = propertyIndex
      continue
    }
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < source.length; index += 1) {
      const character = source[index]
      if (inString) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') inString = false
        continue
      }
      if (character === '"') inString = true
      else if (character === '{') depth += 1
      else if (character === '}') {
        depth -= 1
        if (depth === 0) {
          try { return JSON.parse(source.slice(start, index + 1)) } catch { break }
        }
      }
    }
    searchFrom = propertyIndex
  }
  return undefined
}

function extractTokenUsageFromSource(source) {
  const usage = extractJsonObjectProperty(source, 'usage')
  const fromUsage = usage ? extractTokenUsage({ usage }) : undefined
  if (fromUsage) return fromUsage
  const usageMetadata = extractJsonObjectProperty(source, 'usageMetadata')
  return usageMetadata ? extractTokenUsage({ usageMetadata }) : undefined
}

function extractRequestMetadata(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {}
  const reasoning = payload.reasoning
  const reasoningEffort = typeof payload.reasoning_effort === 'string'
    ? payload.reasoning_effort
    : typeof reasoning === 'string'
      ? reasoning
      : typeof reasoning?.effort === 'string' ? reasoning.effort : undefined
  return {
    ...(typeof payload.model === 'string'
      && payload.model.trim()
      && payload.model.trim().length <= MAX_MODEL_METADATA_LENGTH
      ? { model: payload.model.trim() }
      : {}),
    ...(reasoningEffort && reasoningEffort.trim().length <= MAX_REASONING_METADATA_LENGTH
      ? { reasoningEffort: reasoningEffort.trim() }
      : {}),
    ...(typeof payload.stream === 'boolean' ? { streaming: payload.stream } : {}),
  }
}

/**
 * 判断已接收的流数据是否包含协议级完成标记。
 *
 * 客户端常在拿到完整响应后立即关闭连接，socket 层面表现为中止；
 * 只要流里出现过终止事件，就应把请求视为正常完成。
 */
const TERMINAL_MARKER_PATTERN = new RegExp([
  'message_stop',
  'response\\.completed',
  'response\\.incomplete',
  '\\[DONE\\]',
  '"finish_reason"\\s*:\\s*"',
  '"finishReason"\\s*:\\s*"',
].join('|'))

function hasTerminalMarker(source) {
  return TERMINAL_MARKER_PATTERN.test(source)
}

/**
 * 上游错误事件标记：流只回了个错误就结束时（HTTP 仍是 200），不该记成「已完成」。
 *
 * 模式收紧到行首 SSE 事件与事件体的 type 字段，避免误伤正文里恰好出现的字样。
 */
const ERROR_EVENT_PATTERN = new RegExp([
  '(?:^|\\r?\\n)event:\\s*(?:response\\.failed|error)\\b',
  '"type"\\s*:\\s*"(?:response\\.failed|error)"',
].join('|'))

function hasErrorEvent(source) {
  return ERROR_EVENT_PATTERN.test(source)
}

function mergeUsage(current, next) {
  if (!next) return current
  const merged = { ...(current || {}) }
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined) merged[key] = value
  }
  if (next.totalTokens === undefined
    && (merged.inputTokens !== undefined || merged.outputTokens !== undefined)) {
    merged.totalTokens = (merged.inputTokens ?? 0) + (merged.outputTokens ?? 0)
  }
  return merged
}

/** 活跃记录带 startedAtMs；从磁盘恢复的只有 ISO 串。排序两边都得认。 */
function startedAtMillis(entry) {
  if (Number.isFinite(entry.startedAtMs)) return entry.startedAtMs
  const parsed = Date.parse(entry.startedAt)
  return Number.isFinite(parsed) ? parsed : 0
}

function toPublicRequest(entry) {
  /*
   * 已结束的记录不会再变，公开形态缓存下来。
   *
   * _notify 每次都要把全部记录（活跃 + 三天历史）重建一遍，而它是同步压在
   * 网关转发路径上的——实测这一项吃掉了 observeChunk 四成的时间，且随历史条数线性
   * 增长。历史是死的，没有理由每 200 毫秒重造一次。
   */
  if (entry.publicCache) return entry.publicCache
  const result = {
    id: entry.id,
    client: entry.client,
    ...(entry.profileId ? { profileId: entry.profileId } : {}),
    profileName: entry.profileName,
    ...(entry.keyHint ? { keyHint: entry.keyHint } : {}),
    upstreamUrl: entry.upstreamUrl,
    ...(entry.protocol ? { protocol: entry.protocol } : {}),
    state: entry.state,
    startedAt: entry.startedAt,
    ...(entry.completedAt ? { completedAt: entry.completedAt } : {}),
    ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
    ...(entry.firstTokenLatencyMs !== undefined
      ? { firstTokenLatencyMs: entry.firstTokenLatencyMs }
      : {}),
    ...(entry.firstByteLatencyMs !== undefined
      ? { firstByteLatencyMs: entry.firstByteLatencyMs }
      : {}),
    ...(entry.statusCode !== undefined ? { statusCode: entry.statusCode } : {}),
    ...(entry.model ? { model: entry.model } : {}),
    ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}),
    ...(entry.streaming !== undefined ? { streaming: entry.streaming } : {}),
    ...(entry.outcome ? { outcome: entry.outcome } : {}),
    ...(entry.tokenUsage ? { tokenUsage: { ...entry.tokenUsage } } : {}),
    receivedBytes: entry.receivedBytes,
  }
  // 只缓存已结束的：活跃记录每一片数据都在变
  if (entry.completedAt) entry.publicCache = result
  return result
}

class RequestMonitorService {
  constructor({ now = () => Date.now(), onChange, onRequestEnded, store } = {}) {
    this.now = now
    this.onChange = onChange
    this.onRequestEnded = onRequestEnded
    this.store = store
    this.active = new Map()
    this.recent = []
    this._persistTimer = undefined
    /** 进度通知的服务级节流时间戳。见 _notifyProgress。 */
    this._lastProgressAt = 0
    /** bootstrap 与增量事件共用的单调版本号。 */
    this.revision = 0
  }

  /**
   * 从持久化存储恢复最近完成的请求记录。
   *
   * 存储缺失或损坏时静默从空列表开始，不阻塞网关启动。
   */
  async initialize() {
    if (!this.store) return
    try {
      const data = await this.store.read()
      this.recent = data.entries
      if (this._prune().length > 0) this._schedulePersist()
    } catch {
      this.recent = []
    }
  }

  _schedulePersist() {
    if (!this.store) return
    clearTimeout(this._persistTimer)
    this._persistTimer = setTimeout(() => { void this._persist() }, 800)
    this._persistTimer.unref?.()
  }

  async _persist() {
    if (!this.store) return
    try {
      await this.store.write({
        version: 1,
        entries: this.recent.map(toPublicRequest),
      })
    } catch {
      // 记录持久化失败不影响网关转发。
    }
  }

  /** 立即写盘挂起的记录变更，供应用退出前调用。 */
  async flush() {
    if (!this.store) return
    clearTimeout(this._persistTimer)
    await this._persist()
  }

  /**
   * 丢弃保留窗口之外的记录。
   *
   * 按时间保留而非条数：动态页需要完整的三天记录，固定条数会在高频场景下把窗口
   * 截短。
   */
  _prune() {
    const cutoff = this.now() - RETENTION_WINDOW_MS
    const removedIds = []
    this.recent = this.recent.filter((entry) => {
      const completedAt = Date.parse(entry.completedAt || entry.startedAt)
      const keep = !Number.isFinite(completedAt) || completedAt >= cutoff
      if (!keep) removedIds.push(entry.id)
      return keep
    })
    return removedIds
  }

  setOnChange(onChange) {
    this.onChange = onChange
  }

  /**
   * 全部记录按「开始时间」倒序，最新的永远在最上面。
   *
   * 老写法是 [...active, ...recent]：活跃的整组置顶，组内还按正序排，于是刚发出的
   * 请求只能落在活跃组的末尾——看上去像是「新请求出现在下面」。而 recent 是按完成
   * 时间 unshift 的，并发请求交错完成时，时间戳列也是乱的。
   *
   * recent 本身仍保持完成时间倒序不动，便于和活跃请求按开始时间合并。
   */
  list() {
    // 时间窗口也必须在“没有新请求”的日子里生效；否则打开动态页或重新 bootstrap
    // 仍会把已经过期的历史带回渲染进程。只安排一次低频写盘，不在这里广播事件。
    if (this._prune().length > 0) this._schedulePersist()
    return [...this.active.values(), ...this.recent]
      .sort((left, right) => startedAtMillis(right) - startedAtMillis(left))
      .map(toPublicRequest)
  }

  /**
   * 在网关热路径上查询最近的一条失败记录，不排序也不复制整部历史。
   * 调用方只需要能力探测结果，不应为此把三天动态记录全部映射到渲染格式。
   */
  hasRecentFailure({ profileId, upstreamUrls = [], maxAgeMs, statusCode = 502 } = {}) {
    const removedIds = this._prune()
    if (removedIds.length > 0) this._schedulePersist()
    const urlSet = new Set(upstreamUrls)
    const cutoff = this.now() - (Number.isFinite(maxAgeMs) ? maxAgeMs : 0)
    return this.recent.some((entry) => {
      const completedAt = Date.parse(entry.completedAt || entry.startedAt)
      return entry.profileId === profileId
        && (urlSet.size === 0 || urlSet.has(entry.upstreamUrl))
        && entry.streaming !== true
        && entry.statusCode === statusCode
        && entry.outcome === 'failed'
        && Number.isFinite(completedAt)
        && completedAt >= cutoff
    })
  }

  /** bootstrap 使用的完整快照；后续状态变化通过记录级增量传输。 */
  getActiveRequestsSnapshot() {
    return {
      activeRequests: this.list(),
      activeRequestsRevision: this.revision,
    }
  }

  /** 兼容旧调用方的列表接口。 */
  getActiveRequests() {
    return this.list()
  }

  start(input) {
    const startedAtMs = this.now()
    const id = crypto.randomUUID()
    this.active.set(id, {
      id,
      client: input.client || 'unknown',
      profileId: input.profileId,
      profileName: input.profileName || 'Unknown profile',
      keyHint: input.keyHint,
      upstreamUrl: input.upstreamUrl || '',
      protocol: input.protocol,
      state: 'connecting',
      startedAt: new Date(startedAtMs).toISOString(),
      startedAtMs,
      receivedBytes: 0,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      streaming: input.streaming,
      scanner: new StreamScanner(),
    })
    this._notifyChanged([this.active.get(id)])
    return id
  }

  updateMetadata(id, patch = {}) {
    const entry = this.active.get(id)
    if (!entry) return false
    if (typeof patch.profileName === 'string' && patch.profileName.trim()) {
      entry.profileName = patch.profileName.trim()
    }
    if (typeof patch.keyHint === 'string' && patch.keyHint.trim()) entry.keyHint = patch.keyHint.trim()
    if (typeof patch.upstreamUrl === 'string') entry.upstreamUrl = patch.upstreamUrl
    if (typeof patch.protocol === 'string' && patch.protocol.trim()) entry.protocol = patch.protocol.trim()
    if (typeof patch.model === 'string'
      && patch.model.trim()
      && patch.model.trim().length <= MAX_MODEL_METADATA_LENGTH) {
      entry.model = patch.model.trim()
    }
    if (typeof patch.reasoningEffort === 'string' && patch.reasoningEffort.trim()) {
      const reasoningEffort = patch.reasoningEffort.trim()
      if (reasoningEffort.length <= MAX_REASONING_METADATA_LENGTH) {
        entry.reasoningEffort = reasoningEffort
      }
    }
    if (typeof patch.streaming === 'boolean' && !entry.streamingLocked) {
      entry.streaming = patch.streaming
    }
    if (patch.tokenUsage) entry.tokenUsage = mergeUsage(entry.tokenUsage, patch.tokenUsage)
    this._notifyChanged([entry])
    return true
  }

  responseStarted(id, { statusCode, contentType, streaming } = {}) {
    const entry = this.active.get(id)
    if (!entry) return false
    entry.statusCode = statusCode
    entry.state = 'waiting-first-token'
    const mediaType = String(contentType || '').split(';', 1)[0].trim().toLowerCase()
    const responseStreaming = mediaType === 'text/event-stream'
      || mediaType === 'application/x-ndjson'
      || mediaType === 'application/json-seq'
      ? true
      : mediaType === 'application/json' || mediaType.endsWith('+json')
        ? false
        : undefined
    if (streaming !== undefined || responseStreaming !== undefined) {
      entry.streaming = streaming ?? responseStreaming
      entry.streamingLocked = true
    }
    this._notifyChanged([entry])
    return true
  }

  observeChunk(id, chunk) {
    const entry = this.active.get(id)
    if (!entry) return false
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (bytes.byteLength === 0) return false
    const receivedAtMs = this.now()
    entry.lastChunkAtMs = receivedAtMs
    entry.receivedBytes += bytes.byteLength
    if (entry.firstByteLatencyMs === undefined) {
      entry.firstByteLatencyMs = Math.max(0, receivedAtMs - entry.startedAtMs)
      if (entry.streaming === false) entry.state = 'streaming'
      this._notifyChanged([entry])
    }
    const marked = this._absorb(
      entry,
      entry.scanner.push(bytes, entry.streaming === true),
      receivedAtMs,
    )
    if (marked) return true
    this._notifyProgress(receivedAtMs)
    return false
  }

  /** 消化新解析出的 payload：累计 usage、认领模型、判首字。 */
  _absorb(entry, payloads, receivedAtMs) {
    let marked = false
    for (const { eventName, payload } of payloads) {
      const usage = extractTokenUsage(payload)
      if (usage) entry.tokenUsage = mergeUsage(entry.tokenUsage, usage)
      if (entry.firstTokenLatencyMs !== undefined) continue
      const metadata = extractRequestMetadata(payload?.response || payload)
      if (metadata.model) entry.model = metadata.model
      if (entry.streaming === true && isFirstTokenPayload(entry.protocol, payload, eventName)) {
        this._markFirstToken(entry, receivedAtMs)
        marked = true
      }
    }
    if (entry.scanner.sawTerminal) entry.sawCompletion = true
    if (entry.scanner.sawErrorEvent) entry.sawErrorEvent = true
    return marked
  }

  end(id, { outcome, channelFailure } = {}) {
    const entry = this.active.get(id)
    if (!entry) return false
    this.active.delete(id)
    // 收尾：残留的半行、没闭合的块，还有非 SSE 正文——被换行拆开的正文行行都解析
    // 不出来，只能从尾巴里把 usage 捞出来（它通常就在 JSON 末尾）。
    this._absorb(entry, entry.scanner.end(), entry.lastChunkAtMs ?? entry.startedAtMs)
    if (entry.tokenUsage === undefined) {
      const usage = extractTokenUsageFromSource(entry.scanner.tailSource())
      if (usage) entry.tokenUsage = mergeUsage(entry.tokenUsage, usage)
    }
    const completedAtMs = this.now()
    entry.completedAt = new Date(completedAtMs).toISOString()
    entry.durationMs = Math.max(0, completedAtMs - entry.startedAtMs)
    // 流里已出现协议级完成标记时，socket 层的中止只是客户端提前收尾，不改判为中止。
    const effectiveOutcome = outcome === 'aborted' && entry.sawCompletion ? undefined : outcome
    entry.outcome = effectiveOutcome || (
      entry.statusCode !== undefined && entry.statusCode >= 400 ? 'failed'
        : entry.sawErrorEvent ? 'failed'
          : 'completed'
    )
    entry.state = entry.outcome === 'completed' ? 'completed' : entry.outcome
    // 记录会在 recent 里保留三天，但扫描器的尾部缓存不需要随历史一起保留。
    delete entry.scanner
    this.recent.unshift(entry)
    const removedIds = this._prune()
    if (typeof this.onRequestEnded === 'function') {
      try {
        const context = entry.sawErrorEvent
          ? { channelFailure: true }
          : typeof channelFailure === 'boolean' ? { channelFailure } : {}
        this.onRequestEnded(toPublicRequest(entry), context)
      } catch {
        // 统计订阅者不得影响网关请求。
      }
    }
    this._schedulePersist()
    this._notifyChanged([entry], removedIds)
    return true
  }

  clear() {
    if (this.active.size === 0) return
    for (const id of [...this.active.keys()]) this.end(id, { outcome: 'cancelled' })
  }

  _markFirstToken(entry, receivedAtMs) {
    entry.firstTokenLatencyMs = Math.max(0, receivedAtMs - entry.startedAtMs)
    entry.state = 'streaming'
    // 告诉扫描器：可以只盯 usage 了，别再解析每一个增量
    entry.scanner.settled = true
    this._notifyChanged([entry])
  }

  /**
   * 流传输途中的进度通知：只推还在跑的那几条，不推整部历史。
   *
   * 历史记录只在请求「结束」时才会变；传输途中变的只有活跃的那几条。而这段代码是
   * 同步压在网关转发路径上的——原本每 200ms 就把全部记录（活跃 + 三天历史）
   * 重新序列化一遍推过去。实测：4 条并发流跑 30 秒，光这一项就推了一百万条记录，
   * 吃掉 observeChunk 八成六的 CPU。
   *
   * 节流器也是整个服务共用的，不是每条请求各管各的——否则四条流并发时，节流加起来
   * 一秒能发二十次。
   */
  _notifyProgress(now) {
    if (now - this._lastProgressAt < PROGRESS_NOTIFY_INTERVAL_MS) return
    this._lastProgressAt = now
    this._emit([...this.active.values()].map(toPublicRequest), true)
  }

  /** 发送变动记录；完整三天快照只由 bootstrap 返回。 */
  _notifyChanged(entries = [], removedRequestIds = []) {
    this._emit(entries.filter(Boolean).map(toPublicRequest), true, removedRequestIds)
  }

  _emit(activeRequests, patch, removedRequestIds = []) {
    this.revision += 1
    if (typeof this.onChange !== 'function') return
    try {
      // patch = 只是变动记录，渲染进程按 id upsert，并删除明确淘汰的历史 ID。
      this.onChange({
        type: 'active-requests-changed',
        activeRequests,
        ...(patch ? { patch: true } : {}),
        ...(removedRequestIds.length > 0 ? { removedRequestIds } : {}),
        revision: this.revision,
      })
    } catch {
      // UI 订阅者不得影响网关请求。
    }
  }
}

module.exports = {
  MAX_DETECTION_BUFFER_BYTES,
  MAX_LINE_BYTES,
  RETENTION_WINDOW_MS,
  RequestLogStoreSchema,
  RequestMonitorService,
  StreamScanner,
  extractRequestMetadata,
  extractTokenUsage,
  extractTokenUsageFromSource,
  isFirstTokenPayload,
}
