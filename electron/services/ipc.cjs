const { z } = require('zod')
const { SaveProfileSchema, TARGETS, validationMessage } = require('./schemas.cjs')

const CHANNELS = Object.freeze({
  bootstrap: 'agentgate:get-bootstrap',
  saveProfile: 'agentgate:save-profile',
  duplicateProfile: 'agentgate:duplicate-profile',
  reorderProfiles: 'agentgate:reorder-profiles',
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
  reassignPort: 'agentgate:reassign-port',
  updateSettings: 'agentgate:update-settings',
  // 会话不进 bootstrap：扫一遍要翻上百个正文文件加两个 SQLite，开页面时再拉
  listSessions: 'agentgate:list-sessions',
  readSessionMessages: 'agentgate:read-session-messages',
  countSessionMessages: 'agentgate:count-session-messages',
  planSessionRemoval: 'agentgate:plan-session-removal',
  removeSessions: 'agentgate:remove-sessions',
  checkForUpdate: 'agentgate:check-for-update',
  downloadUpdate: 'agentgate:download-update',
  installUpdate: 'agentgate:install-update',
  stateChanged: 'agentgate:state-changed',
})

const GatewayStartSchema = z.object({
  port: z.number().int().min(1024).max(65535).optional(),
  // 省略 = 全部已分配的客户端；给定子集 = 只接管这几个
  targets: z.array(z.enum(TARGETS)).optional(),
})

/** 会话 id 长这样：`<客户端>:<原生 id>`。一次最多删这么多，防手滑清空。 */
const SessionIdSchema = z.string().min(3).max(200)
const SessionIdsSchema = z.array(SessionIdSchema).min(1).max(200)
/** 0 = 尽量多（主进程仍有硬上限）。 */
const MessageLimitSchema = z.number().int().min(0).max(200).optional().default(30)

const GatewayStopSchema = z.object({
  // 省略 = 放掉全部；给定子集 = 只放掉这几个
  targets: z.array(z.enum(TARGETS)).optional(),
}).optional()

function changedRoutedConfigFields(existing, input) {
  const changed = []
  if (existing.protocol !== input.protocol) changed.push('protocol')
  return changed
}

function routedProfileChangeError(fields) {
  return new Error(
    `This profile is used by the local gateway. Switch its route or stop the gateway before changing: ${fields.join(', ')}`,
  )
}

/**
 * 注册渲染进程允许调用的全部 IPC 命令。
 *
 * 参数在 Service 层再次校验；列表和历史不会返回 Key，复制操作直接写系统剪贴板。
 *
 * @param {object} dependencies Electron 能力和已构建服务。
 * @returns {void} 注册完成后无返回值。
 */
function registerIpcHandlers({
  ipcMain,
  clipboard,
  isTrustedSender,
  isShuttingDown = () => false,
  profileService,
  clientService,
  healthService,
  applyService,
  gatewayService,
  settingsService,
  updateService,
  requestMonitor,
  sessionService,
  startupError,
  requestUpdateInstall,
}) {
  if (typeof isTrustedSender !== 'function') {
    throw new Error('IPC sender validation is required')
  }
  if (typeof isShuttingDown !== 'function') {
    throw new Error('IPC shutdown state callback is required')
  }
  const readOnlyChannels = new Set([
    CHANNELS.bootstrap,
    CHANNELS.listSessions,
    CHANNELS.readSessionMessages,
    CHANNELS.countSessionMessages,
    CHANNELS.planSessionRemoval,
  ])
  const handle = (channel, handler) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrustedSender(event)) throw new Error('Unauthorized IPC sender')
      if (isShuttingDown() && !readOnlyChannels.has(channel)) {
        throw new Error('Application is shutting down')
      }
      return handler(event, ...args)
    })
  }
  const getBootstrap = async () => {
    const [profiles, history] = await Promise.all([
      profileService.list(),
      applyService.listHistory(),
    ])
    const scannedClients = await clientService.scan(profiles)
    const activeProfileIds = [...new Set(
      scannedClients.map((client) => client.activeProfileId).filter(Boolean),
    )]
    const verifiedEntries = await Promise.all(activeProfileIds.map(async (profileId) => [
      profileId,
      await applyService.listVerifiedTargets(profileId),
    ]))
    const verifiedTargets = new Map(verifiedEntries)
    const clients = scannedClients.map((client) => {
      if (!client.activeProfileId || client.drifted || client.viaGateway) return client
      const verified = verifiedTargets.get(client.activeProfileId)?.includes(client.target)
      return verified ? client : {
        ...client,
        drifted: true,
        warning: 'Configuration no longer matches the last Agent;Gate write',
      }
    })
    const rawGateway = gatewayService.getPublicState()
    /*
     * 展开 rawGateway，别逐字段手抄。
     *
     * 这里原本是一个字段一个字段抄过来的，于是给网关状态新增 engaged 之后忘了跟着
     * 抄，桌面版拿到的 gateway 就少了这个字段，渲染进程一读 engaged.length 直接白屏。
     * 而浏览器预览用的是 mock 数据，字段是全的，所以怎么点都测不出来。
     */
    const gateway = {
      ...rawGateway,
      routes: rawGateway.routes.map((route) => {
        const profile = profiles.find((item) => item.id === route.profileId)
        return {
          ...route,
          profileName: profile?.name || 'Missing profile',
          protocol: profile?.protocol || 'openai-responses',
          activatedAt: rawGateway.startedAt || profile?.updatedAt || new Date(0).toISOString(),
        }
      }),
    }
    const requestSnapshot = typeof requestMonitor?.getActiveRequestsSnapshot === 'function'
      ? requestMonitor.getActiveRequestsSnapshot()
      : {
        activeRequests: gatewayService.getActiveRequests ? gatewayService.getActiveRequests() : undefined,
      }
    return {
      profiles,
      clients,
      history,
      gateway,
      ...(settingsService ? { settings: settingsService.getPublicSettings() } : {}),
      ...(requestSnapshot.activeRequests ? { activeRequests: requestSnapshot.activeRequests } : {}),
      ...(Number.isFinite(requestSnapshot.activeRequestsRevision)
        ? { activeRequestsRevision: requestSnapshot.activeRequestsRevision }
        : {}),
      ...(updateService ? { update: updateService.getPublicState() } : {}),
      ...(startupError ? { startupError } : {}),
    }
  }

  handle(CHANNELS.bootstrap, getBootstrap)

  handle(CHANNELS.saveProfile, async (_event, input) => {
    const parsed = SaveProfileSchema.safeParse(input)
    if (!parsed.success) throw new Error(validationMessage(parsed.error))
    const nextProfile = parsed.data
    return applyService.withLifecycleLock(async () => {
      const gatewayState = gatewayService.getPublicState()
      const routedTargets = (gatewayState.status === 'running' ? gatewayState.routes : [])
        .filter((route) => route.profileId === nextProfile.id)
        .map((route) => route.target)
      if (routedTargets.length > 0) {
        const existing = (await profileService.list())
          .find((profile) => profile.id === nextProfile.id)
        if (existing) {
          const changedFields = changedRoutedConfigFields(existing, nextProfile)
          if (changedFields.length > 0) throw routedProfileChangeError(changedFields)
        }
      }
      const saved = await profileService.save(nextProfile)
      await gatewayService.refreshProfile(saved.id)
      return saved
    })
  })
  handle(CHANNELS.duplicateProfile, (_event, id) => profileService.duplicate(id))
  handle(CHANNELS.reorderProfiles, (_event, ids) => profileService.reorder(ids))
  handle(CHANNELS.deleteProfile, (_event, id) => {
    return applyService.withLifecycleLock(async () => {
      const gatewayState = gatewayService.getPublicState()
      const routedTargets = gatewayState.routes
        .filter((route) => route.profileId === id)
        .map((route) => route.target)
      if (routedTargets.length === 0) return profileService.delete(id)
      if (gatewayState.status !== 'stopped') {
        throw new Error('Switch this gateway route or turn off the local gateway before deleting the profile')
      }
      const routeSnapshot = await gatewayService.unassignRoutes(routedTargets)
      try {
        return await profileService.delete(id)
      } catch (error) {
        await gatewayService.restoreRoutes(routeSnapshot).catch(() => {})
        throw error
      }
    })
  })
  handle(CHANNELS.copyProfileKey, async (_event, id) => {
    const apiKey = await profileService.getSecret(id)
    clipboard.writeText(apiKey)
    return { ok: true }
  })
  handle(CHANNELS.testProfile, async (_event, id) => {
    return healthService.test(id)
  })
  handle(CHANNELS.testProfileDraft, async (_event, input) => {
    return healthService.discoverDraftModels(input)
  })
  handle(CHANNELS.checkProfileHealth, async (_event, id) => {
    return healthService.testHealth(id)
  })
  handle(CHANNELS.probeProfile, async (_event, id) => {
    return healthService.probeProfile(id)
  })
  handle(CHANNELS.applyProfile, async (_event, id, targets) => {
    const result = await applyService.assignProfile(id, targets)
    const profiles = await profileService.list()
    const clients = await clientService.scan(profiles)
    const profile = profiles.find((item) => item.id === id)
    if (!profile) throw new Error('Applied profile no longer exists')
    return {
      profile,
      clients,
      gateway: {
        ...result.gateway,
        routes: result.gateway.routes.map((route) => {
          const routedProfile = profiles.find((item) => item.id === route.profileId)
          return {
            ...route,
            profileName: routedProfile?.name || 'Missing profile',
            protocol: routedProfile?.protocol || 'openai-responses',
            activatedAt: routedProfile?.updatedAt || new Date(0).toISOString(),
          }
        }),
      },
      assignedTargets: result.assignedTargets,
      ...(result.history ? { historyEntry: result.history } : {}),
    }
  })
  handle(CHANNELS.undoHistory, async (_event, id) => {
    await applyService.undo(id)
    return getBootstrap()
  })
  handle(CHANNELS.openConfig, (_event, target) => clientService.openConfig(target))
  handle(CHANNELS.startGateway, async (_event, rawSettings) => {
    const result = GatewayStartSchema.safeParse(rawSettings)
    if (!result.success) throw new Error(validationMessage(result.error))
    await applyService.startGateway(result.data)
    return getBootstrap()
  })
  handle(CHANNELS.stopGateway, async (_event, rawSettings) => {
    const parsed = GatewayStopSchema.safeParse(rawSettings)
    if (!parsed.success) throw new Error(validationMessage(parsed.error))
    const recovery = await applyService.stopGateway(parsed.data || {})
    return {
      ...await getBootstrap(),
      gatewayRecovery: {
        skippedTargets: recovery.skippedTargets || [],
      },
    }
  })
  handle(CHANNELS.reassignPort, async () => {
    if (!gatewayService) throw new Error('Local gateway is unavailable')
    await gatewayService.reassignPort()
    return getBootstrap()
  })
  handle(CHANNELS.updateSettings, async (_event, patch) => {
    if (!settingsService) throw new Error('Application settings are unavailable')
    return settingsService.update(patch)
  })
  /*
   * 会话管理。删除是不可逆的，所以渲染进程只能递会话 id，删什么由主进程按各家的
   * 真实牵连面自己算——路径不从渲染进程来，免得被越权删到别处去。
   */
  handle(CHANNELS.listSessions, async () => (
    sessionService ? sessionService.listDetailed() : { sessions: [], errors: [] }
  ))
  handle(CHANNELS.readSessionMessages, async (_event, id, limit) => (
    sessionService
      ? sessionService.readMessages(SessionIdSchema.parse(id), { limit: MessageLimitSchema.parse(limit) })
      : { messages: [], truncated: false }
  ))
  handle(CHANNELS.countSessionMessages, async (_event, ids) => (
    sessionService ? sessionService.countMessages(SessionIdsSchema.parse(ids)) : {}
  ))
  handle(CHANNELS.planSessionRemoval, async (_event, ids) => (
    sessionService ? sessionService.plan(SessionIdsSchema.parse(ids)) : []
  ))
  handle(CHANNELS.removeSessions, async (_event, ids) => {
    if (!sessionService) return { removed: [], failed: [] }
    return sessionService.remove(SessionIdsSchema.parse(ids))
  })

  handle(CHANNELS.checkForUpdate, async () => {
    if (!updateService) throw new Error('Update service is unavailable')
    return updateService.check()
  })
  handle(CHANNELS.downloadUpdate, async () => {
    if (!updateService) throw new Error('Update service is unavailable')
    return updateService.download()
  })
  handle(CHANNELS.installUpdate, async () => {
    if (!updateService) throw new Error('Update service is unavailable')
    const state = updateService.getPublicState()
    if (state.portable || state.state !== 'ready') throw new Error('Update is not ready to install')
    // 由主进程的退出屏障先停网关、恢复客户端配置，再安装。
    requestUpdateInstall()
    return { ok: true }
  })
}

module.exports = {
  CHANNELS,
  registerIpcHandlers,
}
