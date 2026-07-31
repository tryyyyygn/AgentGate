const {
  AUTH_MODE,
  PROTOCOL,
  ProfileConnectionSchema,
  normalizeHttpUrl,
  validationMessage,
} = require('./schemas.cjs')
const { extractTokenUsage } = require('./request-monitor-service.cjs')

const HEALTH_TIMEOUT_MS = 8_000
const PROBE_TIMEOUT_MS = 60_000
const ANTHROPIC_VERSION = '2023-06-01'
const MAX_MODEL_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_DISCOVERED_MODELS = 1_000
const MAX_PROBE_ERROR_LENGTH = 160

/**
 * 根据协议和指定端点生成只读模型列表地址。
 *
 * @param {object} profile 已校验方案。
 * @param {string} baseUrl 当前待探测的 URL。
 * @returns {URL} 不包含片段的模型列表 URL。
 */
function healthUrl(profile, baseUrl = profile.baseUrl) {
  const url = new URL(baseUrl)
  const path = url.pathname.replace(/\/+$/, '')
  if (!path.endsWith('/models')) {
    if (profile.protocol === PROTOCOL.GEMINI) {
      url.pathname = path.endsWith('/v1beta') ? `${path}/models` : `${path}/v1beta/models`
    } else if (profile.protocol === PROTOCOL.ANTHROPIC) {
      url.pathname = path.endsWith('/v1') ? `${path}/models` : `${path}/v1/models`
    } else {
      url.pathname = `${path}/models`
    }
  }
  url.hash = ''
  return url
}

function healthHeaders(profile, apiKey) {
  const headers = { accept: 'application/json' }
  if (profile.protocol === PROTOCOL.ANTHROPIC) {
    headers['anthropic-version'] = ANTHROPIC_VERSION
    if (profile.authMode === AUTH_MODE.API_KEY) headers['x-api-key'] = apiKey
    else headers.authorization = `Bearer ${apiKey}`
  } else if (profile.protocol === PROTOCOL.GEMINI) {
    headers['x-goog-api-key'] = apiKey
  } else {
    headers.authorization = `Bearer ${apiKey}`
  }
  return headers
}

/**
 * 返回后台健康探测地址。它严格保留用户配置的 URL，不追加 `/models`，也不携带
 * 查询片段之外的任何派生路径。
 */
function endpointHealthUrl(endpoint) {
  const url = new URL(endpoint.url)
  url.hash = ''
  return url
}

function networkErrorType(error, timedOut) {
  if (timedOut || error?.name === 'AbortError') return 'timeout'
  const code = String(error?.cause?.code || error?.code || '').toUpperCase()
  if (code.includes('CERT') || code.includes('TLS') || code.includes('SSL')) return 'tls'
  return 'network'
}

/**
 * 无凭据探测 URL 的网络可达性和响应延迟。
 *
 * 2xx-4xx 说明目标主机与 HTTP 服务可达；429 单独标记为受限。探测使用 HEAD，
 * 不发送方案 Key、不读取响应正文，也不会访问模型列表。
 */
async function probeEndpointHealth(_profile, endpoint, fetchImpl, externalSignal) {
  const controller = new AbortController()
  const abortFromExternal = () => controller.abort()
  if (externalSignal?.aborted) controller.abort()
  else externalSignal?.addEventListener('abort', abortFromExternal, { once: true })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, HEALTH_TIMEOUT_MS)
  timeout.unref?.()
  const startedAt = Date.now()

  try {
    const response = await fetchImpl(endpointHealthUrl(endpoint), {
      method: 'HEAD',
      redirect: 'manual',
      signal: controller.signal,
    })
    const latencyMs = Date.now() - startedAt
    if (response.body) await response.body.cancel().catch(() => {})
    const reachable = response.status >= 200 && response.status < 500
    const limited = response.status === 429
    return {
      url: endpoint.url,
      health: {
        status: reachable ? (limited ? 'limited' : 'healthy') : 'unhealthy',
        reachable,
        latencyMs,
        checkedAt: new Date().toISOString(),
        statusCode: response.status,
        message: limited
          ? 'Endpoint is reachable but rate limited (HTTP 429)'
          : reachable
            ? `Endpoint is reachable (HTTP ${response.status})`
            : `Endpoint returned HTTP ${response.status}`,
      },
    }
  } catch (error) {
    const errorType = networkErrorType(error, timedOut)
    return {
      url: endpoint.url,
      health: {
        status: 'unhealthy',
        reachable: false,
        latencyMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString(),
        errorType,
        message: errorType === 'timeout'
          ? 'Connection timed out'
          : errorType === 'tls'
            ? 'TLS connection failed'
            : 'Could not reach the endpoint',
      },
    }
  } finally {
    clearTimeout(timeout)
    externalSignal?.removeEventListener('abort', abortFromExternal)
  }
}

/**
 * 在固定字节上限内读取 JSON 响应。
 *
 * @param {Response} response Fetch 响应。
 * @returns {Promise<unknown>} 解析后的 JSON。
 * @throws 响应过大、编码无效或 JSON 格式错误时抛出错误。
 */
async function readLimitedJson(response) {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MODEL_RESPONSE_BYTES) {
    if (response.body) await response.body.cancel().catch(() => {})
    throw new Error('Model list response is too large')
  }
  if (!response.body) return undefined

  const reader = response.body.getReader()
  const chunks = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > MAX_MODEL_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {})
        throw new Error('Model list response is too large')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }

  const source = new TextDecoder('utf-8', { fatal: true })
    .decode(Buffer.concat(chunks, totalBytes))
  return JSON.parse(source)
}

function modelId(protocol, item) {
  if (typeof item === 'string') return item
  if (!item || typeof item !== 'object') return undefined
  const value = typeof item.id === 'string' ? item.id : item.name
  if (typeof value !== 'string') return undefined
  return protocol === PROTOCOL.GEMINI ? value.replace(/^models\//, '') : value
}

/**
 * 解析 OpenAI、Anthropic 和 Gemini 模型列表结构。
 *
 * @param {string} protocol 方案协议。
 * @param {unknown} payload 已解析的模型列表响应。
 * @returns {string[]} 去重、限长并保持服务端顺序的模型 ID。
 */
function parseModelIds(protocol, payload) {
  if (!payload || typeof payload !== 'object') return []
  const source = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.models) ? payload.models : []
  const models = []
  const seen = new Set()

  for (const item of source) {
    const id = modelId(protocol, item)?.trim()
    if (!id || id.length > 240 || seen.has(id)) continue
    seen.add(id)
    models.push(id)
    if (models.length >= MAX_DISCOVERED_MODELS) break
  }
  return models
}

/**
 * 确认健康检测仍允许提交持久化结果。
 *
 * @param {AbortSignal | undefined} signal 外部停止信号。
 * @throws 信号已中止时抛出 AbortError。
 */
function assertEndpointTestActive(signal) {
  if (!signal?.aborted) return

  const error = new Error('Endpoint test was stopped')
  error.name = 'AbortError'
  throw error
}

/**
 * 使用同一方案 Key 探测一个 URL，并识别其可用模型。
 *
 * @param {object} profile 发起检测时的内部方案快照。
 * @param {string} apiKey 仅在主进程内使用的明文 Key。
 * @param {object} endpoint 待检测端点。
 * @param {typeof fetch} fetchImpl 可替换的 Fetch 实现。
 * @returns {Promise<object>} URL、健康状态和模型 ID 列表。
 */
async function probeEndpoint(profile, apiKey, endpoint, fetchImpl, externalSignal) {
  const controller = new AbortController()
  const abortFromExternal = () => controller.abort()
  if (externalSignal?.aborted) controller.abort()
  else externalSignal?.addEventListener('abort', abortFromExternal, { once: true })
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
  const startedAt = Date.now()

  try {
    const response = await fetchImpl(healthUrl(profile, endpoint.url), {
      method: 'GET',
      headers: healthHeaders(profile, apiKey),
      redirect: 'manual',
      signal: controller.signal,
    })
    if (!response.ok) {
      const latencyMs = Date.now() - startedAt
      if (response.body) await response.body.cancel().catch(() => {})
      return {
        url: endpoint.url,
        models: [],
        health: {
          status: 'unhealthy',
          latencyMs,
          checkedAt: new Date().toISOString(),
          statusCode: response.status,
          message: `Endpoint returned HTTP ${response.status}`,
        },
      }
    }

    try {
      const models = parseModelIds(profile.protocol, await readLimitedJson(response))
      const latencyMs = Date.now() - startedAt
      const verified = models.length > 0
      return {
        url: endpoint.url,
        models,
        health: {
          status: verified ? 'healthy' : 'unhealthy',
          latencyMs,
          checkedAt: new Date().toISOString(),
          statusCode: response.status,
          message: verified
            ? 'Connection, credentials, and model list accepted'
            : 'Endpoint returned no recognized model IDs',
        },
      }
    } catch {
      return {
        url: endpoint.url,
        models: [],
        health: {
          status: 'unhealthy',
          latencyMs: Date.now() - startedAt,
          checkedAt: new Date().toISOString(),
          statusCode: response.status,
          message: 'Endpoint model list could not be verified',
        },
      }
    }
  } catch (error) {
    return {
      url: endpoint.url,
      models: [],
      health: {
        status: 'unhealthy',
        latencyMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString(),
        message: error.name === 'AbortError' ? 'Connection timed out' : 'Could not reach the endpoint',
      },
    }
  } finally {
    clearTimeout(timeout)
    externalSignal?.removeEventListener('abort', abortFromExternal)
  }
}

/**
 * 按方案协议生成最小实测消息的目标 URL。
 *
 * 与各客户端的实际拼接方式一致：Anthropic 追加 /v1/messages，Responses 追加
 * /responses，Chat 追加 /chat/completions，Gemini 追加 /v1beta/models/{model}:generateContent。
 *
 * @param {object} profile 已校验方案。
 * @param {string} model 实测使用的模型 ID。
 * @returns {URL} 完整消息端点。
 */
function probeMessageUrl(profile, model) {
  const url = new URL(profile.baseUrl)
  const path = url.pathname.replace(/\/+$/, '')
  if (profile.protocol === PROTOCOL.ANTHROPIC) {
    url.pathname = path.endsWith('/v1') ? `${path}/messages` : `${path}/v1/messages`
  } else if (profile.protocol === PROTOCOL.OPENAI_RESPONSES) {
    url.pathname = `${path}/responses`
  } else if (profile.protocol === PROTOCOL.OPENAI_CHAT) {
    url.pathname = `${path}/chat/completions`
  } else {
    url.pathname = path.endsWith('/v1beta')
      ? `${path}/models/${model}:generateContent`
      : `${path}/v1beta/models/${model}:generateContent`
  }
  url.hash = ''
  return url
}

function probeMessageBody(profile, model) {
  if (profile.protocol === PROTOCOL.ANTHROPIC) {
    return { model, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }
  }
  if (profile.protocol === PROTOCOL.OPENAI_RESPONSES) {
    return {
      model,
      input: 'hi',
      instructions: 'Reply with OK.',
      max_output_tokens: 16,
      stream: false,
    }
  }
  if (profile.protocol === PROTOCOL.OPENAI_CHAT) {
    return { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16, stream: false }
  }
  return {
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    generationConfig: { maxOutputTokens: 16 },
  }
}

/**
 * 从上游错误响应中提取一段可展示原因，不回显任何凭据。
 */
function probeErrorMessage(payload) {
  const message = payload?.error?.message
    || payload?.error?.error?.message
    || payload?.message
  if (typeof message !== 'string' || !message.trim()) return undefined
  const compact = message.replace(/\s+/g, ' ').trim()
  return compact.length > MAX_PROBE_ERROR_LENGTH
    ? `${compact.slice(0, MAX_PROBE_ERROR_LENGTH)}…`
    : compact
}

function normalizeProbeModel(value) {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('检测模型 ID 无效')
  const model = value.trim()
  if (!model || model.length > 240) throw new Error('检测模型 ID 无效')
  return model
}

/**
 * 直接探测供应商端点，不经过本地代理。
 */
class HealthService {
  constructor(profileService, fetchImpl = globalThis.fetch) {
    this.profileService = profileService
    this.fetch = fetchImpl
  }

  /**
   * 并发请求方案中的全部模型列表，保存每个 URL 的延迟和可用模型。
   *
   * 检测提交携带发起时的 connection revision；若期间用户更换 URL、协议或 Key，
   * 结果会被拒绝，避免旧网络响应覆盖新配置。
   *
   * @param {string} id 方案 UUID。
   * @param {{signal?: AbortSignal}} options 可选的外部取消信号。
   * @returns {Promise<{profile: object, connectionRevision: number}>} 公开方案和决策 revision。
   * @throws 方案、密钥不可用、检测被停止或期间连接发生变化时抛出错误。
   */
  async testWithSnapshot(id, options = {}) {
    const { profile, apiKey } = await this.profileService.getConnection(id)
    const results = await Promise.all(profile.endpoints.map((endpoint) => (
      probeEndpoint(profile, apiKey, endpoint, this.fetch, options.signal)
    )))
    assertEndpointTestActive(options.signal)
    const committed = await this.profileService.commitEndpointResults(
      id,
      results,
      profile.connectionRevision,
      { signal: options.signal },
    )
    return committed
  }

  /**
   * 并发检测全部 URL 并仅返回公开方案。
   *
   * @param {string} id 方案 UUID。
   * @param {{signal?: AbortSignal}} options 可选的外部取消信号。
   * @returns {Promise<object>} 已保存最新检测结果的公开方案。
   */
  async test(id, options = {}) {
    const committed = await this.testWithSnapshot(id, options)
    return committed.profile
  }

  /** 使用编辑器当前草稿识别模型，不保存草稿或检测结果。 */
  async discoverDraftModels(rawInput, options = {}) {
    const parsed = ProfileConnectionSchema.safeParse(rawInput)
    if (!parsed.success) throw new Error(validationMessage(parsed.error))
    const input = parsed.data
    const suppliedKey = input.apiKey?.trim()
    const apiKey = suppliedKey || (input.id
      ? await this.profileService.getSecret(input.id)
      : '')
    if (!apiKey) throw new Error('API key is required for model discovery')

    const activeUrl = normalizeHttpUrl(input.baseUrl)
    const endpoints = [...(input.endpoints || [{ url: activeUrl }])]
    if (!endpoints.some((endpoint) => normalizeHttpUrl(endpoint.url) === activeUrl)) {
      endpoints.unshift({ url: activeUrl })
    }
    const profile = { ...input, baseUrl: activeUrl, endpoints }
    const results = await Promise.all(endpoints.map((endpoint) => (
      probeEndpoint(profile, apiKey, endpoint, this.fetch, options.signal)
    )))
    assertEndpointTestActive(options.signal)
    return results.find((result) => normalizeHttpUrl(result.url) === activeUrl)?.models || []
  }

  /**
   * 后台并发探测全部 URL，不解密或发送方案 Key，也不更新模型列表。
   */
  async testHealthWithSnapshot(id, options = {}) {
    const profile = await this.profileService.getStored(id)
    const results = await Promise.all(profile.endpoints.map((endpoint) => (
      probeEndpointHealth(profile, endpoint, this.fetch, options.signal)
    )))
    assertEndpointTestActive(options.signal)
    return this.profileService.commitEndpointHealthResults(
      id,
      results,
      profile.connectionRevision,
      { signal: options.signal },
    )
  }

  async testHealth(id, options = {}) {
    const committed = await this.testHealthWithSnapshot(id, options)
    return committed.profile
  }

  /**
   * 向方案的活动 URL 发送一条最小消息，实测渠道可用性与真实时延。
   *
   * 使用方案的真实 Key 与协议格式请求 "hi"，测量首包（响应头到达）和总耗时
   * （正文读取完成）。结果只返回状态与时延摘要，不包含模型输出内容。
   *
   * @param {string} id 方案 UUID。
   * @param {string | undefined} modelOverride 仅用于本次实测的模型 ID，不修改方案。
   * @param {{signal?: AbortSignal}} options 可选的外部中止信号。
   * @returns {Promise<object>} { ok, statusCode?, firstByteMs, totalMs, model, message? }。
   * @throws 方案不存在、Key 不可解密或未设置模型时抛出错误。
   */
  async probeProfile(id, modelOverride, options = {}) {
    const { profile, apiKey } = await this.profileService.getConnection(id)
    const activeEndpoint = profile.endpoints.find((endpoint) => (
      endpoint.url.replace(/\/+$/, '') === profile.baseUrl.replace(/\/+$/, '')
    )) || profile.endpoints[0]
    const model = normalizeProbeModel(modelOverride)
      || (profile.model || '').trim()
      || activeEndpoint?.models?.[0]
      || ''
    if (!model) throw new Error('请先设置模型 ID 或识别模型后再实测')

    const controller = new AbortController()
    const abortFromExternal = () => controller.abort()
    if (options.signal?.aborted) controller.abort()
    else options.signal?.addEventListener('abort', abortFromExternal, { once: true })
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    timeout.unref?.()
    const startedAt = Date.now()

    try {
      const response = await this.fetch(probeMessageUrl(profile, model), {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          ...healthHeaders(profile, apiKey),
          'content-type': 'application/json',
        },
        body: JSON.stringify(probeMessageBody(profile, model)),
      })
      const firstByteMs = Date.now() - startedAt
      let payload
      try {
        payload = await readLimitedJson(response)
      } catch {
        payload = undefined
      }
      const totalMs = Date.now() - startedAt
      const ok = response.status >= 200 && response.status < 300
      const tokenUsage = extractTokenUsage(payload)
      return {
        ok,
        statusCode: response.status,
        firstByteMs,
        totalMs,
        model,
        checkedAt: new Date().toISOString(),
        ...(tokenUsage ? { tokenUsage } : {}),
        ...(ok ? {} : { message: probeErrorMessage(payload) || `HTTP ${response.status}` }),
      }
    } catch (error) {
      const totalMs = Date.now() - startedAt
      const errorType = networkErrorType(error, controller.signal.aborted)
      return {
        ok: false,
        firstByteMs: totalMs,
        totalMs,
        model,
        checkedAt: new Date().toISOString(),
        message: errorType === 'timeout'
          ? '连接超时'
          : errorType === 'tls'
            ? 'TLS 连接失败'
            : '无法连接到端点',
      }
    } finally {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abortFromExternal)
    }
  }
}

module.exports = {
  HEALTH_TIMEOUT_MS,
  MAX_MODEL_RESPONSE_BYTES,
  PROBE_TIMEOUT_MS,
  HealthService,
  endpointHealthUrl,
  healthUrl,
  parseModelIds,
  probeEndpoint,
  probeEndpointHealth,
  probeMessageBody,
  probeMessageUrl,
}
