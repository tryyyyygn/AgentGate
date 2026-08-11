const electronUpdater = require('electron-updater')

const RELEASE_DOWNLOAD_URL = 'https://github.com/tryyyyyygn/AgentGate/releases/latest'

/** 便携版无法就地替换自身，只能引导用户手动下载。 */
const PORTABLE = Boolean(process.env.PORTABLE_EXECUTABLE_FILE)

const STATE = Object.freeze({
  IDLE: 'idle',
  CHECKING: 'checking',
  AVAILABLE: 'available',
  DOWNLOADING: 'downloading',
  READY: 'ready',
  UP_TO_DATE: 'up-to-date',
  ERROR: 'error',
})

/**
 * 管理 GitHub Releases 上的应用更新。
 *
 * NSIS 安装版支持后台下载与重启安装；便携版只报告新版本，由用户自行下载。
 * 所有网络错误都转换为公开状态，不会中断应用运行。
 */
class UpdateService {
  constructor({ app, shell, onChanged, updater, portable = PORTABLE } = {}) {
    if (!app) throw new Error('UpdateService requires app')
    this.app = app
    this.shell = shell
    this.onChanged = onChanged
    this.updater = updater || electronUpdater.autoUpdater
    this.portable = portable
    this.state = {
      state: STATE.IDLE,
      currentVersion: app.getVersion(),
      portable,
    }

    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = true
    this.updater.on('checking-for-update', () => this._set({ state: STATE.CHECKING }))
    this.updater.on('update-available', (info) => this._set({
      state: STATE.AVAILABLE,
      version: info?.version,
      releaseNotes: typeof info?.releaseNotes === 'string' ? info.releaseNotes : undefined,
      releaseUrl: RELEASE_DOWNLOAD_URL,
    }))
    this.updater.on('update-not-available', () => this._set({ state: STATE.UP_TO_DATE }))
    this.updater.on('download-progress', (progress) => this._set({
      state: STATE.DOWNLOADING,
      percent: Math.round(progress?.percent || 0),
    }))
    this.updater.on('update-downloaded', (info) => this._set({
      state: STATE.READY,
      version: info?.version,
      percent: 100,
    }))
    this.updater.on('error', (error) => this._set({
      state: STATE.ERROR,
      message: String(error?.message || error || '更新检查失败'),
    }))
  }

  getPublicState() {
    return { ...this.state }
  }

  /**
   * 检查 GitHub Releases 上是否有新版本。
   *
   * @returns {Promise<object>} 检查后的公开状态；失败时状态为 error，不抛出。
   */
  async check() {
    if (!this.app.isPackaged) {
      this._set({ state: STATE.IDLE, message: '开发模式不检查更新' })
      return this.getPublicState()
    }
    if (this.state.state === STATE.CHECKING || this.state.state === STATE.DOWNLOADING) {
      return this.getPublicState()
    }
    try {
      this._set({ state: STATE.CHECKING })
      await this.updater.checkForUpdates()
    } catch (error) {
      this._set({ state: STATE.ERROR, message: String(error?.message || error) })
    }
    return this.getPublicState()
  }

  /**
   * 下载已发现的更新。便携版改为打开下载页面。
   *
   * @returns {Promise<object>} 下载开始后的公开状态。
   */
  async download() {
    if (this.portable) {
      if (!this.shell?.openExternal) throw new Error('Download page is unavailable')
      await this.shell.openExternal(this.state.releaseUrl || RELEASE_DOWNLOAD_URL)
      return this.getPublicState()
    }
    if (this.state.state === STATE.DOWNLOADING) return this.getPublicState()
    if (this.state.state !== STATE.AVAILABLE) return this.getPublicState()
    try {
      this._set({ state: STATE.DOWNLOADING, percent: 0 })
      await this.updater.downloadUpdate()
    } catch (error) {
      this._set({ state: STATE.ERROR, message: String(error?.message || error) })
    }
    return this.getPublicState()
  }

  /**
   * 退出并安装已下载的更新。
   *
   * 调用方负责先停止网关并恢复客户端配置。
   */
  quitAndInstall() {
    if (this.portable || this.state.state !== STATE.READY) return false
    try {
      this.updater.quitAndInstall()
      return true
    } catch {
      return false
    }
  }

  _set(patch) {
    this.state = { ...this.state, ...patch }
    if (typeof this.onChanged === 'function') {
      try {
        this.onChanged(this.getPublicState())
      } catch {
        // 更新状态推送失败不影响应用。
      }
    }
  }
}

module.exports = {
  RELEASE_DOWNLOAD_URL,
  PORTABLE,
  STATE,
  UpdateService,
}
