const SCHEDULER_TICK_MS = 60_000
const MINIMUM_IMPROVEMENT_MS = 25
const REQUIRED_CONSECUTIVE_WINS = 2
const HEALTH_HISTORY_WINDOW_MS = 60 * 60_000
const MINIMUM_COMPETING_SAMPLES = 3
const ERROR_MESSAGE_LIMIT = 240
const FAILOVER_FAILURE_THRESHOLD = 3
const FAILOVER_COOLDOWN_MS = 60_000
const FAILOVER_DECISION_HISTORY_LIMIT = 20
const FAILOVER_TARGETS = new Set(['claude', 'claude-desktop', 'codex', 'opencode', 'gemini'])
const PROFILE_TARGETS = {
  anthropic: new Set(['claude', 'claude-desktop', 'opencode']),
  'openai-responses': new Set(['codex', 'opencode']),
  'openai-chat': new Set(['codex', 'opencode']),
  gemini: new Set(['gemini', 'opencode']),
}

function profileCompatibleWithTarget(profile, target) {
  return PROFILE_TARGETS[profile.protocol]?.has(target) === true
}

function checkedAtTimestamp(profile) {
  return Math.max(0, ...profile.endpoints.flatMap((endpoint) => {
    const samples = [...(endpoint.healthHistory || []), endpoint.health].filter(Boolean)
    return samples.map((sample) => {
      const timestamp = Date.parse(sample.checkedAt || '')
      return Number.isFinite(timestamp) ? timestamp : 0
    })
  }))
}

function healthIsReachable(health) {
  if (!health) return false
  if (typeof health.reachable === 'boolean') return health.reachable
  return health.status === 'healthy' || health.status === 'limited'
}

function recentHealthHistory(endpoint, now = Date.now()) {
  const minimumTimestamp = now - HEALTH_HISTORY_WINDOW_MS
  return (endpoint.healthHistory || []).filter((sample) => {
    const timestamp = Date.parse(sample.checkedAt || '')
    return Number.isFinite(timestamp) && timestamp >= minimumTimestamp && timestamp <= now + 60_000
  })
}

function median(values) {
  if (values.length === 0) return Number.POSITIVE_INFINITY
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function endpointMetrics(endpoint, now = Date.now()) {
  const history = recentHealthHistory(endpoint, now)
  const reachable = history.filter((sample) => healthIsReachable(sample))
  return {
    sampleCount: history.length,
    availability: history.length === 0 ? 0 : reachable.length / history.length,
    medianLatencyMs: median(reachable.map((sample) => sample.latencyMs)),
  }
}

/**
 * 按最近一小时可用率降序、中位延迟升序排列可竞争端点。
 */
function candidateEndpoints(profile, options = {}) {
  const now = options.now ?? Date.now()
  const allowCold = options.allowCold === true
  return profile.endpoints
    .filter((endpoint) => healthIsReachable(endpoint.health))
    .filter((endpoint) => !profile.model
      || (Array.isArray(endpoint.models) && endpoint.models.includes(profile.model)))
    .map((endpoint) => ({ endpoint, metrics: endpointMetrics(endpoint, now) }))
    .filter(({ endpoint, metrics }) => (
      endpoint.url === profile.baseUrl
      || allowCold
      || metrics.sampleCount >= MINIMUM_COMPETING_SAMPLES
    ))
    .sort((left, right) => (
      right.metrics.availability - left.metrics.availability
      || left.metrics.medianLatencyMs - right.metrics.medianLatencyMs
      || left.endpoint.url.localeCompare(right.endpoint.url)
    ))
    .map(({ endpoint, metrics }) => ({ ...endpoint, metrics }))
}

function legacyCandidateEndpoints(profile) {
  return profile.endpoints
    .filter((endpoint) => endpoint.health?.status === 'healthy')
    .filter((endpoint) => endpoint.models.length > 0)
    .filter((endpoint) => !profile.model || endpoint.models.includes(profile.model))
    .sort((left, right) => left.health.latencyMs - right.health.latencyMs)
}

function errorMessage(error) {
  const message = error instanceof Error ? error.message : 'Automatic endpoint check failed'
  return message.slice(0, ERROR_MESSAGE_LIMIT)
}

function abortedError() {
  const error = new Error('Automatic endpoint check was stopped')
  error.name = 'AbortError'
  return error
}

function requestFailedByChannel(entry, context = {}) {
  if (entry.outcome !== 'failed') return false
  if (context.channelFailure === false) return false
  if (entry.statusCode === undefined) return context.channelFailure !== false
  if (entry.statusCode >= 200 && entry.statusCode < 300) {
    return context.channelFailure === true
  }
  return entry.statusCode === 401
    || entry.statusCode === 403
    || entry.statusCode === 429
    || entry.statusCode >= 500
}

function profileFailoverMetrics(profile, now, probe) {
  const endpoint = profile.endpoints.find((item) => item.url === profile.baseUrl)
    || profile.endpoints[0]
  const metrics = endpoint ? endpointMetrics(endpoint, now) : {
    sampleCount: 0,
    availability: 0,
    medianLatencyMs: Number.POSITIVE_INFINITY,
  }
  return {
    availability: metrics.sampleCount > 0 ? metrics.availability : 1,
    medianLatencyMs: Number.isFinite(metrics.medianLatencyMs)
      ? metrics.medianLatencyMs
      : probe.totalMs,
  }
}

/**
 * 在 Agent;Gate 运行期间定时检测 URL 池并更新网关使用的活动端点。
 *
 * 服务不直接写客户端配置，也不在应用退出后常驻。停止调度会中止网络并使
 * 旧轮次失效；网关运行时只刷新对应方案的内存连接缓存。
 */
class AutoSwitchService {
  constructor({
    profileService,
    healthService,
    applyService,
    gatewayService,
    settingsService,
    tickMs = SCHEDULER_TICK_MS,
    now = () => Date.now(),
  }) {
    this.profileService = profileService
    this.healthService = healthService
    this.applyService = applyService
    this.gatewayService = gatewayService
    this.settingsService = settingsService
    this.tickMs = tickMs
    this.now = now
    this.running = false
    this.timer = undefined
    this.activeController = undefined
    this.activeTick = undefined
    this.generation = 0
    this.onChange = () => {}
    this.lastRuns = new Map()
    this.candidates = new Map()
    this.failures = new Map()
    this.failoverInFlight = new Map()
    this.failoverControllers = new Map()
    this.profileDecisions = new Map()
    this.failoverDecisions = new Map()
    this.failoverCooldowns = new Map()
    this.acceptingFailover = true
  }

  setProfileDecision(profileId, decision) {
    const previous = this.profileDecisions.get(profileId) || {}
    this.profileDecisions.set(profileId, {
      ...previous,
      ...decision,
      checkedAt: decision.checkedAt || new Date(this.now()).toISOString(),
    })
  }

  setFailoverDecision(target, decision) {
    const previous = this.failoverDecisions.get(target) || {}
    const hasReason = Object.prototype.hasOwnProperty.call(decision, 'reason')
    const hasMessage = Object.prototype.hasOwnProperty.call(decision, 'message')
    const history = [
      ...(previous.history || []),
      ...(decision.reason ? [{
        at: decision.at || new Date(this.now()).toISOString(),
        reason: decision.reason,
        profileId: decision.profileId,
        previousProfileId: decision.previousProfileId,
      }] : []),
    ].slice(-FAILOVER_DECISION_HISTORY_LIMIT)
    this.failoverDecisions.set(target, {
      ...previous,
      ...decision,
      at: decision.at || new Date(this.now()).toISOString(),
      history,
      excluded: Array.isArray(decision.excluded)
        ? decision.excluded.slice(0, FAILOVER_DECISION_HISTORY_LIMIT)
        : hasReason ? [] : (previous.excluded || []),
      message: hasMessage ? decision.message : hasReason ? undefined : previous.message,
    })
  }

  notifyDecision() {
    // 生命周期未启动或已经进入停止屏障时，不再向渲染进程发送异步状态。
    if (!this.timer || !this.acceptingFailover) return
    this.onChange({ type: 'auto-switch-decision', autoSwitch: this.getPublicState() })
  }

  getPublicState() {
    const settings = this.settingsService?.getPublicSettings?.()
    const gateway = this.gatewayService?.getPublicState?.()
    const failover = Object.fromEntries([...FAILOVER_TARGETS].map((target) => {
      const decision = this.failoverDecisions.get(target) || {}
      const cooldownUntil = this.failoverCooldowns.get(target)
      const configuredEnabled = settings?.failover?.[target]?.enabled
      const gatewayManaged = gateway
        ? gateway.status === 'running' && gateway.engaged?.includes(target)
        : undefined
      const reason = configuredEnabled === false
        ? 'disabled'
        : configuredEnabled === true && gatewayManaged === false
          ? 'not-engaged'
          : decision.reason || 'idle'
      return [target, {
        enabled: typeof configuredEnabled === 'boolean'
          ? configuredEnabled
          : decision.enabled === true,
        failureCount: this.failures.get(target)?.count || decision.failureCount || 0,
        failureThreshold: FAILOVER_FAILURE_THRESHOLD,
        reason,
        at: decision.at,
        profileId: decision.profileId,
        previousProfileId: decision.previousProfileId,
        profileName: decision.profileName,
        availability: decision.availability,
        medianLatencyMs: decision.medianLatencyMs,
        message: decision.message,
        excluded: decision.excluded || [],
        cooldownUntil: cooldownUntil && cooldownUntil > this.now() ? new Date(cooldownUntil).toISOString() : undefined,
        history: decision.history || [],
      }]
    }))
    return {
      profiles: Object.fromEntries(this.profileDecisions.entries()),
      failover,
    }
  }

  /**
   * 启动无重入的后台调度循环。
   *
   * @param {(event: object) => void} onChange 检测或切换后的主进程通知回调。
   * @returns {void} 已启动时不重复注册计时器。
   */
  start(onChange = () => {}) {
    if (this.timer) return
    this.onChange = onChange
    this.acceptingFailover = true
    const generation = ++this.generation
    this.timer = setInterval(() => void this.tick(generation), this.tickMs)
    this.timer.unref?.()
    void this.tick(generation)
  }

  /**
   * 停止调度、中止当前网络请求并使运行中的旧轮次失效。
   *
   * @returns {void} 停止后不会保留计时器或防抖候选。
   */
  stop() {
    this.acceptingFailover = false
    this.generation += 1
    this.activeController?.abort()
    for (const controller of this.failoverControllers.values()) controller.abort()
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.lastRuns.clear()
    this.candidates.clear()
    this.failures.clear()
    this.profileDecisions.clear()
    this.failoverDecisions.clear()
    this.failoverCooldowns.clear()
  }

  /**
   * 停止调度并等待当前轮次跨过配置事务的提交或回滚边界。
   *
   * 新的网络工作会立即中止；若配置写入已经开始，活动 tick 会等待 ApplyService
   * 完成全部提交或回滚后结束。重复调用会等待同一个活动 Promise。
   *
   * @returns {Promise<void>} 当前轮次完全结束后完成。
   */
  async stopAndWait() {
    this.stop()
    const pending = [this.activeTick, ...this.failoverInFlight.values()].filter(Boolean)
    await Promise.allSettled(pending)
  }

  assertGeneration(generation, signal) {
    if (signal?.aborted || (generation !== undefined && generation !== this.generation)) {
      throw abortedError()
    }
  }

  resetFailoverFailures() {
    this.failures.clear()
    this.failoverCooldowns.clear()
    for (const [target, decision] of this.failoverDecisions.entries()) {
      this.failoverDecisions.set(target, {
        ...decision,
        failureCount: 0,
        reason: 'idle',
        message: undefined,
        excluded: [],
      })
    }
  }

  /**
   * 判断方案是否达到用户配置的检测周期。
   *
   * @param {object} profile 公开方案。
   * @returns {boolean} 未检测或周期已到时返回 true。
   */
  isDue(profile) {
    const lastRun = Math.max(
      checkedAtTimestamp(profile),
      this.lastRuns.get(profile.id) || 0,
    )
    const intervalMs = profile.autoSwitch.intervalMinutes * 60_000
    return this.now() - lastRun >= intervalMs
  }

  /**
   * 执行一次到期方案扫描，同一时刻最多运行一轮。
   *
   * @param {number} generation 当前调度生命周期编号。
   * @returns {Promise<void>} 全部到期方案处理完成后结束。
   */
  tick(generation = this.generation) {
    if (this.activeTick) return this.activeTick
    if (generation !== this.generation) return Promise.resolve()

    const activeTick = this.executeTick(generation)
    this.activeTick = activeTick
    const clearActiveTick = () => {
      if (this.activeTick === activeTick) this.activeTick = undefined
    }
    activeTick.then(clearActiveTick, clearActiveTick)
    return activeTick
  }

  /**
   * 执行单轮到期方案扫描，由 tick 保存并复用其 Promise。
   *
   * @param {number} generation 当前调度生命周期编号。
   * @returns {Promise<void>} 全部到期方案处理完成后结束。
   */
  async executeTick(generation) {
    this.running = true
    const controller = new AbortController()
    this.activeController = controller
    try {
      const profiles = await this.profileService.list()
      this.assertGeneration(generation, controller.signal)
      const profileIds = new Set(profiles.map((profile) => profile.id))
      for (const id of this.candidates.keys()) {
        if (!profileIds.has(id)) this.candidates.delete(id)
      }

      for (const profile of profiles) {
        if (!this.isDue(profile)) continue
        this.lastRuns.set(profile.id, this.now())
        try {
          const event = await this.runProfile(profile.id, {
            generation,
            signal: controller.signal,
            // 探测始终按方案周期执行；此开关只控制是否允许自动切换活动 URL。
            allowSwitch: profile.autoSwitch?.enabled === true,
          })
          this.assertGeneration(generation, controller.signal)
          this.onChange(event)
          this.notifyDecision()
        } catch (error) {
          if (error.name === 'AbortError' || generation !== this.generation) break
          this.onChange({
            type: 'auto-switch-error',
            profileId: profile.id,
            message: errorMessage(error),
          })
          this.setProfileDecision(profile.id, {
            reason: 'probe-failed',
            switched: false,
            message: errorMessage(error),
          })
          this.notifyDecision()
        }
      }
    } finally {
      if (this.activeController === controller) this.activeController = undefined
      this.running = false
    }
  }

  /**
   * 检测单个方案并按滚动健康指标切换。
   *
   * 测速返回的 decision revision 会贯穿活动 URL 选择和网关缓存刷新。自动择优
   * 不写客户端配置；任一步失败都会条件式恢复活动 URL。
   *
   * @param {string} profileId 方案 UUID。
   * @param {{generation?: number, signal?: AbortSignal}} context 调度生命周期上下文。
   * @returns {Promise<object>} 可发送给渲染进程的无敏感事件。
   */
  async runProfile(profileId, context = {}) {
    const rollingHealth = typeof this.healthService.testHealthWithSnapshot === 'function'
    const testMethod = rollingHealth
      ? this.healthService.testHealthWithSnapshot.bind(this.healthService)
      : this.healthService.testWithSnapshot.bind(this.healthService)
    const decision = await testMethod(profileId, {
      signal: context.signal,
    })
    this.assertGeneration(context.generation, context.signal)
    const tested = decision.profile
    if (context.allowSwitch === false) {
      this.candidates.delete(profileId)
      this.setProfileDecision(profileId, { reason: 'monitoring-only', switched: false })
      return {
        type: 'profile-tested',
        profileId,
        switched: false,
        reason: 'monitoring-only',
      }
    }
    const current = tested.endpoints.find((endpoint) => endpoint.url === tested.baseUrl)
    const currentFailed = !healthIsReachable(current?.health)
    const candidates = rollingHealth
      ? candidateEndpoints(tested, {
          allowCold: currentFailed,
          now: this.now(),
        })
      : legacyCandidateEndpoints(tested)
    const best = candidates[0]

    if (!best || best.url === tested.baseUrl) {
      this.candidates.delete(profileId)
      this.setProfileDecision(profileId, {
        reason: best ? 'already-best' : 'no-reachable-endpoint',
        switched: false,
      })
      return {
        type: 'profile-tested',
        profileId,
        switched: false,
        reason: best ? 'already-best' : 'no-reachable-endpoint',
      }
    }

    let switchReason = currentFailed ? 'current-failed' : 'better-health-score'
    if (!rollingHealth) {
      const improvement = current?.health
        ? current.health.latencyMs - best.health.latencyMs
        : Number.POSITIVE_INFINITY
      if (!currentFailed && improvement < MINIMUM_IMPROVEMENT_MS) {
        this.candidates.delete(profileId)
        this.setProfileDecision(profileId, { reason: 'latency-threshold', switched: false })
        return { type: 'profile-tested', profileId, switched: false, reason: 'latency-threshold' }
      }

      const previousCandidate = this.candidates.get(profileId)
      const winCount = previousCandidate?.url === best.url ? previousCandidate.count + 1 : 1
      this.candidates.set(profileId, { url: best.url, count: winCount })
      if (!currentFailed && winCount < REQUIRED_CONSECUTIVE_WINS) {
        this.setProfileDecision(profileId, {
          reason: 'warming-candidate',
          switched: false,
        })
        return {
          type: 'profile-tested',
          profileId,
          switched: false,
          reason: 'warming-candidate',
        }
      }
      switchReason = currentFailed ? 'current-failed' : 'legacy-latency-win'
    }

    const previousBaseUrl = tested.baseUrl
    const switched = await this.applyService.withLifecycleLock(async () => {
      this.assertGeneration(context.generation, context.signal)
      const assignedTargets = this.gatewayService?.assignedTargetsForProfile(profileId)
        || this.gatewayService?.activeTargetsForProfile(profileId)
        || []
      const gatewayRunning = this.gatewayService?.getPublicState().status === 'running'
      this.assertGeneration(context.generation, context.signal)
      let selected

      try {
        selected = await this.profileService.setActiveEndpoint(profileId, best.url, {
          expectedBaseUrl: tested.baseUrl,
          expectedRevision: decision.connectionRevision,
        })
        this.assertGeneration(context.generation, context.signal)
        if (gatewayRunning && assignedTargets.length > 0) {
          await this.gatewayService.refreshProfile(profileId)
        }
      } catch (error) {
        if (selected) {
          try {
            await this.profileService.setActiveEndpoint(profileId, previousBaseUrl, {
              expectedBaseUrl: best.url,
              expectedRevision: selected.connectionRevision,
            })
            if (gatewayRunning && assignedTargets.length > 0) {
              await this.gatewayService.refreshProfile(profileId)
            }
          } catch {
            throw new Error('Automatic write failed and the active endpoint could not be restored')
          }
        }
        throw error
      }

      return { activeTargets: assignedTargets }
    })

    this.candidates.delete(profileId)
    this.setProfileDecision(profileId, {
      reason: switchReason,
      switched: true,
      availability: rollingHealth && best.metrics ? best.metrics.availability : undefined,
      medianLatencyMs: rollingHealth && best.metrics ? best.metrics.medianLatencyMs : undefined,
    })
    return {
      type: 'profile-tested',
      profileId,
      switched: true,
      reason: switchReason,
      previousBaseUrl,
      baseUrl: best.url,
      targets: switched.activeTargets,
      ...(rollingHealth && best.metrics ? {
        availability: best.metrics.availability,
        medianLatencyMs: best.metrics.medianLatencyMs,
      } : {}),
    }
  }

  async recordRequestResult(entry, context = {}) {
    const target = entry?.client
    if (!this.acceptingFailover || !FAILOVER_TARGETS.has(target)) return

    if (entry.outcome === 'completed') {
      if (this.failures.get(target)?.profileId === entry.profileId) {
        this.failures.delete(target)
        this.setFailoverDecision(target, { reason: 'healthy', failureCount: 0 })
        this.notifyDecision()
      }
      return
    }
    if (!entry.profileId || !requestFailedByChannel(entry, context)) return

    const settings = this.settingsService?.getPublicSettings()
    const targetSettings = settings?.failover?.[target]
    const gateway = this.gatewayService?.getPublicState()
    const route = gateway?.routes?.find((item) => item.target === target)
    if (!targetSettings?.enabled
      || gateway?.status !== 'running'
      || !gateway.engaged?.includes(target)) {
      this.failures.delete(target)
      this.setFailoverDecision(target, {
        enabled: targetSettings?.enabled === true,
        reason: !targetSettings?.enabled ? 'disabled' : 'not-engaged',
        failureCount: 0,
      })
      this.notifyDecision()
      return
    }
    if (!targetSettings.profileIds.includes(entry.profileId)
      || route?.profileId !== entry.profileId) {
      if (this.failures.get(target)?.profileId === entry.profileId) {
        this.failures.delete(target)
      }
      this.setFailoverDecision(target, { reason: 'current-not-allowed', failureCount: 0 })
      this.notifyDecision()
      return
    }

    const cooldownUntil = this.failoverCooldowns.get(target)
    if (cooldownUntil && cooldownUntil > this.now()) {
      this.setFailoverDecision(target, {
        enabled: true,
        reason: 'cooldown',
        failureCount: 0,
      })
      this.notifyDecision()
      return
    }

    const previous = this.failures.get(target)
    const count = previous?.profileId === entry.profileId ? previous.count + 1 : 1
    this.failures.set(target, { profileId: entry.profileId, count })
    this.setFailoverDecision(target, {
      enabled: true,
      reason: count < FAILOVER_FAILURE_THRESHOLD ? 'failure-counting' : 'probing-candidates',
      failureCount: count,
      previousProfileId: entry.profileId,
    })
    if (count < FAILOVER_FAILURE_THRESHOLD) {
      this.notifyDecision()
      return
    }
    this.failures.delete(target)

    if (this.failoverInFlight.has(target)) return this.failoverInFlight.get(target)
    const generation = this.generation
    const controller = new AbortController()
    const operation = this.switchFailedTarget(target, entry.profileId, {
      generation,
      signal: controller.signal,
    })
      .catch((error) => {
        if (error.name === 'AbortError' || generation !== this.generation) return
        this.setFailoverDecision(target, { message: errorMessage(error) })
        this.notifyDecision()
        this.onChange({
          type: 'failure-switch',
          target,
          previousProfileId: entry.profileId,
          switched: false,
          message: errorMessage(error),
        })
      })
      .finally(() => {
        if (this.failoverInFlight.get(target) === operation) {
          this.failoverInFlight.delete(target)
          this.failoverControllers.delete(target)
        }
      })
    this.failoverInFlight.set(target, operation)
    this.failoverControllers.set(target, controller)
    return operation
  }

  async switchFailedTarget(target, previousProfileId, context = {}) {
    this.assertGeneration(context.generation, context.signal)
    const settings = this.settingsService.getPublicSettings()
    const targetSettings = settings.failover[target]
    if (!targetSettings.enabled || !targetSettings.profileIds.includes(previousProfileId)) {
      this.setFailoverDecision(target, { reason: 'disabled', failureCount: 0 })
      return
    }

    const allowed = new Set(targetSettings.profileIds)
    const profiles = await this.profileService.list()
    this.assertGeneration(context.generation, context.signal)
    const excluded = []
    const candidates = profiles.filter((profile) => {
      if (profile.id === previousProfileId) {
        excluded.push({ profileId: profile.id, reason: 'current' })
        return false
      }
      if (!allowed.has(profile.id)) {
        excluded.push({ profileId: profile.id, reason: 'not-allowed' })
        return false
      }
      if (!profile.targets.includes(target) || !profileCompatibleWithTarget(profile, target)) {
        excluded.push({ profileId: profile.id, reason: 'incompatible' })
        return false
      }
      return true
    })
    const probed = (await Promise.all(candidates.map(async (profile) => {
      try {
        const probe = await this.healthService.probeProfile(profile.id, undefined, {
          signal: context.signal,
        })
        if (!probe.ok) {
          excluded.push({ profileId: profile.id, reason: 'probe-failed' })
          return undefined
        }
        return {
          profile,
          probe,
          metrics: profileFailoverMetrics(profile, this.now(), probe),
        }
      } catch {
        excluded.push({ profileId: profile.id, reason: 'probe-failed' })
        return undefined
      }
    }))).filter(Boolean)
    this.assertGeneration(context.generation, context.signal)
    probed.sort((left, right) => (
      right.metrics.availability - left.metrics.availability
      || left.metrics.medianLatencyMs - right.metrics.medianLatencyMs
      || left.probe.totalMs - right.probe.totalMs
      || left.profile.name.localeCompare(right.profile.name)
    ))
    const selected = probed[0]
    if (!selected) {
      this.setFailoverDecision(target, {
        reason: 'no-candidate',
        failureCount: FAILOVER_FAILURE_THRESHOLD,
        previousProfileId,
        excluded,
      })
      throw new Error('No allowed failover profile passed the live probe')
    }

    const switched = await this.applyService.withLifecycleLock(async ({ apply }) => {
      this.assertGeneration(context.generation, context.signal)
      const latestSettings = this.settingsService.getPublicSettings().failover[target]
      const gateway = this.gatewayService.getPublicState()
      const route = gateway.routes.find((item) => item.target === target)
      if (!latestSettings.enabled
        || !latestSettings.profileIds.includes(previousProfileId)
        || !latestSettings.profileIds.includes(selected.profile.id)
        || gateway.status !== 'running'
        || !gateway.engaged.includes(target)
        || route?.profileId !== previousProfileId) return false
      this.assertGeneration(context.generation, context.signal)
      let applied = false
      try {
        await apply(selected.profile.id, [target])
        applied = true
        this.assertGeneration(context.generation, context.signal)
      } catch (error) {
        if (applied && (error.name === 'AbortError' || context.signal?.aborted)) {
          await apply(previousProfileId, [target])
        }
        throw error
      }
      return true
    })

    if (!switched) {
      this.setFailoverDecision(target, {
        enabled: true,
        reason: 'route-changed',
        failureCount: 0,
        excluded,
      })
      return
    }
    const cooldownUntil = this.now() + FAILOVER_COOLDOWN_MS
    this.failoverCooldowns.set(target, cooldownUntil)
    this.setFailoverDecision(target, {
      enabled: true,
      reason: 'switched',
      failureCount: 0,
      previousProfileId,
      profileId: selected.profile.id,
      profileName: selected.profile.name,
      availability: selected.metrics.availability,
      medianLatencyMs: selected.metrics.medianLatencyMs,
      excluded,
    })
    this.notifyDecision()
    this.onChange({
      type: 'failure-switch',
      target,
      previousProfileId,
      profileId: selected.profile.id,
      profileName: selected.profile.name,
      switched: true,
      availability: selected.metrics.availability,
      medianLatencyMs: selected.metrics.medianLatencyMs,
    })
  }
}

module.exports = {
  HEALTH_HISTORY_WINDOW_MS,
  MINIMUM_COMPETING_SAMPLES,
  MINIMUM_IMPROVEMENT_MS,
  FAILOVER_FAILURE_THRESHOLD,
  FAILOVER_COOLDOWN_MS,
  REQUIRED_CONSECUTIVE_WINS,
  SCHEDULER_TICK_MS,
  AutoSwitchService,
  candidateEndpoints,
  endpointMetrics,
  healthIsReachable,
}
