import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  AutoSwitchService,
  MINIMUM_IMPROVEMENT_MS,
  candidateEndpoints,
} = require("../electron/services/auto-switch-service.cjs");

const PROFILE_ID = "profile-auto-switch";
const MODEL = "gpt-5.2-codex";
const CURRENT_URL = "https://current.example/v1";
const FAST_URL = "https://fast.example/v1";
const ALTERNATE_URL = "https://alternate.example/v1";
const CONNECTION_REVISION = 7;
const CURRENT_PROFILE_ID = "00000000-0000-4000-8000-000000000101";
const STABLE_PROFILE_ID = "00000000-0000-4000-8000-000000000102";
const FAST_PROFILE_ID = "00000000-0000-4000-8000-000000000103";
const EXCLUDED_PROFILE_ID = "00000000-0000-4000-8000-000000000104";

/**
 * 创建自动切换测试使用的端点快照。
 *
 * @param {string} url 端点 URL。
 * @param {{status?: string, latencyMs?: number, models?: string[]}} options 健康状态与模型覆盖项。
 * @returns {object} 不包含密钥的端点快照。
 */
function endpoint(url, {
  status = "healthy",
  latencyMs = 100,
  models = [MODEL],
} = {}) {
  return {
    url,
    models,
    health: {
      status,
      latencyMs,
      checkedAt: "2026-07-10T08:00:00.000Z",
    },
  };
}

/**
 * 创建带 URL 池和自动切换设置的公开方案快照。
 *
 * @param {object} overrides 需要覆盖的方案字段。
 * @returns {object} 健康检测服务可返回的方案。
 */
function profile(overrides = {}) {
  return {
    id: PROFILE_ID,
    baseUrl: CURRENT_URL,
    model: MODEL,
    endpoints: [
      endpoint(CURRENT_URL),
      endpoint(FAST_URL, { latencyMs: 50 }),
    ],
    autoSwitch: {
      enabled: true,
      intervalMinutes: 1,
    },
    ...overrides,
  };
}

/**
 * 使用纯内存 fake services 创建被测服务，不访问网络或客户端配置。
 *
 * @param {{tested?: object, testResults?: object[], clients?: object[], applyError?: Error, now?: () => number}} options 测试场景输入。
 * @returns {{service: AutoSwitchService, profileService: object, healthService: object, clientService: object, applyService: object}} 被测服务及可断言依赖。
 */
function createHarness({
  tested = profile(),
  testResults,
  clients = [],
  applyError,
  refreshError,
  gatewayTargets = [],
  gatewayRunning = true,
  now,
} = {}) {
  const profileService = {
    list: vi.fn().mockResolvedValue([tested]),
    setActiveEndpoint: vi.fn().mockResolvedValue({
      profile: tested,
      connectionRevision: CONNECTION_REVISION + 1,
    }),
  };
  const healthService = {
    testWithSnapshot: vi.fn(),
  };
  if (testResults) {
    for (const result of testResults) {
      healthService.testWithSnapshot.mockResolvedValueOnce({
        profile: result,
        connectionRevision: CONNECTION_REVISION,
      });
    }
  } else {
    healthService.testWithSnapshot.mockResolvedValue({
      profile: tested,
      connectionRevision: CONNECTION_REVISION,
    });
  }
  const clientService = {
    scan: vi.fn().mockResolvedValue(clients),
  };
  const applyService = {
    getVerifiedWriteState: vi.fn().mockResolvedValue({
      targets: clients
        .filter((client) => client.activeProfileId === PROFILE_ID && !client.drifted)
        .map((client) => client.target),
      hashes: { "c:\\fixture\\config.toml": "a".repeat(64) },
    }),
    apply: applyError
      ? vi.fn().mockRejectedValue(applyError)
      : vi.fn().mockResolvedValue(undefined),
  };
  applyService.withLifecycleLock = vi.fn(async (operation) => operation({
    apply: applyService.apply,
  }));
  const gatewayService = {
    activeTargetsForProfile: vi.fn().mockReturnValue(gatewayTargets),
    assignedTargetsForProfile: vi.fn().mockReturnValue(gatewayTargets),
    getPublicState: vi.fn().mockReturnValue({
      status: gatewayRunning ? "running" : "stopped",
    }),
    refreshProfile: refreshError
      ? vi.fn().mockRejectedValueOnce(refreshError).mockResolvedValue(undefined)
      : vi.fn().mockResolvedValue(undefined),
  };
  const service = new AutoSwitchService({
    profileService,
    healthService,
    clientService,
    applyService,
    gatewayService,
    now,
  });

  return {
    service,
    profileService,
    healthService,
    clientService,
    applyService,
    gatewayService,
  };
}

function failoverProfile(id, name, samples) {
  const checkedAt = "2026-07-30T08:00:00.000Z";
  return {
    id,
    name,
    protocol: "openai-responses",
    baseUrl: `https://${name.toLowerCase()}.example/v1`,
    model: MODEL,
    targets: ["codex"],
    endpoints: [{
      url: `https://${name.toLowerCase()}.example/v1`,
      models: [MODEL],
      health: samples.at(-1),
      healthHistory: samples.map(({ reachable, latencyMs }) => ({
        status: reachable ? "healthy" : "unhealthy",
        reachable,
        latencyMs,
        checkedAt,
      })),
    }],
    autoSwitch: { enabled: false, intervalMinutes: 2 },
  };
}

function failoverHarness() {
  const reachable = (latencyMs) => ({
    status: "healthy",
    reachable: true,
    latencyMs,
    checkedAt: "2026-07-30T08:00:00.000Z",
  });
  const unreachable = (latencyMs) => ({
    status: "unhealthy",
    reachable: false,
    latencyMs,
    checkedAt: "2026-07-30T08:00:00.000Z",
  });
  const current = failoverProfile(CURRENT_PROFILE_ID, "Current", [reachable(120)]);
  const stable = failoverProfile(STABLE_PROFILE_ID, "Stable", [
    reachable(180), reachable(200), reachable(190),
  ]);
  const fast = failoverProfile(FAST_PROFILE_ID, "Fast", [
    reachable(20), unreachable(20), reachable(20),
  ]);
  const excluded = failoverProfile(EXCLUDED_PROFILE_ID, "Excluded", [reachable(1)]);
  const profiles = [current, stable, fast, excluded];
  const route = { target: "codex", profileId: CURRENT_PROFILE_ID };
  const apply = vi.fn().mockResolvedValue(undefined);
  const onChange = vi.fn();
  const profileService = { list: vi.fn().mockResolvedValue(profiles) };
  const healthService = {
    probeProfile: vi.fn(async (id) => ({
      ok: true,
      firstByteMs: id === STABLE_PROFILE_ID ? 180 : 10,
      totalMs: id === STABLE_PROFILE_ID ? 200 : 20,
      model: MODEL,
      checkedAt: "2026-07-30T08:01:00.000Z",
    })),
  };
  const settingsService = {
    getPublicSettings: vi.fn(() => ({
      failover: {
        claude: { enabled: false, profileIds: [] },
        codex: {
          enabled: true,
          profileIds: [CURRENT_PROFILE_ID, STABLE_PROFILE_ID, FAST_PROFILE_ID],
        },
        opencode: { enabled: false, profileIds: [] },
        gemini: { enabled: false, profileIds: [] },
      },
    })),
  };
  const gatewayService = {
    getPublicState: vi.fn(() => ({
      status: "running",
      engaged: ["codex"],
      routes: [route],
    })),
  };
  const applyService = {
    withLifecycleLock: vi.fn(async (operation) => operation({ apply })),
  };
  const service = new AutoSwitchService({
    profileService,
    healthService,
    settingsService,
    gatewayService,
    applyService,
    now: () => Date.parse("2026-07-30T08:02:00.000Z"),
  });
  service.onChange = onChange;
  return {
    service,
    apply,
    applyService,
    onChange,
    healthService,
    settingsService,
    gatewayService,
  };
}

describe("自动 URL 切换服务", () => {
  it("自动择优只切活动 URL 和网关缓存，不重写客户端配置", async () => {
    const tested = profile({
      endpoints: [
        endpoint(CURRENT_URL, { status: "unhealthy", latencyMs: 900 }),
        endpoint(FAST_URL, { latencyMs: 40 }),
      ],
    });
    const { service, applyService, gatewayService } = createHarness({
      tested,
      clients: [
        { target: "codex", activeProfileId: PROFILE_ID, drifted: false },
        { target: "opencode", activeProfileId: PROFILE_ID, drifted: false },
      ],
      gatewayTargets: ["codex"],
    });

    const event = await service.runProfile(PROFILE_ID);

    expect(gatewayService.assignedTargetsForProfile).toHaveBeenCalledWith(PROFILE_ID);
    expect(gatewayService.refreshProfile).toHaveBeenCalledWith(PROFILE_ID);
    expect(applyService.apply).not.toHaveBeenCalled();
    expect(event.targets).toEqual(["codex"]);
  });

  it("进入生命周期锁后重新读取路由，已解除分配时不刷新缓存", async () => {
    const tested = profile({
      endpoints: [
        endpoint(CURRENT_URL, { status: "unhealthy", latencyMs: 900 }),
        endpoint(FAST_URL, { latencyMs: 40 }),
      ],
    });
    const { service, applyService, gatewayService } = createHarness({
      tested,
      clients: [
        { target: "codex", activeProfileId: PROFILE_ID, drifted: false },
      ],
      gatewayTargets: ["codex"],
    });
    applyService.withLifecycleLock.mockImplementation(async (operation) => {
      gatewayService.assignedTargetsForProfile.mockReturnValue([]);
      return operation({ apply: applyService.apply });
    });

    await service.runProfile(PROFILE_ID);

    expect(applyService.withLifecycleLock).toHaveBeenCalledOnce();
    expect(gatewayService.refreshProfile).not.toHaveBeenCalled();
    expect(applyService.apply).not.toHaveBeenCalled();
  });

  it("当前端点失败时立即切到最快兼容端点，并报告已分配目标", async () => {
    const tested = profile({
      endpoints: [
        endpoint(CURRENT_URL, { status: "unhealthy", latencyMs: 900 }),
        endpoint(FAST_URL, { latencyMs: 45 }),
        endpoint(ALTERNATE_URL, { latencyMs: 70 }),
      ],
    });
    const clients = [
      { target: "codex", activeProfileId: PROFILE_ID, drifted: false },
      { target: "opencode", activeProfileId: PROFILE_ID, drifted: false },
      { target: "claude", activeProfileId: PROFILE_ID, drifted: true },
      { target: "gemini", activeProfileId: "another-profile", drifted: false },
    ];
    const {
      service,
      profileService,
      applyService,
    } = createHarness({ tested, clients, gatewayTargets: ["codex", "opencode"] });

    const event = await service.runProfile(PROFILE_ID);

    expect(event).toMatchObject({
      switched: true,
      previousBaseUrl: CURRENT_URL,
      baseUrl: FAST_URL,
      targets: ["codex", "opencode"],
    });
    expect(profileService.setActiveEndpoint).toHaveBeenCalledWith(
      PROFILE_ID,
      FAST_URL,
      {
        expectedBaseUrl: CURRENT_URL,
        expectedRevision: CONNECTION_REVISION,
      },
    );
    expect(applyService.apply).not.toHaveBeenCalled();
  });

  it("当前端点健康时要求同一候选连续胜出两轮", async () => {
    const firstWinner = profile({
      endpoints: [
        endpoint(CURRENT_URL, { latencyMs: 100 }),
        endpoint(FAST_URL, { latencyMs: 50 }),
        endpoint(ALTERNATE_URL, { latencyMs: 60 }),
      ],
    });
    const secondWinner = profile({
      endpoints: [
        endpoint(CURRENT_URL, { latencyMs: 100 }),
        endpoint(FAST_URL, { latencyMs: 70 }),
        endpoint(ALTERNATE_URL, { latencyMs: 50 }),
      ],
    });
    const { service, profileService } = createHarness({
      tested: secondWinner,
      testResults: [firstWinner, secondWinner, secondWinner],
    });

    const first = await service.runProfile(PROFILE_ID);
    const second = await service.runProfile(PROFILE_ID);
    const third = await service.runProfile(PROFILE_ID);

    expect(first.switched).toBe(false);
    expect(second.switched).toBe(false);
    expect(third).toMatchObject({ switched: true, baseUrl: ALTERNATE_URL });
    expect(profileService.setActiveEndpoint).toHaveBeenCalledOnce();
  });

  it("只在候选至少快 25ms 时切换健康端点", async () => {
    const boundary = profile({
      endpoints: [
        endpoint(CURRENT_URL, { latencyMs: 100 }),
        endpoint(FAST_URL, {
          latencyMs: 100 - MINIMUM_IMPROVEMENT_MS,
        }),
      ],
    });
    const belowBoundary = profile({
      endpoints: [
        endpoint(CURRENT_URL, { latencyMs: 100 }),
        endpoint(FAST_URL, {
          latencyMs: 101 - MINIMUM_IMPROVEMENT_MS,
        }),
      ],
    });
    const boundaryHarness = createHarness({ tested: boundary });
    const belowBoundaryHarness = createHarness({ tested: belowBoundary });

    await boundaryHarness.service.runProfile(PROFILE_ID);
    const boundaryEvent = await boundaryHarness.service.runProfile(PROFILE_ID);
    await belowBoundaryHarness.service.runProfile(PROFILE_ID);
    const belowBoundaryEvent = await belowBoundaryHarness.service.runProfile(PROFILE_ID);

    expect(boundaryEvent.switched).toBe(true);
    expect(boundaryHarness.profileService.setActiveEndpoint).toHaveBeenCalledOnce();
    expect(belowBoundaryEvent.switched).toBe(false);
    expect(belowBoundaryHarness.profileService.setActiveEndpoint).not.toHaveBeenCalled();
  });

  it("网关缓存刷新失败时恢复原活动 URL", async () => {
    const tested = profile({
      endpoints: [
        endpoint(CURRENT_URL, { status: "unhealthy", latencyMs: 900 }),
        endpoint(FAST_URL, { latencyMs: 40 }),
      ],
    });
    const refreshError = new Error("测试缓存刷新失败");
    const { service, profileService } = createHarness({
      tested,
      clients: [
        { target: "codex", activeProfileId: PROFILE_ID, drifted: false },
      ],
      refreshError,
      gatewayTargets: ["codex"],
    });

    await expect(service.runProfile(PROFILE_ID)).rejects.toThrow("测试缓存刷新失败");
    expect(profileService.setActiveEndpoint.mock.calls).toEqual([
      [
        PROFILE_ID,
        FAST_URL,
        {
          expectedBaseUrl: CURRENT_URL,
          expectedRevision: CONNECTION_REVISION,
        },
      ],
      [
        PROFILE_ID,
        CURRENT_URL,
        {
          expectedBaseUrl: FAST_URL,
          expectedRevision: CONNECTION_REVISION + 1,
        },
      ],
    ]);
  });

  it("健康端点没有当前模型时不切换", async () => {
    const tested = profile({
      endpoints: [
        endpoint(CURRENT_URL, { status: "unhealthy", latencyMs: 900 }),
        endpoint(FAST_URL, { latencyMs: 30, models: ["another-model"] }),
      ],
    });
    const {
      service,
      profileService,
      clientService,
      applyService,
    } = createHarness({ tested });

    const event = await service.runProfile(PROFILE_ID);

    expect(event.switched).toBe(false);
    expect(profileService.setActiveEndpoint).not.toHaveBeenCalled();
    expect(applyService.apply).not.toHaveBeenCalled();
  });

  it("滚动健康候选也排除不支持当前模型的端点", () => {
    const tested = profile({
      endpoints: [
        endpoint(CURRENT_URL, { status: "unhealthy", latencyMs: 900 }),
        endpoint(FAST_URL, { latencyMs: 30, models: ["another-model"] }),
      ],
    });

    expect(candidateEndpoints(tested, { allowCold: true })).toEqual([]);
  });

  it("按方案配置的检测周期判断是否到期", () => {
    let now = 9 * 60_000;
    const tested = profile({
      endpoints: [
        { ...endpoint(CURRENT_URL), health: undefined },
        { ...endpoint(FAST_URL), health: undefined },
      ],
      autoSwitch: { enabled: true, intervalMinutes: 10 },
    });
    const { service } = createHarness({ tested, now: () => now });

    expect(service.isDue(tested)).toBe(false);
    now = 10 * 60_000;
    expect(service.isDue(tested)).toBe(true);
  });

  it("未开启 URL 自动择优的密钥仍会按周期探测，但不会切换 URL", async () => {
    const tested = profile({
      autoSwitch: { enabled: false, intervalMinutes: 2 },
      endpoints: [
        { ...endpoint(CURRENT_URL), health: undefined },
        { ...endpoint(FAST_URL), health: undefined },
      ],
    });
    const { service, healthService, profileService } = createHarness({
      tested,
      now: () => 120_000,
    });

    await service.tick();

    expect(healthService.testWithSnapshot).toHaveBeenCalledOnce();
    expect(profileService.setActiveEndpoint).not.toHaveBeenCalled();
  });

  it("Codex 连续三次渠道失败后只在其候选库内实测，并按可用率优先切换", async () => {
    const { service, apply, healthService, onChange } = failoverHarness();
    const failure = {
      client: "codex",
      profileId: CURRENT_PROFILE_ID,
      outcome: "failed",
      statusCode: 503,
    };

    await service.recordRequestResult(failure);
    await service.recordRequestResult(failure);
    expect(apply).not.toHaveBeenCalled();
    await service.recordRequestResult(failure);

    expect(healthService.probeProfile.mock.calls.map(([id]) => id).sort()).toEqual([
      FAST_PROFILE_ID,
      STABLE_PROFILE_ID,
    ].sort());
    expect(healthService.probeProfile).not.toHaveBeenCalledWith(EXCLUDED_PROFILE_ID);
    expect(apply).toHaveBeenCalledWith(STABLE_PROFILE_ID, ["codex"]);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      type: "failure-switch",
      target: "codex",
      previousProfileId: CURRENT_PROFILE_ID,
      profileId: STABLE_PROFILE_ID,
      profileName: "Stable",
      switched: true,
    }));
  });

  it("成功请求会清零连续失败，且其他客户端的关闭状态互不影响", async () => {
    const { service, apply } = failoverHarness();
    const failure = {
      client: "codex",
      profileId: CURRENT_PROFILE_ID,
      outcome: "failed",
      statusCode: 429,
    };
    await service.recordRequestResult(failure);
    await service.recordRequestResult(failure);
    await service.recordRequestResult({
      client: "codex",
      profileId: CURRENT_PROFILE_ID,
      outcome: "completed",
      statusCode: 200,
    });
    await service.recordRequestResult(failure);
    await service.recordRequestResult({
      client: "claude",
      profileId: CURRENT_PROFILE_ID,
      outcome: "failed",
      statusCode: 503,
    });

    expect(apply).not.toHaveBeenCalled();
  });

  it("旧密钥晚到的成功请求不会清零当前密钥的连续失败", async () => {
    const { service } = failoverHarness();
    const currentFailure = {
      client: "codex",
      profileId: CURRENT_PROFILE_ID,
      outcome: "failed",
      statusCode: 503,
    };

    await service.recordRequestResult(currentFailure);
    await service.recordRequestResult({
      client: "codex",
      profileId: STABLE_PROFILE_ID,
      outcome: "completed",
      statusCode: 200,
    });

    expect(service.failures.get("codex")).toEqual({
      profileId: CURRENT_PROFILE_ID,
      count: 1,
    });
  });

  it("旧密钥晚到的失败请求不会清零当前密钥的连续失败", async () => {
    const { service, gatewayService } = failoverHarness();
    const currentFailure = {
      client: "codex",
      profileId: CURRENT_PROFILE_ID,
      outcome: "failed",
      statusCode: 503,
    };
    const nextFailure = { ...currentFailure, profileId: STABLE_PROFILE_ID };
    gatewayService.getPublicState.mockReturnValue({
      status: "running",
      engaged: ["codex"],
      routes: [{ target: "codex", profileId: STABLE_PROFILE_ID }],
    });

    await service.recordRequestResult(nextFailure);
    await service.recordRequestResult(currentFailure);

    expect(service.failures.get("codex")).toEqual({
      profileId: STABLE_PROFILE_ID,
      count: 1,
    });
  });

  it("设置或网关生命周期变化后必须重新累计连续失败", async () => {
    const { service, apply } = failoverHarness();
    const failure = {
      client: "codex",
      profileId: CURRENT_PROFILE_ID,
      outcome: "failed",
      statusCode: 503,
    };

    await service.recordRequestResult(failure);
    await service.recordRequestResult(failure);
    service.resetFailoverFailures();
    await service.recordRequestResult(failure);

    expect(service.failures.get("codex")).toEqual({
      profileId: CURRENT_PROFILE_ID,
      count: 1,
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it("当前密钥不在候选库时不接管，普通 4xx 和取消也不累计失败", async () => {
    const { service, apply, healthService, settingsService } = failoverHarness();
    settingsService.getPublicSettings.mockReturnValue({
      failover: {
        claude: { enabled: false, profileIds: [] },
        codex: { enabled: true, profileIds: [STABLE_PROFILE_ID, FAST_PROFILE_ID] },
        opencode: { enabled: false, profileIds: [] },
        gemini: { enabled: false, profileIds: [] },
      },
    });
    const failure = {
      client: "codex",
      profileId: CURRENT_PROFILE_ID,
      outcome: "failed",
      statusCode: 503,
    };

    await service.recordRequestResult(failure);
    await service.recordRequestResult(failure);
    await service.recordRequestResult(failure);
    await service.recordRequestResult({ ...failure, statusCode: 400 });
    await service.recordRequestResult({ ...failure, statusCode: 400 }, { channelFailure: true });
    await service.recordRequestResult({ ...failure, outcome: "cancelled", statusCode: undefined });
    await service.recordRequestResult({ ...failure, statusCode: undefined }, { channelFailure: false });

    expect(healthService.probeProfile).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("HTTP 200 流内的协议级渠道失败会累计并触发切换", async () => {
    const { service, apply } = failoverHarness();
    const failure = {
      client: "codex",
      profileId: CURRENT_PROFILE_ID,
      outcome: "failed",
      statusCode: 200,
    };

    await service.recordRequestResult(failure, { channelFailure: true });
    await service.recordRequestResult(failure, { channelFailure: true });
    await service.recordRequestResult(failure, { channelFailure: true });

    expect(apply).toHaveBeenCalledWith(STABLE_PROFILE_ID, ["codex"]);
  });

  it("stopAndWait 会中止并等待故障切换实测，且停止后不再接管请求", async () => {
    const { service, apply, healthService, onChange } = failoverHarness();
    healthService.probeProfile.mockImplementation((_id, _model, { signal }) => (
      new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ ok: false }), { once: true });
      })
    ));
    const failure = {
      client: "codex",
      profileId: CURRENT_PROFILE_ID,
      outcome: "failed",
      statusCode: 503,
    };

    await service.recordRequestResult(failure);
    await service.recordRequestResult(failure);
    const switching = service.recordRequestResult(failure);
    await vi.waitFor(() => expect(healthService.probeProfile).toHaveBeenCalledTimes(2));
    await Promise.all([switching, service.stopAndWait()]);

    expect(healthService.probeProfile.mock.calls.every((call) => call[2].signal.aborted)).toBe(true);
    expect(apply).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();

    await service.recordRequestResult(failure);
    await service.recordRequestResult(failure);
    await service.recordRequestResult(failure);
    expect(healthService.probeProfile).toHaveBeenCalledTimes(2);
  });

  it("停止后即使故障切换拿到生命周期锁也不得提交路由", async () => {
    const { service, apply, applyService, onChange } = failoverHarness();
    let releaseLifecycle;
    applyService.withLifecycleLock.mockImplementation((operation) => new Promise((resolve, reject) => {
      releaseLifecycle = () => Promise.resolve(operation({ apply })).then(resolve, reject);
    }));
    const failure = {
      client: "codex",
      profileId: CURRENT_PROFILE_ID,
      outcome: "failed",
      statusCode: 503,
    };

    await service.recordRequestResult(failure);
    await service.recordRequestResult(failure);
    const switching = service.recordRequestResult(failure);
    await vi.waitFor(() => expect(applyService.withLifecycleLock).toHaveBeenCalledOnce());
    let stopped = false;
    const stopBarrier = service.stopAndWait().then(() => {
      stopped = true;
    });
    await Promise.resolve();

    expect(stopped).toBe(false);
    releaseLifecycle();
    await Promise.all([switching, stopBarrier]);
    expect(apply).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("故障切换提交期间停止会在同一事务内切回原密钥", async () => {
    const { service, apply, onChange } = failoverHarness();
    let finishSelectedApply;
    apply
      .mockImplementationOnce(() => new Promise((resolve) => {
        finishSelectedApply = resolve;
      }))
      .mockResolvedValueOnce(undefined);
    const failure = {
      client: "codex",
      profileId: CURRENT_PROFILE_ID,
      outcome: "failed",
      statusCode: 503,
    };

    await service.recordRequestResult(failure);
    await service.recordRequestResult(failure);
    const switching = service.recordRequestResult(failure);
    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith(STABLE_PROFILE_ID, ["codex"]));
    const stopBarrier = service.stopAndWait();
    finishSelectedApply();
    await Promise.all([switching, stopBarrier]);

    expect(apply.mock.calls).toEqual([
      [STABLE_PROFILE_ID, ["codex"]],
      [CURRENT_PROFILE_ID, ["codex"]],
    ]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("前一轮 tick 未完成时不会重入", async () => {
    const dueProfile = profile({
      endpoints: [
        { ...endpoint(CURRENT_URL), health: undefined },
        { ...endpoint(FAST_URL), health: undefined },
      ],
    });
    const { service, profileService } = createHarness({
      tested: dueProfile,
      gatewayTargets: ["codex"],
      now: () => 120_000,
    });
    let finishRun;
    service.runProfile = vi.fn().mockImplementation(() => new Promise((resolve) => {
      finishRun = () => resolve({
        type: "profile-tested",
        profileId: PROFILE_ID,
        switched: false,
      });
    }));

    const firstTick = service.tick();
    await vi.waitFor(() => expect(service.runProfile).toHaveBeenCalledOnce());
    const secondTick = service.tick();

    expect(secondTick).toBe(firstTick);
    expect(profileService.list).toHaveBeenCalledOnce();
    expect(service.runProfile).toHaveBeenCalledOnce();
    finishRun();
    await Promise.all([firstTick, secondTick]);
  });

  it("未分配给任何客户端的备用方案仍在后台扫描，但不刷新客户端路由", async () => {
    const dueProfile = profile({
      endpoints: [
        { ...endpoint(CURRENT_URL), health: undefined },
        { ...endpoint(FAST_URL), health: undefined },
      ],
    });
    const { service, healthService, gatewayService, applyService } = createHarness({
      tested: dueProfile,
      gatewayTargets: [],
      now: () => 120_000,
    });

    await service.tick();

    expect(healthService.testWithSnapshot).toHaveBeenCalledOnce();
    expect(healthService.testWithSnapshot).toHaveBeenCalledWith(PROFILE_ID, {
      signal: expect.any(AbortSignal),
    });
    expect(gatewayService.refreshProfile).not.toHaveBeenCalled();
    expect(applyService.apply).not.toHaveBeenCalled();
  });

  it("stopAndWait 会中止运行中的检测且不切换 URL", async () => {
    const dueProfile = profile({
      endpoints: [
        { ...endpoint(CURRENT_URL), health: undefined },
        { ...endpoint(FAST_URL), health: undefined },
      ],
    });
    const { service, healthService, profileService } = createHarness({
      tested: dueProfile,
      gatewayTargets: ["codex"],
    });
    healthService.testWithSnapshot.mockImplementation((_id, { signal }) => (
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("测试中止");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      })
    ));

    service.start();
    await vi.waitFor(() => expect(healthService.testWithSnapshot).toHaveBeenCalledOnce());
    await service.stopAndWait();

    expect(service.running).toBe(false);
    expect(profileService.setActiveEndpoint).not.toHaveBeenCalled();
  });

  it("停止后即使生命周期锁放行也不再提交切换", async () => {
    const tested = profile({
      endpoints: [
        endpoint(CURRENT_URL, { status: "unhealthy", latencyMs: 900 }),
        endpoint(FAST_URL, { latencyMs: 40 }),
      ],
    });
    const { service, profileService, applyService } = createHarness({
      tested,
      gatewayTargets: ["codex"],
    });
    let releaseLifecycle;
    applyService.withLifecycleLock.mockImplementation((operation) => new Promise((resolve, reject) => {
      releaseLifecycle = () => Promise.resolve(operation({})).then(resolve, reject);
    }));

    const activeTick = service.tick();
    await vi.waitFor(() => expect(applyService.withLifecycleLock).toHaveBeenCalledOnce());
    const stopBarrier = service.stopAndWait();
    releaseLifecycle();
    await Promise.all([activeTick, stopBarrier]);

    expect(profileService.setActiveEndpoint).not.toHaveBeenCalled();
  });

  it("stopAndWait 等待已开始的缓存刷新完成回滚后才结束", async () => {
    const tested = profile({
      endpoints: [
        endpoint(CURRENT_URL, { status: "unhealthy", latencyMs: 900 }),
        endpoint(FAST_URL, { latencyMs: 40 }),
      ],
    });
    const { service, profileService, gatewayService } = createHarness({
      tested,
      gatewayTargets: ["codex"],
    });
    let finishRollback;
    gatewayService.refreshProfile
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        finishRollback = () => reject(new Error("测试缓存刷新失败"));
      }))
      .mockResolvedValue(undefined);

    const activeTick = service.tick();
    await vi.waitFor(() => expect(gatewayService.refreshProfile).toHaveBeenCalledOnce());
    let stopped = false;
    const stopBarrier = service.stopAndWait().then(() => {
      stopped = true;
    });
    await Promise.resolve();

    expect(stopped).toBe(false);
    expect(profileService.setActiveEndpoint).toHaveBeenCalledTimes(1);
    finishRollback();
    await Promise.all([activeTick, stopBarrier]);

    expect(profileService.setActiveEndpoint).toHaveBeenLastCalledWith(
      PROFILE_ID,
      CURRENT_URL,
      {
        expectedBaseUrl: FAST_URL,
        expectedRevision: CONNECTION_REVISION + 1,
      },
    );
    expect(stopped).toBe(true);
    expect(service.running).toBe(false);
  });
});
