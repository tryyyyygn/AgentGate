const { z } = require('zod')
const { SerialExecutor } = require('./storage.cjs')

const THEME_VALUES = ['system', 'light', 'dark']
const LANGUAGE_VALUES = ['system', 'zh', 'zh-TW', 'ja', 'en']
const SILENT_LAUNCH_FLAG = '--silent'

const SettingsSchema = z.object({
  version: z.literal(1),
  launchAtLogin: z.boolean(),
  closeToTray: z.boolean(),
  startGatewayOnLaunch: z.boolean(),
  theme: z.enum(THEME_VALUES),
  // 老版本写下的 settings.json 没有这个字段，缺省值让它继续可读。
  language: z.enum(LANGUAGE_VALUES).default('system'),
})

const SettingsPatchSchema = SettingsSchema.omit({ version: true }).partial().strict()

function defaultSettings() {
  return {
    version: 1,
    launchAtLogin: false,
    closeToTray: true,
    startGatewayOnLaunch: true,
    theme: 'system',
    language: 'system',
  }
}

class SettingsService {
  constructor({ store, app, onChanged, executablePath } = {}) {
    if (!store || !app) throw new Error('SettingsService requires store and app')
    this.store = store
    this.app = app
    this.onChanged = onChanged
    this.executablePath = executablePath
      || process.env.PORTABLE_EXECUTABLE_FILE
      || process.execPath
    this.serial = new SerialExecutor()
    this.loaded = false
    this.settings = defaultSettings()
  }

  async initialize() {
    return this.serial.run(async () => {
      if (!this.loaded) {
        this.settings = SettingsSchema.parse(await this.store.read())
        this.loaded = true
      }
      this._applyLaunchAtLogin(this.settings.launchAtLogin)
      return this.getPublicSettings()
    })
  }

  getPublicSettings() {
    return { ...this.settings }
  }

  async update(patch) {
    const parsed = SettingsPatchSchema.parse(patch)
    return this.serial.run(async () => {
      if (!this.loaded) {
        this.settings = SettingsSchema.parse(await this.store.read())
        this.loaded = true
      }
      const previous = this.settings
      const next = SettingsSchema.parse({ ...previous, ...parsed, version: 1 })
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
