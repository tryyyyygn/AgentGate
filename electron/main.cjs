const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { z } = require('zod')
const {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  screen,
  shell,
  Tray,
} = require('electron')
const {
  ProfileStoreSchema,
  HistoryStoreSchema,
} = require('./services/schemas.cjs')
const { JsonFileStore, Vault } = require('./services/storage.cjs')
const { resolveClientPaths } = require('./services/paths.cjs')
const { createAdapters } = require('./services/adapters.cjs')
const { ProfileService } = require('./services/profile-service.cjs')
const { ClientService } = require('./services/client-service.cjs')
const { HealthService } = require('./services/health-service.cjs')
const { AutoSwitchService } = require('./services/auto-switch-service.cjs')
const {
  RequestLogStoreSchema,
  RequestMonitorService,
} = require('./services/request-monitor-service.cjs')
const {
  SILENT_LAUNCH_FLAG,
  SettingsSchema,
  defaultSettings,
  SettingsService,
} = require('./services/settings-service.cjs')
const {
  ApplyService,
  GatewayBaselineStoreSchema,
  defaultGatewayBaselineStore,
} = require('./services/apply-service.cjs')
const {
  GatewayService,
  GatewayStoreSchema,
  defaultGatewayStore,
} = require('./services/gateway-service.cjs')
const { UpdateService } = require('./services/update-service.cjs')
const { WalletService, WalletStoreSchema } = require('./services/wallet-service.cjs')
const { WalletLoginService } = require('./services/wallet-login-service.cjs')
const { migrateLegacyUserData } = require('./services/migration-service.cjs')
const { CHANNELS, registerIpcHandlers } = require('./services/ipc.cjs')
const { SessionService } = require('./services/session-service.cjs')

const APP_NAME = 'agentgate'
const APP_DISPLAY_NAME = 'Agent;Gate'
const APP_USER_MODEL_ID = 'dev.agentgate.desktop'
/** 0.8.0 及更早版本使用的数据目录名；首次启动时自动迁移。 */
const LEGACY_APP_NAMES = Object.freeze(['Keydeck'])
const DATA_DIRECTORY_NAME = 'data'
const PROFILE_STORE_FILE = 'profiles.json'
const HISTORY_STORE_FILE = 'history.json'
const GATEWAY_STORE_FILE = 'gateway.json'
const GATEWAY_BASELINE_STORE_FILE = 'gateway-recovery.json'
const SETTINGS_STORE_FILE = 'settings.json'
const REQUEST_LOG_STORE_FILE = 'requests.json'
const WALLET_STORE_FILE = 'wallets.json'
const WINDOW_STATE_STORE_FILE = 'window-state.json'
const BACKUP_DIRECTORY_NAME = 'backups'
const WINDOW_OPTIONS = Object.freeze({
  width: 1180,
  height: 760,
  minWidth: 1000,
  minHeight: 620,
  useContentSize: true,
  frame: false,
})
const DEV_SERVER_URL = app.isPackaged ? undefined : process.env.VITE_DEV_SERVER_URL
const PRODUCTION_RENDERER_URL = pathToFileURL(
  path.join(__dirname, '..', 'dist', 'index.html'),
).href

const WindowStateSchema = z.object({
  version: z.literal(1),
  bounds: z.object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().min(WINDOW_OPTIONS.minWidth),
    height: z.number().int().min(WINDOW_OPTIONS.minHeight),
  }).optional(),
  maximized: z.boolean().optional(),
})

app.setName(APP_NAME)


let mainWindow
let tray
let services
let quitBarrierComplete = false
let quitBarrierPromise
let quitting = false
/** 退出屏障完成后是否改为安装更新，而不是普通退出。 */
let installUpdateOnQuit = false
let installFallbackTimer
/** 开机自启拉起的实例带 --silent：直接驻留托盘，不显示窗口。 */
const silentLaunch = process.argv.includes(SILENT_LAUNCH_FLAG)

/**
 * 创建主进程服务并绑定应用数据目录。
 *
 * @returns 配置管理、客户端扫描、健康检测和事务写入服务。
 * @throws 当 DPAPI 或本地数据文件不可用时，由具体服务在首次调用时抛出错误。
 */
function createServices() {
  const dataDirectory = path.join(app.getPath('userData'), DATA_DIRECTORY_NAME)
  const profileStore = new JsonFileStore(
    path.join(dataDirectory, PROFILE_STORE_FILE),
    ProfileStoreSchema,
    () => ({ version: 3, groups: [], profiles: [] }),
  )
  const historyStore = new JsonFileStore(
    path.join(dataDirectory, HISTORY_STORE_FILE),
    HistoryStoreSchema,
    () => ({ version: 1, entries: [] }),
  )
  const gatewayStore = new JsonFileStore(
    path.join(dataDirectory, GATEWAY_STORE_FILE),
    GatewayStoreSchema,
    defaultGatewayStore,
  )
  const gatewayBaselineStore = new JsonFileStore(
    path.join(dataDirectory, GATEWAY_BASELINE_STORE_FILE),
    GatewayBaselineStoreSchema,
    defaultGatewayBaselineStore,
  )
  const settingsStore = new JsonFileStore(
    path.join(dataDirectory, SETTINGS_STORE_FILE),
    SettingsSchema,
    defaultSettings,
  )
  const requestLogStore = new JsonFileStore(
    path.join(dataDirectory, REQUEST_LOG_STORE_FILE),
    RequestLogStoreSchema,
    () => ({ version: 1, entries: [] }),
  )
  const walletStore = new JsonFileStore(
    path.join(dataDirectory, WALLET_STORE_FILE),
    WalletStoreSchema,
    () => ({ version: 1, wallets: [] }),
  )
  const windowStateStore = new JsonFileStore(
    path.join(dataDirectory, WINDOW_STATE_STORE_FILE),
    WindowStateSchema,
    () => ({ version: 1 }),
  )
  const vault = new Vault(safeStorage)
  const profileService = new ProfileService(profileStore, vault)
  const walletService = new WalletService({ store: walletStore, vault, profileService })
  const walletLoginService = new WalletLoginService({
    BrowserWindow,
    walletService,
    getParentWindow: () => mainWindow,
    iconPath: path.join(__dirname, '..', 'assets', 'icon.ico'),
    openExternal: (url) => shell.openExternal(url),
  })
  let autoSwitchService
  const requestMonitor = new RequestMonitorService({
    onChange: (event) => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send(CHANNELS.stateChanged, event)
    },
    onRequestEnded: (entry, context) => {
      const failover = autoSwitchService?.recordRequestResult(entry, context)
      if (failover) void failover.catch(() => {})
      if (!entry.profileId || !entry.tokenUsage) return
      void profileService.addTokenUsage(entry.profileId, entry.tokenUsage).then(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return
        return profileService.list().then((profiles) => {
          const profile = profiles.find((item) => item.id === entry.profileId)
          if (!profile || !mainWindow || mainWindow.isDestroyed()) return
          mainWindow.webContents.send(CHANNELS.stateChanged, {
            type: 'profile-usage-changed',
            profile,
          })
        })
      }).catch(() => {})
    },
    store: requestLogStore,
  })
  const gatewayService = new GatewayService({
    profileService,
    store: gatewayStore,
    vault,
    requestMonitor,
    onStateChanged: (event) => {
      autoSwitchService?.resetFailoverFailures()
      // 托盘常驻，即使窗口已隐藏或销毁也要反映网关状态。
      refreshTray()
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send(CHANNELS.stateChanged, {
        type: 'gateway-state-changed',
        gateway: event,
      })
    },
  })
  const adapters = createAdapters(resolveClientPaths())
  const clientService = new ClientService(adapters, shell, gatewayService)
  const healthService = new HealthService(profileService)
  const applyService = new ApplyService({
    profileService,
    adapters,
    historyStore,
    backupDirectory: path.join(dataDirectory, BACKUP_DIRECTORY_NAME),
    vault,
    gatewayService,
    gatewayBaselineStore,
  })
  const settingsService = new SettingsService({
    store: settingsStore,
    app,
    onChanged: (settings) => {
      autoSwitchService?.resetFailoverFailures()
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send(CHANNELS.stateChanged, {
        type: 'settings-changed',
        settings,
      })
    },
  })
  autoSwitchService = new AutoSwitchService({
    profileService,
    healthService,
    applyService,
    gatewayService,
    settingsService,
  })

  const updateService = new UpdateService({
    app,
    shell,
    onChanged: (state) => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send(CHANNELS.stateChanged, {
        type: 'update-state-changed',
        update: state,
      })
    },
  })

  // 读的是各家 agent 自己的会话库，跟本应用的 userData 无关
  const sessionService = new SessionService({})

  return {
    sessionService,
    walletService,
    walletLoginService,
    profileService,
    clientService,
    healthService,
    applyService,
    autoSwitchService,
    gatewayService,
    settingsService,
    requestMonitor,
    updateService,
    windowStateStore,
  }
}

/**
 * 限制渲染窗口导航范围，阻止页面跳转接管本地权限。
 *
 * @param window 需要加固的 Electron 窗口。
 * @returns 无返回值；会注册导航和新窗口拦截器。
 */
function secureWindowNavigation(window) {
  const allowedOrigin = DEV_SERVER_URL ? new URL(DEV_SERVER_URL).origin : undefined

  window.webContents.on('will-navigate', (event, destination) => {
    if (allowedOrigin && new URL(destination).origin === allowedOrigin) return
    event.preventDefault()
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
}

function isTrustedIpcSender(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  if (event?.sender !== mainWindow.webContents) return false
  if (!event.senderFrame || event.senderFrame !== mainWindow.webContents.mainFrame) return false
  try {
    const senderUrl = new URL(event.senderFrame.url)
    if (DEV_SERVER_URL) return senderUrl.origin === new URL(DEV_SERVER_URL).origin
    senderUrl.hash = ''
    senderUrl.search = ''
    return senderUrl.href === PRODUCTION_RENDERER_URL
  } catch {
    return false
  }
}

/**
 * 校验保存的窗口位置仍然落在某个可见屏幕的工作区内。
 *
 * @param {{x: number, y: number, width: number, height: number}} bounds 保存的窗口位置。
 * @returns {boolean} 至少有可抓取的标题栏区域可见时返回 true。
 */
function boundsOnScreen(bounds) {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea
    return bounds.x < area.x + area.width - 60
      && bounds.x + bounds.width > area.x + 60
      && bounds.y >= area.y - 20
      && bounds.y < area.y + area.height - 60
  })
}

let windowStateTimer

async function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed() || !services) return
  const state = {
    version: 1,
    bounds: mainWindow.getNormalBounds(),
    maximized: mainWindow.isMaximized(),
  }
  try {
    await services.windowStateStore.write(state)
  } catch {
    // 窗口状态持久化失败不影响使用。
  }
}

function scheduleWindowStateSave() {
  clearTimeout(windowStateTimer)
  windowStateTimer = setTimeout(() => { void saveWindowState() }, 600)
  windowStateTimer.unref?.()
}

/**
 * 创建并加载主窗口，恢复上次记录的位置、大小和最大化状态。
 *
 * 开发环境加载 Vite 地址，生产环境加载打包后的静态文件。窗口在内容准备完成前
 * 保持隐藏，加载失败时 Promise 会拒绝并交由 Electron 启动流程处理。
 *
 * @param {{silent?: boolean}} options silent 为 true 时窗口保持隐藏（开机自启场景）。
 * @returns 窗口完成页面加载后的 Promise。
 */
async function createWindow({ silent = false } = {}) {
  let savedState
  try {
    savedState = await services?.windowStateStore.read()
  } catch {
    savedState = undefined
  }
  const savedBounds = savedState?.bounds && boundsOnScreen(savedState.bounds)
    ? savedState.bounds
    : undefined

  mainWindow = new BrowserWindow({
    ...WINDOW_OPTIONS,
    ...(savedBounds ?? {}),
    show: false,
    title: APP_DISPLAY_NAME,
    // 打包后任务栏图标取自 exe 的资源，开发时取不到——显式指定，两边一致
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    backgroundColor: '#1C1A16',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  if (savedState?.maximized) mainWindow.maximize()

  secureWindowNavigation(mainWindow)
  mainWindow.once('ready-to-show', () => {
    if (!silent) mainWindow?.show()
  })
  mainWindow.on('resize', scheduleWindowStateSave)
  mainWindow.on('move', scheduleWindowStateSave)
  mainWindow.on('maximize', scheduleWindowStateSave)
  mainWindow.on('unmaximize', scheduleWindowStateSave)
  mainWindow.on('close', (event) => {
    void saveWindowState()
    const gatewayRunning = services?.gatewayService.getPublicState().status === 'running'
    const closeToTray = services?.settingsService.getPublicSettings().closeToTray
    if (quitting || (!closeToTray && !gatewayRunning)) return
    event.preventDefault()
    mainWindow?.hide()
  })
  mainWindow.on('closed', () => {
    mainWindow = undefined
  })

  if (DEV_SERVER_URL) {
    await mainWindow.loadURL(DEV_SERVER_URL)
  } else {
    await mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    void createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function trayIcon(gatewayRunning) {
  const name = gatewayRunning ? 'tray-on.ico' : 'tray-off.ico'
  return nativeImage.createFromPath(path.join(__dirname, '..', 'assets', name))
}

/**
 * 按网关运行状态刷新托盘图标与提示文本。
 *
 * 网关运行时显示实心品牌图标并带绿点，关闭时显示灰色描边图标，
 * 让用户不用打开窗口就能确认接管状态。
 */
function refreshTray() {
  if (!tray || tray.isDestroyed()) return
  const gateway = services?.gatewayService.getPublicState()
  const running = gateway?.status === 'running' || gateway?.status === 'starting'
  tray.setImage(trayIcon(running))
  tray.setToolTip(running
    ? `${APP_DISPLAY_NAME} · 网关运行中 · ${gateway.host}:${gateway.port}`
    : `${APP_DISPLAY_NAME} · 网关已关闭`)
}

function createTray() {
  if (tray) return tray
  tray = new Tray(trayIcon(false))
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `打开 ${APP_DISPLAY_NAME}`, click: showMainWindow },
    { type: 'separator' },
    { label: `退出 ${APP_DISPLAY_NAME}（关闭网关）`, click: () => app.quit() },
  ]))
  tray.on('double-click', showMainWindow)
  refreshTray()
  return tray
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })

  app.whenReady().then(async () => {
    app.setAppUserModelId(APP_USER_MODEL_ID)
    Menu.setApplicationMenu(null)
    // 必须早于任何数据读取，否则会以空配置覆盖旧版数据。
    await migrateLegacyUserData(app.getPath('userData'), LEGACY_APP_NAMES)
    services = createServices()
    const settings = await services.settingsService.initialize()
    await services.requestMonitor.initialize()
    await services.gatewayService.initialize({ start: false })
    let launchGatewayError
    try {
      await services.applyService.reconcileGatewayOnLaunch({
        start: settings.startGatewayOnLaunch,
      })
    } catch (error) {
      // 配置冲突时仍需启动窗口和托盘，让用户能看到并修复问题。
      const reason = error instanceof Error ? error.message : String(error)
      launchGatewayError = `Agent;Gate could not restore the gateway on launch: ${reason}`
    }
    registerIpcHandlers({
      ipcMain,
      clipboard,
      isTrustedSender: isTrustedIpcSender,
      isShuttingDown: () => quitting,
      ...services,
      startupError: launchGatewayError,
      requestUpdateInstall: () => {
        installUpdateOnQuit = true
        app.quit()
      },
    })
    // 无边框窗口的最小化/最大化/关闭；关闭沿用 close 事件里的托盘驻留判断。
    ipcMain.handle('agentgate:window-control', (event, action) => {
      if (!isTrustedIpcSender(event)) throw new Error('Unauthorized IPC sender')
      if (quitting) throw new Error('Application is shutting down')
      if (!mainWindow || mainWindow.isDestroyed()) return
      if (action === 'minimize') mainWindow.minimize()
      else if (action === 'maximize') {
        if (mainWindow.isMaximized()) mainWindow.unmaximize()
        else mainWindow.maximize()
      } else if (action === 'close') mainWindow.close()
    })
    await createWindow({ silent: silentLaunch })
    createTray()
    services.autoSwitchService.start((event) => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send(CHANNELS.stateChanged, event)
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow()
    })
  })
}

app.on('before-quit', (event) => {
  quitting = true
  if (quitBarrierComplete) return
  event.preventDefault()
  if (quitBarrierPromise) return

  const installingUpdate = installUpdateOnQuit
  quitBarrierPromise = (async () => {
    let cleanupStep = 'stop automatic switching'
    try {
      services?.walletLoginService.closeAll()
      await services?.autoSwitchService.stopAndWait()
      cleanupStep = 'restore client configuration'
      await services?.applyService.stopGateway({ preserveResumeIntent: true })
      cleanupStep = 'stop the local gateway'
      await services?.gatewayService.shutdown()
      cleanupStep = 'flush request history'
      await services?.requestMonitor.flush()
    } catch (error) {
      quitting = false
      installUpdateOnQuit = false
      const message = error instanceof Error ? error.message : String(error)
      showMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(CHANNELS.stateChanged, {
          type: 'auto-switch-error',
          message: installingUpdate
            ? `Update cancelled because Agent;Gate could not ${cleanupStep}: ${message}`
            : `Quit cancelled because Agent;Gate could not ${cleanupStep}: ${message}`,
        })
      }
      return
    }
    tray?.destroy()
    tray = undefined
    quitBarrierComplete = true
    if (installingUpdate) {
      let installStarted = false
      try {
        installStarted = Boolean(services?.updateService.quitAndInstall())
      } catch {
        installStarted = false
      }
      if (installStarted) {
        // electron-updater 通常会自行触发 app.quit；若它只返回不退出，避免应用卡在托盘。
        installFallbackTimer = setTimeout(() => {
          installFallbackTimer = undefined
          app.quit()
        }, 5_000)
        installFallbackTimer.unref?.()
        return
      }
    }
    app.quit()
  })().finally(() => {
    if (!quitBarrierComplete) quitBarrierPromise = undefined
  })
})

app.on('window-all-closed', () => {
  const gatewayRunning = services?.gatewayService.getPublicState().status === 'running'
  if (process.platform !== 'darwin'
    && !services?.settingsService.getPublicSettings().closeToTray
    && !gatewayRunning) {
    app.quit()
  }
})
