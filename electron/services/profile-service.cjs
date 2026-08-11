const crypto = require('node:crypto')
const { z } = require('zod')
const {
  DEFAULT_AUTO_SWITCH_INTERVAL_MINUTES,
  HealthSchema,
  HttpUrlSchema,
  MAX_PROFILE_ENDPOINTS,
  ProfileRoutingSchema,
  SaveProfileSchema,
  normalizeHttpUrl,
  toPublicProfile,
  validationMessage,
} = require('./schemas.cjs')
const { SerialExecutor } = require('./storage.cjs')

const ProfileIdSchema = z.string().uuid()
const ProfileGroupIdSchema = z.string().uuid()
const ProfileGroupNameSchema = z.string().trim().min(1, 'Group name is required').max(80)
const ProfileIdsSchema = z.array(ProfileIdSchema).max(500)
const ConnectionRevisionSchema = z.number().int().positive()
const EMPTY_KEY_HINT = 'Not set'
const DEFAULT_PROFILE_ROUTING = Object.freeze({
  enabled: true,
  disabledModels: [],
  weight: 0,
  autoDisableOnFailure: false,
})

const ProfileOrganizationSchema = z.object({
  groupIds: z.array(ProfileGroupIdSchema).max(500),
  profiles: z.array(z.object({
    id: ProfileIdSchema,
    groupId: ProfileGroupIdSchema.nullable(),
  })).max(500),
})

const ImportedProfileSchema = z.object({
  name: z.string().trim().min(1).max(80),
  protocol: z.enum(['anthropic', 'openai-responses', 'openai-chat', 'gemini']),
  baseUrl: HttpUrlSchema,
  apiKey: z.string().trim().min(1).max(32768),
  model: z.string().trim().max(240).default(''),
  authMode: z.enum(['api-key', 'bearer']),
  targets: z.array(z.enum(['claude', 'claude-desktop', 'codex', 'opencode', 'gemini'])).min(1).max(5),
})

const ImportProfilesSchema = z.object({
  groupName: ProfileGroupNameSchema,
  groupMode: z.enum(['existing', 'new']).optional(),
  profiles: z.array(ImportedProfileSchema).max(500),
})

/** 网关一条条请求攒出来的账。编辑方案时必须原样带走，见 save()。 */
const TOKEN_ACCOUNTING_FIELDS = Object.freeze([
  'tokenUsageTotal',
  'tokenInputTotal',
  'tokenCachedTotal',
  'tokenCacheWriteTotal',
  'tokenReasoningTotal',
  'tokenDayKey',
  'tokenUsageToday',
])

function tokenAccounting(profile) {
  const result = {}
  for (const field of TOKEN_ACCOUNTING_FIELDS) {
    if (profile?.[field] !== undefined) result[field] = profile[field]
  }
  return result
}

function profileRouting(profile) {
  return ProfileRoutingSchema.parse(profile?.routing || DEFAULT_PROFILE_ROUTING)
}
const MAX_DISCOVERED_MODELS = 1_000
const HEALTH_HISTORY_WINDOW_MS = 60 * 60_000
const HEALTH_TIMELINE_WINDOW_MS = 2 * 60 * 60_000
const MAX_HEALTH_HISTORY = 30
const MAX_HEALTH_TIMELINE = 60

const EndpointProbeResultSchema = z.object({
  url: HttpUrlSchema,
  health: HealthSchema,
  models: z.array(z.string().trim().min(1).max(240)).max(MAX_DISCOVERED_MODELS),
})

const EndpointHealthProbeResultSchema = z.object({
  url: HttpUrlSchema,
  health: HealthSchema,
})

function appendHealthSample(history, health, now = Date.now()) {
  const minimumTimestamp = now - HEALTH_HISTORY_WINDOW_MS
  return [...(history || []), health]
    .filter((sample) => {
      const timestamp = Date.parse(sample.checkedAt)
      return Number.isFinite(timestamp) && timestamp >= minimumTimestamp && timestamp <= now + 60_000
    })
    .sort((left, right) => Date.parse(left.checkedAt) - Date.parse(right.checkedAt))
    .slice(-MAX_HEALTH_HISTORY)
}

function appendHealthTimeline(history, health, now = Date.now()) {
  const minimumTimestamp = now - HEALTH_TIMELINE_WINDOW_MS
  return [...(history || []), health]
    .filter((sample) => {
      const timestamp = Date.parse(sample.checkedAt)
      return Number.isFinite(timestamp) && timestamp >= minimumTimestamp && timestamp <= now + 60_000
    })
    .sort((left, right) => Date.parse(left.checkedAt) - Date.parse(right.checkedAt))
    .slice(-MAX_HEALTH_TIMELINE)
}

/** 本地日期键（YYYY-MM-DD）：当日用量以用户本地 0 点为界重置。 */
function localDateKey(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function profileId(value) {
  const result = ProfileIdSchema.safeParse(value)
  if (!result.success) throw new Error(validationMessage(result.error))
  return result.data
}

function normalizeBaseUrl(value) {
  return normalizeHttpUrl(value)
}

function comparableUrl(value) {
  return normalizeHttpUrl(value)
}

function sameUrl(left, right) {
  return comparableUrl(left) === comparableUrl(right)
}

function endpointUrlsFromInput(input) {
  const requestedBaseUrl = normalizeBaseUrl(input.baseUrl)
  const source = input.endpoints?.length
    ? input.endpoints.map((endpoint) => normalizeBaseUrl(endpoint.url))
    : [requestedBaseUrl]
  const seen = new Set()
  const endpoints = []

  for (const url of source) {
    const comparable = comparableUrl(url)
    if (seen.has(comparable)) throw new Error('Endpoint URLs must be unique')
    seen.add(comparable)
    endpoints.push(url)
  }

  const activeEndpoint = endpoints.find((url) => sameUrl(url, requestedBaseUrl))
  if (activeEndpoint) return { baseUrl: activeEndpoint, endpoints }
  if (endpoints.length >= MAX_PROFILE_ENDPOINTS) {
    throw new Error(`A profile can contain at most ${MAX_PROFILE_ENDPOINTS} endpoints`)
  }
  return { baseUrl: requestedBaseUrl, endpoints: [requestedBaseUrl, ...endpoints] }
}

function stringSetsDiffer(left, right) {
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  return leftSet.size !== rightSet.size || [...leftSet].some((value) => !rightSet.has(value))
}

function modelRoutesDiffer(left, right) {
  return JSON.stringify(left || {}) !== JSON.stringify(right || {})
}

function decisionShapeChanged(existing, input, baseUrl, endpointUrls, suppliedKey) {
  if (!existing) return true
  if (suppliedKey) return true
  if (existing.protocol !== input.protocol || existing.authMode !== input.authMode) return true
  if (!sameUrl(existing.baseUrl, baseUrl)) return true
  if (existing.model !== input.model) return true
  if (modelRoutesDiffer(existing.modelRoutes, input.modelRoutes)) return true
  if (existing.enableToolSearch !== input.enableToolSearch) return true
  if (stringSetsDiffer(existing.targets, input.targets)) return true
  const previous = new Set(existing.endpoints.map((endpoint) => comparableUrl(endpoint.url)))
  const next = new Set(endpointUrls.map(comparableUrl))
  if (previous.size !== next.size) return true
  return [...previous].some((url) => !next.has(url))
}

function endpointFor(profile, url) {
  return profile.endpoints.find((endpoint) => sameUrl(endpoint.url, url))
}

function copyName(name, profiles) {
  const usedNames = new Set(profiles.map((profile) => profile.name.toLocaleLowerCase()))
  const baseName = `${name} 副本`
  if (!usedNames.has(baseName.toLocaleLowerCase())) return baseName

  let suffix = 2
  while (usedNames.has(`${baseName} ${suffix}`.toLocaleLowerCase())) suffix += 1
  return `${baseName} ${suffix}`
}

function namesEqual(left, right) {
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0
}

function uniqueName(name, items) {
  const used = new Set(items.map((item) => item.name.toLocaleLowerCase()))
  if (!used.has(name.toLocaleLowerCase())) return name
  let suffix = 2
  while (used.has(`${name} (${suffix})`.toLocaleLowerCase())) suffix += 1
  return `${name} (${suffix})`
}

function secretFingerprint(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

function connectionFingerprint(protocol, baseUrl, apiKey) {
  return `${protocol}\n${comparableUrl(baseUrl)}\n${secretFingerprint(apiKey)}`
}

function importedStoredProfile(input, groupId, profiles, vault, now) {
  const normalized = endpointUrlsFromInput({
    baseUrl: input.baseUrl,
    endpoints: [{ url: input.baseUrl }],
  })
  return {
    id: crypto.randomUUID(),
    groupId,
    name: uniqueName(input.name, profiles),
    protocol: input.protocol,
    baseUrl: normalized.baseUrl,
    endpoints: normalized.endpoints.map((url) => ({
      url,
      models: [],
      healthHistory: [],
      healthTimeline: [],
    })),
    model: input.model,
    modelRoutes: {},
    authMode: input.authMode,
    targets: [...new Set(input.targets)],
    enableToolSearch: false,
    autoSwitch: {
      enabled: false,
      intervalMinutes: DEFAULT_AUTO_SWITCH_INTERVAL_MINUTES,
    },
    routing: { ...DEFAULT_PROFILE_ROUTING, disabledModels: [] },
    connectionRevision: 1,
    keyHint: vault.hint(input.apiKey),
    encryptedKey: vault.encrypt(input.apiKey),
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * 在检测结果事务内确认调度仍允许提交。
 *
 * @param {{signal?: AbortSignal, shouldContinue?: () => boolean}} options 提交取消条件。
 * @throws 外部信号已中止或继续条件不成立时抛出 AbortError。
 */
function assertEndpointCommitActive(options) {
  const canContinue = !options.signal?.aborted
    && (typeof options.shouldContinue !== 'function' || options.shouldContinue())
  if (canContinue) return

  const error = new Error('Endpoint test was stopped')
  error.name = 'AbortError'
  throw error
}

/**
 * 管理方案元数据、URL 池和 DPAPI 密钥密文。
 *
 * 服务层只返回公开方案；所有连接变更都递增 revision，使较早发出的网络检测
 * 无法覆盖较新的 URL、协议或 Key。解密后的 Key 只在主进程调用栈内短暂存在。
 */
class ProfileService {
  constructor(store, vault) {
    this.store = store
    this.vault = vault
    this.serial = new SerialExecutor()
  }

  /**
   * 列出全部公开方案。
   *
   * @returns {Promise<object[]>} 不含密文和明文 Key 的方案列表。
   */
  async list() {
    const data = await this.store.read()
    return data.profiles.map(toPublicProfile)
  }

  async listGroups() {
    const data = await this.store.read()
    return data.groups.map((group) => ({ ...group }))
  }

  async createGroup(rawName, rawProfileIds = []) {
    const nameResult = ProfileGroupNameSchema.safeParse(rawName)
    const idsResult = ProfileIdsSchema.safeParse(rawProfileIds)
    if (!nameResult.success) throw new Error(validationMessage(nameResult.error))
    if (!idsResult.success) throw new Error(validationMessage(idsResult.error))
    const profileIds = new Set(idsResult.data)

    return this.serial.run(async () => {
      const data = await this.store.read()
      if (data.groups.some((group) => namesEqual(group.name, nameResult.data))) {
        throw new Error('A group with this name already exists')
      }
      const knownIds = new Set(data.profiles.map((profile) => profile.id))
      for (const id of profileIds) {
        if (!knownIds.has(id)) throw new Error('Profile not found')
      }
      const now = new Date().toISOString()
      const group = {
        id: crypto.randomUUID(),
        name: nameResult.data,
        createdAt: now,
        updatedAt: now,
      }
      data.groups.push(group)
      data.profiles = data.profiles.map((profile) => profileIds.has(profile.id)
        ? { ...profile, groupId: group.id }
        : profile)
      await this.store.write(data)
      return { ...group }
    })
  }

  async renameGroup(rawId, rawName) {
    const idResult = ProfileGroupIdSchema.safeParse(rawId)
    const nameResult = ProfileGroupNameSchema.safeParse(rawName)
    if (!idResult.success) throw new Error(validationMessage(idResult.error))
    if (!nameResult.success) throw new Error(validationMessage(nameResult.error))

    return this.serial.run(async () => {
      const data = await this.store.read()
      const index = data.groups.findIndex((group) => group.id === idResult.data)
      if (index === -1) throw new Error('Group not found')
      if (data.groups.some((group, groupIndex) => (
        groupIndex !== index && namesEqual(group.name, nameResult.data)
      ))) throw new Error('A group with this name already exists')
      const group = {
        ...data.groups[index],
        name: nameResult.data,
        updatedAt: new Date().toISOString(),
      }
      data.groups[index] = group
      await this.store.write(data)
      return { ...group }
    })
  }

  async updateGroupMembers(rawId, rawProfileIds) {
    const idResult = ProfileGroupIdSchema.safeParse(rawId)
    const idsResult = ProfileIdsSchema.safeParse(rawProfileIds)
    if (!idResult.success) throw new Error(validationMessage(idResult.error))
    if (!idsResult.success) throw new Error(validationMessage(idsResult.error))
    const profileIds = new Set(idsResult.data)

    return this.serial.run(async () => {
      const data = await this.store.read()
      const groupIndex = data.groups.findIndex((group) => group.id === idResult.data)
      if (groupIndex === -1) throw new Error('Group not found')
      const knownIds = new Set(data.profiles.map((profile) => profile.id))
      for (const id of profileIds) {
        if (!knownIds.has(id)) throw new Error('Profile not found')
      }
      data.profiles = data.profiles.map((profile) => {
        if (profileIds.has(profile.id)) return { ...profile, groupId: idResult.data }
        if (profile.groupId !== idResult.data) return profile
        const { groupId, ...ungrouped } = profile
        return ungrouped
      })
      data.groups[groupIndex] = {
        ...data.groups[groupIndex],
        updatedAt: new Date().toISOString(),
      }
      await this.store.write(data)
      return data.profiles.map(toPublicProfile)
    })
  }

  async deleteGroup(rawId) {
    const idResult = ProfileGroupIdSchema.safeParse(rawId)
    if (!idResult.success) throw new Error(validationMessage(idResult.error))

    return this.serial.run(async () => {
      const data = await this.store.read()
      if (!data.groups.some((group) => group.id === idResult.data)) throw new Error('Group not found')
      data.groups = data.groups.filter((group) => group.id !== idResult.data)
      data.profiles = data.profiles.map((profile) => {
        if (profile.groupId !== idResult.data) return profile
        const { groupId, ...ungrouped } = profile
        return ungrouped
      })
      await this.store.write(data)
      return { ok: true }
    })
  }

  async organize(rawInput) {
    const result = ProfileOrganizationSchema.safeParse(rawInput)
    if (!result.success) throw new Error(validationMessage(result.error))
    const input = result.data
    if (new Set(input.groupIds).size !== input.groupIds.length) {
      throw new Error('Group order contains duplicates')
    }
    if (new Set(input.profiles.map((profile) => profile.id)).size !== input.profiles.length) {
      throw new Error('Profile order contains duplicates')
    }

    return this.serial.run(async () => {
      const data = await this.store.read()
      const groupsById = new Map(data.groups.map((group) => [group.id, group]))
      const profilesById = new Map(data.profiles.map((profile) => [profile.id, profile]))
      for (const id of input.groupIds) {
        if (!groupsById.has(id)) throw new Error('Group not found')
      }
      for (const assignment of input.profiles) {
        if (!profilesById.has(assignment.id)) throw new Error('Profile not found')
        if (assignment.groupId && !groupsById.has(assignment.groupId)) throw new Error('Group not found')
      }

      const orderedGroups = input.groupIds.map((id) => groupsById.get(id))
      for (const group of data.groups) {
        if (!input.groupIds.includes(group.id)) orderedGroups.push(group)
      }
      const orderedProfiles = input.profiles.map((assignment) => {
        const profile = profilesById.get(assignment.id)
        profilesById.delete(assignment.id)
        if (assignment.groupId) return { ...profile, groupId: assignment.groupId }
        const { groupId, ...ungrouped } = profile
        return ungrouped
      })
      for (const profile of data.profiles) {
        if (profilesById.has(profile.id)) orderedProfiles.push(profile)
      }
      data.groups = orderedGroups
      data.profiles = orderedProfiles
      await this.store.write(data)
      return {
        groups: data.groups.map((group) => ({ ...group })),
        profiles: data.profiles.map(toPublicProfile),
      }
    })
  }

  async importProfiles(rawInput) {
    const result = ImportProfilesSchema.safeParse(rawInput)
    if (!result.success) throw new Error(validationMessage(result.error))
    const input = result.data

    return this.serial.run(async () => {
      const data = await this.store.read()
      const existingGroup = data.groups.find((group) => namesEqual(group.name, input.groupName))
      if (existingGroup && input.groupMode === undefined) {
        return { status: 'group-conflict', groupName: input.groupName }
      }

      const now = new Date().toISOString()
      let group = input.groupMode === 'existing' ? existingGroup : undefined
      if (!group) {
        const name = input.groupMode === 'new'
          ? uniqueName(input.groupName, data.groups)
          : input.groupName
        group = {
          id: crypto.randomUUID(),
          name,
          createdAt: now,
          updatedAt: now,
        }
        data.groups.push(group)
      }

      const connections = new Map()
      for (const profile of data.profiles) {
        if (!profile.encryptedKey) continue
        const apiKey = this.vault.decrypt(profile.encryptedKey)
        connections.set(connectionFingerprint(profile.protocol, profile.baseUrl, apiKey), profile.id)
      }

      let imported = 0
      let reused = 0
      const profileIds = []
      for (const item of input.profiles) {
        const fingerprint = connectionFingerprint(item.protocol, item.baseUrl, item.apiKey)
        const duplicateId = connections.get(fingerprint)
        if (duplicateId) {
          const index = data.profiles.findIndex((profile) => profile.id === duplicateId)
          if (index >= 0) data.profiles[index] = { ...data.profiles[index], groupId: group.id }
          profileIds.push(duplicateId)
          reused += 1
          continue
        }
        const profile = importedStoredProfile(item, group.id, data.profiles, this.vault, now)
        data.profiles.push(profile)
        connections.set(fingerprint, profile.id)
        profileIds.push(profile.id)
        imported += 1
      }

      await this.store.write(data)
      return {
        status: 'complete',
        groupId: group.id,
        groupName: group.name,
        imported,
        reused,
        skipped: 0,
        profileIds: [...new Set(profileIds)],
      }
    })
  }

  /**
   * 读取内部持久化方案。
   *
   * @param {string} id 方案 UUID。
   * @returns {Promise<object>} 含密文和连接 revision 的内部方案。
   * @throws UUID 无效或方案不存在时抛出错误。
   */
  async getStored(id) {
    const validatedId = profileId(id)
    const data = await this.store.read()
    const profile = data.profiles.find((item) => item.id === validatedId)
    if (!profile) throw new Error('Profile not found')
    return profile
  }

  /**
   * 读取同一 revision 的方案和明文 Key，供主进程网络或写入服务使用。
   *
   * @param {string} id 方案 UUID。
   * @returns {Promise<{profile: object, apiKey: string}>} 同一存储快照中的连接数据。
   * @throws 方案不存在、密文缺失或当前 Windows 用户无法解密时抛出错误。
   */
  async getConnection(id) {
    const profile = await this.getStored(id)
    return {
      profile,
      apiKey: this.vault.decrypt(profile.encryptedKey),
    }
  }

  /**
   * 解锁指定方案的 Key。
   *
   * @param {string} id 方案 UUID。
   * @returns {Promise<string>} 明文 Key；调用方不得记录或返回渲染进程。
   * @throws 方案不存在或当前 Windows 用户无法解密时抛出错误。
   */
  async getSecret(id) {
    const { apiKey } = await this.getConnection(id)
    return apiKey
  }

  /**
   * 新建或更新方案，并规范化活动 URL 与端点池。
   *
   * 编辑时空白 Key 表示保留原密文。连接参数变化会使旧检测结果失效；仅修改
   * 名称、模型、目标或活动 URL 时保留仍然适用的端点状态。
   *
   * @param {object} rawInput 未信任的渲染进程输入。
   * @returns {Promise<object>} 不含密文的公开方案。
   * @throws 参数无效、方案不存在、加密或持久化失败时抛出错误。
   */
  async save(rawInput) {
    const result = SaveProfileSchema.safeParse(rawInput)
    if (!result.success) throw new Error(validationMessage(result.error))
    const input = result.data

    return this.serial.run(async () => {
      const data = await this.store.read()
      const existingIndex = input.id
        ? data.profiles.findIndex((profile) => profile.id === input.id)
        : -1
      if (input.id && existingIndex === -1) throw new Error('Profile not found')

      const existing = existingIndex >= 0 ? data.profiles[existingIndex] : undefined
      const groupId = input.groupId === undefined ? existing?.groupId : input.groupId || undefined
      if (groupId && !data.groups.some((group) => group.id === groupId)) {
        throw new Error('Group not found')
      }
      const now = new Date().toISOString()
      const suppliedKey = input.apiKey?.trim() || ''
      const normalized = endpointUrlsFromInput(input)
      const connectionChanged = decisionShapeChanged(
        existing,
        input,
        normalized.baseUrl,
        normalized.endpoints,
        suppliedKey,
      )
      const encryptedKey = suppliedKey
        ? this.vault.encrypt(suppliedKey)
        : existing?.encryptedKey
      const keyHint = suppliedKey
        ? this.vault.hint(suppliedKey)
        : existing?.keyHint || EMPTY_KEY_HINT

      const endpoints = normalized.endpoints.map((url) => {
        const previous = existing ? endpointFor(existing, url) : undefined
        if (previous && !suppliedKey
          && existing.protocol === input.protocol
          && existing.authMode === input.authMode) {
          return { ...previous, url }
        }
        return { url, models: [], healthHistory: [], healthTimeline: [] }
      })
      const activeEndpoint = endpoints.find((endpoint) => sameUrl(endpoint.url, normalized.baseUrl))
        || endpoints[0]
      const profile = {
        id: existing?.id || crypto.randomUUID(),
        ...(groupId ? { groupId } : {}),
        name: input.name,
        protocol: input.protocol,
        baseUrl: activeEndpoint.url,
        endpoints,
        model: input.model,
        modelRoutes: input.modelRoutes || {},
        authMode: input.authMode,
        targets: [...new Set(input.targets)],
        enableToolSearch: input.enableToolSearch,
        autoSwitch: input.autoSwitch || {
          enabled: false,
          intervalMinutes: DEFAULT_AUTO_SWITCH_INTERVAL_MINUTES,
        },
        routing: profileRouting(existing),
        connectionRevision: existing
          ? existing.connectionRevision + (connectionChanged ? 1 : 0)
          : 1,
        keyHint,
        ...(encryptedKey ? { encryptedKey } : {}),
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        ...(existing?.lastAppliedAt ? { lastAppliedAt: existing.lastAppliedAt } : {}),
        ...(!connectionChanged && existing?.modelsCheckedAt
          ? { modelsCheckedAt: existing.modelsCheckedAt }
          : {}),
        ...(activeEndpoint.health ? { health: activeEndpoint.health } : {}),
        /*
         * 累计用量必须原样带过来。
         *
         * 这个对象是从零重建的，编辑一次名字就把累计 Token、缓存率的分母全部
         * 归零——那是网关一条条请求攒出来的账，不是这次编辑的输入。哪怕换了
         * Key、换了 URL 也照样保留：账记在「方案」名下，跟着方案走。
         */
        ...tokenAccounting(existing),
      }

      if (existingIndex >= 0) data.profiles[existingIndex] = profile
      else data.profiles.unshift(profile)
      await this.store.write(data)
      return toPublicProfile(profile)
    })
  }

  /**
   * 复制方案及其 Key，不继承运行时检测和已写入状态。
   *
   * 副本保留协议、URL、模型、目标和检测周期，但默认关闭自动切换，避免复制
   * 操作本身触发后台写配置。Key 在主进程内解密后立即重新加密。
   *
   * @param {string} id 来源方案 UUID。
   * @returns {Promise<object>} 新副本的公开方案。
   * @throws 来源不存在或 Key 无法解密/重新加密时抛出错误。
   */
  async duplicate(id) {
    const validatedId = profileId(id)
    return this.serial.run(async () => {
      const data = await this.store.read()
      const sourceIndex = data.profiles.findIndex((profile) => profile.id === validatedId)
      if (sourceIndex === -1) throw new Error('Profile not found')
      const source = data.profiles[sourceIndex]
      const now = new Date().toISOString()
      const apiKey = this.vault.decrypt(source.encryptedKey)
      const duplicate = {
        id: crypto.randomUUID(),
        ...(source.groupId ? { groupId: source.groupId } : {}),
        name: copyName(source.name, data.profiles),
        protocol: source.protocol,
        baseUrl: source.baseUrl,
        endpoints: source.endpoints.map((endpoint) => ({
          url: endpoint.url,
          models: [],
          healthHistory: [],
          healthTimeline: [],
        })),
        model: source.model,
        modelRoutes: structuredClone(source.modelRoutes || {}),
        authMode: source.authMode,
        targets: [...source.targets],
        enableToolSearch: source.enableToolSearch,
        autoSwitch: {
          enabled: false,
          intervalMinutes: source.autoSwitch.intervalMinutes,
        },
        routing: profileRouting(source),
        connectionRevision: 1,
        keyHint: source.keyHint,
        encryptedKey: this.vault.encrypt(apiKey),
        createdAt: now,
        updatedAt: now,
      }
      data.profiles.splice(sourceIndex + 1, 0, duplicate)
      await this.store.write(data)
      return toPublicProfile(duplicate)
    })
  }

  /**
   * 从管理库删除方案，不修改已写入客户端的配置。
   *
   * @param {string} id 方案 UUID。
   * @returns {Promise<{ok: boolean}>} 删除结果。
   * @throws UUID 无效或方案不存在时抛出错误。
   */
  async delete(id) {
    const validatedId = profileId(id)
    return this.serial.run(async () => {
      const data = await this.store.read()
      const next = data.profiles.filter((profile) => profile.id !== validatedId)
      if (next.length === data.profiles.length) throw new Error('Profile not found')
      data.profiles = next
      await this.store.write(data)
      return { ok: true }
    })
  }

  /**
   * 原子提交一次全端点检测结果。
   *
   * @param {string} id 方案 UUID。
   * @param {object[]} rawResults 每个 URL 的健康状态和模型列表。
   * @param {number} expectedRevision 发起检测时的连接 revision。
   * @param {{signal?: AbortSignal, shouldContinue?: () => boolean}} options 可选的提交取消条件。
   * @returns {Promise<{profile: object, connectionRevision: number}>} 公开方案和提交后的 revision。
   * @throws 检测期间连接参数变化或提交被停止时拒绝写入旧结果。
   */
  async commitEndpointResults(id, rawResults, expectedRevision, options = {}) {
    const validatedId = profileId(id)
    const revisionResult = ConnectionRevisionSchema.safeParse(expectedRevision)
    if (!revisionResult.success) throw new Error(validationMessage(revisionResult.error))
    const resultsResult = z.array(EndpointProbeResultSchema).max(MAX_PROFILE_ENDPOINTS)
      .safeParse(rawResults)
    if (!resultsResult.success) throw new Error(validationMessage(resultsResult.error))

    return this.serial.run(async () => {
      const data = await this.store.read()
      const index = data.profiles.findIndex((profile) => profile.id === validatedId)
      if (index === -1) throw new Error('Profile not found')
      const current = data.profiles[index]
      if (current.connectionRevision !== revisionResult.data) {
        throw new Error('Profile connection changed while endpoints were being tested')
      }
      assertEndpointCommitActive(options)

      const resultMap = new Map(resultsResult.data.map((result) => [
        comparableUrl(result.url),
        result,
      ]))
      const endpoints = current.endpoints.map((endpoint) => {
        const probe = resultMap.get(comparableUrl(endpoint.url))
        return probe
          ? {
              ...endpoint,
              url: endpoint.url,
              health: probe.health,
              models: [...new Set(probe.models)],
            }
          : endpoint
      })
      const activeEndpoint = endpoints.find((endpoint) => sameUrl(endpoint.url, current.baseUrl))
        || endpoints[0]
      const fallbackEndpoint = activeEndpoint.health?.status === 'unhealthy'
        ? endpoints
          .filter((endpoint) => endpoint.health?.status === 'healthy' && endpoint.models.length > 0)
          .sort((left, right) => left.health.latencyMs - right.health.latencyMs)[0]
        : undefined
      const now = new Date().toISOString()
      const nextModel = current.model
        || activeEndpoint.models[0]
        || fallbackEndpoint?.models[0]
        || ''
      const next = {
        ...current,
        baseUrl: activeEndpoint.url,
        endpoints,
        model: nextModel,
        connectionRevision: current.connectionRevision + (nextModel !== current.model ? 1 : 0),
        modelsCheckedAt: now,
        updatedAt: now,
      }
      if (activeEndpoint.health) next.health = activeEndpoint.health
      else delete next.health
      data.profiles[index] = next
      assertEndpointCommitActive(options)
      await this.store.write(data)
      return {
        profile: toPublicProfile(next),
        connectionRevision: next.connectionRevision,
      }
    })
  }

  /**
   * 原子提交检测结果并仅返回公开方案。
   *
   * @param {string} id 方案 UUID。
   * @param {object[]} rawResults 每个 URL 的健康状态和模型列表。
   * @param {number} expectedRevision 发起检测时的连接 revision。
   * @returns {Promise<object>} 更新后的公开方案。
   */
  async updateEndpointResults(id, rawResults, expectedRevision) {
    const committed = await this.commitEndpointResults(id, rawResults, expectedRevision)
    return committed.profile
  }

  /**
   * 原子提交无凭据 URL 健康探测，并维护每个端点最近一小时的滚动样本。
   *
   * 此路径不会修改模型列表、modelsCheckedAt 或连接 revision。这样后台测速不会
   * 冒充手动模型识别，也不会使正在进行的网关连接快照失效。
   *
   * @param {string} id 方案 UUID。
   * @param {object[]} rawResults 每个 URL 的健康探测结果。
   * @param {number} expectedRevision 发起探测时的连接 revision。
   * @param {{signal?: AbortSignal, shouldContinue?: () => boolean}} options 可选提交取消条件。
   * @returns {Promise<{profile: object, connectionRevision: number}>} 公开方案与原 revision。
   */
  async commitEndpointHealthResults(id, rawResults, expectedRevision, options = {}) {
    const validatedId = profileId(id)
    const revisionResult = ConnectionRevisionSchema.safeParse(expectedRevision)
    if (!revisionResult.success) throw new Error(validationMessage(revisionResult.error))
    const resultsResult = z.array(EndpointHealthProbeResultSchema).max(MAX_PROFILE_ENDPOINTS)
      .safeParse(rawResults)
    if (!resultsResult.success) throw new Error(validationMessage(resultsResult.error))

    return this.serial.run(async () => {
      const data = await this.store.read()
      const index = data.profiles.findIndex((profile) => profile.id === validatedId)
      if (index === -1) throw new Error('Profile not found')
      const current = data.profiles[index]
      if (current.connectionRevision !== revisionResult.data) {
        throw new Error('Profile connection changed while endpoints were being tested')
      }
      assertEndpointCommitActive(options)

      const now = Date.now()
      const resultMap = new Map(resultsResult.data.map((result) => [
        comparableUrl(result.url),
        result,
      ]))
      const endpoints = current.endpoints.map((endpoint) => {
        const probe = resultMap.get(comparableUrl(endpoint.url))
        if (!probe) return endpoint
        return {
          ...endpoint,
          health: probe.health,
          healthHistory: appendHealthSample(endpoint.healthHistory, probe.health, now),
          healthTimeline: appendHealthTimeline(
            endpoint.healthTimeline?.length ? endpoint.healthTimeline : endpoint.healthHistory,
            probe.health,
            now,
          ),
        }
      })
      const activeEndpoint = endpoints.find((endpoint) => sameUrl(endpoint.url, current.baseUrl))
        || endpoints[0]
      const next = {
        ...current,
        endpoints,
        updatedAt: new Date(now).toISOString(),
      }
      if (activeEndpoint.health) next.health = activeEndpoint.health
      else delete next.health
      data.profiles[index] = next
      assertEndpointCommitActive(options)
      await this.store.write(data)
      return {
        profile: toPublicProfile(next),
        connectionRevision: next.connectionRevision,
      }
    })
  }

  /**
   * 保存活动 URL 的单次健康状态，兼容仅测试一个端点的内部调用。
   *
   * @param {string} id 方案 UUID。
   * @param {object} health 已规范化的检测结果。
   * @returns {Promise<object>} 更新后的公开方案。
   */
  async updateHealth(id, health) {
    const profile = await this.getStored(id)
    const committed = await this.commitEndpointHealthResults(id, [{
      url: profile.baseUrl,
      health,
    }], profile.connectionRevision)
    return committed.profile
  }

  /**
   * 更新仅供权重路由使用的公开方案策略。
   *
   * 识别到的模型仍由端点检测维护；这里保存的是用户明确禁用的模型集合，
   * 因而后续识别到新模型时不会把它误判成用户已经选择的旧模型。
   */
  async updateRouting(id, rawRouting) {
    const validatedId = profileId(id)
    const routingResult = z.object({
      enabled: z.boolean(),
      enabledModels: z.array(z.string().trim().min(1).max(240)).max(MAX_DISCOVERED_MODELS),
      weight: z.number().int().min(0).max(1_000_000),
      autoDisableOnFailure: z.boolean(),
    }).safeParse(rawRouting)
    if (!routingResult.success) throw new Error(validationMessage(routingResult.error))

    return this.serial.run(async () => {
      const data = await this.store.read()
      const index = data.profiles.findIndex((profile) => profile.id === validatedId)
      if (index === -1) throw new Error('Profile not found')
      const current = data.profiles[index]
      const knownModels = new Set(current.endpoints.flatMap((endpoint) => endpoint.models || []))
      const enabledModels = [...new Set(routingResult.data.enabledModels)]
        .filter((model) => knownModels.has(model))
      const next = {
        ...current,
        routing: {
          ...profileRouting(current),
          enabled: routingResult.data.enabled,
          disabledModels: [...knownModels].filter((model) => !enabledModels.includes(model)),
          weight: routingResult.data.weight,
          autoDisableOnFailure: routingResult.data.autoDisableOnFailure,
        },
        updatedAt: new Date().toISOString(),
      }
      data.profiles[index] = next
      await this.store.write(data)
      return toPublicProfile(next)
    })
  }

  /**
   * 条件式切换当前活动 URL。
   *
   * @param {string} id 方案 UUID。
   * @param {string} rawUrl 必须已存在于方案 URL 池中的地址。
   * @param {{expectedBaseUrl?: string, expectedRevision?: number}} conditions 并发保护条件。
   * @returns {Promise<{profile: object, connectionRevision: number}>} 切换后的公开方案和 revision。
   * @throws 条件不再成立或 URL 不属于方案时拒绝切换。
   */
  async setActiveEndpoint(id, rawUrl, conditions = {}) {
    const validatedId = profileId(id)
    const urlResult = HttpUrlSchema.safeParse(rawUrl)
    if (!urlResult.success) throw new Error(validationMessage(urlResult.error))

    return this.serial.run(async () => {
      const data = await this.store.read()
      const index = data.profiles.findIndex((profile) => profile.id === validatedId)
      if (index === -1) throw new Error('Profile not found')
      const current = data.profiles[index]
      if (conditions.expectedRevision !== undefined
        && current.connectionRevision !== conditions.expectedRevision) {
        throw new Error('Profile connection changed before the endpoint switch')
      }
      if (conditions.expectedBaseUrl
        && !sameUrl(current.baseUrl, conditions.expectedBaseUrl)) {
        throw new Error('The active endpoint changed before the endpoint switch')
      }
      const endpoint = endpointFor(current, urlResult.data)
      if (!endpoint) throw new Error('Endpoint does not belong to this profile')

      const next = {
        ...current,
        baseUrl: endpoint.url,
        connectionRevision: current.connectionRevision + (sameUrl(current.baseUrl, endpoint.url) ? 0 : 1),
        updatedAt: new Date().toISOString(),
      }
      if (endpoint.health) next.health = endpoint.health
      else delete next.health
      data.profiles[index] = next
      await this.store.write(data)
      return {
        profile: toPublicProfile(next),
        connectionRevision: next.connectionRevision,
      }
    })
  }

  /**
   * 在方案修改互斥区内读取并使用稳定连接快照。
   *
   * operation 执行期间保存、删除、检测提交和活动 URL 切换都会等待。调用方必须
   * 使用传入的 markApplied 更新最近写入时间，不得在 operation 内再次调用本服务
   * 的修改方法，避免同一串行器重入。
   *
   * @param {string} id 方案 UUID。
   * @param {number | undefined} expectedRevision 可选的决策 revision。
   * @param {(context: {profile: object, apiKey: string, markApplied: (appliedAt: string) => Promise<void>}) => Promise<unknown>} operation 受保护操作。
   * @returns {Promise<unknown>} operation 的返回值。
   */
  async withConnectionLock(id, expectedRevision, operation) {
    const validatedId = profileId(id)
    if (expectedRevision !== undefined) {
      const revisionResult = ConnectionRevisionSchema.safeParse(expectedRevision)
      if (!revisionResult.success) throw new Error(validationMessage(revisionResult.error))
    }
    if (typeof operation !== 'function') throw new Error('Connection operation must be a function')

    return this.serial.run(async () => {
      const data = await this.store.read()
      const index = data.profiles.findIndex((profile) => profile.id === validatedId)
      if (index === -1) throw new Error('Profile not found')
      const profile = data.profiles[index]
      if (expectedRevision !== undefined && profile.connectionRevision !== expectedRevision) {
        throw new Error('Profile connection changed before configuration could be written')
      }
      const apiKey = this.vault.decrypt(profile.encryptedKey)
      const markApplied = async (appliedAt) => {
        data.profiles[index] = {
          ...data.profiles[index],
          lastAppliedAt: appliedAt,
          updatedAt: appliedAt,
        }
        await this.store.write(data)
      }
      return operation({ profile, apiKey, markApplied })
    })
  }

  /**
   * 按给定顺序重排方案列表。
   *
   * 未出现在 ids 中的方案保持原有相对顺序追加在末尾，重排不修改任何方案内容。
   *
   * @param {string[]} rawIds 期望的方案 UUID 顺序。
   * @returns {Promise<object[]>} 重排后的公开方案列表。
   */
  async reorder(rawIds) {
    const idsResult = z.array(ProfileIdSchema).max(500).safeParse(rawIds)
    if (!idsResult.success) throw new Error(validationMessage(idsResult.error))
    const ids = idsResult.data

    return this.serial.run(async () => {
      const data = await this.store.read()
      const byId = new Map(data.profiles.map((profile) => [profile.id, profile]))
      const ordered = []
      for (const id of ids) {
        const profile = byId.get(id)
        if (!profile) continue
        byId.delete(id)
        ordered.push(profile)
      }
      for (const profile of data.profiles) {
        if (byId.has(profile.id)) ordered.push(profile)
      }
      data.profiles = ordered
      await this.store.write(data)
      return ordered.map(toPublicProfile)
    })
  }

  /**
   * 累加方案的历史 Token 用量与缓存统计。
   *
   * 由请求监控在每次请求结束时调用；方案不存在或增量无效时静默忽略，
   * 统计失败不得影响网关转发。
   *
   * @param {string} id 方案 UUID。
   * @param {object} usage 本次请求的 Token 计量（totalTokens/inputTokens/cachedTokens）。
   * @returns {Promise<void>} 持久化完成后的 Promise。
   */
  async addTokenUsage(id, usage) {
    const idResult = ProfileIdSchema.safeParse(id)
    const positive = (value) => (Number.isFinite(value) && value > 0 ? value : 0)
    const total = positive(usage?.totalTokens)
      || positive(usage?.inputTokens) + positive(usage?.outputTokens)
    // usage 已在 request-monitor 里归一化：inputTokens 含缓存读写，三家口径一致
    const input = positive(usage?.inputTokens)
    const cached = positive(usage?.cachedTokens)
    const cacheWrite = positive(usage?.cacheWriteTokens)
    // reasoning 本来就含在 output 里，只单独统计用于显示，绝不再加进 total
    const reasoning = positive(usage?.reasoningTokens)
    if (!idResult.success || total + input + cached + cacheWrite <= 0) return
    return this.serial.run(async () => {
      const data = await this.store.read()
      const index = data.profiles.findIndex((profile) => profile.id === idResult.data)
      if (index === -1) return
      const current = data.profiles[index]
      // 当日用量按本地日期归零：跨过 0 点后第一次记账时重新计数。
      const today = localDateKey()
      const sameDay = current.tokenDayKey === today
      data.profiles[index] = {
        ...current,
        tokenUsageTotal: Math.round((current.tokenUsageTotal || 0) + total),
        tokenInputTotal: Math.round((current.tokenInputTotal || 0) + input),
        tokenCachedTotal: Math.round((current.tokenCachedTotal || 0) + cached),
        tokenCacheWriteTotal: Math.round((current.tokenCacheWriteTotal || 0) + cacheWrite),
        tokenReasoningTotal: Math.round((current.tokenReasoningTotal || 0) + reasoning),
        tokenDayKey: today,
        tokenUsageToday: Math.round((sameDay ? current.tokenUsageToday || 0 : 0) + total),
      }
      await this.store.write(data)
    })
  }

  /**
   * 记录方案最近一次成功写入时间。
   *
   * @param {string} id 方案 UUID。
   * @param {string} appliedAt ISO 时间。
   * @returns {Promise<void>} 持久化完成后的 Promise。
   */
  async markApplied(id, appliedAt) {
    const validatedId = profileId(id)
    return this.serial.run(async () => {
      const data = await this.store.read()
      const index = data.profiles.findIndex((profile) => profile.id === validatedId)
      if (index === -1) return
      data.profiles[index] = {
        ...data.profiles[index],
        lastAppliedAt: appliedAt,
        updatedAt: appliedAt,
      }
      await this.store.write(data)
    })
  }
}

module.exports = {
  HEALTH_HISTORY_WINDOW_MS,
  localDateKey,
  HEALTH_TIMELINE_WINDOW_MS,
  MAX_HEALTH_HISTORY,
  MAX_HEALTH_TIMELINE,
  ProfileService,
  appendHealthSample,
  comparableUrl,
}
