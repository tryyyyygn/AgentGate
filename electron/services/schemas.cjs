const { z } = require('zod')

const TARGET = Object.freeze({
  CLAUDE: 'claude',
  CLAUDE_DESKTOP: 'claude-desktop',
  CODEX: 'codex',
  OPENCODE: 'opencode',
  GEMINI: 'gemini',
})
const PROTOCOL = Object.freeze({
  ANTHROPIC: 'anthropic',
  OPENAI_RESPONSES: 'openai-responses',
  OPENAI_CHAT: 'openai-chat',
  GEMINI: 'gemini',
})
const AUTH_MODE = Object.freeze({
  API_KEY: 'api-key',
  BEARER: 'bearer',
})
const DEFAULT_AUTO_SWITCH_INTERVAL_MINUTES = 2
const MAX_PROFILE_ENDPOINTS = 20
const MAX_DISCOVERED_MODELS = 1_000
const MAX_MODEL_ROUTES = 64
const MAX_HEALTH_HISTORY = 30
const MAX_HEALTH_TIMELINE = 60
const TARGETS = Object.freeze(Object.values(TARGET))
const PROTOCOLS = Object.freeze(Object.values(PROTOCOL))
const EXISTING_PROFILE_GROUP_ID = '00000000-0000-4000-8000-000000000001'
const MIGRATED_GROUP_TIMESTAMP = '1970-01-01T00:00:00.000Z'

const TargetSchema = z.enum(TARGETS)
const ProtocolSchema = z.enum(PROTOCOLS)
const AuthModeSchema = z.enum(Object.values(AUTH_MODE))

/**
 * 规范化 HTTP(S) URL，同时保留查询参数和值中的尾斜杠。
 *
 * @param {string} value 已通过基础 URL 校验的字符串。
 * @returns {string} 主机名和 pathname 尾斜杠已规范化的 URL。
 */
function normalizeHttpUrl(value) {
  const url = new URL(value.trim())
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  url.hash = ''
  const normalized = url.toString()
  return url.pathname === '/' && !url.search ? normalized.replace(/\/$/, '') : normalized
}

const HttpUrlSchema = z
  .string()
  .trim()
  .min(1, 'Base URL is required')
  .max(2048, 'Base URL is too long')
  .url('Base URL must be a valid URL')
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol
      return protocol === 'http:' || protocol === 'https:'
    } catch {
      return false
    }
  }, 'Base URL must use HTTP or HTTPS')

const HealthSchema = z.object({
  status: z.enum(['healthy', 'limited', 'unhealthy']),
  latencyMs: z.number().int().nonnegative(),
  checkedAt: z.string(),
  reachable: z.boolean().optional(),
  statusCode: z.number().int().optional(),
  errorType: z.enum(['timeout', 'tls', 'network']).optional(),
  message: z.string().max(240),
})

const HealthHistorySchema = z.array(HealthSchema).max(MAX_HEALTH_HISTORY)
const HealthTimelineSchema = z.array(HealthSchema).max(MAX_HEALTH_TIMELINE)

const EndpointInputSchema = z.object({
  url: HttpUrlSchema,
})

const StoredEndpointSchema = EndpointInputSchema.extend({
  health: HealthSchema.optional(),
  healthHistory: HealthHistorySchema.optional().default([]),
  healthTimeline: HealthTimelineSchema.optional().default([]),
  models: z.array(z.string().trim().min(1).max(240))
    .max(MAX_DISCOVERED_MODELS)
    .optional()
    .default([]),
})

const AutoSwitchSettingsSchema = z.object({
  enabled: z.boolean().optional().default(false),
  intervalMinutes: z.number().int().min(1).max(1_440)
    .optional()
    .default(DEFAULT_AUTO_SWITCH_INTERVAL_MINUTES),
})

const ProfileRoutingSchema = z.object({
  enabled: z.boolean().default(true),
  disabledModels: z.array(z.string().trim().min(1).max(240))
    .max(MAX_DISCOVERED_MODELS)
    .default([]),
  weight: z.number().int().min(0).max(1_000_000).default(0),
  autoDisableOnFailure: z.boolean().default(false),
})

const ModelRouteTargetSchema = z.object({
  model: z.string().trim().min(1).max(240),
  labelOverride: z.string().trim().min(1).max(240).optional(),
  supports1m: z.boolean().optional(),
})

const ModelRoutesSchema = z.record(
  z.string().trim().min(1).max(240),
  ModelRouteTargetSchema,
).refine((value) => Object.keys(value).length <= MAX_MODEL_ROUTES, {
  message: 'Too many model routes',
})

function refineConnectionUrls(value, context) {
  const connectionUrls = [value.baseUrl, ...(value.endpoints || []).map((endpoint) => endpoint.url)]
  for (const [index, rawUrl] of connectionUrls.entries()) {
    const url = new URL(rawUrl)
    if (url.username || url.password || url.hash) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: index === 0 ? ['baseUrl'] : ['endpoints', index - 1, 'url'],
        message: 'Endpoint URLs cannot contain credentials or fragments',
      })
    }
  }

  const normalizedEndpoints = (value.endpoints || [{ url: value.baseUrl }])
    .map((endpoint) => normalizeHttpUrl(endpoint.url))
  if (new Set(normalizedEndpoints).size !== normalizedEndpoints.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endpoints'],
      message: 'Endpoint URLs must be unique',
    })
  }
}

const ProfileConnectionSchema = z.object({
  id: z.string().uuid().optional(),
  protocol: ProtocolSchema,
  baseUrl: HttpUrlSchema,
  endpoints: z.array(EndpointInputSchema).min(1).max(MAX_PROFILE_ENDPOINTS).optional(),
  apiKey: z.string().max(32768).optional(),
  authMode: AuthModeSchema,
}).superRefine((value, context) => {
  if (!value.id && !value.apiKey?.trim()) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['apiKey'],
      message: 'API key is required for a new profile',
    })
  }
  refineConnectionUrls(value, context)
})

const SaveProfileSchema = z.object({
  id: z.string().uuid().optional(),
  groupId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1, 'Name is required').max(80),
  protocol: ProtocolSchema,
  baseUrl: HttpUrlSchema,
  endpoints: z.array(EndpointInputSchema).min(1).max(MAX_PROFILE_ENDPOINTS).optional(),
  apiKey: z.string().max(32768).optional(),
  model: z.string().trim().max(240),
  modelRoutes: ModelRoutesSchema.optional().default({}),
  authMode: AuthModeSchema,
  targets: z.array(TargetSchema).max(TARGETS.length).default([]),
  enableToolSearch: z.boolean().optional().default(false),
  autoSwitch: AutoSwitchSettingsSchema.optional().default({
    enabled: false,
    intervalMinutes: DEFAULT_AUTO_SWITCH_INTERVAL_MINUTES,
  }),
}).superRefine((value, context) => {
  const compatibleTargets = {
    [PROTOCOL.ANTHROPIC]: [TARGET.CLAUDE, TARGET.CLAUDE_DESKTOP, TARGET.OPENCODE],
    [PROTOCOL.OPENAI_RESPONSES]: [TARGET.CODEX, TARGET.OPENCODE],
    [PROTOCOL.OPENAI_CHAT]: [TARGET.CODEX, TARGET.OPENCODE],
    [PROTOCOL.GEMINI]: [TARGET.GEMINI, TARGET.OPENCODE],
  }[value.protocol]

  if (!value.id && !value.apiKey?.trim()) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['apiKey'],
      message: 'API key is required for a new profile',
    })
  }
  if (value.targets.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targets'],
      message: 'Select at least one client',
    })
  }
  for (const target of value.targets) {
    if (!compatibleTargets.includes(target)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targets'],
        message: `${target} is not compatible with ${value.protocol}`,
      })
    }
  }

  refineConnectionUrls(value, context)
})

const LegacyStoredProfileSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  protocol: ProtocolSchema,
  baseUrl: HttpUrlSchema,
  model: z.string(),
  authMode: AuthModeSchema,
  targets: z.array(TargetSchema),
  enableToolSearch: z.boolean().default(false),
  keyHint: z.string(),
  encryptedKey: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastAppliedAt: z.string().optional(),
  health: HealthSchema.optional(),
})

const StoredProfileSchema = LegacyStoredProfileSchema.extend({
  groupId: z.string().uuid().optional(),
  endpoints: z.array(StoredEndpointSchema).min(1).max(MAX_PROFILE_ENDPOINTS),
  autoSwitch: AutoSwitchSettingsSchema,
  routing: ProfileRoutingSchema.default(() => ({
    enabled: true,
    disabledModels: [],
    weight: 0,
    autoDisableOnFailure: false,
  })),
  modelRoutes: ModelRoutesSchema.default({}),
  connectionRevision: z.number().int().positive(),
  modelsCheckedAt: z.string().optional(),
  tokenUsageTotal: z.number().int().nonnegative().optional(),
  tokenInputTotal: z.number().int().nonnegative().optional(),
  tokenCachedTotal: z.number().int().nonnegative().optional(),
  tokenCacheWriteTotal: z.number().int().nonnegative().optional(),
  tokenReasoningTotal: z.number().int().nonnegative().optional(),
  tokenDayKey: z.string().optional(),
  tokenUsageToday: z.number().int().nonnegative().optional(),
})

const LegacyProfileStoreSchema = z.object({
  version: z.literal(1),
  profiles: z.array(LegacyStoredProfileSchema),
})

const ProfileGroupSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

const VersionTwoProfileStoreSchema = z.object({
  version: z.literal(2),
  profiles: z.array(StoredProfileSchema),
})

const CurrentProfileStoreSchema = z.object({
  version: z.literal(4),
  groups: z.array(ProfileGroupSchema).max(500),
  profiles: z.array(StoredProfileSchema),
})

const VersionThreeProfileStoreSchema = z.object({
  version: z.literal(3),
  groups: z.array(ProfileGroupSchema).max(500),
  profiles: z.array(StoredProfileSchema),
})

function migrateProfilesToGroups(profiles) {
  if (profiles.length === 0) return { version: 3, groups: [], profiles }
  return {
    version: 3,
    groups: [{
      id: EXISTING_PROFILE_GROUP_ID,
      name: '现有密钥',
      createdAt: MIGRATED_GROUP_TIMESTAMP,
      updatedAt: MIGRATED_GROUP_TIMESTAMP,
    }],
    profiles: profiles.map((profile) => ({
      ...profile,
      groupId: EXISTING_PROFILE_GROUP_ID,
    })),
  }
}

// v3 的 claude 目标同时覆盖 CLI 和桌面端；v4 拆出 claude-desktop 后，
// anthropic 方案补上桌面目标以保持拆分前的服务范围。
function migrateProfilesToDesktopTarget(store) {
  return {
    ...store,
    version: 4,
    profiles: store.profiles.map((profile) => {
      if (profile.protocol !== PROTOCOL.ANTHROPIC) return profile
      if (!profile.targets.includes(TARGET.CLAUDE)) return profile
      if (profile.targets.includes(TARGET.CLAUDE_DESKTOP)) return profile
      const targets = [...profile.targets]
      targets.splice(targets.indexOf(TARGET.CLAUDE) + 1, 0, TARGET.CLAUDE_DESKTOP)
      return { ...profile, targets }
    }),
  }
}

const ProfileStoreSchema = z.union([
  CurrentProfileStoreSchema,
  VersionThreeProfileStoreSchema.transform(migrateProfilesToDesktopTarget),
  VersionTwoProfileStoreSchema.transform((store) => migrateProfilesToDesktopTarget(
    migrateProfilesToGroups(store.profiles),
  )),
  LegacyProfileStoreSchema.transform((store) => migrateProfilesToDesktopTarget(
    migrateProfilesToGroups(store.profiles.map((profile) => ({
      ...profile,
      endpoints: [{
        url: profile.baseUrl,
        models: [],
        healthHistory: [],
        healthTimeline: [],
        ...(profile.health ? { health: profile.health } : {}),
      }],
      autoSwitch: {
        enabled: false,
        intervalMinutes: DEFAULT_AUTO_SWITCH_INTERVAL_MINUTES,
      },
      connectionRevision: 1,
    }))),
  )),
])

const HistoryChangeSchema = z.object({
  target: TargetSchema,
  path: z.string(),
  existed: z.boolean(),
  beforeHash: z.string(),
  afterHash: z.string(),
})

const HistoryEntrySchema = z.object({
  id: z.string().uuid(),
  profileId: z.string().uuid(),
  profileName: z.string(),
  appliedConnectionRevision: z.number().int().positive().optional(),
  targets: z.array(TargetSchema),
  createdAt: z.string(),
  status: z.enum(['applied', 'undone', 'superseded', 'rolled-back', 'failed']),
  source: z.enum(['manual', 'auto']).optional().default('manual'),
  connectionMode: z.enum(['direct', 'gateway']).optional().default('direct'),
  changes: z.array(HistoryChangeSchema),
  backupFile: z.string(),
  undoneAt: z.string().optional(),
  failureMessage: z.string().max(240).optional(),
})

const HistoryStoreSchema = z.object({
  version: z.literal(1),
  entries: z.array(HistoryEntrySchema),
})

const BackupFileSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  createdAt: z.string(),
  files: z.array(z.object({
    path: z.string(),
    existed: z.boolean(),
    encryptedContent: z.string(),
  })),
})

/**
 * 移除仅允许主进程持有的密钥密文。
 *
 * @param {object} profile 持久化方案。
 * @returns {object} 可安全返回渲染进程的方案。
 */
function toPublicProfile(profile) {
  const {
    encryptedKey,
    connectionRevision,
    health: storedHealth,
    ...publicProfile
  } = profile
  const endpoints = profile.endpoints?.length
    ? profile.endpoints
    : [{
        url: profile.baseUrl,
        models: [],
        healthHistory: [],
        healthTimeline: [],
        ...(storedHealth ? { health: storedHealth } : {}),
      }]
  const activeEndpoint = endpoints.find((endpoint) => (
    endpoint.url.replace(/\/+$/, '') === profile.baseUrl.replace(/\/+$/, '')
  )) || endpoints[0]

  const routing = ProfileRoutingSchema.parse(profile.routing || {})
  const disabledModels = new Set(routing.disabledModels)
  const enabledModels = (activeEndpoint.models || []).filter((model) => !disabledModels.has(model))
  return {
    ...publicProfile,
    baseUrl: activeEndpoint.url,
    endpoints,
    autoSwitch: profile.autoSwitch || {
      enabled: false,
      intervalMinutes: DEFAULT_AUTO_SWITCH_INTERVAL_MINUTES,
    },
    availableModels: activeEndpoint.models || [],
    routing: {
      enabled: routing.enabled,
      enabledModels,
      weight: routing.weight,
      autoDisableOnFailure: routing.autoDisableOnFailure,
    },
    ...(activeEndpoint.health ? { health: activeEndpoint.health } : {}),
  }
}

/**
 * 将内部事务记录投影为不含路径和备份位置的公开历史。
 *
 * @param {object} entry 内部历史记录。
 * @returns {object} 可安全返回渲染进程的历史摘要。
 */
function toPublicHistory(entry) {
  const success = !['rolled-back', 'failed'].includes(entry.status)
  const message = entry.failureMessage
    || (entry.status === 'undone' ? 'The configuration change was undone' : undefined)
    || (entry.status === 'superseded' ? 'A newer write replaced this configuration state' : undefined)
  return {
    id: entry.id,
    profileId: entry.profileId,
    profileName: entry.profileName,
    targets: entry.targets,
    createdAt: entry.createdAt,
    status: entry.status,
    source: entry.source || 'manual',
    success,
    canUndo: entry.status === 'applied' && entry.connectionMode !== 'gateway',
    connectionMode: entry.connectionMode || 'direct',
    ...(message ? { message } : {}),
  }
}

/**
 * 将 Zod 结构化问题合并为适合 IPC 展示的单行错误。
 *
 * @param {object} error Zod 错误。
 * @returns {string} 包含字段路径的错误文本。
 */
function validationMessage(error) {
  if (!error || !Array.isArray(error.issues)) return 'Invalid input'
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
    .join('; ')
}

module.exports = {
  TARGET,
  PROTOCOL,
  AUTH_MODE,
  DEFAULT_AUTO_SWITCH_INTERVAL_MINUTES,
  MAX_PROFILE_ENDPOINTS,
  MAX_HEALTH_HISTORY,
  MAX_HEALTH_TIMELINE,
  TARGETS,
  PROTOCOLS,
  TargetSchema,
  ProtocolSchema,
  HttpUrlSchema,
  HealthSchema,
  HealthHistorySchema,
  StoredEndpointSchema,
  AutoSwitchSettingsSchema,
  ProfileRoutingSchema,
  ModelRoutesSchema,
  ProfileConnectionSchema,
  normalizeHttpUrl,
  SaveProfileSchema,
  StoredProfileSchema,
  ProfileGroupSchema,
  ProfileStoreSchema,
  HistoryEntrySchema,
  HistoryStoreSchema,
  BackupFileSchema,
  toPublicProfile,
  toPublicHistory,
  validationMessage,
}
