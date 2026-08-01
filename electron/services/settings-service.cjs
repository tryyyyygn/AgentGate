const { z } = require('zod')
const { SerialExecutor } = require('./storage.cjs')

const THEME_VALUES = ['system', 'light', 'dark']
const LANGUAGE_VALUES = ['system', 'zh', 'zh-TW', 'ja', 'en']
const SILENT_LAUNCH_FLAG = '--silent'

const FailoverTargetSchema = z.object({
  enabled: z.boolean(),
  profileIds: z.array(z.string().uuid()),
}).strict()

const FailoverSettingsSchema = z.object({
  claude: FailoverTargetSchema.default(() => ({ enabled: false, profileIds: [] })),
  codex: FailoverTargetSchema.default(() => ({ enabled: false, profileIds: [] })),
  opencode: FailoverTargetSchema.default(() => ({ enabled: false, profileIds: [] })),
  gemini: FailoverTargetSchema.default(() => ({ enabled: false, profileIds: [] })),
}).strict()

const FailoverTargetPatchSchema = FailoverTargetSchema.partial().strict()
const FailoverSettingsPatchSchema = z.object({
  claude: FailoverTargetPatchSchema.optional(),
  codex: FailoverTargetPatchSchema.optional(),
  opencode: FailoverTargetPatchSchema.optional(),
  gemini: FailoverTargetPatchSchema.optional(),
}).strict()

const SettingsSchema = z.object({
  version: z.literal(1),
  launchAtLogin: z.boolean(),
  closeToTray: z.boolean(),
  startGatewayOnLaunch: z.boolean(),
  theme: z.enum(THEME_VALUES),
  // 老版本写下的 settings.json 没有这个字段，缺省值让它继续可读。
  language: z.enum(LANGUAGE_VALUES).default('system'),
  failover: FailoverSettingsSchema.default(() => defaultFailoverSettings()),
})

const SettingsPatchSchema = SettingsSchema
  .omit({ version: true, failover: true })
  .partial()
  .extend({ failover: FailoverSettingsPatchSchema.optional() })
  .strict()

function defaultSettings() {
  return {
    version: 1,
    launchAtLogin: false,
    closeToTray: true,
    startGatewayOnLaunch: true,
    theme: 'system',
    language: 'system',
    failover: defaultFailoverSettings(),
  }
}

function defaultFailoverSettings() {
  return {
    claude: { enabled: false, profileIds: [] },
    codex: { enabled: false, profileIds: [] },
    opencode: { enabled: false, profileIds: [] },
    gemini: { enabled: false, profileIds: [] },
  }
}

function parseSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const failover = source.failover && typeof source.failover === 'object' && !Array.isArray(source.failover)
    ? source.failover
    : {}
  return SettingsSchema.parse({
    ...source,
    failover: Object.fromEntries(Object.entries(defaultFailoverSettings()).map(([target, defaults]) => [
      target,
      { ...defaults, ...(failover[target] || {}) },
    ])),
  })
}

class SettingsService {
  constructor({ store, app, onChanged, executablePath, getProfileIds } = {}) {
    if (!store || !app) throw new Error('SettingsService requires store and app')
    this.store = store
    this.app = app
    this.onChanged = onChanged
    this.executablePath = executablePath
      || process.env.PORTABLE_EXECUTABLE_FILE
      || process.execPath
    this.getProfileIds = getProfileIds
    this.serial = new SerialExecutor()
    this.loaded = false
    this.settings = defaultSettings()
    this.knownProfileIds = undefined
  }

  async _refreshKnownProfileIds() {
    if (typeof this.getProfileIds !== 'function') return undefined
    const ids = await this.getProfileIds()
    this.knownProfileIds = new Set(Array.isArray(ids) ? ids : [])
    return this.knownProfileIds
  }

  _normalizeFailover(settings) {
    if (!this.knownProfileIds) return settings
    const failover = Object.fromEntries(Object.entries(settings.failover).map(([target, value]) => [
      target,
      {
        ...value,
        profileIds: value.profileIds.filter((id) => this.knownProfileIds.has(id)),
      },
    ]))
    return { ...settings, failover }
  }

  async initialize() {
    return this.serial.run(async () => {
      if (!this.loaded) {
        await this._refreshKnownProfileIds()
        const parsed = parseSettings(await this.store.read())
        this.settings = this._normalizeFailover(parsed)
        if (JSON.stringify(parsed) !== JSON.stringify(this.settings)) {
          await this.store.write(this.settings)
        }
        this.loaded = true
      }
      this._applyLaunchAtLogin(this.settings.launchAtLogin)
      return this.getPublicSettings()
    })
  }

  getPublicSettings() {
    return structuredClone(this.settings)
  }

  async update(patch) {
    const parsed = SettingsPatchSchema.parse(patch)
    return this.serial.run(async () => {
      if (!this.loaded) {
        await this._refreshKnownProfileIds()
        this.settings = this._normalizeFailover(parseSettings(await this.store.read()))
        this.loaded = true
      }
      const previous = this.settings
      await this._refreshKnownProfileIds()
      const nextInput = {
        ...previous,
        ...parsed,
        version: 1,
      }
      if (parsed.failover) {
        nextInput.failover = Object.fromEntries(Object.keys(defaultFailoverSettings()).map((target) => [
          target,
          { ...previous.failover[target], ...(parsed.failover[target] || {}) },
        ]))
      }
      const next = SettingsSchema.parse(this._normalizeFailover(nextInput))
      if (next.launchAtLogin !== previous.launchAtLogin) {
        this._applyLaunchAtLogin(next.launchAtLogin)
      }
      try {
        this.settings = await this.store.write(next)
      } catch (error) {
        if (next.launchAtLogin !== previous.launchAtLogin) {
          this._applyLaunchAtLogin(previous.launchAtLogin)
        }
        throw error
      }
      if (typeof this.onChanged === 'function') await this.onChanged(this.getPublicSettings())
      return this.getPublicSettings()
    })
  }

  async removeProfileId(profileId) {
    return this.serial.run(async () => {
      if (!this.loaded) {
        await this._refreshKnownProfileIds()
        this.settings = this._normalizeFailover(parseSettings(await this.store.read()))
        this.loaded = true
      }
      const failover = Object.fromEntries(Object.entries(this.settings.failover).map(([target, value]) => [
        target,
        { ...value, profileIds: value.profileIds.filter((id) => id !== profileId) },
      ]))
      const next = SettingsSchema.parse({ ...this.settings, failover })
      if (JSON.stringify(next) === JSON.stringify(this.settings)) return this.getPublicSettings()
      // 方案已经从主数据删除；即使设置文件暂时无法写入，当前进程也不能继续引用它。
      this.settings = next
      this.settings = await this.store.write(next)
      if (typeof this.onChanged === 'function') await this.onChanged(this.getPublicSettings())
      return this.getPublicSettings()
    })
  }

  /**
   * 注册或撤销开机自启。
   *
   * 开机自启带 `--silent`：Windows 登录时拉起的实例直接驻留托盘，不弹出窗口；
   * 用户手动启动（无此参数）仍然正常显示界面。
   */
  _applyLaunchAtLogin(enabled) {
    this.app.setLoginItemSettings({
      openAtLogin: enabled,
      path: this.executablePath,
      args: enabled ? [SILENT_LAUNCH_FLAG] : [],
    })
  }
}

module.exports = {
  SILENT_LAUNCH_FLAG,
  LANGUAGE_VALUES,
  SettingsSchema,
  SettingsPatchSchema,
  defaultSettings,
  SettingsService,
}
