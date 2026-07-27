import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { CHANNELS, registerIpcHandlers } = require("../electron/services/ipc.cjs");

function createHarness({ gatewayRoutes = [], gatewayStatus, ...overrides } = {}) {
  const handlers = new Map();
  const trace = [];
  const stopGateway = vi.fn().mockResolvedValue({ skippedTargets: ["codex"] });
  const profile = {
    id: "00000000-0000-4000-8000-000000000901",
    name: "IPC 夹具",
    protocol: "openai-responses",
    baseUrl: "https://api.example.com/v1",
    endpoints: [{ url: "https://api.example.com/v1", models: [] }],
    model: "gpt-test",
    authMode: "bearer",
    targets: ["codex"],
    enableToolSearch: false,
    autoSwitch: { enabled: false, intervalMinutes: 5 },
  };
  const dependencies = {
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    clipboard: { writeText: vi.fn() },
    isTrustedSender: vi.fn(() => true),
    profileService: {
      list: vi.fn().mockResolvedValue([profile]),
      listGroups: vi.fn().mockResolvedValue([]),
      save: vi.fn().mockImplementation(async (input) => {
        trace.push("save");
        return { ...profile, ...input, id: input.id ?? profile.id };
      }),
      createGroup: vi.fn().mockResolvedValue({ id: "00000000-0000-4000-8000-000000000902" }),
      renameGroup: vi.fn().mockResolvedValue({ id: "00000000-0000-4000-8000-000000000902" }),
      updateGroupMembers: vi.fn().mockResolvedValue([profile]),
      deleteGroup: vi.fn().mockResolvedValue({ ok: true }),
      organize: vi.fn().mockResolvedValue({ groups: [], profiles: [profile] }),
      delete: vi.fn().mockResolvedValue({ ok: true }),
    },
    walletService: {
      list: vi.fn().mockResolvedValue([]),
      save: vi.fn().mockImplementation(async (input) => ({ id: "wallet-id", ...input })),
      importSub2ApiKeys: vi.fn().mockResolvedValue({
        status: "complete",
        groupName: "余额",
        imported: 1,
        reused: 0,
        skipped: 0,
        profileIds: [profile.id],
      }),
      delete: vi.fn().mockResolvedValue({ ok: true }),
      check: vi.fn().mockResolvedValue({ id: "wallet-id", balance: { status: "ok" } }),
    },
    walletLoginService: {
      login: vi.fn().mockResolvedValue({ cancelled: false, wallet: { id: "wallet-id" } }),
    },
    clientService: {
      scan: vi.fn().mockResolvedValue([]),
      openConfig: vi.fn(),
    },
    healthService: {
      test: vi.fn().mockImplementation(async () => {
        trace.push("test");
        return { ...profile, availableModels: ["gpt-test"] };
      }),
      discoverDraftModels: vi.fn().mockResolvedValue(["gpt-draft"]),
      testHealth: vi.fn().mockImplementation(async () => ({
        ...profile,
        endpoints: profile.endpoints.map((endpoint) => ({
          ...endpoint,
          health: { status: "healthy", latencyMs: 123 },
        })),
      })),
    },
    applyService: {
      listHistory: vi.fn().mockResolvedValue([]),
      listVerifiedTargets: vi.fn().mockResolvedValue([]),
      withLifecycleLock: vi.fn().mockImplementation((operation) => operation({ stopGateway })),
      assignProfile: vi.fn().mockImplementation(async (_id, targets) => ({
        assignedTargets: targets || profile.targets,
        gateway: {
          status: gatewayStatus ?? (gatewayRoutes.length > 0 ? "running" : "stopped"),
          host: "127.0.0.1",
          port: 17863,
          targets: gatewayRoutes.map((route) => route.target),
          routes: gatewayRoutes,
        },
      })),
      startGateway: vi.fn().mockResolvedValue(undefined),
      stopGateway,
    },
    gatewayService: {
      // 形状必须跟真的 GatewayService.getPublicState() 一致——上面那条测试会拿真货来比对。
      getPublicState: vi.fn().mockImplementation(() => ({
        status: gatewayStatus ?? (gatewayRoutes.length > 0 ? "running" : "stopped"),
        host: "127.0.0.1",
        port: 17863,
        targets: gatewayRoutes.map((route) => route.target),
        engaged: gatewayRoutes.map((route) => route.target),
        routes: gatewayRoutes,
        localBaseUrls: Object.fromEntries(gatewayRoutes.map((route) => [
          route.target,
          `http://127.0.0.1:17863/${route.target}`,
        ])),
      })),
      refreshProfile: vi.fn().mockImplementation(async () => {
        trace.push("refresh");
      }),
      unassignRoutes: vi.fn().mockResolvedValue({
        targets: gatewayRoutes.map((route) => route.target),
        routes: Object.fromEntries(gatewayRoutes.map((route) => [route.target, route.profileId])),
      }),
      restoreRoutes: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
  registerIpcHandlers(dependencies);
  return { handlers, trace, profile, dependencies };
}

function saveInput(profile, overrides = {}) {
  return {
    id: profile.id,
    name: profile.name,
    protocol: profile.protocol,
    baseUrl: profile.baseUrl,
    endpoints: profile.endpoints.map(({ url }) => ({ url })),
    apiKey: "",
    model: profile.model,
    authMode: profile.authMode,
    targets: [...profile.targets],
    enableToolSearch: profile.enableToolSearch,
    autoSwitch: { ...profile.autoSwitch },
    ...overrides,
  };
}

describe("IPC bootstrap", () => {
  it("在调用任何 service 前拒绝不可信的渲染进程", async () => {
    const isTrustedSender = vi.fn(() => false);
    const { handlers, dependencies } = createHarness({ isTrustedSender });
    const event = { senderFrame: { url: "https://attacker.example" } };

    await expect(handlers.get(CHANNELS.bootstrap)(event)).rejects.toThrow("Unauthorized IPC sender");
    expect(isTrustedSender).toHaveBeenCalledWith(event);
    expect(dependencies.profileService.list).not.toHaveBeenCalled();
    expect(dependencies.clientService.scan).not.toHaveBeenCalled();
  });

  it("网关状态的每个字段都要透传给渲染进程，一个都不能漏", async () => {
    /*
     * 真实事故：getBootstrap 原本逐字段手抄 getPublicState()，给网关状态新增
     * engaged 后忘了跟着抄，桌面版拿到的 gateway 少了这个字段，渲染进程一读
     * engaged.length 就白屏。而浏览器预览用 mock 数据、字段是全的，测不出来。
     *
     * 所以这里必须拿【真的】 GatewayService 产出的字段清单来比对——手写一份假的
     * public state 只会和被测代码犯同一个错。
     */
    const { GatewayService, defaultGatewayStore } = require("../electron/services/gateway-service.cjs");
    const real = new GatewayService({
      profileService: { async getConnection() { throw new Error("unused"); } },
      store: { async read() { return defaultGatewayStore(); }, async write(next) { return next; } },
      vault: { encrypt: (v) => v, decrypt: (v) => v },
    });
    await real.initialize({ start: false });
    const expectedKeys = Object.keys(real.getPublicState()).sort();

    const { handlers } = createHarness();
    const bootstrap = await handlers.get(CHANNELS.bootstrap)();
    const actualKeys = Object.keys(bootstrap.gateway).sort();

    const missing = expectedKeys.filter((key) => !actualKeys.includes(key));
    expect(missing, `getBootstrap 漏传了网关字段：${missing.join(", ")}`).toEqual([]);
  });

  it("请求监控 bootstrap 透传完整快照和 revision", async () => {
    const activeRequests = [{
      id: "request-1",
      client: "codex",
      profileName: "方案",
      upstreamUrl: "https://api.example.com/v1",
      state: "completed",
      startedAt: "2026-07-14T10:00:00.000Z",
    }];
    const requestMonitor = {
      getActiveRequestsSnapshot: vi.fn(() => ({
        activeRequests,
        activeRequestsRevision: 17,
      })),
    };
    const { handlers } = createHarness({ requestMonitor });

    await expect(handlers.get(CHANNELS.bootstrap)()).resolves.toMatchObject({
      activeRequests,
      activeRequestsRevision: 17,
    });
    expect(requestMonitor.getActiveRequestsSnapshot).toHaveBeenCalledTimes(1);
  });

  it("启动恢复错误随 bootstrap 返回，避免静默启动时丢失一次性事件", async () => {
    const startupError = "Could not restore gateway targets on launch: claude: configuration is busy";
    const { handlers } = createHarness({ startupError });

    await expect(handlers.get(CHANNELS.bootstrap)()).resolves.toMatchObject({ startupError });
  });
});

describe("IPC sessions", () => {
  it("会话扫描把部分结果和逐客户端错误一起返回", async () => {
    const result = {
      sessions: [{ id: "codex:ok", client: "codex", nativeId: "ok" }],
      errors: [{ client: "claude", reason: "permission denied" }],
    };
    const sessionService = { listDetailed: vi.fn().mockResolvedValue(result) };
    const { handlers } = createHarness({ sessionService });

    await expect(handlers.get(CHANNELS.listSessions)(null)).resolves.toEqual(result);
    expect(sessionService.listDetailed).toHaveBeenCalledTimes(1);
  });
});

describe("IPC wallets", () => {
  it("独立转发钱包的列表、保存、登录、导入、检测和删除操作", async () => {
    const { handlers, dependencies, profile } = createHarness();
    const input = {
      name: "余额",
      siteUrl: "https://relay.example",
      template: "sub2api",
      lowBalanceUsd: 5,
    };

    await expect(handlers.get(CHANNELS.listWallets)(null)).resolves.toEqual([]);
    await expect(handlers.get(CHANNELS.saveWallet)(null, input)).resolves.toMatchObject(input);
    await expect(handlers.get(CHANNELS.loginWallet)(null, "wallet-id"))
      .resolves.toMatchObject({ cancelled: false, wallet: { id: "wallet-id" } });
    await expect(handlers.get(CHANNELS.importWalletKeys)(null, "wallet-id", "existing"))
      .resolves.toMatchObject({ status: "complete", imported: 1 });
    await expect(handlers.get(CHANNELS.checkWallet)(null, "wallet-id"))
      .resolves.toMatchObject({ id: "wallet-id" });
    await expect(handlers.get(CHANNELS.deleteWallet)(null, "wallet-id"))
      .resolves.toEqual({ ok: true });
    expect(dependencies.walletService.list).toHaveBeenCalledTimes(1);
    expect(dependencies.walletService.save).toHaveBeenCalledWith(input);
    expect(dependencies.walletLoginService.login).toHaveBeenCalledWith("wallet-id");
    expect(dependencies.walletService.importSub2ApiKeys).toHaveBeenCalledWith("wallet-id", "existing");
    expect(dependencies.healthService.test).toHaveBeenCalledWith(profile.id);
    expect(dependencies.walletService.check).toHaveBeenCalledWith("wallet-id");
    expect(dependencies.walletService.delete).toHaveBeenCalledWith("wallet-id");
  });
});

describe("IPC profile groups", () => {
  it("转发分组创建、改名、成员调整、排序和删除操作", async () => {
    const { handlers, dependencies, profile } = createHarness();
    const groupId = "00000000-0000-4000-8000-000000000902";
    const organization = {
      groupIds: [groupId],
      profiles: [{ id: profile.id, groupId }],
    };

    await handlers.get(CHANNELS.createProfileGroup)(null, "主用", [profile.id]);
    await handlers.get(CHANNELS.renameProfileGroup)(null, groupId, "常用");
    await handlers.get(CHANNELS.updateProfileGroupMembers)(null, groupId, [profile.id]);
    await handlers.get(CHANNELS.organizeProfiles)(null, organization);
    await handlers.get(CHANNELS.deleteProfileGroup)(null, groupId);

    expect(dependencies.profileService.createGroup).toHaveBeenCalledWith("主用", [profile.id]);
    expect(dependencies.profileService.renameGroup).toHaveBeenCalledWith(groupId, "常用");
    expect(dependencies.profileService.updateGroupMembers).toHaveBeenCalledWith(groupId, [profile.id]);
    expect(dependencies.profileService.organize).toHaveBeenCalledWith(organization);
    expect(dependencies.profileService.deleteGroup).toHaveBeenCalledWith(groupId);
  });
});

describe("IPC shutdown gate", () => {
  it("退出屏障期间拒绝写入，但允许只读快照和删除预演", async () => {
    const isShuttingDown = vi.fn(() => true);
    const { handlers, profile, dependencies } = createHarness({ isShuttingDown });

    await expect(handlers.get(CHANNELS.saveProfile)(null, saveInput(profile)))
      .rejects.toThrow("Application is shutting down");
    await expect(handlers.get(CHANNELS.bootstrap)(null)).resolves.toBeDefined();
    await expect(handlers.get(CHANNELS.planSessionRemoval)(null, ["codex:session"]))
      .resolves.toEqual([]);
    expect(dependencies.profileService.save).not.toHaveBeenCalled();
  });

  it("清理失败后闸门可恢复接受写入", async () => {
    let shuttingDown = true;
    const { handlers, profile, dependencies } = createHarness({
      isShuttingDown: () => shuttingDown,
    });
    await expect(handlers.get(CHANNELS.saveProfile)(null, saveInput(profile)))
      .rejects.toThrow("Application is shutting down");
    shuttingDown = false;
    await expect(handlers.get(CHANNELS.saveProfile)(null, saveInput(profile))).resolves.toBeDefined();
    expect(dependencies.profileService.save).toHaveBeenCalledTimes(1);
  });
});

describe("IPC update install", () => {
  it("只在安装包已下载完成时请求退出安装", async () => {
    const requestUpdateInstall = vi.fn();
    const updateService = {
      getPublicState: vi.fn(() => ({ state: "available", portable: false })),
    };
    const { handlers } = createHarness({ updateService, requestUpdateInstall });

    await expect(handlers.get(CHANNELS.installUpdate)(null)).rejects.toThrow("not ready");
    expect(requestUpdateInstall).not.toHaveBeenCalled();

    updateService.getPublicState.mockReturnValue({ state: "ready", portable: false });
    await expect(handlers.get(CHANNELS.installUpdate)(null)).resolves.toEqual({ ok: true });
    expect(requestUpdateInstall).toHaveBeenCalledTimes(1);
  });
});

describe("IPC gateway coordination", () => {
  it("新建方案保存后自动识别一次模型，再刷新网关连接", async () => {
    const { handlers, trace, profile, dependencies } = createHarness();
    const input = saveInput(profile);
    delete input.id;
    input.apiKey = "sk-new-profile";

    const result = await handlers.get(CHANNELS.saveProfile)(null, input);

    expect(result).toMatchObject({ id: profile.id, availableModels: ["gpt-test"] });
    expect(dependencies.healthService.test).toHaveBeenCalledOnce();
    expect(dependencies.healthService.test).toHaveBeenCalledWith(profile.id);
    expect(trace).toEqual(["save", "test", "refresh"]);
  });

  it("保存方案只刷新网关连接，不自动识别模型", async () => {
    const { handlers, trace, profile } = createHarness();

    const result = await handlers.get(CHANNELS.saveProfile)(null, saveInput(profile));

    expect(trace).toEqual(["save", "refresh"]);
    expect(result).toMatchObject({ id: profile.id });
  });

  it("活动路由修改协议时先恢复客户端并解除旧路由", async () => {
    const route = { target: "codex", profileId: "00000000-0000-4000-8000-000000000901" };
    const { handlers, trace, profile, dependencies } = createHarness({ gatewayRoutes: [route] });

    await expect(handlers.get(CHANNELS.saveProfile)(
      null,
      saveInput(profile, { protocol: "openai-chat" }),
    )).resolves.toMatchObject({ protocol: "openai-chat" });

    expect(dependencies.applyService.stopGateway).toHaveBeenCalledWith({ targets: ["codex"] });
    expect(dependencies.gatewayService.unassignRoutes).toHaveBeenCalledWith(["codex"]);
    expect(dependencies.gatewayService.restoreRoutes).not.toHaveBeenCalled();
    expect(trace).toEqual(["save", "refresh"]);
  });

  it("活动路由恢复失败时不修改协议", async () => {
    const route = { target: "codex", profileId: "00000000-0000-4000-8000-000000000901" };
    const { handlers, profile, dependencies } = createHarness({ gatewayRoutes: [route] });
    dependencies.applyService.stopGateway.mockRejectedValueOnce(new Error("configuration conflict"));

    await expect(handlers.get(CHANNELS.saveProfile)(
      null,
      saveInput(profile, { protocol: "openai-chat" }),
    )).rejects.toThrow("configuration conflict");

    expect(dependencies.gatewayService.unassignRoutes).not.toHaveBeenCalled();
    expect(dependencies.profileService.save).not.toHaveBeenCalled();
  });

  it("解除活动路由后保存失败会恢复路由分配", async () => {
    const route = { target: "codex", profileId: "00000000-0000-4000-8000-000000000901" };
    const { handlers, profile, dependencies } = createHarness({ gatewayRoutes: [route] });
    const saveError = new Error("profile store is locked");
    dependencies.profileService.save.mockRejectedValueOnce(saveError);

    await expect(handlers.get(CHANNELS.saveProfile)(
      null,
      saveInput(profile, { protocol: "openai-chat" }),
    )).rejects.toThrow(saveError.message);

    expect(dependencies.gatewayService.restoreRoutes).toHaveBeenCalledWith({
      targets: ["codex"],
      routes: { codex: profile.id },
    });
  });

  it("活动路由允许 URL、Key、模型和名称热刷新", async () => {
    const route = { target: "codex", profileId: "00000000-0000-4000-8000-000000000901" };
    const { handlers, trace, profile } = createHarness({ gatewayRoutes: [route] });

    await handlers.get(CHANNELS.saveProfile)(null, saveInput(profile, {
      name: "新的名称",
      baseUrl: "https://fast.example.com/v1",
      endpoints: [{ url: "https://fast.example.com/v1" }],
      apiKey: "sk-new",
      model: "gpt-new",
      autoSwitch: { enabled: true, intervalMinutes: 15 },
    }));

    expect(trace).toEqual(["save", "refresh"]);
  });

  it("等待生命周期锁时新激活的路由也会先恢复再修改协议", async () => {
    const change = { protocol: "openai-chat" };
    const routes = [];
    const stopGateway = vi.fn().mockResolvedValue({ skippedTargets: [] });
    let enterLock;
    const lockReady = new Promise((resolve) => {
      enterLock = resolve;
    });
    const withLifecycleLock = vi.fn().mockImplementation(async (operation) => {
      await lockReady;
      return operation({ stopGateway });
    });
    const { handlers, profile, dependencies } = createHarness({
      gatewayRoutes: routes,
      applyService: {
        listHistory: vi.fn().mockResolvedValue([]),
        listVerifiedTargets: vi.fn().mockResolvedValue([]),
        withLifecycleLock,
        stopGateway: vi.fn().mockResolvedValue({}),
      },
    });

    const saving = handlers.get(CHANNELS.saveProfile)(null, saveInput(profile, change));
    routes.push({ target: "codex", profileId: profile.id });
    enterLock();

    await expect(saving).resolves.toMatchObject(change);
    expect(stopGateway).toHaveBeenCalledWith({ targets: ["codex"] });
    expect(dependencies.gatewayService.unassignRoutes).toHaveBeenCalledWith(["codex"]);
  });

  it("等待生命周期锁时新激活的路由仍允许保存 URL", async () => {
    const routes = [];
    let enterLock;
    const lockReady = new Promise((resolve) => {
      enterLock = resolve;
    });
    const withLifecycleLock = vi.fn().mockImplementation(async (operation) => {
      await lockReady;
      return operation({});
    });
    const { handlers, trace, profile } = createHarness({
      gatewayRoutes: routes,
      applyService: {
        listHistory: vi.fn().mockResolvedValue([]),
        listVerifiedTargets: vi.fn().mockResolvedValue([]),
        withLifecycleLock,
        stopGateway: vi.fn().mockResolvedValue({}),
      },
    });

    const saving = handlers.get(CHANNELS.saveProfile)(null, saveInput(profile, {
      baseUrl: "https://fast.example.com/v1",
      endpoints: [{ url: "https://fast.example.com/v1" }],
    }));
    routes.push({ target: "codex", profileId: profile.id });
    enterLock();

    await expect(saving).resolves.toBeDefined();
    expect(trace).toEqual(["save", "refresh"]);
  });

  it("活动路由保存空模型方案时不通过自动测速补写模型", async () => {
    const route = { target: "codex", profileId: "00000000-0000-4000-8000-000000000901" };
    const { handlers, trace, profile, dependencies } = createHarness({ gatewayRoutes: [route] });
    profile.model = "";

    const result = await handlers.get(CHANNELS.saveProfile)(null, saveInput(profile, {
      name: "仍允许修改名称",
    }));

    expect(result.model).toBe("");
    expect(trace).toEqual(["save", "refresh"]);
    expect(dependencies.healthService.test).not.toHaveBeenCalled();
  });

  it("活动路由的空模型方案仍可手动识别模型", async () => {
    const route = { target: "codex", profileId: "00000000-0000-4000-8000-000000000901" };
    const { handlers, profile, dependencies } = createHarness({ gatewayRoutes: [route] });
    profile.model = "";

    await expect(handlers.get(CHANNELS.testProfile)(null, profile.id))
      .resolves.toBeDefined();
    expect(dependencies.healthService.test).toHaveBeenCalledWith(profile.id);
  });

  it("草稿模型识别使用当前表单参数且不保存方案", async () => {
    const { handlers, profile, dependencies } = createHarness();
    const input = saveInput(profile, {
      baseUrl: "https://draft.example/v1",
      endpoints: [{ url: "https://draft.example/v1" }],
    });

    await expect(handlers.get(CHANNELS.testProfileDraft)(null, input))
      .resolves.toEqual(["gpt-draft"]);
    expect(dependencies.healthService.discoverDraftModels).toHaveBeenCalledWith(input);
    expect(dependencies.profileService.save).not.toHaveBeenCalled();
  });

  it("端点检测使用无凭据健康探测且不触发模型识别", async () => {
    const { handlers, profile, dependencies } = createHarness();
    await expect(handlers.get(CHANNELS.checkProfileHealth)(null, profile.id))
      .resolves.toBeDefined();
    expect(dependencies.healthService.testHealth).toHaveBeenCalledWith(profile.id);
    expect(dependencies.healthService.test).not.toHaveBeenCalled();
  });

  it("手动识别模型不依赖应用生命周期锁", async () => {
    const routes = [];
    let enterLock;
    const lockReady = new Promise((resolve) => {
      enterLock = resolve;
    });
    const withLifecycleLock = vi.fn().mockImplementation(async (operation) => {
      await lockReady;
      return operation({});
    });
    const { handlers, profile, dependencies } = createHarness({
      gatewayRoutes: routes,
      applyService: {
        listHistory: vi.fn().mockResolvedValue([]),
        listVerifiedTargets: vi.fn().mockResolvedValue([]),
        withLifecycleLock,
        stopGateway: vi.fn().mockResolvedValue({}),
      },
    });
    profile.model = "";

    const testing = handlers.get(CHANNELS.testProfile)(null, profile.id);
    routes.push({ target: "codex", profileId: profile.id });
    enterLock();

    await expect(testing).resolves.toBeDefined();
    expect(dependencies.healthService.test).toHaveBeenCalledWith(profile.id);
  });

  it("应用方案只分配网关路由并返回 assigned targets", async () => {
    const route = { target: "codex", profileId: "00000000-0000-4000-8000-000000000901" };
    const { handlers, profile, dependencies } = createHarness({ gatewayRoutes: [route] });

    const result = await handlers.get(CHANNELS.applyProfile)(null, profile.id, ["codex"]);

    expect(dependencies.applyService.assignProfile).toHaveBeenCalledWith(profile.id, ["codex"]);
    expect(result.assignedTargets).toEqual(["codex"]);
    expect(result.historyEntry).toBeUndefined();
    expect(result.gateway.routes[0]).toMatchObject({
      target: "codex",
      profileId: profile.id,
      profileName: profile.name,
    });
  });

  it("停止网关时把未覆盖的用户漂移目标返回给界面", async () => {
    const { handlers } = createHarness();

    const result = await handlers.get(CHANNELS.stopGateway)();

    expect(result.gateway.status).toBe("stopped");
    expect(result.gatewayRecovery).toEqual({ skippedTargets: ["codex"] });
  });

  it("网关关闭时删除方案会同时移除引用它的预设路由", async () => {
    const route = { target: "codex", profileId: "00000000-0000-4000-8000-000000000901" };
    const { handlers, profile, dependencies } = createHarness({
      gatewayRoutes: [route],
      gatewayStatus: "stopped",
    });

    await expect(handlers.get(CHANNELS.deleteProfile)(null, profile.id))
      .resolves.toEqual({ ok: true });
    expect(dependencies.gatewayService.unassignRoutes).toHaveBeenCalledWith(["codex"]);
    expect(dependencies.profileService.delete).toHaveBeenCalledWith(profile.id);
    expect(dependencies.gatewayService.restoreRoutes).not.toHaveBeenCalled();
  });

  it("网关运行时删除方案会先恢复客户端并解除路由", async () => {
    const route = { target: "codex", profileId: "00000000-0000-4000-8000-000000000901" };
    const { handlers, profile, dependencies } = createHarness({ gatewayRoutes: [route] });

    await expect(handlers.get(CHANNELS.deleteProfile)(null, profile.id))
      .resolves.toEqual({ ok: true });
    expect(dependencies.applyService.stopGateway).toHaveBeenCalledWith({ targets: ["codex"] });
    expect(dependencies.gatewayService.unassignRoutes).toHaveBeenCalledWith(["codex"]);
    expect(dependencies.profileService.delete).toHaveBeenCalledWith(profile.id);
    expect(dependencies.gatewayService.restoreRoutes).not.toHaveBeenCalled();
  });

  it("解除活动路由后删除失败会恢复路由分配", async () => {
    const route = { target: "codex", profileId: "00000000-0000-4000-8000-000000000901" };
    const { handlers, profile, dependencies } = createHarness({ gatewayRoutes: [route] });
    dependencies.profileService.delete.mockRejectedValueOnce(new Error("profile store is locked"));

    await expect(handlers.get(CHANNELS.deleteProfile)(null, profile.id))
      .rejects.toThrow("profile store is locked");
    expect(dependencies.gatewayService.restoreRoutes).toHaveBeenCalledWith({
      targets: ["codex"],
      routes: { codex: profile.id },
    });
  });
});
