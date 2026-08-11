const { contextBridge, ipcRenderer } = require('electron')

const CHANNELS = Object.freeze({
  bootstrap: 'agentgate:get-bootstrap',
  saveProfile: 'agentgate:save-profile',
  updateProfileRouting: 'agentgate:update-profile-routing',
  duplicateProfile: 'agentgate:duplicate-profile',
  reorderProfiles: 'agentgate:reorder-profiles',
  createProfileGroup: 'agentgate:create-profile-group',
  renameProfileGroup: 'agentgate:rename-profile-group',
  updateProfileGroupMembers: 'agentgate:update-profile-group-members',
  deleteProfileGroup: 'agentgate:delete-profile-group',
  organizeProfiles: 'agentgate:organize-profiles',
  deleteProfile: 'agentgate:delete-profile',
  copyProfileKey: 'agentgate:copy-profile-key',
  testProfile: 'agentgate:test-profile',
  testProfileDraft: 'agentgate:test-profile-draft',
  checkProfileHealth: 'agentgate:check-profile-health',
  probeProfile: 'agentgate:probe-profile',
  applyProfile: 'agentgate:apply-profile',
  undoHistory: 'agentgate:undo-history',
  openConfig: 'agentgate:open-config',
  startGateway: 'agentgate:start-gateway',
  stopGateway: 'agentgate:stop-gateway',
  restoreCodexOfficial: 'agentgate:restore-codex-official',
  reassignPort: 'agentgate:reassign-port',
  updateSettings: 'agentgate:update-settings',
  listWallets: 'agentgate:list-wallets',
  saveWallet: 'agentgate:save-wallet',
  loginWallet: 'agentgate:login-wallet',
  importWalletKeys: 'agentgate:import-wallet-keys',
  deleteWallet: 'agentgate:delete-wallet',
  checkWallet: 'agentgate:check-wallet',
  listSessions: 'agentgate:list-sessions',
  readSessionMessages: 'agentgate:read-session-messages',
  countSessionMessages: 'agentgate:count-session-messages',
  planSessionRemoval: 'agentgate:plan-session-removal',
  removeSessions: 'agentgate:remove-sessions',
  windowControl: 'agentgate:window-control',
  checkForUpdate: 'agentgate:check-for-update',
  downloadUpdate: 'agentgate:download-update',
  installUpdate: 'agentgate:install-update',
  stateChanged: 'agentgate:state-changed',
})

/**
 * 以 `window.agentgate` 暴露给渲染进程的最小 API。
 *
 * 公开方案结构：
 * `{ id, name, protocol, baseUrl, endpoints, availableModels, autoSwitch,
 *    keyHint, model, authMode, targets, enableToolSearch, createdAt,
 *    updatedAt, lastAppliedAt?, health? }`
 *
 * `saveProfile(input)` 接收上述可编辑字段和可选 `apiKey`。编辑已有方案时，
 * 缺失或空白的 `apiKey` 表示保留现有密文。任何接口都不会向渲染进程返回
 * 明文 Key；复制操作由主进程直接写入剪贴板。
 *
 * 方法与 IPC 通道：
 * - getBootstrap()                    -> agentgate:get-bootstrap
 * - saveProfile(input)                -> agentgate:save-profile
 * - duplicateProfile(id)              -> agentgate:duplicate-profile
 * - deleteProfile(id)                 -> agentgate:delete-profile
 * - copyProfileKey(id)                -> agentgate:copy-profile-key
 * - testProfile(id)                   -> agentgate:test-profile
  * - testProfileDraft(input)           -> agentgate:test-profile-draft
  * - checkProfileHealth(id)            -> agentgate:check-profile-health
  * - probeProfile(id, model?)           -> agentgate:probe-profile
  * - applyProfile(id, targets?)        -> agentgate:apply-profile（只分配本地网关路由）
 * - undoHistory(id)                   -> agentgate:undo-history
 * - openConfig(target)                -> agentgate:open-config
 * - startGateway({ port? })           -> agentgate:start-gateway（使用已分配路由）
 * - stopGateway()                     -> agentgate:stop-gateway（保留路由分配）
 * - restoreCodexOfficial()            -> agentgate:restore-codex-official
 * - updateSettings(patch)             -> agentgate:update-settings（保存应用运行设置）
 * - onStateChanged(callback)          -> agentgate:state-changed
 */
const api = Object.freeze({
  getBootstrap: () => ipcRenderer.invoke(CHANNELS.bootstrap),
  saveProfile: (input) => ipcRenderer.invoke(CHANNELS.saveProfile, input),
  updateProfileRouting: (id, input) => ipcRenderer.invoke(CHANNELS.updateProfileRouting, id, input),
  duplicateProfile: (id) => ipcRenderer.invoke(CHANNELS.duplicateProfile, id),
  reorderProfiles: (ids) => ipcRenderer.invoke(CHANNELS.reorderProfiles, ids),
  createProfileGroup: (name, profileIds) => (
    ipcRenderer.invoke(CHANNELS.createProfileGroup, name, profileIds)
  ),
  renameProfileGroup: (id, name) => ipcRenderer.invoke(CHANNELS.renameProfileGroup, id, name),
  updateProfileGroupMembers: (id, profileIds) => (
    ipcRenderer.invoke(CHANNELS.updateProfileGroupMembers, id, profileIds)
  ),
  deleteProfileGroup: (id) => ipcRenderer.invoke(CHANNELS.deleteProfileGroup, id),
  organizeProfiles: (input) => ipcRenderer.invoke(CHANNELS.organizeProfiles, input),
  deleteProfile: (id) => ipcRenderer.invoke(CHANNELS.deleteProfile, id),
  copyProfileKey: (id) => ipcRenderer.invoke(CHANNELS.copyProfileKey, id),
  testProfile: (id) => ipcRenderer.invoke(CHANNELS.testProfile, id),
  testProfileDraft: (input) => ipcRenderer.invoke(CHANNELS.testProfileDraft, input),
  checkProfileHealth: (id) => ipcRenderer.invoke(CHANNELS.checkProfileHealth, id),
  probeProfile: (id, model) => ipcRenderer.invoke(CHANNELS.probeProfile, id, model),
  applyProfile: (id, targets) => ipcRenderer.invoke(CHANNELS.applyProfile, id, targets),
  undoHistory: (id) => ipcRenderer.invoke(CHANNELS.undoHistory, id),
  openConfig: (target) => ipcRenderer.invoke(CHANNELS.openConfig, target),
  startGateway: (settings) => ipcRenderer.invoke(CHANNELS.startGateway, settings),
  reassignPort: () => ipcRenderer.invoke(CHANNELS.reassignPort),
  stopGateway: (settings) => ipcRenderer.invoke(CHANNELS.stopGateway, settings),
  restoreCodexOfficial: () => ipcRenderer.invoke(CHANNELS.restoreCodexOfficial),
  updateSettings: (patch) => ipcRenderer.invoke(CHANNELS.updateSettings, patch),
  listWallets: () => ipcRenderer.invoke(CHANNELS.listWallets),
  saveWallet: (input) => ipcRenderer.invoke(CHANNELS.saveWallet, input),
  loginWallet: (id) => ipcRenderer.invoke(CHANNELS.loginWallet, id),
  importWalletKeys: (id, groupMode) => ipcRenderer.invoke(CHANNELS.importWalletKeys, id, groupMode),
  deleteWallet: (id) => ipcRenderer.invoke(CHANNELS.deleteWallet, id),
  checkWallet: (id) => ipcRenderer.invoke(CHANNELS.checkWallet, id),
  listSessions: () => ipcRenderer.invoke(CHANNELS.listSessions),
  readSessionMessages: (id, limit) => ipcRenderer.invoke(CHANNELS.readSessionMessages, id, limit),
  countSessionMessages: (ids) => ipcRenderer.invoke(CHANNELS.countSessionMessages, ids),
  planSessionRemoval: (ids) => ipcRenderer.invoke(CHANNELS.planSessionRemoval, ids),
  removeSessions: (ids) => ipcRenderer.invoke(CHANNELS.removeSessions, ids),
  windowControl: (action) => ipcRenderer.invoke(CHANNELS.windowControl, action),
  checkForUpdate: () => ipcRenderer.invoke(CHANNELS.checkForUpdate),
  downloadUpdate: () => ipcRenderer.invoke(CHANNELS.downloadUpdate),
  installUpdate: () => ipcRenderer.invoke(CHANNELS.installUpdate),
  onStateChanged: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('State listener must be a function')
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on(CHANNELS.stateChanged, listener)
    return () => ipcRenderer.removeListener(CHANNELS.stateChanged, listener)
  },
})

contextBridge.exposeInMainWorld('agentgate', api)
