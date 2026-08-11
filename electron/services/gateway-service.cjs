const crypto = require('node:crypto')
const http = require('node:http')
const https = require('node:https')
const { pipeline, Transform } = require('node:stream')
const zlib = require('node:zlib')
const { parser: createJsonParser } = require('stream-json')
const { z } = require('zod')
let http2Wrapper
try {
  http2Wrapper = require('http2-wrapper')
} catch {
  // 旧的开发目录可能还没有安装可选传输依赖；HTTPS/1.1 仍可工作。
}
const { TARGETS } = require('./schemas.cjs')
const { SerialExecutor } = require('./storage.cjs')
const {
  MAX_REQUEST_BODY_BYTES,
  createResponsesSseJsonTransform,
} = require('./responses-tool-bridge.cjs')
const { extractRequestMetadata } = require('./request-monitor-service.cjs')

const DEFAULT_GATEWAY_HOST = '127.0.0.1'
const DEFAULT_GATEWAY_PORT = 17863
const LOCAL_HEADERS_TIMEOUT_MS = 15_000
const LOCAL_REQUEST_TIMEOUT_MS = 5 * 60_000
const LOCAL_IDLE_TIMEOUT_MS = 5 * 60_000
const LOCAL_MAX_CONNECTIONS = 128
const REJECTED_BODY_LIMIT_BYTES = 64 * 1024
const REJECTED_BODY_DRAIN_MS = 1_000
const UPSTREAM_HEADERS_TIMEOUT_MS = 120_000
// count_tokens 需要先完整读入才能做本地保守估算；把这条兼容路径单独限流，
// 避免 128 个普通网关连接各自占满一份大缓冲。
const ANTHROPIC_COUNT_BODY_LIMIT_BYTES = 16 * 1024 * 1024
const ANTHROPIC_COUNT_BODY_SLOTS = 2
const ANTHROPIC_COUNT_UNSUPPORTED_CACHE_MS = 30 * 60_000
const RESPONSES_FALLBACK_BODY_LIMIT_BYTES = 32 * 1024 * 1024
const RESPONSES_FALLBACK_BODY_SLOTS = 4
const RESPONSES_FALLBACK_IDLE_TIMEOUT_MS = 5 * 60_000
const RESPONSES_FALLBACK_TOTAL_TIMEOUT_MS = 30 * 60_000
const WEIGHTED_MODEL_BODY_LIMIT_BYTES = 32 * 1024 * 1024
const WEIGHTED_COOLDOWN_MS = 30_000
const WEIGHTED_RATE_LIMIT_COOLDOWN_MS = 10_000
const WEIGHTED_MODEL_FAILURE_COOLDOWN_MS = 60_000
const WEIGHTED_FAILURE_THRESHOLD = 3
const CODEX_HTTP2_MAX_FREE_SESSIONS = 10
const CODEX_GZIP_MIN_BYTES = 64 * 1024
const CODEX_GZIP_HOSTNAMES = new Set(['lucen.cc', 'lucen.plus'])
const TRANSFORMED_RESPONSE_INVALIDATED_HEADERS = [
  'content-length',
  'etag',
  'digest',
  'content-digest',
  'repr-digest',
  'content-md5',
]
const AGGREGATED_RESPONSE_INVALIDATED_HEADERS = [
  ...TRANSFORMED_RESPONSE_INVALIDATED_HEADERS,
  'content-encoding',
]
const MAX_MODEL_METADATA_LENGTH = 240
const MAX_REASONING_METADATA_LENGTH = 32
const MINIMAL_CODEX_INSTRUCTIONS = 'You are a helpful coding assistant.'
const GATEWAY_VERSION = 5
const TARGET_SET = new Set(TARGETS)
const ProfileIdSchema = z.string().trim().uuid()
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'x-goog-api-key',
])
const CODEX_HTTPS_AGENT = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1_000,
  maxSockets: LOCAL_MAX_CONNECTIONS,
  maxFreeSockets: 16,
})
const CODEX_HTTP2_AGENT = http2Wrapper?.Agent
  ? new http2Wrapper.Agent({
      maxFreeSessions: CODEX_HTTP2_MAX_FREE_SESSIONS,
      timeout: LOCAL_REQUEST_TIMEOUT_MS,
    })
  : undefined

function codexHttp2ProtocolCacheKey(destination) {
  return `${destination.hostname}:${destination.port || 443}:h2,http/1.1`
}

async function prewarmCodexHttp2Session(destination) {
  if (destination.protocol !== 'https:'
    || !CODEX_HTTP2_AGENT?.getSession
    || !http2Wrapper?.auto) {
    return false
  }
  const protocolCache = http2Wrapper.auto.protocolCache
  const cacheKey = codexHttp2ProtocolCacheKey(destination)
  if (protocolCache?.get?.(cacheKey) === 'http/1.1') return false
  try {
    await CODEX_HTTP2_AGENT.getSession(destination.origin, {
      servername: destination.hostname,
    })
    protocolCache?.set?.(cacheKey, 'h2')
    return true
  } catch {
    return false
  }
}

function createRequestMetadataTap(onMetadata) {
  const jsonParser = createJsonParser({ packStrings: false })
  const keys = []
  const paths = []
  let depth = 0
  let stopped = false
  let stringField
  let stringValue = ''
  let stringExceeded = false

  const publish = (patch) => {
    if (Object.keys(patch).length === 0) return
    try { onMetadata(patch) } catch {}
  }

  const metadataField = (key) => {
    if (depth === 1 && key === 'model') {
      return { name: 'model', limit: MAX_MODEL_METADATA_LENGTH }
    }
    if (depth === 1 && (key === 'reasoning_effort' || key === 'reasoning')) {
      return { name: 'reasoningEffort', limit: MAX_REASONING_METADATA_LENGTH }
    }
    if (depth === 2 && paths[2] === 'reasoning' && key === 'effort') {
      return { name: 'reasoningEffort', limit: MAX_REASONING_METADATA_LENGTH }
    }
    return undefined
  }

  jsonParser.on('data', ({ name, value }) => {
    if (name === 'keyValue') {
      keys[depth] = value
      return
    }
    if (name === 'startObject' || name === 'startArray') {
      const enteringKey = keys[depth]
      delete keys[depth]
      depth += 1
      paths[depth] = enteringKey
      return
    }
    if (name === 'endObject' || name === 'endArray') {
      delete paths[depth]
      delete keys[depth]
      depth = Math.max(0, depth - 1)
      return
    }
    if (name === 'startString') {
      stringField = metadataField(keys[depth])
      delete keys[depth]
      stringValue = ''
      stringExceeded = false
      return
    }
    if (name === 'stringChunk') {
      if (!stringField || stringExceeded) return
      stringValue += value
      if (stringValue.length > stringField.limit) {
        stringValue = ''
        stringExceeded = true
      }
      return
    }
    if (name === 'endString') {
      if (stringField && !stringExceeded && stringValue.trim()) {
        publish({ [stringField.name]: stringValue.trim() })
      }
      stringField = undefined
      stringValue = ''
      stringExceeded = false
      return
    }
    if (!name.endsWith('Value')) return
    const key = keys[depth]
    delete keys[depth]
    if (depth === 1 && key === 'model' && typeof value === 'string') {
      publish({ model: value })
    } else if (depth === 1 && key === 'stream' && typeof value === 'boolean') {
      publish({ streaming: value })
    } else if (depth === 1 && (key === 'reasoning_effort' || key === 'reasoning')
      && typeof value === 'string') {
      publish({ reasoningEffort: value })
    } else if (depth === 2 && paths[2] === 'reasoning'
      && key === 'effort' && typeof value === 'string') {
      publish({ reasoningEffort: value })
    }
  })
  jsonParser.on('error', () => {
    stopped = true
  })

  return new Transform({
    transform(chunk, _encoding, callback) {
      if (!stopped) {
        try { jsonParser.write(chunk) } catch { stopped = true }
      }
      callback(null, chunk)
    },
    flush(callback) {
      if (!stopped) {
        try { jsonParser.end() } catch {}
      }
      callback()
    },
  })
}

const CanonicalGatewayStoreSchema = z.object({
  version: z.literal(GATEWAY_VERSION),
  enabled: z.boolean(),
  port: z.number().int().min(1).max(65535),
  targets: z.array(z.enum(TARGETS)).max(TARGETS.length),
  /**
   * 已接管的客户端，必为 targets 的子集。
   *
   * targets（= routes 的键）只是「分配了方案」，engaged 才是「配置真的被改写成
   * 走网关」。两者原本是同一个集合，于是一开网关就把所有分配过的客户端全接管了，
   * 连不想动的也一起改。拆开之后可以只接管其中一个。
   */
  engaged: z.array(z.enum(TARGETS)).max(TARGETS.length),
  /** 用户希望下次启动时继续接管的目标，独立于当前进程是否正在监听。 */
  resumeTargets: z.array(z.enum(TARGETS)).max(TARGETS.length),
  routes: z.record(z.enum(TARGETS), ProfileIdSchema),
  encryptedToken: z.string().optional(),
  encryptedRouteToken: z.string().optional(),
})

function migrateGatewayStore(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaultGatewayStore()
  const routes = routeRecord(value)
  // v5 拆分出 claude-desktop 之前，claude 一个目标同时服务 CLI 和桌面端。
  // 只有老库才继承分配与接管状态；新库允许两个目标独立接管。
  const inheritDesktop = !Number.isInteger(value.version) || value.version < 5
  if (inheritDesktop && routes.claude && !routes['claude-desktop']) {
    routes['claude-desktop'] = routes.claude
  }
  const explicitTargets = Array.isArray(value.targets)
    ? value.targets.filter((target) => TARGET_SET.has(target))
    : []
  const targets = [...new Set([...explicitTargets, ...Object.keys(routes)])]
  const targetSet = new Set(targets)
  const enabled = value.enabled === true
  // 老库没有 engaged 字段。它当年的语义就是「开着就全接管」——照此还原，
  // 升级后的第一次启动行为不变，不会凭空多接管或少接管一个客户端。
  const engaged = (Array.isArray(value.engaged)
    ? value.engaged.filter((target) => TARGET_SET.has(target))
    : enabled ? targets : []
  ).filter((target) => targetSet.has(target))
  if (inheritDesktop && engaged.includes('claude') && !engaged.includes('claude-desktop')) {
    engaged.push('claude-desktop')
  }
  const resumeTargets = (Array.isArray(value.resumeTargets)
    ? value.resumeTargets.filter((target) => TARGET_SET.has(target))
    : [...engaged]
  ).filter((target) => targetSet.has(target))
  if (inheritDesktop
    && resumeTargets.includes('claude')
    && !resumeTargets.includes('claude-desktop')) {
    resumeTargets.push('claude-desktop')
  }
  const normalized = {
    version: GATEWAY_VERSION,
    enabled,
    port: Number.isInteger(value.port) && value.port >= 1 && value.port <= 65535
      ? value.port
      : DEFAULT_GATEWAY_PORT,
    targets,
    engaged: [...new Set(engaged)],
    resumeTargets: [...new Set(resumeTargets)],
    routes,
  }
  if (typeof value.encryptedToken === 'string' && value.encryptedToken) {
    normalized.encryptedToken = value.encryptedToken
  }
  if (typeof value.encryptedRouteToken === 'string' && value.encryptedRouteToken) {
    normalized.encryptedRouteToken = value.encryptedRouteToken
  }
  return normalized
}

const GatewayStoreSchema = z.preprocess(migrateGatewayStore, CanonicalGatewayStoreSchema)

function defaultGatewayStore() {
  return {
    version: GATEWAY_VERSION,
    enabled: false,
    port: DEFAULT_GATEWAY_PORT,
    targets: [],
    engaged: [],
    resumeTargets: [],
    routes: {},
  }
}

/** 随机端口的取值区间：避开系统端口，也避开 49152+ 的临时端口段。 */
const PORT_MIN = 20000
const PORT_MAX = 45000

/**
 * 随机换一个空闲端口。
 *
 * 不从当前端口往上顺着扫——占端口的程序往往霸着一串连号，爬一格只会撞下一个。
 * 直接在区间里随机取，绑一下试试，绑不上就再摇一个。
 *
 * 也不用系统分配的临时端口：那些在 49152+，且重启后容易被别的进程抢走，而这个
 * 端口要写进客户端配置文件，得能稳定复用。
 */
async function findFreePort(host, current = DEFAULT_GATEWAY_PORT, attempts = 25) {
  const canBind = (port) => new Promise((resolve) => {
    const probe = http.createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen({ host, port, exclusive: true })
  })

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN + 1))
    if (port === current) continue
    if (await canBind(port)) return port
  }
  throw new Error('Could not find a free port to move the local gateway to')
}

function normalizeTargets(targets) {
  if (!Array.isArray(targets)) throw new Error('Gateway targets must be an array')
  const result = []
  const seen = new Set()
  for (const target of targets) {
    if (!TARGET_SET.has(target)) throw new Error(`Unsupported gateway target: ${target}`)
    if (!seen.has(target)) result.push(target)
    seen.add(target)
  }
  return result
}

function validatePort(port, allowZero = false) {
  const minimum = allowZero ? 0 : 1
  if (!Number.isInteger(port) || port < minimum || port > 65535) {
    throw new Error(`Gateway port must be between ${minimum} and 65535`)
  }
  return port
}

function localBaseUrl(port, target, routeToken) {
  const route = target === 'codex' && routeToken
    ? `${target}/${encodeURIComponent(routeToken)}`
    : target
  return `http://${DEFAULT_GATEWAY_HOST}:${port}/${route}`
}

function routeRecord(value) {
  const source = value?.routes || value || {}
  const result = {}
  if (Array.isArray(source)) {
    for (const route of source) {
      const profileId = ProfileIdSchema.safeParse(route?.profileId)
      if (route && TARGET_SET.has(route.target) && profileId.success) {
        result[route.target] = profileId.data
      }
    }
    return result
  }
  for (const [target, profileId] of Object.entries(source)) {
    const parsedProfileId = ProfileIdSchema.safeParse(profileId)
    if (TARGET_SET.has(target) && parsedProfileId.success) {
      result[target] = parsedProfileId.data
    }
  }
  return result
}

function drainRejectedRequest(request) {
  if (request.complete || request.destroyed) return
  let received = 0
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    clearTimeout(timer)
  }
  const destroy = () => {
    finish()
    if (!request.destroyed) request.destroy()
  }
  const timer = setTimeout(destroy, REJECTED_BODY_DRAIN_MS)
  timer.unref?.()
  request.on('data', (chunk) => {
    received += chunk.length
    if (received > REJECTED_BODY_LIMIT_BYTES) destroy()
  })
  request.once('end', finish)
  request.once('close', finish)
  request.once('error', destroy)
  request.resume()
}

function rejectRequest(request, response, statusCode, message) {
  if (!response.headersSent) {
    response.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' })
  }
  if (!response.writableEnded) response.end(message)
  drainRejectedRequest(request)
}

function timingSafeTokenEqual(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false
  const left = Buffer.from(candidate, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function bearerValue(value) {
  if (typeof value !== 'string') return undefined
  const match = /^Bearer\s+(.+)$/i.exec(value.trim())
  return match ? match[1] : value.trim()
}

function requestHasToken(request, url, token) {
  const candidates = [
    bearerValue(request.headers.authorization),
    request.headers['x-api-key'],
    request.headers['x-goog-api-key'],
    url.searchParams.get('key'),
  ]
  return candidates.some((value) => (
    Array.isArray(value)
      ? value.some((item) => timingSafeTokenEqual(item, token))
      : timingSafeTokenEqual(value, token)
  ))
}

function stripHeaders(headers, extra = []) {
  const blocked = new Set([...HOP_BY_HOP_HEADERS, ...CREDENTIAL_HEADERS, ...extra])
  const connection = headers.connection
  if (typeof connection === 'string') {
    for (const name of connection.split(',')) blocked.add(name.trim().toLowerCase())
  }
  const result = {}
  for (const [name, value] of Object.entries(headers)) {
    if (name.startsWith(':')) continue
    if (value !== undefined && !blocked.has(name.toLowerCase())) result[name] = value
  }
  return result
}

function injectUpstreamCredential(headers, profile, apiKey) {
  if (profile.protocol === 'gemini') {
    headers['x-goog-api-key'] = apiKey
    return
  }
  if (profile.authMode === 'api-key') {
    headers['x-api-key'] = apiKey
    return
  }
  headers.authorization = `Bearer ${apiKey}`
}

function upstreamUrl(profile, suffix, incomingSearchParams) {
  const url = new URL(profile.baseUrl)
  const basePath = url.pathname.replace(/\/+$/, '')
  const suffixPath = suffix
    ? (suffix.startsWith('/') ? suffix : `/${suffix}`)
    : ''
  url.pathname = `${basePath}${suffixPath}` || '/'
  url.hash = ''
  const query = new URLSearchParams(url.search)
  for (const [name, value] of incomingSearchParams) {
    if (name !== 'key') query.append(name, value)
  }
  url.search = query.toString()
  return url
}

async function readRequestBody(request, limit = MAX_REQUEST_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > limit) {
      throw new Error('Gateway request body is too large')
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, size)
}

function hasUncountableAnthropicInput(value, parentKey) {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) {
    return value.some((item) => hasUncountableAnthropicInput(item, parentKey))
  }
  if (parentKey === 'source' && ['url', 'file'].includes(value.type)) return true
  if (['image', 'document', 'container_upload', 'mcp_toolset'].includes(value.type)) return true
  return Object.entries(value).some(([key, item]) => hasUncountableAnthropicInput(item, key))
}

/**
 * 上游没有 count_tokens 时的保守估算。它不是计费 tokenizer，只用于阻止 Claude Code
 * 再发一次 Haiku 请求来计数；媒体和远程引用无法可靠本地估算，因此拒绝伪造。
 */
function conservativeAnthropicInputTokens(body) {
  let value
  let text
  try {
    text = body.toString('utf8')
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Array.isArray(value.messages)
    || hasUncountableAnthropicInput(value)) return undefined

  let weightedCharacters = 0
  for (const character of text) {
    const codePoint = character.codePointAt(0)
    if (codePoint <= 0x7f) weightedCharacters += 0.4
    else if ((codePoint >= 0x3400 && codePoint <= 0x9fff)
      || (codePoint >= 0x3040 && codePoint <= 0x30ff)
      || (codePoint >= 0xac00 && codePoint <= 0xd7af)) weightedCharacters += 1.25
    else if (codePoint <= 0xffff) weightedCharacters += 1.5
    else weightedCharacters += 3
  }

  const messageOverhead = value.messages.length * 4
  const toolCount = Array.isArray(value.tools) ? value.tools.length : 0
  const toolOverhead = toolCount === 0
    ? 0
    : toolCount === 1
      ? 400
      : toolCount <= 5
        ? 150 + toolCount * 150
        : 250 + toolCount * 80
  return Math.max(1, Math.ceil(weightedCharacters * 1.1) + 64 + messageOverhead + toolOverhead)
}

function anthropicCountResponse(inputTokens) {
  return Buffer.from(JSON.stringify({ input_tokens: inputTokens }), 'utf8')
}

function anthropicCountErrorSupportsFallback(statusCode) {
  return statusCode === 501
}

function prepareResponsesRequest(body) {
  try {
    const payload = JSON.parse(body.toString('utf8'))
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { body, streamingForced: false }
    }
    let changed = false
    const streamingForced = payload.stream !== true
    if (streamingForced) {
      payload.stream = true
      changed = true
    }
    if (typeof payload.instructions !== 'string' || !payload.instructions.trim()) {
      payload.instructions = MINIMAL_CODEX_INSTRUCTIONS
      changed = true
    }
    return {
      body: changed ? Buffer.from(JSON.stringify(payload), 'utf8') : body,
      streamingForced,
    }
  } catch {
    // 已经消费了请求体时，仍把原字节交给上游；只有可确认的 JSON 才改写。
    return { body, streamingForced: false }
  }
}

/**
 * 查映射条目：先精确匹配；Claude 模型带 -YYYYMMDD 日期后缀的变体
 * （如 claude-haiku-4-5-20251001）归并到主档位条目。
 */
function lookupModelRoute(routes, model) {
  if (!routes || typeof routes !== 'object' || typeof model !== 'string') return undefined
  const direct = routes[model]
  if (direct) return direct
  const stripped = model.replace(/-\d{8}$/, '')
  return stripped !== model ? routes[stripped] : undefined
}

/**
 * 按方案的模型映射改写请求体顶层的 model。未命中、非 JSON 或映射值不变时
 * 返回 undefined，调用方继续转发原字节——不为改写而改写，避免无谓的重序列化。
 */
function rewriteRequestModel(body, routes) {
  if (!routes || typeof routes !== 'object') return undefined
  let payload
  try {
    payload = JSON.parse(body.toString('utf8'))
  } catch {
    return undefined
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  if (typeof payload.model !== 'string' || !payload.model) return undefined
  const route = lookupModelRoute(routes, payload.model)
  const upstreamModel = typeof route?.model === 'string' ? route.model.trim() : ''
  if (!upstreamModel || upstreamModel === payload.model) return undefined
  payload.model = upstreamModel
  return { body: Buffer.from(JSON.stringify(payload), 'utf8'), model: upstreamModel }
}

function compressCodexRequestBodyForUpstream(destination, body) {
  if (destination?.protocol !== 'https:'
    || !CODEX_GZIP_HOSTNAMES.has(destination.hostname.toLowerCase())
    || !Buffer.isBuffer(body)
    || body.length < CODEX_GZIP_MIN_BYTES) {
    return { body, contentEncoding: undefined }
  }
  try {
    const compressed = zlib.gzipSync(body, { level: zlib.constants.Z_BEST_SPEED })
    return compressed.length < body.length
      ? { body: compressed, contentEncoding: 'gzip' }
      : { body, contentEncoding: undefined }
  } catch {
    return { body, contentEncoding: undefined }
  }
}

function isCodexResponsesRequest(target, profile, suffix, method) {
  const normalizedSuffix = suffix.replace(/\/+$/, '') || '/'
  return target === 'codex'
    && profile?.protocol === 'openai-responses'
    && method === 'POST'
    && normalizedSuffix === '/responses'
}

async function createUpstreamRequest(destination, options, useCodexTransport) {
  if (useCodexTransport && destination.protocol === 'https:' && http2Wrapper?.auto) {
    // auto() 的首次 H2 请求会先做一次 ALPN 探测，再另建真正的 H2 会话。
    // 先复用/建立 Agent 会话并写入协议缓存，避免首个 Codex 请求支付两次 TLS 建链。
    await prewarmCodexHttp2Session(destination)
    return http2Wrapper.auto(destination, {
      ...options,
      agent: {
        https: CODEX_HTTPS_AGENT,
        http2: CODEX_HTTP2_AGENT || http2Wrapper.globalAgent,
      },
    })
  }
  const transport = destination.protocol === 'https:' ? https : http
  return transport.request(destination, {
    ...options,
    ...(useCodexTransport && destination.protocol === 'https:'
      ? { agent: CODEX_HTTPS_AGENT }
      : {}),
  })
}

function extractRequestModel(target, suffix, body) {
  if (target === 'gemini') {
    const match = /\/models\/([^/:?]+)/.exec(suffix || '')
    if (match?.[1]) {
      try { return decodeURIComponent(match[1]) } catch { return match[1] }
    }
  }
  if (!body?.length) return undefined
  try {
    const payload = JSON.parse(body.toString('utf8'))
    return typeof payload?.model === 'string' && payload.model.trim()
      ? payload.model.trim()
      : undefined
  } catch {
    return undefined
  }
}

function percentile(values, percentileValue) {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)
  return sorted[Math.max(0, index)]
}

/** 本地回环网关；仅兼容同步 Responses 时需要聚合上游 SSE。 */
class GatewayService {
  constructor({
    profileService,
    store,
    vault,
    host = DEFAULT_GATEWAY_HOST,
    onStateChanged,
    requestMonitor,
    getRoutingSettings,
    responsesFallbackIdleTimeoutMs = RESPONSES_FALLBACK_IDLE_TIMEOUT_MS,
    responsesFallbackTotalTimeoutMs = RESPONSES_FALLBACK_TOTAL_TIMEOUT_MS,
  }) {
    if (!profileService || !store || !vault) {
      throw new Error('GatewayService requires profileService, store, and vault')
    }
    this.profileService = profileService
    this.store = store
    this.vault = vault
    this.host = host
    this.onStateChanged = onStateChanged
    this.requestMonitor = requestMonitor
    this.routingSettingsReader = getRoutingSettings
    this.responsesFallbackIdleTimeoutMs = Number.isFinite(responsesFallbackIdleTimeoutMs)
      && responsesFallbackIdleTimeoutMs > 0
      ? responsesFallbackIdleTimeoutMs
      : RESPONSES_FALLBACK_IDLE_TIMEOUT_MS
    this.responsesFallbackTotalTimeoutMs = Number.isFinite(responsesFallbackTotalTimeoutMs)
      && responsesFallbackTotalTimeoutMs > 0
      ? responsesFallbackTotalTimeoutMs
      : RESPONSES_FALLBACK_TOTAL_TIMEOUT_MS
    this.serial = new SerialExecutor()
    this.server = undefined
    this.sockets = new Set()
    this.upstreamRequests = new Set()
    this.loaded = false
    this.status = 'stopped'
    this.startedAt = undefined
    this.error = undefined
    this.persisted = defaultGatewayStore()
    this.localToken = undefined
    this.routeToken = undefined
    this.connectionCache = new Map()
    this.weightedSticky = new Map()
    this.weightedCooldowns = new Map()
    this.weightedRouteAnchors = new Map()
    this.weightedMode = false
    this.weightedAutoDisabled = new Set()
    this.weightedAutoDisableInFlight = new Set()
    this.anthropicCountFallbacks = new Map()
    this.anthropicCountBodyActive = 0
    this.responsesFallbackBodyActive = 0
  }

  async initialize({ start = true } = {}) {
    return this.serial.run(async () => {
      await this._ensureLoaded()
      if (!start || !this.persisted.enabled || this.server) return this.getPublicState()
      try {
        return await this._startLoaded({
          port: this.persisted.port,
          engage: this.persisted.engaged,
        })
      } catch (error) {
        this.status = 'error'
        this.error = error instanceof Error ? error.message : String(error)
        this._notify()
        return this.getPublicState()
      }
    })
  }

  async start(options = {}) {
    return this.serial.run(async () => {
      await this._ensureLoaded()
      return this._startLoaded(options)
    })
  }

  /**
   * @param options.engage 要接管的客户端。省略时沿用已接管的集合；接管集合必须是
   *   已分配集合（targets）的子集，越界的项会被丢掉而不是把它们悄悄提升为已分配。
   */
  async _startLoaded({
    port = this.persisted.port,
    engage,
    targets,
    resumeTargets,
  } = {}) {
    const requestedPort = validatePort(port, true)

    /*
     * 两种入口：
     * - engage：只接管这些（必须已分配）。apply-service 走这条。
     * - targets：旧签名，「暂存并接管这些」。保留它，因为启动时预暂存客户端
     *   （此时还没有任何路由分配）仍是合法用法。
     */
    if (targets !== undefined) {
      const staged = normalizeTargets(targets)
      this.persisted = await this.store.write({
        ...this.persisted,
        targets: [...new Set([...this.persisted.targets, ...staged])],
      })
    }
    const weighted = this.isWeightedRouting()
    if (weighted !== this.weightedMode) {
      this.weightedMode = weighted
      this._clearWeightedRuntime()
    }
    const assigned = new Set(this.persisted.targets)
    const engageable = weighted ? new Set(TARGETS) : assigned
    const requestedEngaged = normalizeTargets(
      engage ?? targets ?? this.persisted.engaged,
    ).filter((target) => engageable.has(target))
    const requestedResumeTargets = normalizeTargets(
      resumeTargets ?? [...new Set([...this.persisted.resumeTargets, ...requestedEngaged])],
    ).filter((target) => engageable.has(target))

    if (this.server) {
      const currentPort = this.persisted.port
      if (requestedPort !== 0 && requestedPort !== currentPort) {
        await this._closeServer()
      } else {
        this.persisted = await this.store.write({
          ...this.persisted,
          enabled: true,
          targets: weighted
            ? [...new Set([...this.persisted.targets, ...requestedEngaged])]
            : this.persisted.targets,
          engaged: requestedEngaged,
          resumeTargets: requestedResumeTargets,
        })
        if (weighted) await this._prepareWeightedRouteAnchors(requestedEngaged)
        this._evictUnroutedConnections()
        this.status = 'running'
        this.error = undefined
        this._notify()
        return this.getPublicState()
      }
    }

    this.status = 'starting'
    this.error = undefined
    this._notify()
    let token
    let routeToken
    try {
      token = this.persisted.encryptedToken
        ? this.vault.decrypt(this.persisted.encryptedToken)
        : crypto.randomBytes(32).toString('base64url')
      routeToken = this.persisted.encryptedRouteToken
        ? this.vault.decrypt(this.persisted.encryptedRouteToken)
        : crypto.randomBytes(32).toString('base64url')
      const server = http.createServer((request, response) => {
        // _handleRequest may await a first connection before pipeline installs its listener.
        request.on('error', () => {})
        request.on('aborted', () => {})
        this._handleRequest(request, response).catch(() => {
          if (!response.headersSent) {
            rejectRequest(request, response, 500, 'Gateway request failed')
          } else {
            response.destroy()
            request.destroy()
          }
        })
      })
      server.headersTimeout = LOCAL_HEADERS_TIMEOUT_MS
      server.requestTimeout = LOCAL_REQUEST_TIMEOUT_MS
      server.keepAliveTimeout = 5_000
      server.maxConnections = LOCAL_MAX_CONNECTIONS
      server.setTimeout(LOCAL_IDLE_TIMEOUT_MS, (socket) => socket.destroy())
      server.on('connection', (socket) => {
        this.sockets.add(socket)
        socket.once('close', () => this.sockets.delete(socket))
      })
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen({ host: this.host, port: requestedPort, exclusive: true })
      })
      const address = server.address()
      const boundPort = typeof address === 'object' && address ? address.port : requestedPort
      this.server = server
      this.localToken = token
      this.routeToken = routeToken
      try {
        this.persisted = await this.store.write({
          version: GATEWAY_VERSION,
          enabled: true,
          port: boundPort,
          targets: weighted
            ? [...new Set([...this.persisted.targets, ...requestedEngaged])]
            : this.persisted.targets,
          engaged: requestedEngaged,
          resumeTargets: requestedResumeTargets,
          routes: this.persisted.routes,
          encryptedToken: this.persisted.encryptedToken || this.vault.encrypt(token),
          encryptedRouteToken: this.persisted.encryptedRouteToken
            || this.vault.encrypt(routeToken),
        })
        this._evictUnroutedConnections()
      } catch (error) {
        await this._closeServer()
        throw error
      }
      if (weighted) await this._prepareWeightedRouteAnchors(requestedEngaged)
      await this._preloadRouteConnections()
      this.status = 'running'
      this.startedAt = new Date().toISOString()
      this.error = undefined
      this._notify()
      return this.getPublicState()
    } catch (error) {
      this.status = 'error'
      this.error = error instanceof Error ? error.message : String(error)
      this.localToken = undefined
      this.routeToken = undefined
      this.connectionCache.clear()
      this._clearWeightedRuntime()
      this._notify()
      throw error
    }
  }

  async stop({ clearRoutes = false, preserveResumeIntent = false, resumeTargets } = {}) {
    return this.serial.run(async () => {
      await this._ensureLoaded()
      this.status = 'stopping'
      this._notify()
      try {
        await this._closeServer()
        const assigned = new Set(clearRoutes ? [] : this.persisted.targets)
        const nextResumeTargets = normalizeTargets(
          resumeTargets ?? (preserveResumeIntent ? this.persisted.resumeTargets : []),
        ).filter((target) => assigned.has(target))
        this.persisted = await this.store.write({
          ...this.persisted,
          enabled: false,
          targets: clearRoutes ? [] : this.persisted.targets,
          // 服务器停了就没有任何客户端还被接管着
          engaged: [],
          resumeTargets: nextResumeTargets,
          routes: clearRoutes ? {} : this.persisted.routes,
        })
        this.status = 'stopped'
        this.error = undefined
      } catch (error) {
        this.status = 'error'
        this.error = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        this.startedAt = undefined
        this.localToken = undefined
        this.routeToken = undefined
        this.connectionCache.clear()
        this._clearWeightedRuntime()
        this._notify()
      }
      return this.getPublicState()
    })
  }

  async stopAndWait(options) {
    return this.stop(options)
  }

  /**
   * 仅关闭本进程监听器，不改变持久化接管状态。
   *
   * 用于应用退出时直连恢复失败的兜底；下次启动会按原端口和路由自动恢复。
   *
   * @returns {Promise<object>} 关闭后的公开运行状态。
   */
  async shutdown() {
    return this.serial.run(async () => {
      await this._ensureLoaded()
      try {
        await this._closeServer()
        this.status = 'stopped'
      } finally {
        this.startedAt = undefined
        this.localToken = undefined
        this.routeToken = undefined
        this.connectionCache.clear()
        this._clearWeightedRuntime()
        this._notify()
      }
      return this.getPublicState()
    })
  }

  getPublicState() {
    const port = this.persisted.port
    const targets = [...this.persisted.targets]
    const publicRoutes = this.isWeightedRouting() ? {} : { ...this.persisted.routes }
    if (this.isWeightedRouting()) {
      for (const target of this.persisted.engaged) {
        const profileId = this.weightedRouteAnchors.get(target)
        if (profileId) publicRoutes[target] = profileId
      }
    }
    return {
      status: this.status,
      host: this.host,
      port,
      targets,
      engaged: [...this.persisted.engaged],
      routes: Object.entries(publicRoutes).map(([target, profileId]) => ({
        target,
        profileId,
      })),
      localBaseUrls: Object.fromEntries(targets.map((target) => [
        target,
        (() => {
          try {
            return this.getLocalBaseUrl(target)
          } catch {
            return localBaseUrl(port, target)
          }
        })(),
      ])),
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      ...(this.error ? { error: this.error } : {}),
    }
  }

  getLocalBaseUrl(target) {
    if (!TARGET_SET.has(target)) throw new Error(`Unsupported gateway target: ${target}`)
    if (target !== 'codex') return localBaseUrl(this.persisted.port, target)
    const routeToken = this.routeToken || (this.persisted.encryptedRouteToken
      ? this.vault.decrypt(this.persisted.encryptedRouteToken)
      : undefined)
    if (!routeToken) throw new Error('Codex gateway route token is unavailable')
    return localBaseUrl(this.persisted.port, target, routeToken)
  }

  getActiveRequests() {
    try {
      if (typeof this.requestMonitor?.getActiveRequests === 'function') {
        return this.requestMonitor.getActiveRequests()
      }
      return this.requestMonitor?.list?.() || []
    } catch {
      return []
    }
  }

  async prepareConnection(profileOrId, apiKeyOrTarget, maybeTarget) {
    let profile
    let target
    if (profileOrId && typeof profileOrId === 'object') {
      profile = profileOrId
      target = maybeTarget
    } else {
      target = apiKeyOrTarget
      const connection = await this.profileService.getConnection(profileOrId)
      profile = connection.profile
    }
    this._assertRunningTarget(target)
    if (!profile?.id) throw new Error('Gateway connection requires a profile ID')
    const baseUrl = this.getLocalBaseUrl(target)
    return {
      profile: { ...profile, baseUrl },
      apiKey: this.localToken,
      localBaseUrl: baseUrl,
      adapterOptions: {
        providerId: 'agentgate_gateway',
        providerName: 'Agent;Gate Local Gateway',
      },
      mode: 'gateway',
    }
  }

  async activateRoutes(profileOrId, targets) {
    return this.assignRoutes(profileOrId, targets)
  }

  /**
   * 分配持久化路由。分配与监听状态无关，因此可以在网关关闭时预先完成。
   *
   * @returns {Promise<object>} 修改前的 targets/routes 快照，供跨服务事务回滚。
   */
  async assignRoutes(profileOrId, targets) {
    return this.serial.run(async () => {
      await this._ensureLoaded()
      const parsedProfileId = ProfileIdSchema.safeParse(
        typeof profileOrId === 'string' ? profileOrId : profileOrId?.id,
      )
      if (!parsedProfileId.success) throw new Error('Gateway route requires a valid profile ID')
      const profileId = parsedProfileId.data
      const selected = normalizeTargets(
        targets === undefined
          ? (typeof profileOrId === 'object' ? profileOrId.targets : [])
          : (Array.isArray(targets) ? targets : [targets]),
      )
      if (selected.length === 0) throw new Error('Select at least one gateway target')
      for (const target of selected) {
        if (!TARGET_SET.has(target)) throw new Error(`Unsupported gateway target: ${target}`)
      }
      const connection = await this.profileService.getConnection(profileId)
      const previous = {
        targets: [...this.persisted.targets],
        engaged: [...this.persisted.engaged],
        resumeTargets: [...this.persisted.resumeTargets],
        routes: { ...this.persisted.routes },
      }
      const routes = { ...previous.routes }
      for (const target of selected) routes[target] = profileId
      const nextTargets = [...new Set([...this.persisted.targets, ...selected])]
      this.persisted = await this.store.write({
        ...this.persisted,
        targets: nextTargets,
        routes,
      })
      this._evictUnroutedConnections()
      if (this.status === 'running' && this.server
        && this._isProfileEngaged(profileId)) {
        this.connectionCache.set(profileId, connection)
        if (selected.includes('codex')) this._prewarmCodexConnection(connection)
      }
      this._notify()
      return previous
    })
  }

  async unassignRoutes(targets) {
    return this.serial.run(async () => {
      await this._ensureLoaded()
      const selected = new Set(normalizeTargets(Array.isArray(targets) ? targets : [targets]))
      const previous = {
        targets: [...this.persisted.targets],
        engaged: [...this.persisted.engaged],
        resumeTargets: [...this.persisted.resumeTargets],
        routes: { ...this.persisted.routes },
      }
      const routes = Object.fromEntries(
        Object.entries(this.persisted.routes).filter(([target]) => !selected.has(target)),
      )
      const nextTargets = this.persisted.targets.filter((target) => !selected.has(target))
      this.persisted = await this.store.write({
        ...this.persisted,
        targets: nextTargets,
        // 取消分配的同时必须取消接管，否则会留下一个指向空路由的接管项
        engaged: this.persisted.engaged.filter((target) => !selected.has(target)),
        resumeTargets: this.persisted.resumeTargets.filter((target) => !selected.has(target)),
        routes,
      })
      this._evictUnroutedConnections()
      this._notify()
      return previous
    })
  }

  async restoreRoutes(snapshot) {
    return this.serial.run(async () => {
      await this._ensureLoaded()
      const routes = routeRecord(snapshot)
      const targets = Array.isArray(snapshot?.targets)
        ? normalizeTargets(snapshot.targets)
        : [...new Set([...this.persisted.targets, ...Object.keys(routes)])]
      const assigned = new Set(targets)
      this.persisted = await this.store.write({
        ...this.persisted,
        targets,
        // 回滚后接管集合和恢复意图都必须指向仍存在的分配
        engaged: Array.isArray(snapshot?.engaged)
          ? normalizeTargets(snapshot.engaged).filter((target) => assigned.has(target))
          : this.persisted.engaged.filter((target) => assigned.has(target)),
        resumeTargets: Array.isArray(snapshot?.resumeTargets)
          ? normalizeTargets(snapshot.resumeTargets).filter((target) => assigned.has(target))
          : this.persisted.resumeTargets.filter((target) => assigned.has(target)),
        routes: this._routesForTargets(routes, targets),
      })
      this._evictUnroutedConnections()
      if (this.status === 'running' && this.server) await this._preloadRouteConnections()
      else this.connectionCache.clear()
      this._notify()
      return this.getPublicState()
    })
  }

  isTargetEnabled(target) {
    return this.status === 'running'
      && Boolean(this.server)
      && this.persisted.engaged.includes(target)
  }

  /**
   * 运行期增删接管的客户端，不重启服务器。
   *
   * target 只是 URL 路径上的一段，isTargetEnabled 是运行期闸门——增删它不影响
   * 已建立的连接，也不必换端口或重新签发令牌。越界（未分配方案）的项直接丢掉。
   */
  async setEngagedTargets(targets, { preserveResumeIntent = false, resumeTargets } = {}) {
    return this.serial.run(async () => {
      await this._ensureLoaded()
      const assigned = new Set(this.persisted.targets)
      const next = normalizeTargets(targets).filter((target) => assigned.has(target))
      const nextResumeTargets = normalizeTargets(
        resumeTargets ?? (preserveResumeIntent ? this.persisted.resumeTargets : next),
      ).filter((target) => assigned.has(target))
      this.persisted = await this.store.write({
        ...this.persisted,
        engaged: next,
        resumeTargets: nextResumeTargets,
      })
      if (this.isWeightedRouting()) await this._prepareWeightedRouteAnchors(next)
      // 放掉客户端后，指向它的方案明文不该继续留在缓存里
      this._evictUnroutedConnections()
      this._notify()
      return this.getPublicState()
    })
  }

  getLifecycleState() {
    return {
      enabled: this.persisted.enabled,
      engaged: [...this.persisted.engaged],
      resumeTargets: [...this.persisted.resumeTargets],
    }
  }

  _routingSettings() {
    let value
    try {
      value = typeof this.routingSettingsReader === 'function'
        ? this.routingSettingsReader()
        : this.routingSettingsReader
    } catch {
      value = undefined
    }
    const routing = value?.routing || value || {}
    return {
      mode: routing.mode === 'weighted' ? 'weighted' : 'assignment',
      strategy: routing.strategy === 'adaptive' ? 'adaptive' : 'fixed',
    }
  }

  getRoutingMode() {
    return this._routingSettings().mode
  }

  isWeightedRouting() {
    return this.getRoutingMode() === 'weighted'
  }

  /**
   * 设置模式运行中发生变化时刷新内存路由状态，不改写客户端配置。
   *
   * 固定/自适应策略切换不清掉粘性；只有分配与权重模式切换才重建锚点。
   */
  async refreshRouting() {
    return this.serial.run(async () => {
      await this._ensureLoaded()
      const weighted = this.isWeightedRouting()
      if (weighted === this.weightedMode) return this.getPublicState()
      this.weightedMode = weighted
      this._clearWeightedRuntime()
      if (this.status === 'running' && this.server) {
        if (weighted) await this._prepareWeightedRouteAnchors(this.persisted.engaged)
        else await this._preloadRouteConnections()
        this._evictUnroutedConnections()
        this._notify()
      }
      return this.getPublicState()
    })
  }

  _activeEndpoint(profile) {
    return profile?.endpoints?.find((endpoint) => (
      endpoint.url?.replace(/\/+$/, '') === profile.baseUrl?.replace(/\/+$/, '')
    )) || profile?.endpoints?.[0]
  }

  _profileCanHandle(profile, target, model) {
    if (!profile?.routing?.enabled || this.weightedAutoDisabled.has(profile.id)) return false
    if (!Array.isArray(profile.targets) || !profile.targets.includes(target)) return false
    const endpoint = this._activeEndpoint(profile)
    if (endpoint?.health?.status === 'unhealthy') return false
    if (!model) return true
    const models = new Set(endpoint?.models || [])
    // 模型映射先把客户端模型翻译成上游模型，再按端点事实与启用列表判断；
    // 没有映射条目时按原模型判断。粘性键仍按传入模型，见 _weightedRequestKey。
    const mapped = lookupModelRoute(profile.modelRoutes, model)?.model
    const effective = typeof mapped === 'string' && mapped.trim() ? mapped.trim() : model
    return models.has(effective) && (profile.routing.enabledModels || []).includes(effective)
  }

  _weightedRequestKey(target, model) {
    return `${target}\0${model || '*'}`
  }

  _weightedCandidateKey(target, model, profileId) {
    return `${this._weightedRequestKey(target, model)}\0${profileId}`
  }

  _canAttemptWeighted(target, model, profileId) {
    const key = this._weightedCandidateKey(target, model, profileId)
    const state = this.weightedCooldowns.get(key)
    if (!state) return true
    const now = Date.now()
    if (state.cooldownUntil > now) return false
    if (state.halfOpenInFlight) return false
    state.halfOpenInFlight = true
    return true
  }

  _adaptiveCandidateScore(profile, target, model) {
    const records = (typeof this.requestMonitor?.list === 'function'
      ? this.requestMonitor.list()
      : [])
      .filter((entry) => entry.profileId === profile.id
        && entry.client === target
        && (!model || entry.model === model)
        && entry.completedAt)
      .slice(0, 100)
    if (records.length === 0) return 0
    const successes = records.filter((entry) => entry.outcome === 'completed').length
    const failures = records.length - successes
    const firstToken = records
      .map((entry) => entry.firstTokenLatencyMs ?? entry.firstByteLatencyMs)
      .filter((value) => Number.isFinite(value))
    const durations = records
      .map((entry) => entry.durationMs)
      .filter((value) => Number.isFinite(value))
    const averageFirstToken = firstToken.length > 0
      ? firstToken.reduce((total, value) => total + value, 0) / firstToken.length
      : 60_000
    const p95 = percentile(durations, 0.95) ?? 60_000
    const availability = successes / records.length
    return availability * 1_000_000
      - failures * 100_000
      - averageFirstToken
      - p95 * 0.25
  }

  async _selectWeightedConnection(target, model) {
    const profiles = await this.profileService.list()
    const candidates = profiles
      .map((profile, index) => ({ profile, index }))
      .filter(({ profile }) => this._profileCanHandle(profile, target, model))
    if (candidates.length === 0) {
      this.weightedRouteAnchors.delete(target)
      return undefined
    }

    const requestKey = this._weightedRequestKey(target, model)
    const stickyId = this.weightedSticky.get(requestKey)
    const sticky = candidates.find(({ profile }) => profile.id === stickyId)
    const ordered = sticky
      ? [sticky, ...candidates.filter((candidate) => candidate !== sticky)]
      : [...candidates].sort((left, right) => {
          const weightDelta = (right.profile.routing?.weight ?? 0) - (left.profile.routing?.weight ?? 0)
          if (weightDelta !== 0) return weightDelta
          if (this._routingSettings().strategy === 'adaptive') {
            const scoreDelta = this._adaptiveCandidateScore(right.profile, target, model)
              - this._adaptiveCandidateScore(left.profile, target, model)
            if (scoreDelta !== 0) return scoreDelta
          }
          return left.index - right.index
        })

    for (const candidate of ordered) {
      if (!this._canAttemptWeighted(target, model, candidate.profile.id)) continue
      this.weightedRouteAnchors.set(target, candidate.profile.id)
      try {
        const connection = await this._connection(candidate.profile.id)
        this.weightedSticky.set(requestKey, candidate.profile.id)
        return {
          connection,
          model,
          profileId: candidate.profile.id,
          autoDisableOnFailure: candidate.profile.routing.autoDisableOnFailure,
        }
      } catch {
        if (this.weightedRouteAnchors.get(target) === candidate.profile.id) {
          this.weightedRouteAnchors.delete(target)
        }
        this._recordWeightedOutcome({
          target,
          model,
          profileId: candidate.profile.id,
          autoDisableOnFailure: candidate.profile.routing.autoDisableOnFailure,
        }, 'hard-failure')
      }
    }
    this.weightedSticky.delete(requestKey)
    return undefined
  }

  _recordWeightedOutcome(attempt, outcome) {
    if (!attempt?.profileId) return
    const key = this._weightedCandidateKey(attempt.target, attempt.model, attempt.profileId)
    if (outcome === 'success') {
      this.weightedCooldowns.delete(key)
      return
    }
    const now = Date.now()
    const current = this.weightedCooldowns.get(key) || { hardFailures: 0 }
    if (outcome === 'hard-failure') {
      current.hardFailures += 1
      current.cooldownUntil = now + Math.min(
        WEIGHTED_COOLDOWN_MS * (2 ** Math.max(0, current.hardFailures - 1)),
        5 * 60_000,
      )
      current.halfOpenInFlight = false
      this.weightedCooldowns.set(key, current)
      if (current.hardFailures >= WEIGHTED_FAILURE_THRESHOLD && attempt.autoDisableOnFailure) {
        void this._autoDisableWeightedProfile(attempt.profileId)
      }
      return
    }
    current.cooldownUntil = now + (outcome === 'rate-limit'
      ? WEIGHTED_RATE_LIMIT_COOLDOWN_MS
      : WEIGHTED_MODEL_FAILURE_COOLDOWN_MS)
    current.halfOpenInFlight = false
    this.weightedCooldowns.set(key, current)
  }

  async _autoDisableWeightedProfile(profileId) {
    if (this.weightedAutoDisableInFlight.has(profileId)) return
    this.weightedAutoDisableInFlight.add(profileId)
    this.weightedAutoDisabled.add(profileId)
    this._dropWeightedProfile(profileId)
    try {
      const profile = (await this.profileService.list()).find((item) => item.id === profileId)
      if (profile?.routing?.enabled && profile.routing.autoDisableOnFailure) {
        await this.profileService.updateRouting(profileId, {
          ...profile.routing,
          enabled: false,
        })
      }
    } catch {
      // 运行时熔断不能因为配置同步失败而影响当前请求。
    } finally {
      this.weightedAutoDisableInFlight.delete(profileId)
      this._notify()
    }
  }

  /**
   * 换一个空闲端口。默认端口被别的程序占住时，用户在界面上本来没有别的出路。
   *
   * 只在未运行时可用——运行中换端口会让已写进客户端配置的地址指向旧端口。
   */
  async reassignPort() {
    return this.serial.run(async () => {
      await this._ensureLoaded()
      if (this.status === 'running' || this.server) {
        throw new Error('Stop the local gateway before changing its port')
      }
      const port = await findFreePort(this.host, this.persisted.port)
      this.persisted = await this.store.write({ ...this.persisted, port })
      this._notify()
      return this.getPublicState()
    })
  }

  activeTargetsForProfile(profileOrId) {
    const profileId = typeof profileOrId === 'string' ? profileOrId : profileOrId?.id
    const routes = this.isWeightedRouting()
      ? Object.fromEntries(this.weightedRouteAnchors.entries())
      : this.persisted.routes
    return Object.entries(routes)
      .filter(([, routedProfileId]) => routedProfileId === profileId)
      .map(([target]) => target)
  }

  assignedTargetsForProfile(profileOrId) {
    return this.activeTargetsForProfile(profileOrId)
  }

  getRouteGroups() {
    const groups = new Map()
    const routes = this.isWeightedRouting()
      ? Object.fromEntries(this.weightedRouteAnchors.entries())
      : this.persisted.routes
    for (const [target, profileId] of Object.entries(routes)) {
      if (!groups.has(profileId)) groups.set(profileId, [])
      groups.get(profileId).push(target)
    }
    return [...groups].map(([profileId, targets]) => ({ profileId, targets }))
  }

  async getWeightedCandidates(target) {
    if (!TARGET_SET.has(target)) return []
    const profiles = await this.profileService.list()
    return profiles.filter((profile) => this._profileCanHandle(profile, target))
  }

  async refreshProfile(profileOrId) {
    return this.serial.run(async () => {
      await this._ensureLoaded()
      const profileId = typeof profileOrId === 'string' ? profileOrId : profileOrId?.id
      if (this.isWeightedRouting() && profileId) {
        const profile = (await this.profileService.list()).find((item) => item.id === profileId)
        if (profile?.routing?.enabled) this.weightedAutoDisabled.delete(profileId)
        else this._dropWeightedProfile(profileId)
      }
      if (this.status !== 'running'
        || !this.server
        || !profileId
        || !this._isProfileEngaged(profileId)) return
      const connection = await this.profileService.getConnection(profileId)
      if (this.status !== 'running'
        || !this.server
        || !this._isProfileEngaged(profileId)) return
      this.connectionCache.set(profileId, connection)
    })
  }

  matchesLocalBase(value, target) {
    if (typeof value !== 'string') return false
    try {
      const url = new URL(value)
      const expectedTarget = target || url.pathname.split('/').filter(Boolean)[0]
      if (expectedTarget === 'codex') {
        return url.toString() === this.getLocalBaseUrl('codex')
      }
      return TARGET_SET.has(expectedTarget)
        && url.protocol === 'http:'
        && url.hostname === DEFAULT_GATEWAY_HOST
        && Number(url.port || 80) === this.persisted.port
        && url.pathname.replace(/\/+$/, '') === `/${expectedTarget}`
        && !url.search
        && !url.hash
    } catch {
      return false
    }
  }

  async _ensureLoaded() {
    if (this.loaded) return
    this.persisted = GatewayStoreSchema.parse(await this.store.read())
    this.loaded = true
  }

  _routesForTargets(routes, targets) {
    const enabled = new Set(targets)
    return Object.fromEntries(Object.entries(routeRecord(routes)).filter(([target]) => enabled.has(target)))
  }

  async _prepareWeightedRouteAnchors(targets) {
    const profiles = await this.profileService.list()
    const requested = new Set(targets)
    for (const target of this.weightedRouteAnchors.keys()) {
      if (!requested.has(target)) this.weightedRouteAnchors.delete(target)
    }
    for (const target of targets) {
      const candidate = profiles
        .map((profile, index) => ({ profile, index }))
        .filter(({ profile }) => this._profileCanHandle(profile, target))
        .sort((left, right) => (
          (right.profile.routing?.weight ?? 0) - (left.profile.routing?.weight ?? 0)
          || left.index - right.index
        ))[0]
      if (candidate) this.weightedRouteAnchors.set(target, candidate.profile.id)
      else this.weightedRouteAnchors.delete(target)
    }
  }

  _dropWeightedProfile(profileId) {
    for (const [target, candidateId] of this.weightedRouteAnchors.entries()) {
      if (candidateId === profileId) this.weightedRouteAnchors.delete(target)
    }
    for (const [requestKey, candidateId] of this.weightedSticky.entries()) {
      if (candidateId === profileId) this.weightedSticky.delete(requestKey)
    }
    this.connectionCache.delete(profileId)
  }

  async _preloadRouteConnections() {
    const profileIds = [...new Set(
      this.persisted.engaged.map((target) => this.persisted.routes[target]).filter(Boolean),
    )]
    await Promise.all(profileIds.map(async (profileId) => {
      try {
        const connection = await this.profileService.getConnection(profileId)
        this.connectionCache.set(profileId, connection)
      } catch {
        this.connectionCache.delete(profileId)
      }
    }))
    const codexProfileId = this.persisted.engaged.includes('codex')
      ? this.persisted.routes.codex
      : undefined
    const codexConnection = codexProfileId
      ? this.connectionCache.get(codexProfileId)
      : undefined
    if (codexConnection) this._prewarmCodexConnection(codexConnection)
    this._evictUnroutedConnections()
  }

  _prewarmCodexConnection(connection) {
    if (connection?.profile?.protocol !== 'openai-responses') return
    let destination
    try {
      destination = new URL(connection.profile.baseUrl)
    } catch {
      return
    }
    void prewarmCodexHttp2Session(destination)
  }

  /**
   * 缓存里放的是解密后的明文 Key，按「还在被接管吗」驱逐，而不是「还有分配吗」。
   *
   * 分配（routes）在断开接管后仍然保留，好让下次一键接管；但只要没有任何被接管
   * 的客户端指向某个方案，它的明文就没有理由继续留在内存里。
   */
  _evictUnroutedConnections() {
    if (this.isWeightedRouting()) {
      const engaged = new Set(this.persisted.engaged)
      for (const target of this.weightedRouteAnchors.keys()) {
        if (!engaged.has(target)) this.weightedRouteAnchors.delete(target)
      }
      for (const requestKey of this.weightedSticky.keys()) {
        const target = requestKey.split('\0', 1)[0]
        if (!engaged.has(target)) this.weightedSticky.delete(requestKey)
      }
    }
    const liveProfileIds = this.isWeightedRouting()
      ? new Set(this.weightedRouteAnchors.values())
      : new Set(
          this.persisted.engaged
            .map((target) => this.persisted.routes[target])
            .filter(Boolean),
        )
    for (const profileId of this.connectionCache.keys()) {
      if (!liveProfileIds.has(profileId)) this.connectionCache.delete(profileId)
    }
  }

  _isProfileEngaged(profileId) {
    if (this.isWeightedRouting()) {
      return [...this.weightedRouteAnchors.values()].includes(profileId)
    }
    return this.persisted.engaged.some((target) => this.persisted.routes[target] === profileId)
  }

  async _connection(profileId) {
    const cached = this.connectionCache.get(profileId)
    if (cached) return cached
    const connection = await this.profileService.getConnection(profileId)
    if (this.status !== 'running'
      || (!this.isWeightedRouting() && !this._isProfileEngaged(profileId))
      || (this.isWeightedRouting() && !this._isProfileEngaged(profileId))) {
      throw new Error('Gateway route changed while loading its connection')
    }
    this.connectionCache.set(profileId, connection)
    return connection
  }

  _assertEnabledTarget(target) {
    if (!TARGET_SET.has(target)) throw new Error(`Unsupported gateway target: ${target}`)
    if (!this.isTargetEnabled(target)) throw new Error(`Gateway target is not enabled: ${target}`)
  }

  _assertRunningTarget(target) {
    if (this.status !== 'running' || !this.server || !this.localToken || !this.routeToken) {
      throw new Error('Local gateway is not running')
    }
    this._assertEnabledTarget(target)
  }

  _tryAcquireResponsesFallbackBody() {
    if (this.responsesFallbackBodyActive >= RESPONSES_FALLBACK_BODY_SLOTS) return undefined
    this.responsesFallbackBodyActive += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.responsesFallbackBodyActive = Math.max(0, this.responsesFallbackBodyActive - 1)
    }
  }

  _tryAcquireAnthropicCountBody() {
    if (this.anthropicCountBodyActive >= ANTHROPIC_COUNT_BODY_SLOTS) return undefined
    this.anthropicCountBodyActive += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.anthropicCountBodyActive = Math.max(0, this.anthropicCountBodyActive - 1)
    }
  }

  _notify() {
    if (typeof this.onStateChanged !== 'function') return
    try {
      this.onStateChanged(this.getPublicState())
    } catch {
      // 状态订阅者不得影响网关生命周期。
    }
  }

  _clearWeightedRuntime() {
    this.weightedSticky.clear()
    this.weightedCooldowns.clear()
    this.weightedRouteAnchors.clear()
    this.weightedAutoDisabled.clear()
    this.weightedAutoDisableInFlight.clear()
  }

  async _closeServer() {
    const server = this.server
    this.server = undefined
    for (const request of this.upstreamRequests) request.destroy()
    this.upstreamRequests.clear()
    if (!server) {
      this.requestMonitor?.clear?.()
      return
    }
    const closed = new Promise((resolve) => server.close(() => resolve()))
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections()
    for (const socket of this.sockets) socket.destroy()
    await closed
    this.sockets.clear()
    this.requestMonitor?.clear?.()
  }

  async _handleRequest(request, response) {
    const incomingUrl = new URL(request.url || '/', `http://${DEFAULT_GATEWAY_HOST}`)
    const routeMatch = /^\/([^/]+)(\/.*)?$/.exec(incomingUrl.pathname)
    const target = routeMatch?.[1]
    if (!TARGET_SET.has(target) || !this.isTargetEnabled(target)) {
      rejectRequest(request, response, 404, 'Gateway route not found')
      return
    }
    const codexRoute = target === 'codex'
      ? /^\/codex\/([^/]+)(\/.*)?$/.exec(incomingUrl.pathname)
      : undefined
    const routeAuthorized = target === 'codex'
      && this.routeToken
      && timingSafeTokenEqual(codexRoute?.[1], this.routeToken)
    const headerAuthorized = target !== 'codex'
      && this.localToken
      && requestHasToken(request, incomingUrl, this.localToken)
    if (!routeAuthorized && !headerAuthorized) {
      rejectRequest(request, response, 401, 'Unauthorized')
      return
    }
    const suffix = target === 'codex' ? (codexRoute?.[2] || '') : (routeMatch?.[2] || '')
    const weighted = this.isWeightedRouting()
    let requestBody
    let requestModel = extractRequestModel(target, suffix)
    let weightedAttempt
    let weightedConnection
    let profileId = this.persisted.routes[target]
    if (weighted && ['POST', 'PUT', 'PATCH'].includes(String(request.method || '').toUpperCase())
      && !request.headers['content-encoding']) {
      try {
        requestBody = await readRequestBody(request, WEIGHTED_MODEL_BODY_LIMIT_BYTES)
      } catch {
        rejectRequest(request, response, 413, 'Weighted routing request body is too large or invalid')
        return
      }
      requestModel = extractRequestModel(target, suffix, requestBody)
    }
    if (weighted) {
      let selection
      try {
        selection = await this._selectWeightedConnection(target, requestModel)
      } catch {
        rejectRequest(request, response, 503, 'Weighted routing is temporarily unavailable')
        return
      }
      if (!selection) {
        rejectRequest(request, response, 503,
          requestModel
            ? `No enabled weighted profile supports model: ${requestModel}`
            : 'No enabled weighted profile is available for this client')
        return
      }
      weightedAttempt = {
        target,
        model: requestModel,
        profileId: selection.profileId,
        autoDisableOnFailure: selection.autoDisableOnFailure,
      }
      weightedConnection = selection.connection
      profileId = selection.profileId
    }
    if (!profileId) {
      rejectRequest(request, response, 404, 'Gateway route not active')
      return
    }

    const transportStartedAtMs = Date.now()
    let monitorId
    try {
      monitorId = this.requestMonitor?.start?.({
        client: target,
        profileId,
        profileName: '正在载入方案',
        upstreamUrl: '',
      })
    } catch {
      monitorId = undefined
    }
    const transportElapsedMs = () => Math.max(0, Date.now() - transportStartedAtMs)
    const recordTransport = (patch) => {
      try { this.requestMonitor?.recordTransport?.(monitorId, patch) } catch {}
    }
    let monitorEnded = false
    let weightedOutcomeRecorded = false
    let clientAborted = false
    const recordWeightedOutcome = (outcome) => {
      if (!weightedAttempt || weightedOutcomeRecorded) return
      weightedOutcomeRecorded = true
      this._recordWeightedOutcome(weightedAttempt, outcome)
    }
    const endMonitor = (outcome, channelFailure) => {
      if (monitorEnded || !monitorId) return
      monitorEnded = true
      try {
        if (outcome || typeof channelFailure === 'boolean') {
          this.requestMonitor?.end?.(monitorId, {
            ...(outcome ? { outcome } : {}),
            ...(typeof channelFailure === 'boolean'
              ? { channelFailure: weighted && channelFailure ? false : channelFailure }
              : {}),
          })
        }
        else this.requestMonitor?.end?.(monitorId)
      } catch {}
    }

    let connection
    try {
      connection = weightedAttempt ? weightedConnection : await this._connection(profileId)
    } catch {
      if (request.aborted || response.destroyed) {
        endMonitor('aborted')
        return
      }
      endMonitor('failed', false)
      rejectRequest(request, response, 502, 'Upstream profile is unavailable')
      return
    }
    if (request.aborted || response.destroyed) {
      endMonitor('aborted')
      return
    }
    let destination
    try {
      destination = upstreamUrl(connection.profile, suffix, incomingUrl.searchParams)
    } catch {
      endMonitor('failed', false)
      rejectRequest(request, response, 502, 'Upstream URL is invalid')
      return
    }
    try {
      this.requestMonitor?.updateMetadata?.(monitorId, {
        profileName: connection.profile.name,
        keyHint: connection.profile.keyHint,
        upstreamUrl: `${destination.origin}${destination.pathname}`,
        protocol: connection.profile.protocol,
        model: requestModel || connection.profile.model || undefined,
      })
    } catch {}
    const normalizedResponsesSuffix = suffix.replace(/\/+$/, '') || '/'
    const responsesSyncCandidate = target === 'codex'
      && connection.profile.protocol === 'openai-responses'
      && request.method === 'POST'
      && normalizedResponsesSuffix === '/responses'
      && !request.headers['content-encoding']
    const codexResponsesTransport = isCodexResponsesRequest(
      target,
      connection.profile,
      suffix,
      request.method,
    )
    const anthropicCountRequest = (target === 'claude' || target === 'claude-desktop')
      && connection.profile.protocol === 'anthropic'
      && request.method === 'POST'
      && /^\/v1\/messages\/count_tokens\/?$/.test(suffix)
      && !request.headers['content-encoding']
    let responsesStreamFallback = false
    let originalRequestBody = requestBody
    let releaseResponsesBodySlot
    let releaseAnthropicCountBodySlot
    let upstreamRequestPromise
    // Responses 上游默认走流式。客户端仍可要求同步；这种情况下网关把 SSE
    // 收拢成 JSON 再返回，避免每个新端点都先用 stream=false 失败一次。
    const needsResponsesFallbackBody = responsesSyncCandidate
    if (anthropicCountRequest) {
      releaseAnthropicCountBodySlot = this._tryAcquireAnthropicCountBody()
      if (!releaseAnthropicCountBodySlot) {
        endMonitor('failed', false)
        rejectRequest(request, response, 503,
          'Anthropic token count compatibility capacity is temporarily full')
        return
      }
    }
    if (needsResponsesFallbackBody) {
      releaseResponsesBodySlot = this._tryAcquireResponsesFallbackBody()
      if (!releaseResponsesBodySlot) {
        releaseAnthropicCountBodySlot?.()
        endMonitor('failed', false)
        rejectRequest(request, response, 503,
          'Responses compatibility capacity is temporarily full')
        return
      }
    }
    if (codexResponsesTransport
      && requestBody === undefined
      && destination.protocol === 'https:'
      && http2Wrapper?.auto) {
      // 先做 TLS/ALPN 协商，与本地读取大 JSON 并行；请求头仍在正文准备好后再提交。
      upstreamRequestPromise = createUpstreamRequest(destination, {
        method: request.method,
        headers: {},
      }, true)
      upstreamRequestPromise.catch(() => {})
    }
    if (requestBody === undefined && (anthropicCountRequest || needsResponsesFallbackBody)) {
      try {
        requestBody = await readRequestBody(
          request,
          anthropicCountRequest
            ? ANTHROPIC_COUNT_BODY_LIMIT_BYTES
            : needsResponsesFallbackBody
              ? RESPONSES_FALLBACK_BODY_LIMIT_BYTES
          : MAX_REQUEST_BODY_BYTES,
        )
        recordTransport({
          clientRequestBytes: requestBody.length,
          clientRequestBodyCompletedAtMs: transportElapsedMs(),
        })
      } catch {
        upstreamRequestPromise?.then((pendingRequest) => {
          pendingRequest.once('error', () => {})
          pendingRequest.destroy()
        }).catch(() => {})
        releaseResponsesBodySlot?.()
        releaseAnthropicCountBodySlot?.()
        endMonitor(request.aborted ? 'aborted' : 'failed', false)
        rejectRequest(request, response, 502,
          anthropicCountRequest
            ? 'Anthropic token count compatibility request failed'
            : 'Responses streaming compatibility request failed')
        return
      }
    }
    if (requestBody !== undefined && (anthropicCountRequest || needsResponsesFallbackBody)) {
      originalRequestBody ||= requestBody
      if (needsResponsesFallbackBody) {
        const prepared = prepareResponsesRequest(requestBody)
        requestBody = prepared.body
        responsesStreamFallback = prepared.streamingForced
      }
    }
    if (request.aborted || response.destroyed) {
      upstreamRequestPromise?.then((pendingRequest) => {
        pendingRequest.once('error', () => {})
        pendingRequest.destroy()
      }).catch(() => {})
      releaseResponsesBodySlot?.()
      releaseAnthropicCountBodySlot?.()
      endMonitor('aborted')
      return
    }
    /*
     * 模型映射：方案配了映射表才在这里读体——分配模式平时是流式透传的。
     * 命中映射就把顶层 model 改写成上游模型；未命中或不可解析时原样转发。
     * 压缩体没法定点改写，直接放行（客户端默认不压缩请求）。
     */
    const modelRoutes = connection.profile.modelRoutes
    if (modelRoutes && typeof modelRoutes === 'object' && Object.keys(modelRoutes).length > 0
      && ['POST', 'PUT', 'PATCH'].includes(String(request.method || '').toUpperCase())
      && !request.headers['content-encoding']) {
      if (requestBody === undefined) {
        try {
          requestBody = await readRequestBody(request, WEIGHTED_MODEL_BODY_LIMIT_BYTES)
          recordTransport({
            clientRequestBytes: requestBody.length,
            clientRequestBodyCompletedAtMs: transportElapsedMs(),
          })
        } catch {
          upstreamRequestPromise?.then((pendingRequest) => {
            pendingRequest.once('error', () => {})
            pendingRequest.destroy()
          }).catch(() => {})
          releaseResponsesBodySlot?.()
          releaseAnthropicCountBodySlot?.()
          endMonitor(request.aborted ? 'aborted' : 'failed', false)
          rejectRequest(request, response, 413,
            'Model-routed request body is too large or invalid')
          return
        }
      }
      const mapped = rewriteRequestModel(requestBody, modelRoutes)
      if (mapped) {
        originalRequestBody ||= requestBody
        requestBody = mapped.body
        try {
          this.requestMonitor?.updateMetadata?.(monitorId, { upstreamModel: mapped.model })
        } catch {}
      }
    }
    const countEstimate = anthropicCountRequest
      ? conservativeAnthropicInputTokens(requestBody)
      : undefined
    const countFallbackKey = anthropicCountRequest
      ? `${profileId}\0${destination.origin}${destination.pathname}`
      : undefined
    const fallbackUntil = countFallbackKey
      ? this.anthropicCountFallbacks.get(countFallbackKey)
      : undefined
    if (countEstimate !== undefined && fallbackUntil && fallbackUntil > Date.now()) {
      const localBody = anthropicCountResponse(countEstimate)
      try {
        this.requestMonitor?.responseStarted?.(monitorId, {
          statusCode: 200,
          contentType: 'application/json',
        })
        this.requestMonitor?.observeChunk?.(monitorId, localBody)
      } catch {}
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(localBody.length),
        'cache-control': 'no-store',
        'x-agentgate-token-count': 'conservative-estimate',
      })
      response.end(localBody)
      releaseAnthropicCountBodySlot?.()
      endMonitor()
      return
    }
    /*
     * 转发期间豁免本地 socket 的空闲回收。
     *
     * SSE 在推理长静默期间上下行都没有一个字节，五分钟空闲计时会把活跃请求
     * 连根掐断——客户端表现为 stream disconnected / transport error，且只在
     * 走网关时出现（直连没有这个计时器）。客户端跑路由 aborted/close 清理
     * 兜底；响应收尾后恢复计时，keep-alive 的闲置回收照旧。
     */
    const localSocket = request.socket
    localSocket?.setTimeout?.(0)
    response.once('close', () => {
      if (localSocket && !localSocket.destroyed) localSocket.setTimeout(LOCAL_IDLE_TIMEOUT_MS)
    })

    const headers = stripHeaders(request.headers, ['host'])
    // Codex Responses 的回包可能很大。向上游协商 gzip，网关随即解压后再转给
    // 本地客户端，既缩短公网 SSE 传输，也保留监控侧的明文事件解析。
    headers['accept-encoding'] = codexResponsesTransport ? 'gzip' : 'identity'
    if (codexResponsesTransport) {
      headers.accept = 'text/event-stream'
      if (headers['cache-control'] === undefined) headers['cache-control'] = 'no-cache'
      if (headers['openai-beta'] === undefined) {
        headers['openai-beta'] = 'responses=experimental'
      }
    }
    if (requestBody !== undefined) {
      headers['content-length'] = String(requestBody.length)
    }
    injectUpstreamCredential(headers, connection.profile, connection.apiKey)
    if (requestBody !== undefined
      && codexResponsesTransport
      && headers['content-encoding'] === undefined) {
      const compressed = compressCodexRequestBodyForUpstream(destination, requestBody)
      requestBody = compressed.body
      if (compressed.contentEncoding) {
        headers['content-encoding'] = compressed.contentEncoding
        headers['content-length'] = String(requestBody.length)
      }
    }
    if (requestBody !== undefined) {
      recordTransport({
        upstreamRequestBytes: requestBody.length,
        upstreamRequestContentEncoding: String(headers['content-encoding'] || 'identity')
          .trim()
          .toLowerCase(),
      })
    }
    let upstreamRequest
    try {
      upstreamRequest = upstreamRequestPromise
        ? await upstreamRequestPromise
        : await createUpstreamRequest(destination, {
            method: request.method,
            headers,
          }, codexResponsesTransport)
      if (upstreamRequestPromise) {
        for (const [name, value] of Object.entries(headers)) {
          upstreamRequest.setHeader(name, value)
        }
      }
    } catch {
      if (request.aborted || response.destroyed) {
        releaseResponsesBodySlot?.()
        releaseAnthropicCountBodySlot?.()
        endMonitor('aborted')
        return
      }
      recordWeightedOutcome('hard-failure')
      releaseResponsesBodySlot?.()
      releaseAnthropicCountBodySlot?.()
      endMonitor('failed', false)
      rejectRequest(request, response, 502, 'Upstream request configuration is invalid')
      return
    }
    if (request.aborted || response.destroyed) {
      upstreamRequest.once('error', () => {})
      if (!upstreamRequest.destroyed) upstreamRequest.destroy()
      releaseResponsesBodySlot?.()
      releaseAnthropicCountBodySlot?.()
      endMonitor('aborted')
      return
    }
    upstreamRequest.once('finish', () => {
      recordTransport({ upstreamRequestFinishedAtMs: transportElapsedMs() })
      if (responsesSyncCandidate) {
        // 中转站通常在收到完整请求体后才开始计时；等待 Node 确认上游请求写完，
        // 让首字口径尽量贴近中转站的上游计时；总耗时仍从客户端请求到达开始记录。
        try { this.requestMonitor?.upstreamRequestStarted?.(monitorId) } catch {}
      }
    })
    let upstreamTimedOut = false
    let fallbackTotalTimer
    const upstreamTimer = setTimeout(() => {
      upstreamTimedOut = true
      upstreamRequest.destroy(new Error('Upstream response headers timed out'))
    }, UPSTREAM_HEADERS_TIMEOUT_MS)
    upstreamTimer.unref?.()
    this.upstreamRequests.add(upstreamRequest)
    let responseReceived = false
    let upstreamFirstByteRecorded = false
    let activeUpstreamResponse
    const abortUpstream = () => {
      if (activeUpstreamResponse && !activeUpstreamResponse.destroyed) {
        activeUpstreamResponse.destroy()
      }
      if (!upstreamRequest.destroyed) upstreamRequest.destroy()
    }
    upstreamRequest.once('close', () => {
      clearTimeout(upstreamTimer)
      clearTimeout(fallbackTotalTimer)
      releaseResponsesBodySlot?.()
      releaseAnthropicCountBodySlot?.()
      this.upstreamRequests.delete(upstreamRequest)
      if (!responseReceived) {
        if (!clientAborted) recordWeightedOutcome('hard-failure')
        endMonitor('failed', true)
      }
    })
    upstreamRequest.on('response', (upstreamResponse) => {
      responseReceived = true
      activeUpstreamResponse = upstreamResponse
      clearTimeout(upstreamTimer)
      try {
        this.requestMonitor?.updateMetadata?.(monitorId, {
          upstreamHttpVersion: upstreamResponse.httpVersion,
        })
      } catch {}
      const contentType = String(upstreamResponse.headers['content-type'] || '')
      const responseIsEventStream = contentType.toLowerCase().includes('text/event-stream')
      const aggregatedResponse = responsesStreamFallback && responseIsEventStream
      const contentEncoding = String(upstreamResponse.headers['content-encoding'] || '')
        .trim()
        .toLowerCase()
      recordTransport({
        upstreamResponseHeadersAtMs: transportElapsedMs(),
        upstreamResponseContentEncoding: contentEncoding || 'identity',
      })
      const responseDecoder = codexResponsesTransport && contentEncoding === 'gzip'
        ? zlib.createGunzip({ flush: zlib.constants.Z_SYNC_FLUSH })
        : undefined
      const unsupportedTransformedEncoding = aggregatedResponse
        && contentEncoding
        && contentEncoding !== 'identity'
        && !responseDecoder
      const responseHeaders = stripHeaders(
        upstreamResponse.headers,
        aggregatedResponse || responseDecoder
          ? AGGREGATED_RESPONSE_INVALIDATED_HEADERS
          : [],
      )
      if (responseIsEventStream && !aggregatedResponse) {
        if (responseHeaders['cache-control'] === undefined) {
          responseHeaders['cache-control'] = 'no-cache'
        }
        responseHeaders['x-accel-buffering'] = 'no'
      }
      const upstreamStatus = upstreamResponse.statusCode || 502
      const updateCountCapability = (useCountFallback) => {
        if (!countFallbackKey) return
        if (useCountFallback) {
          this.anthropicCountFallbacks.set(
            countFallbackKey,
            Date.now() + ANTHROPIC_COUNT_UNSUPPORTED_CACHE_MS,
          )
        } else {
          this.anthropicCountFallbacks.delete(countFallbackKey)
        }
      }
      const startMonitoredResponse = (useCountFallback) => {
        try {
          this.requestMonitor?.responseStarted?.(monitorId, {
            statusCode: useCountFallback ? 200 : upstreamStatus,
            contentType: useCountFallback ? 'application/json' : contentType,
            streaming: responseIsEventStream ? true : undefined,
          })
        } catch {}
      }
      const respondWithCountFallback = () => {
        const localBody = anthropicCountResponse(countEstimate)
        try { this.requestMonitor?.observeChunk?.(monitorId, localBody) } catch {}
        response.writeHead(200, {
          'content-type': 'application/json',
          'content-length': String(localBody.length),
          'cache-control': 'no-store',
          'x-agentgate-token-count': 'conservative-estimate',
        })
        response.end(localBody)
        endMonitor()
      }
      const useCountFallback = countEstimate !== undefined
        && anthropicCountErrorSupportsFallback(upstreamStatus)
      updateCountCapability(useCountFallback)
      if (!useCountFallback) {
        if (upstreamStatus === 429) recordWeightedOutcome('rate-limit')
        else if (upstreamStatus >= 500) recordWeightedOutcome('hard-failure')
        else if (upstreamStatus >= 400) recordWeightedOutcome('model-failure')
      }
      startMonitoredResponse(useCountFallback)
      if (useCountFallback) {
        upstreamResponse.resume()
        respondWithCountFallback()
        return
      }

      let fallbackIdleTimerActive = false
      const clearFallbackTimers = () => {
        if (fallbackIdleTimerActive) {
          if (upstreamResponse.socket) upstreamResponse.setTimeout?.(0)
          fallbackIdleTimerActive = false
        }
        clearTimeout(fallbackTotalTimer)
        fallbackTotalTimer = undefined
      }
      if (aggregatedResponse) {
        fallbackIdleTimerActive = true
        upstreamResponse.setTimeout?.(this.responsesFallbackIdleTimeoutMs, () => {
          if (!fallbackIdleTimerActive) return
          upstreamTimedOut = true
          upstreamResponse.destroy(new Error('Responses compatibility stream idle timeout'))
        })
        fallbackTotalTimer = setTimeout(() => {
          if (!fallbackTotalTimer) return
          upstreamTimedOut = true
          upstreamRequest.destroy(new Error('Responses compatibility stream completion timeout'))
        }, this.responsesFallbackTotalTimeoutMs)
        fallbackTotalTimer.unref?.()
      }

      if (unsupportedTransformedEncoding) {
        clearFallbackTimers()
        endMonitor('failed', true)
        upstreamResponse.resume()
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('Responses compatibility requires an identity-encoded upstream response')
        return
      }

      /*
       * 统计挂在转发之后。
       *
       * 'data' 监听器按注册顺序触发，pipeline 内部也是靠 'data' 把字节写出去的。
       * 原本统计先注册，于是每一片都要先被统计跑完才轮到转发——统计再快也是白白
       * 顶在客户端前面。挪到后面，字节先出门，统计随后。
       */
      upstreamResponse.once('end', () => {
        recordTransport({ upstreamResponseEndedAtMs: transportElapsedMs() })
        clearFallbackTimers()
      })
      upstreamResponse.once('aborted', () => {
        clearFallbackTimers()
        if (!clientAborted) recordWeightedOutcome('hard-failure')
        endMonitor('failed', true)
      })
      upstreamResponse.once('error', () => {
        clearFallbackTimers()
        if (!clientAborted) recordWeightedOutcome('hard-failure')
        endMonitor('failed', true)
      })
      const attachMonitor = (stream) => {
        stream.on('data', (chunk) => {
          if (!upstreamFirstByteRecorded && chunk?.length > 0) {
            upstreamFirstByteRecorded = true
            recordTransport({ upstreamFirstByteAtMs: transportElapsedMs() })
          }
          try {
            this.requestMonitor?.observeChunk?.(monitorId, chunk)
          } catch {}
        })
      }
      if (!aggregatedResponse) {
        const forwardedResponse = responseDecoder || upstreamResponse
        forwardedResponse.once('end', () => {
          recordWeightedOutcome('success')
          endMonitor()
        })
        response.writeHead(
          upstreamResponse.statusCode || 502,
          upstreamResponse.statusMessage,
          responseHeaders,
        )
        if (responseIsEventStream) response.flushHeaders?.()
        const streams = responseDecoder
          ? [upstreamResponse, responseDecoder, response]
          : [upstreamResponse, response]
        pipeline(...streams, (error) => {
          if (error && !response.destroyed) response.destroy(error)
        })
        attachMonitor(forwardedResponse)
        return
      }

      response.statusCode = upstreamResponse.statusCode || 502
      if (upstreamResponse.statusMessage) response.statusMessage = upstreamResponse.statusMessage
      for (const [name, value] of Object.entries(responseHeaders)) {
        if (value !== undefined) response.setHeader(name, value)
      }
      if (aggregatedResponse) {
        response.setHeader('content-type', 'application/json; charset=utf-8')
      }
      const transform = createResponsesSseJsonTransform()
      transform.pipe(response)
      const streams = responseDecoder
        ? [upstreamResponse, responseDecoder, transform]
        : [upstreamResponse, transform]
      pipeline(...streams, (error) => {
        if (!error) {
          clearFallbackTimers()
          recordWeightedOutcome('success')
          endMonitor()
          return
        }
        clearFallbackTimers()
        endMonitor('failed', true)
        if (!response.headersSent) {
          for (const name of response.getHeaderNames()) response.removeHeader(name)
          response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
          response.end('Responses streaming compatibility conversion failed')
        } else if (!response.destroyed) {
          response.destroy(error)
        }
      })
      // 同步客户端的 Responses 请求在上游已经是 SSE；监控原始流，才能记录
      // 监听原始流以记录首个有效生成事件，而不是等收拢后的完整 JSON 才误报首 token。
      attachMonitor(responseDecoder || upstreamResponse)
    })
    upstreamRequest.on('error', () => {
      if (!clientAborted) recordWeightedOutcome('hard-failure')
      releaseResponsesBodySlot?.()
      releaseAnthropicCountBodySlot?.()
      endMonitor('failed', true)
      if (!response.headersSent) {
        response.writeHead(upstreamTimedOut ? 504 : 502, {
          'content-type': 'text/plain; charset=utf-8',
        })
        response.end(upstreamTimedOut
          ? 'Upstream response timed out'
          : 'Could not reach upstream endpoint')
      } else {
        response.destroy()
      }
    })
    request.on('aborted', () => {
      clientAborted = true
      endMonitor('aborted')
      abortUpstream()
    })
    response.on('close', () => {
      if (!response.writableEnded) {
        clientAborted = true
        endMonitor('aborted', false)
        abortUpstream()
      }
    })
    if (requestBody !== undefined) {
      try {
        this.requestMonitor?.updateMetadata?.(
          monitorId,
          extractRequestMetadata(JSON.parse((originalRequestBody || requestBody).toString('utf8'))),
        )
      } catch {}
      upstreamRequest.end(requestBody, () => {
        releaseResponsesBodySlot?.()
        releaseAnthropicCountBodySlot?.()
      })
    } else {
      const requestContentType = String(request.headers['content-type'] || '').toLowerCase()
      const requestEncoding = String(request.headers['content-encoding'] || '').toLowerCase()
      const metadataTap = requestContentType.includes('json') && !requestEncoding
        ? createRequestMetadataTap((patch) => {
            try { this.requestMonitor?.updateMetadata?.(monitorId, patch) } catch {}
          })
        : undefined
      const streams = metadataTap
        ? [request, metadataTap, upstreamRequest]
        : [request, upstreamRequest]
      pipeline(...streams, (error) => {
        if (error && !upstreamRequest.destroyed) upstreamRequest.destroy(error)
      })
    }
  }
}

module.exports = {
  ANTHROPIC_COUNT_BODY_LIMIT_BYTES,
  ANTHROPIC_COUNT_BODY_SLOTS,
  CODEX_GZIP_MIN_BYTES,
  DEFAULT_GATEWAY_HOST,
  DEFAULT_GATEWAY_PORT,
  GatewayStoreSchema,
  compressCodexRequestBodyForUpstream,
  defaultGatewayStore,
  GatewayService,
  conservativeAnthropicInputTokens,
  createRequestMetadataTap,
  localBaseUrl,
}
