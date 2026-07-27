const crypto = require('node:crypto')
const { z } = require('zod')
const {
  HttpUrlSchema,
  normalizeHttpUrl,
  validationMessage,
} = require('./schemas.cjs')
const { SerialExecutor } = require('./storage.cjs')

const WALLET_TEMPLATES = Object.freeze(['sub2api', 'new-api', 'one-api'])
const WalletTemplateSchema = z.enum(WALLET_TEMPLATES)
const WalletIdSchema = z.string().uuid()
const MAX_RESPONSE_BYTES = 1024 * 1024
const REQUEST_TIMEOUT_MS = 15_000
const STATUS_CACHE_MS = 10 * 60_000
const SUB2API_REFRESH_BUFFER_MS = 2 * 60_000
const SUB2API_DAY_MS = 24 * 60 * 60_000
const SUB2API_IMPORT_PROBE_BATCH_SIZE = 3
const MAX_SUB2API_IMPORT_KEYS = 500
const WalletImportGroupModeSchema = z.enum(['existing', 'new']).optional()
const LOOPBACK_WALLET_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

const Sub2ApiSessionSchema = z.object({
  accessToken: z.string().trim().min(1).max(16_384),
  refreshToken: z.string().trim().min(1).max(16_384).optional(),
  tokenExpiresAt: z.number().int().positive().optional(),
  userId: z.string().trim().min(1).max(120).optional(),
  username: z.string().trim().min(1).max(120).optional(),
  userAgent: z.string().trim().min(1).max(1024).regex(/^[^\r\n]+$/).optional(),
})

const WalletSubscriptionSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().trim().min(1).max(120),
  dailyUsedUsd: z.number().finite().nonnegative(),
  dailyLimitUsd: z.number().finite().positive().optional(),
  expiresAt: z.string().datetime().optional(),
  resetsAt: z.string().datetime().optional(),
})

const WalletBalanceSchema = z.object({
  status: z.enum(['ok', 'low', 'empty', 'unlimited', 'error']),
  scope: z.enum(['key', 'account', 'site']).optional(),
  remainingUsd: z.number().finite().nonnegative().optional(),
  totalUsd: z.number().finite().nonnegative().optional(),
  usedUsd: z.number().finite().nonnegative().optional(),
  plan: z.string().max(120).optional(),
  expiresAt: z.string().datetime().optional(),
  subscriptions: z.array(WalletSubscriptionSchema).max(100).optional(),
  checkedAt: z.string().datetime(),
  message: z.string().max(500).optional(),
})

const StoredWalletSchema = z.object({
  id: WalletIdSchema,
  name: z.string().trim().min(1).max(80),
  siteUrl: HttpUrlSchema,
  template: WalletTemplateSchema,
  keyHint: z.string().min(1).max(32).optional(),
  encryptedKey: z.string().min(1).optional(),
  encryptedSession: z.string().min(1).optional(),
  accountLabel: z.string().trim().min(1).max(120).optional(),
  sessionExpired: z.boolean().optional(),
  lowBalanceUsd: z.number().finite().min(0).max(1_000_000_000),
  connectionRevision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  balance: WalletBalanceSchema.optional(),
})

const WalletStoreSchema = z.object({
  version: z.literal(1),
  wallets: z.array(StoredWalletSchema).max(100),
})

const SaveWalletSchema = z.object({
  id: WalletIdSchema.optional(),
  name: z.string().trim().min(1, 'Wallet name is required').max(80),
  siteUrl: HttpUrlSchema,
  template: WalletTemplateSchema,
  apiKey: z.string().max(8192).optional(),
  lowBalanceUsd: z.number().finite().min(0).max(1_000_000_000),
})

function walletId(value) {
  const parsed = WalletIdSchema.safeParse(value)
  if (!parsed.success) throw new Error(validationMessage(parsed.error))
  return parsed.data
}

function assertSecureWalletUrl(value) {
  const url = new URL(value)
  const loopbackHttp = url.protocol === 'http:'
    && LOOPBACK_WALLET_HOSTS.has(url.hostname.toLowerCase())
  if (url.protocol !== 'https:' && !loopbackHttp) {
    throw new Error('Wallet site URL must use HTTPS; HTTP is allowed only for localhost')
  }
  return url
}

function normalizeSiteUrl(value) {
  const source = new URL(value.trim())
  if (source.username || source.password || source.hash) {
    throw new Error('Wallet site URL cannot contain credentials or fragments')
  }
  assertSecureWalletUrl(source)
  const normalized = normalizeHttpUrl(value)
  const url = new URL(normalized)
  if (url.search) throw new Error('Wallet site URL cannot contain a query string')

  const path = url.pathname.replace(/\/+$/, '')
  const lowerPath = path.toLowerCase()
  if (lowerPath.endsWith('/api/v1')) url.pathname = path.slice(0, -7) || '/'
  else if (lowerPath.endsWith('/v1')) url.pathname = path.slice(0, -3) || '/'
  return normalizeHttpUrl(url.toString())
}

function endpointUrl(siteUrl, endpointPath) {
  const url = new URL(siteUrl)
  const prefix = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
  url.pathname = `${prefix}${endpointPath}`
  url.search = ''
  return url.toString()
}

function toPublicWallet(wallet) {
  const {
    encryptedKey,
    encryptedSession,
    connectionRevision,
    keyHint,
    accountLabel,
    sessionExpired,
    ...publicWallet
  } = wallet
  const usesSession = wallet.template === 'sub2api'
  return {
    ...publicWallet,
    credentialKind: usesSession ? 'session' : 'api-key',
    credentialStatus: usesSession
      ? (!encryptedSession ? 'missing' : sessionExpired ? 'expired' : 'ready')
      : encryptedKey ? 'ready' : 'missing',
    ...((usesSession ? accountLabel : keyHint)
      ? { credentialHint: usesSession ? accountLabel : keyHint }
      : {}),
  }
}

function finiteNumber(value, label) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) throw new Error(`${label} is missing or invalid`)
  return number
}

function optionalNonNegative(value) {
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

function epochSecondsToIso(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  return new Date(seconds * 1000).toISOString()
}

function responseMessage(body) {
  if (!body || typeof body !== 'object') return undefined
  const message = body.message
    ?? body.error?.message
    ?? (typeof body.error === 'string' ? body.error : undefined)
  return typeof message === 'string' && message.trim()
    ? message.trim().slice(0, 240)
    : undefined
}

function balanceStatus(remainingUsd, lowBalanceUsd) {
  if (remainingUsd <= 0) return 'empty'
  if (lowBalanceUsd > 0 && remainingUsd <= lowBalanceUsd) return 'low'
  return 'ok'
}

function finalizeBalance(result, lowBalanceUsd) {
  if (result.status === 'unlimited') return result
  const remainingUsd = finiteNumber(result.remainingUsd, 'Remaining balance')
  if (remainingUsd < 0) throw new Error('Remaining balance cannot be negative')
  return {
    ...result,
    remainingUsd,
    status: balanceStatus(remainingUsd, lowBalanceUsd),
  }
}

function sub2ApiAccountData(body) {
  if (body && typeof body === 'object' && 'code' in body && Number(body.code) !== 0) {
    throw new Error(responseMessage(body) || 'Sub2API account query failed')
  }
  const data = body?.data && typeof body.data === 'object' ? body.data : body
  const userId = data?.id === undefined || data?.id === null
    ? undefined
    : String(data.id).trim().slice(0, 120) || undefined
  const username = typeof data?.username === 'string' && data.username.trim()
    ? data.username.trim().slice(0, 120)
    : typeof data?.email === 'string' && data.email.trim()
      ? data.email.trim().slice(0, 120)
      : undefined
  return { data, userId, username }
}

function parseSub2API(body, checkedAt) {
  const { data, username } = sub2ApiAccountData(body)
  const remaining = finiteNumber(data?.balance, 'Sub2API account balance')
  if (remaining < 0) throw new Error('Sub2API returned a negative balance')

  return {
    status: 'ok',
    scope: 'account',
    remainingUsd: remaining,
    ...(username ? { plan: username } : {}),
    checkedAt,
  }
}

function parseSub2ApiSubscriptions(body) {
  if (body && typeof body === 'object' && 'code' in body && Number(body.code) !== 0) {
    throw new Error(responseMessage(body) || 'Sub2API subscription query failed')
  }
  const data = body?.data && typeof body.data === 'object' ? body.data : body
  const rows = Array.isArray(data)
    ? data
    : Array.isArray(data?.subscriptions) ? data.subscriptions : []
  const subscriptions = []

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const id = Number(row.id)
    const group = row.group && typeof row.group === 'object' ? row.group : undefined
    const dailyUsedUsd = optionalNonNegative(row.daily_usage_usd ?? row.daily_used_usd)
    if (!Number.isInteger(id) || id <= 0 || dailyUsedUsd === undefined) continue

    const rawName = typeof group?.name === 'string'
      ? group.name.trim()
      : typeof row.group_name === 'string' ? row.group_name.trim() : ''
    const dailyLimitUsd = optionalNonNegative(group?.daily_limit_usd ?? row.daily_limit_usd)
    const expiresAtMs = typeof row.expires_at === 'string' ? Date.parse(row.expires_at) : Number.NaN
    const windowStartMs = typeof row.daily_window_start === 'string'
      ? Date.parse(row.daily_window_start)
      : Number.NaN
    const regularResetMs = windowStartMs + SUB2API_DAY_MS
    const resetsAtMs = Number.isFinite(windowStartMs) && dailyLimitUsd !== undefined && dailyLimitUsd > 0
      ? Number.isFinite(expiresAtMs) && expiresAtMs > windowStartMs && expiresAtMs < regularResetMs
        ? expiresAtMs
        : regularResetMs
      : Number.NaN
    const parsed = WalletSubscriptionSchema.safeParse({
      id,
      name: rawName || `#${id}`,
      dailyUsedUsd,
      ...(dailyLimitUsd !== undefined && dailyLimitUsd > 0 ? { dailyLimitUsd } : {}),
      ...(Number.isFinite(expiresAtMs) ? { expiresAt: new Date(expiresAtMs).toISOString() } : {}),
      ...(Number.isFinite(resetsAtMs) ? { resetsAt: new Date(resetsAtMs).toISOString() } : {}),
    })
    if (parsed.success) subscriptions.push(parsed.data)
    if (subscriptions.length >= 100) break
  }

  return subscriptions
}

function sub2ApiKeyRows(body) {
  if (body && typeof body === 'object' && 'code' in body && Number(body.code) !== 0) {
    throw new Error(responseMessage(body) || 'Sub2API key query failed')
  }
  const data = body?.data && typeof body.data === 'object' ? body.data : body
  return Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : []
}

function assertSub2ApiKeyImportLimit(body) {
  const data = body?.data && typeof body.data === 'object' ? body.data : body
  const rows = sub2ApiKeyRows(body)
  const total = Number(data?.total)
  const pages = Number(data?.pages)
  if (rows.length > MAX_SUB2API_IMPORT_KEYS
    || (Number.isFinite(total) && total > MAX_SUB2API_IMPORT_KEYS)
    || (Number.isFinite(pages) && pages > 1)) {
    throw new Error(`Sub2API wallets can import at most ${MAX_SUB2API_IMPORT_KEYS} keys`)
  }
}

function sub2ApiProfileConnection(siteUrl, platform) {
  if (platform === 'anthropic') {
    return {
      protocol: 'anthropic',
      baseUrl: siteUrl,
      authMode: 'bearer',
      targets: ['claude'],
    }
  }
  return platform === 'openai'
    ? {
        protocol: 'openai-responses',
        baseUrl: siteUrl,
        authMode: 'bearer',
        targets: ['codex'],
      }
    : undefined
}

function sub2ApiImportProfiles(body, wallet) {
  const profiles = []
  let skipped = 0
  for (const row of sub2ApiKeyRows(body)) {
    const key = typeof row?.key === 'string' ? row.key.trim() : ''
    if (row?.status !== 'active' || !key || key.length > 32768) {
      skipped += 1
      continue
    }
    const rawName = typeof row.name === 'string' ? row.name.trim() : ''
    const platform = typeof row.group?.platform === 'string'
      ? row.group.platform.trim().toLowerCase()
      : undefined
    const connection = sub2ApiProfileConnection(wallet.siteUrl, platform)
    if (!connection) {
      skipped += 1
      continue
    }
    profiles.push({
      name: (rawName || `Sub2API #${row.id ?? profiles.length + 1}`).slice(0, 80),
      ...connection,
      apiKey: key,
      model: '',
    })
  }
  return { profiles, skipped }
}

function walletLoginRequiredError() {
  const error = new Error('Sub2API login has expired; sign in again')
  error.code = 'WALLET_LOGIN_REQUIRED'
  return error
}

function isHttpAuthError(error) {
  return error?.statusCode === 401 || error?.statusCode === 403
}

function unwrapStatus(body) {
  return body?.data && typeof body.data === 'object' ? body.data : body
}

function quotaPerUnit(body) {
  const value = finiteNumber(unwrapStatus(body)?.quota_per_unit, 'quota_per_unit')
  if (value <= 0) throw new Error('quota_per_unit must be greater than zero')
  return value
}

function parseNewAPI(usageBody, statusBody, checkedAt) {
  const data = usageBody?.data
  if (!data || typeof data !== 'object') throw new Error('New API usage response is invalid')
  if (data.unlimited_quota === true) {
    return {
      status: 'unlimited',
      scope: 'key',
      checkedAt,
      ...(epochSecondsToIso(data.expires_at) ? { expiresAt: epochSecondsToIso(data.expires_at) } : {}),
    }
  }

  const unit = quotaPerUnit(statusBody)
  const remaining = finiteNumber(data.total_available, 'New API remaining quota') / unit
  const total = optionalNonNegative(data.total_granted)
  const used = optionalNonNegative(data.total_used)
  return {
    status: 'ok',
    scope: 'key',
    remainingUsd: remaining,
    ...(total !== undefined ? { totalUsd: total / unit } : {}),
    ...(used !== undefined ? { usedUsd: used / unit } : {}),
    ...(epochSecondsToIso(data.expires_at) ? { expiresAt: epochSecondsToIso(data.expires_at) } : {}),
    checkedAt,
  }
}

function parseOneAPI(subscriptionBody, usageBody, statusBody, checkedAt) {
  if (subscriptionBody?.error) {
    throw new Error(responseMessage(subscriptionBody) || 'One API subscription query failed')
  }
  if (usageBody?.error) throw new Error(responseMessage(usageBody) || 'One API usage query failed')

  const hardLimit = finiteNumber(subscriptionBody?.hard_limit_usd, 'One API hard limit')
  const usedValue = finiteNumber(usageBody?.total_usage, 'One API total usage') / 100
  if (hardLimit === 100_000_000) {
    return {
      status: 'unlimited',
      scope: 'site',
      checkedAt,
      ...(epochSecondsToIso(subscriptionBody?.access_until)
        ? { expiresAt: epochSecondsToIso(subscriptionBody.access_until) }
        : {}),
    }
  }

  const status = unwrapStatus(statusBody)
  if (typeof status?.display_in_currency !== 'boolean') {
    throw new Error('One API display_in_currency is missing')
  }
  const divisor = status.display_in_currency ? 1 : quotaPerUnit(statusBody)
  const remaining = (hardLimit - usedValue) / divisor
  if (remaining < 0) {
    throw new Error('One API billing scope is inconsistent; exact balance is unavailable')
  }

  return {
    status: 'ok',
    scope: 'site',
    remainingUsd: remaining,
    totalUsd: hardLimit / divisor,
    usedUsd: usedValue / divisor,
    ...(epochSecondsToIso(subscriptionBody?.access_until)
      ? { expiresAt: epochSecondsToIso(subscriptionBody.access_until) }
      : {}),
    checkedAt,
  }
}

/** 独立管理中转站钱包；不读取方案、网关请求或本地 Token 统计。 */
class WalletService {
  constructor({
    store,
    vault,
    profileService,
    fetchImpl = globalThis.fetch,
    timeoutMs = REQUEST_TIMEOUT_MS,
  }) {
    if (typeof fetchImpl !== 'function') throw new Error('Wallet fetch implementation is required')
    this.store = store
    this.vault = vault
    this.profileService = profileService
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
    this.serial = new SerialExecutor()
    this.statusCache = new Map()
    this.activeChecks = new Map()
    this.sessionOperations = new Map()
  }

  runSessionOperation(id, operation) {
    const previous = this.sessionOperations.get(id) ?? Promise.resolve()
    const result = previous.then(operation, operation)
    const tail = result.catch(() => {})
    this.sessionOperations.set(id, tail)
    void tail.then(() => {
      if (this.sessionOperations.get(id) === tail) this.sessionOperations.delete(id)
    })
    return result
  }

  async list() {
    const data = await this.store.read()
    return data.wallets.map(toPublicWallet)
  }

  async save(input) {
    const parsed = SaveWalletSchema.safeParse(input)
    if (!parsed.success) throw new Error(validationMessage(parsed.error))

    return this.serial.run(async () => {
      const data = await this.store.read()
      const existing = parsed.data.id
        ? data.wallets.find((wallet) => wallet.id === parsed.data.id)
        : undefined
      if (parsed.data.id && !existing) throw new Error('Wallet not found')

      const suppliedKey = typeof parsed.data.apiKey === 'string' && parsed.data.apiKey.trim().length > 0
        ? parsed.data.apiKey.trim()
        : undefined
      const siteUrl = normalizeSiteUrl(parsed.data.siteUrl)
      const usesSession = parsed.data.template === 'sub2api'
      const reusableEncryptedKey = existing?.template !== 'sub2api'
        ? existing?.encryptedKey
        : undefined
      const encryptedKey = suppliedKey
        ? this.vault.encrypt(suppliedKey)
        : reusableEncryptedKey
      if (!usesSession && !encryptedKey) throw new Error('API key is required')

      const preserveSession = usesSession
        && existing?.template === 'sub2api'
        && existing.siteUrl === siteUrl
      const connectionChanged = !existing
        || existing.siteUrl !== siteUrl
        || existing.template !== parsed.data.template
        || existing.lowBalanceUsd !== parsed.data.lowBalanceUsd
        || Boolean(suppliedKey)
      const now = new Date().toISOString()
      const next = {
        id: existing?.id ?? crypto.randomUUID(),
        name: parsed.data.name,
        siteUrl,
        template: parsed.data.template,
        ...(!usesSession ? {
          keyHint: suppliedKey ? this.vault.hint(suppliedKey) : existing?.keyHint,
          encryptedKey,
        } : {}),
        ...(preserveSession && existing.encryptedSession ? {
          encryptedSession: existing.encryptedSession,
          ...(existing.accountLabel ? { accountLabel: existing.accountLabel } : {}),
          ...(existing.sessionExpired ? { sessionExpired: true } : {}),
        } : {}),
        lowBalanceUsd: parsed.data.lowBalanceUsd,
        connectionRevision: connectionChanged
          ? (existing?.connectionRevision ?? 0) + 1
          : existing.connectionRevision,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...(!connectionChanged && existing?.balance ? { balance: existing.balance } : {}),
      }
      const wallets = existing
        ? data.wallets.map((wallet) => wallet.id === next.id ? next : wallet)
        : [next, ...data.wallets]
      await this.store.write({ version: 1, wallets })
      return toPublicWallet(next)
    })
  }

  async delete(id) {
    const validatedId = walletId(id)
    return this.serial.run(async () => {
      const data = await this.store.read()
      if (!data.wallets.some((wallet) => wallet.id === validatedId)) {
        throw new Error('Wallet not found')
      }
      await this.store.write({
        version: 1,
        wallets: data.wallets.filter((wallet) => wallet.id !== validatedId),
      })
      return { ok: true }
    })
  }

  async getStored(id) {
    const validatedId = walletId(id)
    const data = await this.store.read()
    const wallet = data.wallets.find((item) => item.id === validatedId)
    if (!wallet) throw new Error('Wallet not found')
    return wallet
  }

  async getLoginTarget(id) {
    const wallet = await this.getStored(id)
    if (wallet.template !== 'sub2api') {
      throw new Error('Browser login is only available for Sub2API wallets')
    }
    const siteUrl = normalizeSiteUrl(wallet.siteUrl)
    return {
      id: wallet.id,
      siteUrl,
      loginUrl: endpointUrl(siteUrl, '/login'),
    }
  }

  async importSub2ApiSession(id, input) {
    const parsed = Sub2ApiSessionSchema.safeParse(input)
    if (!parsed.success) throw new Error(validationMessage(parsed.error))
    const validatedId = walletId(id)

    return this.runSessionOperation(validatedId, async () => {
      const snapshot = await this.getStored(validatedId)
      if (snapshot.template !== 'sub2api') {
        throw new Error('This wallet does not use Sub2API login')
      }

      const queried = await this.querySub2ApiAccount(snapshot, parsed.data)
      const balance = finalizeBalance(queried.balance, snapshot.lowBalanceUsd)
      const accountData = queried.accountData
      const session = {
        ...queried.session,
        ...(accountData.userId ? { userId: accountData.userId } : {}),
        ...(accountData.username ? { username: accountData.username } : {}),
      }
      const accountLabel = accountData.username || accountData.userId || 'Sub2API account'

      return this.serial.run(async () => {
        const data = await this.store.read()
        const current = data.wallets.find((wallet) => wallet.id === snapshot.id)
        if (!current) throw new Error('Wallet not found')
        if (current.connectionRevision !== snapshot.connectionRevision) {
          throw new Error('Wallet settings changed while the login window was open')
        }

        const updated = {
          ...current,
          encryptedSession: this.vault.encrypt(JSON.stringify(session)),
          accountLabel,
          sessionExpired: false,
          balance: WalletBalanceSchema.parse(balance),
          connectionRevision: current.connectionRevision + 1,
          updatedAt: new Date().toISOString(),
        }
        await this.store.write({
          version: 1,
          wallets: data.wallets.map((wallet) => wallet.id === updated.id ? updated : wallet),
        })
        return toPublicWallet(updated)
      })
    })
  }

  async importSub2ApiKeys(id, rawGroupMode) {
    const groupModeResult = WalletImportGroupModeSchema.safeParse(rawGroupMode)
    if (!groupModeResult.success) throw new Error(validationMessage(groupModeResult.error))
    if (!this.profileService?.importProfiles) {
      throw new Error('Profile import service is unavailable')
    }

    const validatedId = walletId(id)
    const prepared = await this.runSessionOperation(validatedId, async () => {
      const snapshot = await this.getStored(validatedId)
      if (snapshot.template !== 'sub2api') {
        throw new Error('Key import is only available for Sub2API wallets')
      }
      if (!snapshot.encryptedSession || snapshot.sessionExpired) throw walletLoginRequiredError()
      const session = Sub2ApiSessionSchema.parse(JSON.parse(this.vault.decrypt(snapshot.encryptedSession)))
      const queried = await this.querySub2ApiAccount(snapshot, session, (rotated) => (
        this.persistSub2ApiSession(snapshot, rotated)
      ))

      const requestKeys = async (endpointPath) => {
        const url = new URL(endpointUrl(snapshot.siteUrl, endpointPath))
        url.searchParams.set('page', '1')
        url.searchParams.set('page_size', String(MAX_SUB2API_IMPORT_KEYS))
        return this.requestJson(url.toString(), {
          bearerToken: queried.session.accessToken,
          userAgent: queried.session.userAgent,
        })
      }

      let body
      try {
        body = await requestKeys('/api/v1/keys')
      } catch (error) {
        if (isHttpAuthError(error)) throw walletLoginRequiredError()
        if (error?.statusCode !== 404) throw error
        body = await requestKeys('/api/v1/api-keys')
      }
      assertSub2ApiKeyImportLimit(body)
      return { snapshot, parsed: sub2ApiImportProfiles(body, snapshot) }
    })
    const { snapshot, parsed } = prepared
    if (parsed.profiles.length === 0) {
      return {
        status: 'complete',
        groupName: snapshot.name,
        imported: 0,
        reused: 0,
        skipped: parsed.skipped,
        profileIds: [],
      }
    }
    const profiles = await this.resolveSub2ApiImportProfiles(parsed.profiles)
    const imported = await this.profileService.importProfiles({
      groupName: snapshot.name,
      groupMode: groupModeResult.data,
      profiles,
    })
    if (imported.status !== 'complete') return imported
    return {
      ...imported,
      skipped: (imported.skipped || 0) + parsed.skipped,
    }
  }

  async resolveSub2ApiImportProfiles(profiles) {
    const resolved = []
    for (let index = 0; index < profiles.length; index += SUB2API_IMPORT_PROBE_BATCH_SIZE) {
      resolved.push(...await Promise.all(profiles
        .slice(index, index + SUB2API_IMPORT_PROBE_BATCH_SIZE)
        .map((profile) => this.resolveSub2ApiImportProfile(profile))))
    }
    return resolved
  }

  async resolveSub2ApiImportProfile(profile) {
    if (profile.protocol !== 'openai-responses') return profile
    const candidates = [profile.baseUrl, endpointUrl(profile.baseUrl, '/v1')]
    for (const baseUrl of candidates) {
      try {
        await this.requestJson(endpointUrl(baseUrl, '/models'), { bearerToken: profile.apiKey })
        return { ...profile, baseUrl }
      } catch {}
    }
    return profile
  }

  async requestJson(url, options = {}) {
    assertSecureWalletUrl(url)
    const {
      bearerToken,
      method = 'GET',
      jsonBody,
      userAgent,
    } = options
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    timer.unref?.()
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(jsonBody !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
          ...(userAgent ? { 'User-Agent': userAgent } : {}),
        },
        ...(jsonBody !== undefined ? { body: JSON.stringify(jsonBody) } : {}),
        redirect: 'manual',
        signal: controller.signal,
      })
      const contentLength = Number(response.headers?.get?.('content-length'))
      if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
        throw new Error('Wallet response is too large')
      }
      const source = await response.text()
      if (Buffer.byteLength(source, 'utf8') > MAX_RESPONSE_BYTES) {
        throw new Error('Wallet response is too large')
      }
      let body
      try {
        body = source ? JSON.parse(source) : {}
      } catch {
        throw new Error('Wallet endpoint returned invalid JSON')
      }
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}${responseMessage(body) ? ` · ${responseMessage(body)}` : ''}`)
        error.statusCode = response.status
        throw error
      }
      return body
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('Wallet request timed out')
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async siteStatus(siteUrl) {
    const cached = this.statusCache.get(siteUrl)
    if (cached && cached.expiresAt > Date.now()) return cached.body
    const body = await this.requestJson(endpointUrl(siteUrl, '/api/status'))
    this.statusCache.set(siteUrl, { body, expiresAt: Date.now() + STATUS_CACHE_MS })
    return body
  }

  async refreshSub2ApiSession(wallet, session) {
    if (!session.refreshToken) throw walletLoginRequiredError()

    let body
    try {
      body = await this.requestJson(endpointUrl(wallet.siteUrl, '/api/v1/auth/refresh'), {
        method: 'POST',
        bearerToken: session.accessToken,
        jsonBody: { refresh_token: session.refreshToken },
        userAgent: session.userAgent,
      })
    } catch (error) {
      if (isHttpAuthError(error)) throw walletLoginRequiredError()
      throw error
    }
    if (body && typeof body === 'object' && 'code' in body && Number(body.code) !== 0) {
      throw walletLoginRequiredError()
    }
    const data = body?.data && typeof body.data === 'object' ? body.data : body
    const accessToken = typeof data?.access_token === 'string' ? data.access_token.trim() : ''
    const refreshToken = typeof data?.refresh_token === 'string' ? data.refresh_token.trim() : ''
    const expiresIn = Number(data?.expires_in)
    if (!accessToken || !refreshToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error('Sub2API returned an invalid refreshed session')
    }
    return Sub2ApiSessionSchema.parse({
      ...session,
      accessToken,
      refreshToken,
      tokenExpiresAt: Date.now() + expiresIn * 1000,
    })
  }

  async querySub2ApiAccount(wallet, initialSession, onSessionRotated = async () => {}) {
    let session = Sub2ApiSessionSchema.parse(initialSession)
    const rotate = async () => {
      session = await this.refreshSub2ApiSession(wallet, session)
      await onSessionRotated(session)
    }

    if (session.refreshToken
      && session.tokenExpiresAt
      && session.tokenExpiresAt - Date.now() <= SUB2API_REFRESH_BUFFER_MS) {
      try {
        await rotate()
      } catch (error) {
        if (error?.code === 'WALLET_LOGIN_REQUIRED') throw error
        // 网络暂时失败时仍尝试现有 access token；它可能尚未真正过期。
      }
    }

    let body
    try {
      body = await this.requestJson(endpointUrl(wallet.siteUrl, '/api/v1/auth/me'), {
        bearerToken: session.accessToken,
        userAgent: session.userAgent,
      })
    } catch (error) {
      if (!isHttpAuthError(error)) throw error
      if (!session.refreshToken) throw walletLoginRequiredError()
      await rotate()
      try {
        body = await this.requestJson(endpointUrl(wallet.siteUrl, '/api/v1/auth/me'), {
          bearerToken: session.accessToken,
          userAgent: session.userAgent,
        })
      } catch (retryError) {
        if (isHttpAuthError(retryError)) throw walletLoginRequiredError()
        throw retryError
      }
    }

    const requestSubscriptions = async () => {
      try {
        return await this.requestJson(endpointUrl(wallet.siteUrl, '/api/v1/subscriptions/active'), {
          bearerToken: session.accessToken,
          userAgent: session.userAgent,
        })
      } catch (error) {
        if (error?.statusCode !== 404) throw error
        return this.requestJson(endpointUrl(wallet.siteUrl, '/api/v1/subscriptions/summary'), {
          bearerToken: session.accessToken,
          userAgent: session.userAgent,
        })
      }
    }

    let subscriptionBody
    try {
      subscriptionBody = await requestSubscriptions()
    } catch (error) {
      if (error?.statusCode === 404) subscriptionBody = { data: { subscriptions: [] } }
      else if (!isHttpAuthError(error)) throw error
      else {
        if (!session.refreshToken) throw walletLoginRequiredError()
        await rotate()
        try {
          subscriptionBody = await requestSubscriptions()
        } catch (retryError) {
          if (retryError?.statusCode === 404) subscriptionBody = { data: { subscriptions: [] } }
          else if (isHttpAuthError(retryError)) throw walletLoginRequiredError()
          else throw retryError
        }
      }
    }

    const accountData = sub2ApiAccountData(body)
    return {
      session,
      accountData,
      balance: {
        ...parseSub2API(body, new Date().toISOString()),
        subscriptions: parseSub2ApiSubscriptions(subscriptionBody),
      },
    }
  }

  async persistSub2ApiSession(snapshot, session) {
    return this.serial.run(async () => {
      const data = await this.store.read()
      const current = data.wallets.find((wallet) => wallet.id === snapshot.id)
      if (!current || current.connectionRevision !== snapshot.connectionRevision) return false
      const updated = {
        ...current,
        encryptedSession: this.vault.encrypt(JSON.stringify(session)),
        sessionExpired: false,
      }
      await this.store.write({
        version: 1,
        wallets: data.wallets.map((wallet) => wallet.id === updated.id ? updated : wallet),
      })
      return true
    })
  }

  async queryApiKeyWallet(wallet, apiKey) {
    const checkedAt = new Date().toISOString()
    if (wallet.template === 'new-api') {
      const [usage, status] = await Promise.all([
        this.requestJson(endpointUrl(wallet.siteUrl, '/api/usage/token/'), { bearerToken: apiKey }),
        this.siteStatus(wallet.siteUrl),
      ])
      return parseNewAPI(usage, status, checkedAt)
    }
    const [subscription, usage, status] = await Promise.all([
      this.requestJson(endpointUrl(wallet.siteUrl, '/v1/dashboard/billing/subscription'), { bearerToken: apiKey }),
      this.requestJson(endpointUrl(wallet.siteUrl, '/v1/dashboard/billing/usage'), { bearerToken: apiKey }),
      this.siteStatus(wallet.siteUrl),
    ])
    return parseOneAPI(subscription, usage, status, checkedAt)
  }

  async check(id) {
    const validatedId = walletId(id)
    const active = this.activeChecks.get(validatedId)
    if (active) return active

    const operation = this.checkOnce(validatedId).finally(() => {
      if (this.activeChecks.get(validatedId) === operation) this.activeChecks.delete(validatedId)
    })
    this.activeChecks.set(validatedId, operation)
    return operation
  }

  async checkOnce(id) {
    return this.runSessionOperation(id, async () => {
      const snapshot = await this.getStored(id)
      let balance
      let loginExpired = false
      try {
        if (snapshot.template === 'sub2api') {
          if (!snapshot.encryptedSession || snapshot.sessionExpired) throw walletLoginRequiredError()
          const session = Sub2ApiSessionSchema.parse(JSON.parse(this.vault.decrypt(snapshot.encryptedSession)))
          const queried = await this.querySub2ApiAccount(snapshot, session, (rotated) => (
            this.persistSub2ApiSession(snapshot, rotated)
          ))
          balance = finalizeBalance(queried.balance, snapshot.lowBalanceUsd)
        } else {
          const apiKey = this.vault.decrypt(snapshot.encryptedKey)
          balance = finalizeBalance(await this.queryApiKeyWallet(snapshot, apiKey), snapshot.lowBalanceUsd)
        }
      } catch (error) {
        loginExpired = snapshot.template === 'sub2api' && error?.code === 'WALLET_LOGIN_REQUIRED'
        balance = {
          status: 'error',
          checkedAt: new Date().toISOString(),
          message: String(error?.message || error).slice(0, 500),
        }
      }

      return this.serial.run(async () => {
        const data = await this.store.read()
        const current = data.wallets.find((wallet) => wallet.id === snapshot.id)
        if (!current) throw new Error('Wallet not found')
        if (current.connectionRevision !== snapshot.connectionRevision) return toPublicWallet(current)

        const updated = {
          ...current,
          balance: WalletBalanceSchema.parse(balance),
          ...(snapshot.template === 'sub2api'
            ? { sessionExpired: loginExpired ? true : current.sessionExpired === true }
            : {}),
        }
        await this.store.write({
          version: 1,
          wallets: data.wallets.map((wallet) => wallet.id === updated.id ? updated : wallet),
        })
        return toPublicWallet(updated)
      })
    })
  }
}

module.exports = {
  SaveWalletSchema,
  WALLET_TEMPLATES,
  WalletService,
  WalletStoreSchema,
  endpointUrl,
  normalizeSiteUrl,
  parseNewAPI,
  parseOneAPI,
  parseSub2API,
  parseSub2ApiSubscriptions,
}
