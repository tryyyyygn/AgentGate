const crypto = require('node:crypto')

const SESSION_POLL_MS = 500
const SESSION_RETRY_MS = 5_000
const OAUTH_START_PATH = /\/api\/v1\/auth\/oauth\/[^/]+\/start\/?$/
const SUB2API_SESSION_SCRIPT = `(() => {
  const accessToken = localStorage.getItem('auth_token')?.trim() || '';
  const rawUser = localStorage.getItem('auth_user');
  if (!accessToken || !rawUser) return null;

  let user;
  try {
    user = JSON.parse(rawUser);
  } catch {
    return null;
  }
  if (!user || typeof user !== 'object') return null;

  const refreshToken = localStorage.getItem('refresh_token')?.trim() || '';
  const expiresValue = Number(localStorage.getItem('token_expires_at'));
  const userId = user.id === undefined || user.id === null ? '' : String(user.id).trim();
  const username = typeof user.username === 'string' && user.username.trim()
    ? user.username.trim()
    : typeof user.email === 'string' ? user.email.trim() : '';
  const userAgent = typeof navigator.userAgent === 'string' ? navigator.userAgent.trim() : '';

  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(Number.isFinite(expiresValue) && expiresValue > 0 ? { tokenExpiresAt: expiresValue } : {}),
    ...(userId ? { userId } : {}),
    ...(username ? { username } : {}),
    ...(userAgent ? { userAgent } : {}),
  };
})()`

function isHttpNavigation(value) {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function isAllowedLoginNavigation(value, targetOrigin) {
  try {
    const url = new URL(value)
    return isHttpNavigation(value) && url.origin === targetOrigin
  } catch {
    return false
  }
}

function isExternalHttpsNavigation(value, targetOrigin) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.origin !== targetOrigin
  } catch {
    return false
  }
}

function isOAuthStartNavigation(value, targetOrigin) {
  try {
    const url = new URL(value)
    return url.origin === targetOrigin && OAUTH_START_PATH.test(url.pathname)
  } catch {
    return false
  }
}

/** 在隔离的 Electron 会话中完成 Sub2API 登录，并只导入目标站点的登录令牌。 */
class WalletLoginService {
  constructor({ BrowserWindow, walletService, getParentWindow, iconPath, openExternal }) {
    this.BrowserWindow = BrowserWindow
    this.walletService = walletService
    this.getParentWindow = getParentWindow
    this.iconPath = iconPath
    this.openExternal = openExternal
    this.active = new Map()
  }

  async login(id) {
    const active = this.active.get(id)
    if (active) {
      if (active.window && !active.window.isDestroyed()) {
        active.window.show()
        active.window.focus()
      }
      return active.promise
    }

    const target = await this.walletService.getLoginTarget(id)
    const entry = {}
    entry.promise = this.open(target, entry).finally(() => {
      if (this.active.get(id) === entry) this.active.delete(id)
    })
    this.active.set(id, entry)
    return entry.promise
  }

  open(target, entry) {
    const parent = this.getParentWindow?.()
    const targetUrl = new URL(target.siteUrl)
    const targetOrigin = targetUrl.origin
    const window = new this.BrowserWindow({
      width: 980,
      height: 720,
      minWidth: 760,
      minHeight: 560,
      show: false,
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      title: `Agent;Gate · Secure login · ${targetUrl.host}`,
      ...(this.iconPath ? { icon: this.iconPath } : {}),
      backgroundColor: '#1C1A16',
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        partition: `wallet-login-${crypto.randomUUID()}`,
      },
    })
    entry.window = window
    window.removeMenu()
    const loginSession = window.webContents.session
    const preventDownload = (event) => event.preventDefault()
    loginSession.setPermissionCheckHandler(() => false)
    loginSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    loginSession.on('will-download', preventDownload)
    window.once('closed', () => {
      void Promise.allSettled([
        loginSession.clearStorageData(),
        loginSession.clearCache(),
        loginSession.clearAuthCache(),
      ])
    })
    const walletService = this.walletService

    return new Promise((resolve, reject) => {
      let settled = false
      let reading = false
      let closeRequested = false
      let oauthNavigation = false
      let retryAt = 0
      const timer = setInterval(() => { void readSession() }, SESSION_POLL_MS)
      timer.unref?.()

      const cleanup = () => {
        clearInterval(timer)
        window.webContents.removeListener('did-finish-load', readSession)
        window.webContents.removeListener('did-fail-load', didFailLoad)
        window.webContents.removeListener('will-navigate', willNavigate)
        window.webContents.removeListener('will-redirect', willNavigate)
        loginSession.removeListener('will-download', preventDownload)
        window.removeListener('closed', cancel)
      }
      const closeWindow = () => {
        if (!window.isDestroyed()) window.close()
      }
      const fail = (error) => {
        if (settled) return
        settled = true
        cleanup()
        closeWindow()
        reject(error)
      }
      const complete = (wallet) => {
        if (settled) return
        settled = true
        cleanup()
        closeWindow()
        resolve({ cancelled: false, wallet })
      }
      const cancelNow = () => {
        if (settled) return
        settled = true
        cleanup()
        resolve({ cancelled: true })
      }
      const cancel = () => {
        if (settled) return
        if (reading) {
          closeRequested = true
          cleanup()
          return
        }
        cancelNow()
      }
      async function readSession() {
        if (settled || reading || Date.now() < retryAt || window.isDestroyed()) return
        let currentOrigin
        try {
          currentOrigin = new URL(window.webContents.getURL()).origin
        } catch {
          return
        }
        if (currentOrigin !== targetOrigin) return

        reading = true
        try {
          let session
          try {
            session = await window.webContents.executeJavaScript(SUB2API_SESSION_SCRIPT, true)
          } catch {
            if (closeRequested) cancelNow()
            return
          }
          if (!session) {
            if (closeRequested) cancelNow()
            return
          }
          try {
            const wallet = await walletService.importSub2ApiSession(target.id, session)
            complete(wallet)
          } catch (error) {
            if (closeRequested) fail(error)
            else retryAt = Date.now() + SESSION_RETRY_MS
          }
        } finally {
          reading = false
        }
      }
      function updateTitle(destination) {
        try {
          window.setTitle(`Agent;Gate · Secure login · ${new URL(destination).host}`)
        } catch {}
      }
      function allowNavigation(destination) {
        if (isAllowedLoginNavigation(destination, targetOrigin)) {
          oauthNavigation = false
          updateTitle(destination)
          return true
        }
        if (isExternalHttpsNavigation(destination, targetOrigin)
          && (oauthNavigation || isOAuthStartNavigation(window.webContents.getURL(), targetOrigin))) {
          oauthNavigation = true
          updateTitle(destination)
          return true
        }
        return false
      }
      function willNavigate(event, destination) {
        if (!allowNavigation(destination)) event.preventDefault()
      }
      function didFailLoad(_event, errorCode, errorDescription, _url, isMainFrame) {
        if (!isMainFrame || errorCode === -3) return
        fail(new Error(`Wallet login page could not be loaded: ${errorDescription}`))
      }

      window.once('ready-to-show', () => window.show())
      window.on('closed', cancel)
      window.webContents.on('did-finish-load', readSession)
      window.webContents.on('did-fail-load', didFailLoad)
      window.webContents.on('will-navigate', willNavigate)
      window.webContents.on('will-redirect', willNavigate)
      window.webContents.on('page-title-updated', (event) => event.preventDefault())
      window.webContents.setWindowOpenHandler(({ url }) => {
        if (allowNavigation(url) && !window.isDestroyed()) {
          void window.loadURL(url).catch(fail)
        } else if (isExternalHttpsNavigation(url, targetOrigin) && this.openExternal) {
          void this.openExternal(url).catch(() => {})
        }
        return { action: 'deny' }
      })

      window.loadURL(target.loginUrl).catch(fail)
    })
  }

  closeAll() {
    for (const entry of this.active.values()) {
      if (entry.window && !entry.window.isDestroyed()) entry.window.close()
    }
  }
}

module.exports = {
  SUB2API_SESSION_SCRIPT,
  WalletLoginService,
  isAllowedLoginNavigation,
  isExternalHttpsNavigation,
  isHttpNavigation,
  isOAuthStartNavigation,
}
