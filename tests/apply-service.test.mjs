import fs from "node:fs/promises";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestStores, testVault } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const TOML = require("@iarna/toml");
const { ProfileService } = require("../electron/services/profile-service.cjs");
const {
  ApplyService,
  GatewayBaselineStoreSchema,
  defaultGatewayBaselineStore,
} = require("../electron/services/apply-service.cjs");
const { createAdapters } = require("../electron/services/adapters.cjs");
const { JsonFileStore } = require("../electron/services/storage.cjs");
const {
  GatewayService,
  GatewayStoreSchema,
  defaultGatewayStore,
} = require("../electron/services/gateway-service.cjs");

let root;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "keydeck-apply-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("engaged route boundaries", () => {
  it("网关运行时切换未接管目标只更新路由，不写客户端配置", async () => {
    const profileId = "00000000-0000-4000-8000-000000000701";
    const previousProfileId = "00000000-0000-4000-8000-000000000702";
    const profile = {
      id: profileId,
      name: "新 Claude",
      protocol: "anthropic",
      baseUrl: "https://new.example",
      model: "claude-sonnet-4-5",
      authMode: "bearer",
      targets: ["claude"],
    };
    const previousProfile = { ...profile, id: previousProfileId, name: "旧 Claude" };
    const prepareConnection = vi.fn();
    const gatewayService = {
      getPublicState: vi.fn(() => ({
        status: "running",
        engaged: ["codex"],
        routes: [{ target: "claude", profileId: previousProfileId }],
      })),
      assignRoutes: vi.fn().mockResolvedValue({ targets: ["claude"], routes: {} }),
      prepareConnection,
    };
    const profileService = {
      withConnectionLock: vi.fn(async (_id, _revision, operation) => operation({
        profile,
        apiKey: "secret",
        markApplied: vi.fn(async () => {}),
      })),
      getStored: vi.fn().mockResolvedValue(previousProfile),
    };
    const applyService = new ApplyService({
      profileService,
      adapters: { claude: { name: "Claude" } },
      historyStore: { read: vi.fn(async () => ({ version: 1, entries: [] })) },
      backupDirectory: path.join(root, "backups"),
      vault: testVault,
      gatewayService,
    });

    await expect(applyService.assignProfile(profileId, ["claude"])).resolves.toMatchObject({
      assignedTargets: ["claude"],
    });
    expect(prepareConnection).not.toHaveBeenCalled();
  });
});

describe("gateway launch reconciliation", () => {
  function launchService({ engaged, resumeTargets }) {
    const profileId = "00000000-0000-4000-8000-000000000703";
    const profile = {
      id: profileId,
      name: "启动恢复",
      protocol: "openai-responses",
      baseUrl: "https://relay.example/v1",
      model: "gpt-5.6-sol",
      authMode: "bearer",
      targets: ["codex"],
    };
    let state = {
      status: "stopped",
      host: "127.0.0.1",
      port: 17863,
      targets: ["codex", "claude"],
      engaged: [...engaged],
      routes: [
        { target: "codex", profileId },
        { target: "claude", profileId },
      ],
      localBaseUrls: {
        codex: "http://127.0.0.1:17863/codex/route-token",
        claude: "http://127.0.0.1:17863/claude",
      },
    };
    const gatewayService = {
      persisted: { encryptedToken: testVault.encrypt("local-token") },
      getLifecycleState: vi.fn(() => ({ engaged: [...engaged], resumeTargets: [...resumeTargets] })),
      getPublicState: vi.fn(() => state),
      getRouteGroups: vi.fn(() => [{ profileId, targets: ["codex", "claude"] }]),
      getLocalBaseUrl: vi.fn((target) => state.localBaseUrls[target]),
      start: vi.fn(async ({ engage, resumeTargets: nextResumeTargets }) => {
        state = { ...state, status: "running", engaged: [...engage] };
        return { ...state, resumeTargets: nextResumeTargets };
      }),
      setEngagedTargets: vi.fn(async (next) => {
        state = { ...state, engaged: [...next] };
        return state;
      }),
    };
    const adapter = {
      paths: [],
      gatewayOwnership: vi.fn(async () => "owned"),
      buildRestore: vi.fn(async () => []),
    };
    const applyService = new ApplyService({
      profileService: { getStored: vi.fn(async () => profile) },
      adapters: { codex: adapter, claude: adapter },
      historyStore: {},
      backupDirectory: path.join(root, "backups"),
      vault: testVault,
      gatewayService,
      gatewayBaselineStore: {
        read: vi.fn(async () => ({
          version: 2,
          baselines: Object.fromEntries(engaged.map((target) => [target, {
            capturedAt: new Date().toISOString(),
            encryptedState: testVault.encrypt("{}"),
          }])),
        })),
      },
    });
    return { applyService, gatewayService };
  }

  it("强制结束后仍由网关接管的配置直接恢复监听，不先还原再重写", async () => {
    const { applyService, gatewayService } = launchService({
      engaged: ["codex"],
      resumeTargets: ["codex"],
    });
    const stopGateway = vi.spyOn(applyService, "stopGateway").mockResolvedValue({ status: "stopped" });
    const startGateway = vi.spyOn(applyService, "startGateway");

    await expect(applyService.reconcileGatewayOnLaunch({ start: true }))
      .resolves.toMatchObject({ status: "running", engaged: ["codex"] });

    expect(stopGateway).not.toHaveBeenCalled();
    expect(startGateway).not.toHaveBeenCalled();
    expect(gatewayService.start).toHaveBeenCalledWith({
      engage: ["codex"],
      resumeTargets: ["codex"],
    });
  });

  it("关机中途已恢复直连但状态未落盘时重新执行接管", async () => {
    const { applyService, gatewayService } = launchService({
      engaged: ["codex"],
      resumeTargets: ["codex"],
    });
    applyService.adapters.codex.gatewayOwnership.mockResolvedValue("released");
    const startGateway = vi.spyOn(applyService, "startGateway")
      .mockResolvedValue({ status: "running", engaged: ["codex"] });

    await expect(applyService.reconcileGatewayOnLaunch({ start: true }))
      .resolves.toMatchObject({ status: "running" });

    expect(gatewayService.setEngagedTargets).toHaveBeenCalledWith([], {
      preserveResumeIntent: true,
      resumeTargets: ["codex"],
    });
    expect(startGateway).toHaveBeenCalledWith({
      targets: ["codex"],
      preserveResumeIntent: true,
    });
  });

  it("真实 Codex 残留接管在新进程中只恢复监听，不提交配置还原事务", async () => {
    const codexPath = path.join(root, ".codex", "config.toml");
    const original = `model_provider = "custom"

[model_providers.custom]
base_url = "https://direct.example/v1"
wire_api = "responses"
`;
    await fs.mkdir(path.dirname(codexPath), { recursive: true });
    await fs.writeFile(codexPath, original, "utf8");

    const { profileStore, historyStore } = createTestStores(root);
    const profileService = new ProfileService(profileStore, testVault);
    const gatewayStore = new JsonFileStore(
      path.join(root, "data", "gateway.json"),
      GatewayStoreSchema,
      defaultGatewayStore,
    );
    const gatewayBaselineStore = new JsonFileStore(
      path.join(root, "data", "gateway-recovery.json"),
      GatewayBaselineStoreSchema,
      defaultGatewayBaselineStore,
    );
    const adapters = createAdapters({
      claude: { config: path.join(root, ".claude", "settings.json") },
      codex: { config: codexPath },
      opencode: {
        config: path.join(root, ".config", "opencode", "opencode.json"),
        auth: path.join(root, ".local", "share", "opencode", "auth.json"),
      },
      gemini: {
        config: path.join(root, ".gemini", "settings.json"),
        env: path.join(root, ".gemini", ".env"),
      },
    });
    const makeApplyService = (gatewayService) => new ApplyService({
      profileService,
      adapters,
      historyStore,
      backupDirectory: path.join(root, "data", "backups"),
      vault: testVault,
      gatewayService,
      gatewayBaselineStore,
    });
    const firstGateway = new GatewayService({ profileService, store: gatewayStore, vault: testVault });
    const firstApply = makeApplyService(firstGateway);
    const profile = await profileService.save({
      name: "重启恢复",
      protocol: "openai-responses",
      baseUrl: "https://relay.example/v1",
      apiKey: "sk-restart",
      model: "gpt-5.6-sol",
      authMode: "bearer",
      targets: ["codex"],
    });
    await firstApply.assignProfile(profile.id, ["codex"]);
    await firstApply.startGateway({ port: 0 });
    const takenOver = await fs.readFile(codexPath, "utf8");
    await firstGateway.shutdown();

    const restartedGateway = new GatewayService({ profileService, store: gatewayStore, vault: testVault });
    const restartedApply = makeApplyService(restartedGateway);
    await restartedGateway.initialize({ start: false });
    const commitDrafts = vi.spyOn(restartedApply, "_commitDrafts");
    try {
      await restartedApply.reconcileGatewayOnLaunch({ start: true });
      expect(restartedGateway.getPublicState()).toMatchObject({
        status: "running",
        engaged: ["codex"],
      });
      expect(commitDrafts).not.toHaveBeenCalled();
      expect(await fs.readFile(codexPath, "utf8")).toBe(takenOver);
    } finally {
      await restartedApply.stopGateway().catch(() => {});
      await restartedGateway.stopAndWait().catch(() => {});
    }
    expect(await fs.readFile(codexPath, "utf8")).toBe(original);
  });

  it("逐个恢复未接管目标，一个失败仍继续尝试其余目标", async () => {
    const { applyService } = launchService({
      engaged: [],
      resumeTargets: ["claude", "codex"],
    });
    const attempts = [];
    vi.spyOn(applyService, "startGateway").mockImplementation(async ({ targets }) => {
      attempts.push(targets[0]);
      if (targets[0] === "claude") throw new Error("Claude configuration is busy");
      return { status: "running", engaged: ["codex"] };
    });

    await expect(applyService.reconcileGatewayOnLaunch({ start: true }))
      .rejects.toThrow("claude: Claude configuration is busy");
    expect(attempts).toEqual(["claude", "codex"]);
  });

  it("关闭启动恢复时仍清理强制结束留下的接管配置", async () => {
    const { applyService } = launchService({
      engaged: ["codex"],
      resumeTargets: ["codex"],
    });
    const stopped = { status: "stopped", engaged: [] };
    const stopGateway = vi.spyOn(applyService, "stopGateway").mockResolvedValue(stopped);

    await expect(applyService.reconcileGatewayOnLaunch({ start: false })).resolves.toBe(stopped);
    expect(stopGateway).toHaveBeenCalledWith({
      targets: ["codex"],
      preserveResumeIntent: true,
    });
  });
});

describe("dynamic adapter snapshots", () => {
  it("retries when an adapter changes its managed path set while sources are read", async () => {
    const metaPath = path.join(root, "configLibrary", "_meta.json");
    const profileAPath = path.join(root, "configLibrary", "a.json");
    const profileBPath = path.join(root, "configLibrary", "b.json");
    await fs.mkdir(path.dirname(metaPath), { recursive: true });
    await fs.writeFile(metaPath, '{"appliedId":"b"}\n', "utf8");
    await fs.writeFile(profileAPath, '{"profile":"a"}\n', "utf8");
    await fs.writeFile(profileBPath, '{"profile":"b"}\n', "utf8");

    let pathReads = 0;
    const adapter = {
      get paths() {
        pathReads += 1;
        return pathReads === 1
          ? [metaPath, profileAPath]
          : [metaPath, profileBPath];
      },
      gatewayOwnership: vi.fn(async () => "released"),
      captureManagedState: vi.fn(async (sources) => {
        expect(sources.has(metaPath)).toBe(true);
        expect(sources.has(profileAPath)).toBe(false);
        expect(sources.has(profileBPath)).toBe(true);
        return { active: "b" };
      }),
      build: vi.fn(async () => []),
    };
    let baselineData = { version: 2, baselines: {} };
    const gatewayBaselineStore = {
      read: vi.fn(async () => baselineData),
      write: vi.fn(async (value) => { baselineData = value; }),
    };
    const applyService = new ApplyService({
      profileService: {},
      adapters: { claude: adapter },
      historyStore: {},
      backupDirectory: path.join(root, "backups"),
      vault: testVault,
      gatewayService: {
        prepareConnection: vi.fn(async (profile, apiKey) => ({ profile, apiKey })),
      },
      gatewayBaselineStore,
    });

    await applyService._writeGatewayEntries([{
      profile: {
        protocol: "anthropic",
        baseUrl: "https://relay.example",
        model: "",
        authMode: "bearer",
      },
      apiKey: "secret",
      target: "claude",
    }]);

    const backup = JSON.parse(testVault.decrypt(
      baselineData.baselines.claude.encryptedBackup,
    ));
    expect(backup.files.map((file) => file.path)).toEqual([metaPath, profileBPath]);
    expect(pathReads).toBeGreaterThan(1);
  });

  it("includes a baseline-bound path and refuses edits made after ownership", async () => {
    const metaPath = path.join(root, "configLibrary", "_meta.json");
    const profileAPath = path.join(root, "configLibrary", "a.json");
    const profileBPath = path.join(root, "configLibrary", "b.json");
    await fs.mkdir(path.dirname(metaPath), { recursive: true });
    await fs.writeFile(metaPath, '{"appliedId":"b"}\n', "utf8");
    await fs.writeFile(profileAPath, '{"profile":"a-before"}\n', "utf8");
    await fs.writeFile(profileBPath, '{"profile":"b"}\n', "utf8");

    const storedState = { active: "a" };
    const externalEdit = '{"profile":"a-runtime-edit"}\n';
    const adapter = {
      id: "claude",
      paths: [metaPath, profileBPath],
      pathsForBaseline: vi.fn((baseline) => {
        expect(baseline).toEqual(storedState);
        return [metaPath, profileBPath, profileAPath];
      }),
      gatewayOwnership: vi.fn(async (_profile, _apiKey, sources) => {
        expect(sources.has(profileAPath)).toBe(true);
        await fs.writeFile(profileAPath, externalEdit, "utf8");
        return "owned";
      }),
      build: vi.fn(async (_profile, _apiKey, options) => {
        const before = options.sources.get(profileAPath);
        expect(before.content).toBe('{"profile":"a-before"}\n');
        const content = '{"profile":"agentgate"}\n';
        return [{
          target: "claude",
          path: profileAPath,
          before,
          content,
          afterHash: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
        }];
      }),
    };
    let baselineData = {
      version: 2,
      baselines: {
        claude: {
          capturedAt: new Date().toISOString(),
          encryptedState: testVault.encrypt(JSON.stringify(storedState)),
          encryptedBackup: testVault.encrypt(JSON.stringify({ files: [] })),
        },
      },
    };
    const gatewayBaselineStore = {
      read: vi.fn(async () => baselineData),
      write: vi.fn(async (value) => { baselineData = value; }),
    };
    const applyService = new ApplyService({
      profileService: {},
      adapters: { claude: adapter },
      historyStore: {},
      backupDirectory: path.join(root, "backups"),
      vault: testVault,
      gatewayService: {
        prepareConnection: vi.fn(async (profile, apiKey) => ({ profile, apiKey })),
      },
      gatewayBaselineStore,
    });

    await expect(applyService._writeGatewayEntries([{
      profile: {
        protocol: "anthropic",
        baseUrl: "https://relay.example",
        model: "",
        authMode: "bearer",
      },
      apiKey: "secret",
      target: "claude",
    }])).rejects.toThrow("Configuration changed while preparing the switch");
    expect(await fs.readFile(profileAPath, "utf8")).toBe(externalEdit);
  });
});

describe("transactional apply", () => {
  it("Codex URL-only 接管保存完整密文备份并在验证后删除基线", async () => {
    const codexPath = path.join(root, ".codex", "config.toml");
    const recoveryPath = path.join(root, "data", "gateway-recovery.json");
    const original = `model_provider = "custom"
model = "user-model"
approval_policy = "on-request"

[model_providers.custom]
name = "Custom"
base_url = "https://custom.example/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "user-auth"

[mcp_servers.demo]
command = "node"
`;
    await fs.mkdir(path.dirname(codexPath), { recursive: true });
    await fs.writeFile(codexPath, original, "utf8");

    const { profileStore, historyStore } = createTestStores(root);
    const profileService = new ProfileService(profileStore, testVault);
    const gatewayStore = new JsonFileStore(
      path.join(root, "data", "gateway.json"),
      GatewayStoreSchema,
      defaultGatewayStore,
    );
    const gatewayBaselineStore = new JsonFileStore(
      recoveryPath,
      GatewayBaselineStoreSchema,
      defaultGatewayBaselineStore,
    );
    const gatewayService = new GatewayService({ profileService, store: gatewayStore, vault: testVault });
    const adapters = createAdapters({
      claude: { config: path.join(root, ".claude", "settings.json") },
      codex: { config: codexPath },
      opencode: {
        config: path.join(root, ".config", "opencode", "opencode.json"),
        auth: path.join(root, ".local", "share", "opencode", "auth.json"),
      },
      gemini: {
        config: path.join(root, ".gemini", "settings.json"),
        env: path.join(root, ".gemini", ".env"),
      },
    });
    const applyService = new ApplyService({
      profileService,
      adapters,
      historyStore,
      backupDirectory: path.join(root, "data", "backups"),
      vault: testVault,
      gatewayService,
      gatewayBaselineStore,
    });
    const profileA = await profileService.save({
      name: "网关 A",
      protocol: "openai-responses",
      baseUrl: "https://relay-a.example/v1",
      apiKey: "sk-upstream-a",
      model: "ignored-model-a",
      authMode: "bearer",
      targets: ["codex"],
    });
    const profileB = await profileService.save({
      name: "网关 B",
      protocol: "openai-responses",
      baseUrl: "https://relay-b.example/v1",
      apiKey: "sk-upstream-b",
      model: "ignored-model-b",
      authMode: "bearer",
      targets: ["codex"],
    });
    await applyService.assignProfile(profileA.id, ["codex"]);

    try {
      await applyService.startGateway({ port: 0 });
      const localBaseUrl = gatewayService.getPublicState().localBaseUrls.codex;
      expect(localBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/codex\/[A-Za-z0-9_-]{40,}$/);
      const takenOver = await fs.readFile(codexPath, "utf8");
      const parsed = TOML.parse(takenOver);
      expect(parsed.model_provider).toBe("custom");
      expect(parsed.model).toBe("user-model");
      expect(parsed.model_providers.custom).toMatchObject({
        base_url: localBaseUrl,
        wire_api: "responses",
        requires_openai_auth: true,
        experimental_bearer_token: "user-auth",
      });
      expect(parsed.model_providers.agentgate_gateway).toBeUndefined();
      expect(takenOver).not.toContain("sk-upstream-a");

      const recovery = await gatewayBaselineStore.read();
      expect(recovery.version).toBe(2);
      const baseline = recovery.baselines.codex;
      expect(JSON.parse(testVault.decrypt(baseline.encryptedState))).toEqual({
        providerId: "custom",
        wireApi: "responses",
        baseUrl: { present: true, value: "https://custom.example/v1" },
      });
      expect(JSON.parse(testVault.decrypt(baseline.encryptedBackup))).toEqual({
        files: [{ path: codexPath, existed: true, content: original }],
      });
      expect(await fs.readFile(recoveryPath, "utf8")).not.toContain("https://custom.example/v1");

      const runtimeEdit = takenOver
        .replace('model = "user-model"', 'model = "runtime-model"')
        .replace('experimental_bearer_token = "user-auth"', 'experimental_bearer_token = "runtime-auth"');
      await fs.writeFile(codexPath, runtimeEdit, "utf8");
      await applyService.assignProfile(profileB.id, ["codex"]);
      expect(await fs.readFile(codexPath, "utf8")).toBe(runtimeEdit);

      const runtimeWireEdit = runtimeEdit.replace('wire_api = "responses"', 'wire_api = "chat"');
      await fs.writeFile(codexPath, runtimeWireEdit, "utf8");
      await expect(applyService.assignProfile(profileA.id, ["codex"]))
        .rejects.toThrow("wire_api=chat");

      await applyService.stopGateway();
      const restored = TOML.parse(await fs.readFile(codexPath, "utf8"));
      expect(restored.model_provider).toBe("custom");
      expect(restored.model).toBe("runtime-model");
      expect(restored.model_providers.custom).toMatchObject({
        base_url: "https://custom.example/v1",
        wire_api: "chat",
        experimental_bearer_token: "runtime-auth",
      });
      expect((await gatewayBaselineStore.read()).baselines).toEqual({});
    } finally {
      await gatewayService.stopAndWait().catch(() => {});
    }
  });

  it("停止时基线清理短暂失败，配置未变时下一次接管仍可复用基线", async () => {
    const codexPath = path.join(root, ".codex", "config.toml");
    const original = `model_provider = "custom"

[model_providers.custom]
base_url = "https://custom.example/v1"
wire_api = "responses"
`;
    await fs.mkdir(path.dirname(codexPath), { recursive: true });
    await fs.writeFile(codexPath, original, "utf8");

    const { profileStore, historyStore } = createTestStores(root);
    const profileService = new ProfileService(profileStore, testVault);
    const gatewayStore = new JsonFileStore(
      path.join(root, "data", "gateway.json"),
      GatewayStoreSchema,
      defaultGatewayStore,
    );
    const gatewayBaselineStore = new JsonFileStore(
      path.join(root, "data", "gateway-recovery.json"),
      GatewayBaselineStoreSchema,
      defaultGatewayBaselineStore,
    );
    const gatewayService = new GatewayService({ profileService, store: gatewayStore, vault: testVault });
    const adapters = createAdapters({
      claude: { config: path.join(root, ".claude", "settings.json") },
      codex: { config: codexPath },
      opencode: {
        config: path.join(root, ".config", "opencode", "opencode.json"),
        auth: path.join(root, ".local", "share", "opencode", "auth.json"),
      },
      gemini: {
        config: path.join(root, ".gemini", "settings.json"),
        env: path.join(root, ".gemini", ".env"),
      },
    });
    const applyService = new ApplyService({
      profileService,
      adapters,
      historyStore,
      backupDirectory: path.join(root, "data", "backups"),
      vault: testVault,
      gatewayService,
      gatewayBaselineStore,
    });
    const profile = await profileService.save({
      name: "基线重试",
      protocol: "openai-responses",
      baseUrl: "https://relay.example/v1",
      apiKey: "sk-retry",
      model: "gpt-5-codex",
      authMode: "bearer",
      targets: ["codex"],
    });
    await applyService.assignProfile(profile.id, ["codex"]);

    const writeBaseline = gatewayBaselineStore.write.bind(gatewayBaselineStore);
    let failCleanup = true;
    gatewayBaselineStore.write = async (value) => {
      if (failCleanup && Object.keys(value.baselines).length === 0) {
        failCleanup = false;
        throw new Error("simulated baseline cleanup failure");
      }
      return writeBaseline(value);
    };

    try {
      await applyService.startGateway({ port: 0 });
      await expect(applyService.stopGateway()).rejects.toThrow("simulated baseline cleanup failure");
      expect(gatewayService.getPublicState().status).toBe("stopped");
      expect(TOML.parse(await fs.readFile(codexPath, "utf8")).model_provider).toBe("custom");

      await applyService.startGateway({ port: 0 });
      expect(gatewayService.getPublicState().status).toBe("running");
      await applyService.stopGateway();
      expect((await gatewayBaselineStore.read()).baselines).toEqual({});
    } finally {
      await gatewayService.stopAndWait().catch(() => {});
    }
  });

  it.skip("旧版多字段 Codex 接管生命周期（已由 URL-only 用例替代）", async () => {
    const codexPath = path.join(root, ".codex", "config.toml");
    const original = `# 用户自己的 Codex 配置\r\napproval_policy = "on-request"\r\nsandbox_mode = "workspace-write"\r\nmodel_provider = "custom"\r\n\r\n[features]\r\nweb_search_request = true\r\n\r\n[mcp_servers.demo]\r\ncommand = "node"\r\nargs = ["server.js"]\r\n\r\n[model_providers.custom]\r\nname = "Custom"\r\nbase_url = "https://custom.example/v1"\r\nwire_api = "responses"\r\n`;
    await fs.mkdir(path.dirname(codexPath), { recursive: true });
    await fs.writeFile(codexPath, original, "utf8");

    const { profileStore, historyStore } = createTestStores(root);
    const profileService = new ProfileService(profileStore, testVault);
    const gatewayStore = new JsonFileStore(
      path.join(root, "data", "gateway.json"),
      GatewayStoreSchema,
      defaultGatewayStore,
    );
    const gatewayBaselineStore = new JsonFileStore(
      path.join(root, "data", "gateway-recovery.json"),
      GatewayBaselineStoreSchema,
      defaultGatewayBaselineStore,
    );
    const gatewayService = new GatewayService({
      profileService,
      store: gatewayStore,
      vault: testVault,
    });
    const adapters = createAdapters({
      claude: { config: path.join(root, ".claude", "settings.json") },
      codex: { config: codexPath },
      opencode: {
        config: path.join(root, ".config", "opencode", "opencode.json"),
        auth: path.join(root, ".local", "share", "opencode", "auth.json"),
      },
      gemini: {
        config: path.join(root, ".gemini", "settings.json"),
        env: path.join(root, ".gemini", ".env"),
      },
    });
    const applyService = new ApplyService({
      profileService,
      adapters,
      historyStore,
      backupDirectory: path.join(root, "data", "backups"),
      vault: testVault,
      gatewayService,
      gatewayBaselineStore,
    });
    const profileA = await profileService.save({
      name: "网关 A",
      protocol: "openai-responses",
      baseUrl: "https://relay-a.example/v1",
      apiKey: "sk-upstream-a",
      model: "gpt-5.2-codex",
      authMode: "bearer",
      targets: ["codex"],
    });
    const profileB = await profileService.save({
      name: "网关 B",
      protocol: "openai-responses",
      baseUrl: "https://relay-b.example/v1",
      apiKey: "sk-upstream-b",
      model: "gpt-5.2-codex",
      authMode: "bearer",
      targets: ["codex"],
    });
    await applyService.assignProfile(profileA.id, ["codex"]);

    try {
      await applyService.startGateway({ port: 0 });
      const takenOver = await fs.readFile(codexPath, "utf8");
      expect(takenOver).toContain('model_provider = "agentgate_gateway"');
      expect(takenOver).toContain("[model_providers.agentgate_gateway]");
      expect(takenOver).not.toContain("sk-upstream-a");
      expect(takenOver).toContain("[mcp_servers.demo]");
      expect(takenOver).toContain('approval_policy = "on-request"');
      const encryptedRecovery = await fs.readFile(
        path.join(root, "data", "gateway-recovery.json"),
        "utf8",
      );
      expect(encryptedRecovery).not.toContain('model_provider = "custom"');
      expect(encryptedRecovery).not.toContain("https://custom.example/v1");

      const userEdit = `${takenOver}\r\n[projects."D:\\\\Work"]\r\ntrust_level = "trusted"\r\n`;
      await fs.writeFile(codexPath, userEdit, "utf8");
      const switched = await applyService.assignProfile(profileB.id, ["codex"]);
      expect(await fs.readFile(codexPath, "utf8")).toBe(userEdit);
      expect(switched.assignedTargets).toEqual(["codex"]);

      const userReleased = `${original.replace(
        'model_provider = "custom"',
        'model_provider = "custom"\r\nmodel = "user-selected-model"',
      )}\r\n[projects."D:\\\\Work"]\r\ntrust_level = "trusted"\r\n`;
      await fs.writeFile(codexPath, userReleased, "utf8");
      await applyService.assignProfile(profileB.id, ["codex"]);
      const reassignedGateway = await fs.readFile(codexPath, "utf8");
      expect(reassignedGateway).toContain('model_provider = "agentgate_gateway"');
      expect(reassignedGateway).not.toContain('model = "user-selected-model"');

      const gatewayWithExtensions = reassignedGateway
        .replace(
          'experimental_bearer_token = "',
          '# 用户添加的网关注释\r\nrequest_max_retries = 9\r\nexperimental_bearer_token = "',
        );
      await fs.writeFile(codexPath, gatewayWithExtensions, "utf8");

      await applyService.stopGateway();
      const direct = await fs.readFile(codexPath, "utf8");
      expect(direct).toContain('model_provider = "custom"');
      expect(direct).toContain('model = "user-selected-model"');
      expect(direct).toContain('base_url = "https://custom.example/v1"');
      expect(direct).not.toContain("[model_providers.agentgate_gateway]");
      expect(direct).not.toContain("sk-upstream-b");
      expect(direct).toContain('[projects."D:\\\\Work"]');
      expect(direct).toContain('trust_level = "trusted"');
      expect(direct).toContain("[mcp_servers.demo]");
      expect(direct).toContain('sandbox_mode = "workspace-write"');
      expect(gatewayService.getPublicState().status).toBe("stopped");

      await applyService.startGateway({ port: 0 });
      const gatewayAgain = await fs.readFile(codexPath, "utf8");
      const driftGatewayProvider = (pattern, replacement) => gatewayAgain.replace(
        /(\[model_providers\.agentgate_gateway\][\s\S]*?)(?=\r?\n\[|$)/,
        (section) => section.replace(pattern, replacement),
      );
      for (const conflicted of [
        gatewayAgain.replace('model = "gpt-5.2-codex"', 'model = "runtime-selected-model"'),
        driftGatewayProvider(
          /experimental_bearer_token = "[^"]+"/,
          'experimental_bearer_token = "changed-local-token"',
        ),
        driftGatewayProvider('wire_api = "responses"', 'wire_api = "chat"'),
      ]) {
        await fs.writeFile(codexPath, conflicted, "utf8");
        await expect(applyService.stopGateway())
          .rejects.toThrow("Local gateway configuration conflict for codex");
        expect(await fs.readFile(codexPath, "utf8")).toBe(conflicted);
        expect(gatewayService.getPublicState().status).toBe("running");
        expect(gatewayService.getPublicState().routes).toEqual([
          { target: "codex", profileId: profileB.id },
        ]);
        await fs.writeFile(codexPath, gatewayAgain, "utf8");
      }
      const userOwned = gatewayAgain.replace(
        'model_provider = "agentgate_gateway"',
        'model_provider = "custom"',
      );
      await fs.writeFile(codexPath, userOwned, "utf8");
      const skippedStop = await applyService.stopGateway();
      expect(skippedStop.skippedTargets).toEqual(["codex"]);
      expect(await fs.readFile(codexPath, "utf8")).toBe(userOwned);
      expect(gatewayService.getPublicState().routes).toEqual([
        { target: "codex", profileId: profileB.id },
      ]);

      await applyService.assignProfile(profileB.id, ["codex"]);
      await applyService.startGateway({ port: 0 });
      const [concurrentStop] = await Promise.all([
        applyService.stopGateway(),
        applyService.assignProfile(profileA.id, ["codex"]),
      ]);
      const afterConcurrentApply = await fs.readFile(codexPath, "utf8");
      expect(concurrentStop.skippedTargets).toEqual([]);
      expect(afterConcurrentApply).toContain('model_provider = "custom"');
      expect(afterConcurrentApply).toContain('base_url = "https://custom.example/v1"');
      expect(adapters.codex.inspect(new Map([[codexPath, afterConcurrentApply]])).baseUrl)
        .toBe("https://custom.example/v1");
      expect(gatewayService.getPublicState().status).toBe("stopped");

      await applyService.assignProfile(profileB.id, ["codex"]);
      await applyService.startGateway({ port: 0 });
      await gatewayService.shutdown();
      expect(gatewayService.getPublicState().routes).toEqual([
        { target: "codex", profileId: profileB.id },
      ]);
      const stoppedWithoutListener = await applyService.stopGateway();
      const recoveredWithoutListener = await fs.readFile(codexPath, "utf8");
      expect(stoppedWithoutListener.skippedTargets).toEqual([]);
      expect(adapters.codex.inspect(new Map([[codexPath, recoveredWithoutListener]])).baseUrl)
        .toBe("https://custom.example/v1");
      expect(gatewayService.getPublicState().routes).toEqual([
        { target: "codex", profileId: profileB.id },
      ]);

      await applyService.startGateway({ port: 0 });
      const originalOwnership = adapters.codex.gatewayOwnership.bind(adapters.codex);
      let injectedUnrelatedEdit = false;
      let ownershipChecks = 0;
      adapters.codex.gatewayOwnership = async (...args) => {
        const state = await originalOwnership(...args);
        ownershipChecks += 1;
        if (!injectedUnrelatedEdit && ownershipChecks === 1) {
          injectedUnrelatedEdit = true;
          await fs.appendFile(
            codexPath,
            "\r\n[projects.concurrent]\r\ntrust_level = \"trusted\" # ownership 检查后的用户注释\r\n",
            "utf8",
          );
        }
        return state;
      };
      const retriedStop = await applyService.stopGateway();
      const retriedDirect = await fs.readFile(codexPath, "utf8");
      expect(retriedStop.skippedTargets).toEqual([]);
      expect(retriedDirect).toContain('model_provider = "custom"');
      expect(retriedDirect).toContain("# ownership 检查后的用户注释");

      await applyService.startGateway({ port: 0 });
      adapters.codex.gatewayOwnership = async (...args) => {
        const state = await originalOwnership(...args);
        await fs.appendFile(codexPath, "\r\n# 持续并发修改\r\n", "utf8");
        return state;
      };
      await expect(applyService.stopGateway())
        .rejects.toThrow("Configuration kept changing while stopping the gateway: codex");
      expect(gatewayService.getPublicState().status).toBe("running");
      expect(adapters.codex.inspect(new Map([[codexPath, await fs.readFile(codexPath, "utf8")]])).baseUrl)
        .toMatch(/^http:\/\/127\.0\.0\.1:/);
      adapters.codex.gatewayOwnership = originalOwnership;
      await applyService.stopGateway();

      await applyService.startGateway({ port: 0 });
      let injectedConcurrentEdit = false;
      adapters.codex.gatewayOwnership = async (...args) => {
        const state = await originalOwnership(...args);
        if (!injectedConcurrentEdit) {
          injectedConcurrentEdit = true;
          const source = await fs.readFile(codexPath, "utf8");
          await fs.writeFile(
            codexPath,
            source.replace(
              'model_provider = "agentgate_gateway"',
              'model_provider = "custom"',
            ),
            "utf8",
          );
        }
        return state;
      };
      const racedStop = await applyService.stopGateway();
      const racedUserConfig = await fs.readFile(codexPath, "utf8");
      expect(racedStop.skippedTargets).toEqual(["codex"]);
      expect(racedUserConfig).toContain('model_provider = "custom"');
      expect(racedUserConfig).toContain('base_url = "http://127.0.0.1:');
      adapters.codex.gatewayOwnership = originalOwnership;

      await applyService.startGateway({ port: 0 });
      const orphanedGatewayConfig = await fs.readFile(codexPath, "utf8");
      await profileService.delete(profileB.id);
      await expect(applyService.stopGateway())
        .rejects.toThrow(`routed profile ${profileB.id} is unavailable`);
      expect(await fs.readFile(codexPath, "utf8")).toBe(orphanedGatewayConfig);
      expect(gatewayService.getPublicState().status).toBe("running");
      expect(gatewayService.getPublicState().routes).toEqual([
        { target: "codex", profileId: profileB.id },
      ]);
    } finally {
      await gatewayService.stopAndWait().catch(() => {});
    }
  });

  it("applies a profile, returns no secret, and restores the exact original on undo", async () => {
    const codexPath = path.join(root, ".codex", "config.toml");
    const original = `# 用户配置
approval_policy = "on-request"

[mcp_servers.demo]
command = "node"
`;
    await fs.mkdir(path.dirname(codexPath), { recursive: true });
    await fs.writeFile(codexPath, original, "utf8");

    const { profileStore, historyStore } = createTestStores(root);
    const profileService = new ProfileService(profileStore, testVault);
    const adapters = createAdapters({
      claude: { config: path.join(root, ".claude", "settings.json") },
      codex: { config: codexPath },
      opencode: {
        config: path.join(root, ".config", "opencode", "opencode.json"),
        auth: path.join(root, ".local", "share", "opencode", "auth.json"),
      },
      gemini: {
        config: path.join(root, ".gemini", "settings.json"),
        env: path.join(root, ".gemini", ".env"),
      },
    });
    const applyService = new ApplyService({
      profileService,
      adapters,
      historyStore,
      backupDirectory: path.join(root, "data", "backups"),
      vault: testVault,
    });

    const publicProfile = await profileService.save({
      name: "Codex fixture",
      protocol: "openai-responses",
      baseUrl: "https://codex-relay.example/v1",
      apiKey: "sk-super-secret",
      model: "gpt-5.2-codex",
      authMode: "bearer",
      targets: ["codex"],
    });
    expect(JSON.stringify(publicProfile)).not.toContain("sk-super-secret");
    expect(publicProfile.encryptedKey).toBeUndefined();

    const revision = (await profileService.getStored(publicProfile.id)).connectionRevision;
    const applied = await applyService.apply(
      publicProfile.id,
      undefined,
      { expectedRevision: revision },
    );
    const live = await fs.readFile(codexPath, "utf8");
    expect(live).toContain("sk-super-secret");
    expect(live).toContain("[mcp_servers.demo]");
    expect(JSON.stringify(applied.history)).not.toContain("sk-super-secret");
    expect(applied.history.canUndo).toBe(true);
    const verifiedState = await applyService.getVerifiedWriteState(publicProfile.id);
    expect(verifiedState.targets).toEqual(["codex"]);

    await fs.writeFile(
      codexPath,
      live.replace("sk-super-secret", "sk-external-secret"),
      "utf8",
    );
    expect(await applyService.listVerifiedTargets(publicProfile.id)).toEqual([]);
    await expect(applyService.apply(publicProfile.id, ["codex"], {
      source: "auto",
      expectedRevision: revision,
      expectedHashes: verifiedState.hashes,
    })).rejects.toThrow("no longer matches the last Agent;Gate write");
    await fs.writeFile(codexPath, live, "utf8");

    await applyService.undo(applied.history.id);
    expect(await fs.readFile(codexPath, "utf8")).toBe(original);
    const history = await applyService.listHistory();
    expect(history[0].canUndo).toBe(false);

    await profileService.save({
      id: publicProfile.id,
      name: publicProfile.name,
      protocol: publicProfile.protocol,
      baseUrl: publicProfile.baseUrl,
      endpoints: publicProfile.endpoints.map(({ url }) => ({ url })),
      model: "gpt-new-model",
      authMode: publicProfile.authMode,
      targets: publicProfile.targets,
      autoSwitch: publicProfile.autoSwitch,
    });
    await expect(applyService.apply(
      publicProfile.id,
      undefined,
      { expectedRevision: revision },
    )).rejects.toThrow("Profile connection changed before configuration could be written");
    expect(await fs.readFile(codexPath, "utf8")).toBe(original);
  });

  it("marks an older overlapping write as superseded", async () => {
    const { historyStore } = createTestStores(root);
    const applyService = new ApplyService({
      profileService: {},
      adapters: {},
      historyStore,
      backupDirectory: path.join(root, "data", "backups"),
      vault: testVault,
    });
    const filePath = path.join(root, ".codex", "config.toml");
    const profileId = crypto.randomUUID();
    const createHistory = (source) => ({
      id: crypto.randomUUID(),
      profileId,
      profileName: "历史夹具",
      targets: ["codex"],
      createdAt: new Date().toISOString(),
      status: "applied",
      source,
      changes: [{
        target: "codex",
        path: filePath,
        existed: true,
        beforeHash: "before",
        afterHash: "after",
      }],
      backupFile: path.join(root, "data", "backups", `${crypto.randomUUID()}.json`),
    });
    const older = createHistory("manual");
    const latest = createHistory("auto");

    await applyService.saveHistory(older);
    await applyService.saveHistory(latest);
    await applyService.supersedeOlderHistory(latest.id, [filePath]);

    const history = await applyService.listHistory();
    expect(history[0]).toMatchObject({ id: latest.id, canUndo: true, source: "auto" });
    expect(history[1]).toMatchObject({ id: older.id, canUndo: false, success: true });
  });

  it("仅允许当前连接 revision 的成功历史授权自动写入", async () => {
    const codexPath = path.join(root, ".codex", "config.toml");
    await fs.mkdir(path.dirname(codexPath), { recursive: true });
    await fs.writeFile(codexPath, "model = \"fixture\"\n", "utf8");

    const { profileStore, historyStore } = createTestStores(root);
    const profileService = new ProfileService(profileStore, testVault);
    const applyService = new ApplyService({
      profileService,
      adapters: createAdapters({
        claude: { config: path.join(root, ".claude", "settings.json") },
        codex: { config: codexPath },
        opencode: {
          config: path.join(root, ".config", "opencode", "opencode.json"),
          auth: path.join(root, ".local", "share", "opencode", "auth.json"),
        },
        gemini: {
          config: path.join(root, ".gemini", "settings.json"),
          env: path.join(root, ".gemini", ".env"),
        },
      }),
      historyStore,
      backupDirectory: path.join(root, "data", "backups"),
      vault: testVault,
    });
    const created = await profileService.save({
      name: "revision 夹具",
      protocol: "openai-responses",
      baseUrl: "https://revision.example/v1",
      apiKey: "sk-revision-one",
      model: "gpt-revision-one",
      authMode: "bearer",
      targets: ["codex"],
    });
    const revisionN = (await profileService.getStored(created.id)).connectionRevision;
    await applyService.apply(created.id, ["codex"], { expectedRevision: revisionN });
    const appliedContent = await fs.readFile(codexPath, "utf8");
    expect((await applyService.getVerifiedWriteState(created.id)).targets).toEqual(["codex"]);

    await profileService.save({
      id: created.id,
      name: "revision 夹具（已启用自动择优）",
      protocol: created.protocol,
      baseUrl: created.baseUrl,
      endpoints: created.endpoints.map(({ url }) => ({ url })),
      model: created.model,
      authMode: created.authMode,
      targets: created.targets,
      enableToolSearch: created.enableToolSearch,
      autoSwitch: { enabled: true, intervalMinutes: 15 },
    });
    expect((await profileService.getStored(created.id)).connectionRevision).toBe(revisionN);
    expect((await applyService.getVerifiedWriteState(created.id)).targets).toEqual(["codex"]);

    const legacyData = await historyStore.read();
    delete legacyData.entries[0].appliedConnectionRevision;
    await historyStore.write(legacyData);
    expect((await applyService.getVerifiedWriteState(created.id)).targets).toEqual([]);

    legacyData.entries[0].appliedConnectionRevision = revisionN;
    await historyStore.write(legacyData);
    await profileService.save({
      id: created.id,
      name: "revision 夹具已更新",
      protocol: created.protocol,
      baseUrl: created.baseUrl,
      endpoints: created.endpoints.map(({ url }) => ({ url })),
      apiKey: "sk-revision-two",
      model: "gpt-revision-two",
      authMode: created.authMode,
      targets: created.targets,
      autoSwitch: created.autoSwitch,
    });

    const revisionNPlusOne = (await profileService.getStored(created.id)).connectionRevision;
    expect(revisionNPlusOne).toBe(revisionN + 1);
    expect(await fs.readFile(codexPath, "utf8")).toBe(appliedContent);
    expect((await applyService.getVerifiedWriteState(created.id)).targets).toEqual([]);
  });

  it("自动写入开始后收到停止信号会完整回滚已写文件", async () => {
    const firstPath = path.join(root, "configs", "first.txt");
    const secondPath = path.join(root, "configs", "second.txt");
    const firstOriginal = "第一份原配置\n";
    const secondOriginal = "第二份原配置\n";
    await fs.mkdir(path.dirname(firstPath), { recursive: true });
    await Promise.all([
      fs.writeFile(firstPath, firstOriginal, "utf8"),
      fs.writeFile(secondPath, secondOriginal, "utf8"),
    ]);

    const { profileStore, historyStore } = createTestStores(root);
    const profileService = new ProfileService(profileStore, testVault);
    const snapshot = (filePath, content) => ({
      path: filePath,
      existed: true,
      content,
      hash: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
    });
    const replacement = (target, before, content) => ({
      target,
      path: before.path,
      before,
      content,
      afterHash: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
    });
    const adapters = {
      codex: {
        build: async () => [
          replacement("codex", snapshot(firstPath, firstOriginal), "第一份新配置\n"),
          replacement("codex", snapshot(secondPath, secondOriginal), "第二份新配置\n"),
        ],
      },
    };
    const applyService = new ApplyService({
      profileService,
      adapters,
      historyStore,
      backupDirectory: path.join(root, "data", "backups"),
      vault: testVault,
    });
    const created = await profileService.save({
      name: "停止回滚夹具",
      protocol: "openai-responses",
      baseUrl: "https://rollback.example/v1",
      apiKey: "sk-rollback",
      model: "gpt-rollback",
      authMode: "bearer",
      targets: ["codex"],
    });
    const revision = (await profileService.getStored(created.id)).connectionRevision;
    let continuationChecks = 0;

    await expect(applyService.apply(created.id, ["codex"], {
      source: "auto",
      expectedRevision: revision,
      shouldContinue: () => {
        continuationChecks += 1;
        return continuationChecks < 6;
      },
    })).rejects.toThrow("Automatic configuration write was stopped");

    expect(await fs.readFile(firstPath, "utf8")).toBe(firstOriginal);
    expect(await fs.readFile(secondPath, "utf8")).toBe(secondOriginal);
    expect(await applyService.listHistory()).toEqual([
      expect.objectContaining({ success: false, canUndo: false }),
    ]);
  });

  it("回滚不会覆盖写入后发生的用户编辑", async () => {
    const firstPath = path.join(root, "configs", "first-user-edit.txt");
    const secondPath = path.join(root, "configs", "second-user-edit.txt");
    const firstOriginal = "第一份原配置\n";
    const secondOriginal = "第二份原配置\n";
    const userEdit = "用户在事务期间保存的新配置\n";
    await fs.mkdir(path.dirname(firstPath), { recursive: true });
    await Promise.all([
      fs.writeFile(firstPath, firstOriginal, "utf8"),
      fs.writeFile(secondPath, secondOriginal, "utf8"),
    ]);

    const { profileStore, historyStore } = createTestStores(root);
    const profileService = new ProfileService(profileStore, testVault);
    const snapshot = (filePath, content) => ({
      path: filePath,
      existed: true,
      content,
      hash: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
    });
    const replacement = (before, content) => ({
      target: "codex",
      path: before.path,
      before,
      content,
      afterHash: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
    });
    const adapters = {
      codex: {
        build: async () => [
          replacement(snapshot(firstPath, firstOriginal), "第一份新配置\n"),
          replacement(snapshot(secondPath, secondOriginal), "第二份新配置\n"),
        ],
      },
    };
    const applyService = new ApplyService({
      profileService,
      adapters,
      historyStore,
      backupDirectory: path.join(root, "data", "backups"),
      vault: testVault,
    });
    const created = await profileService.save({
      name: "并发编辑回滚夹具",
      protocol: "openai-responses",
      baseUrl: "https://rollback-race.example/v1",
      apiKey: "sk-rollback-race",
      model: "gpt-rollback-race",
      authMode: "bearer",
      targets: ["codex"],
    });
    let continuationChecks = 0;

    await expect(applyService.apply(created.id, ["codex"], {
      source: "auto",
      shouldContinue: () => {
        continuationChecks += 1;
        if (continuationChecks !== 6) return true;
        require("node:fs").writeFileSync(firstPath, userEdit, "utf8");
        return false;
      },
    })).rejects.toThrow("automatic rollback was incomplete");

    expect(await fs.readFile(firstPath, "utf8")).toBe(userEdit);
    expect(await fs.readFile(secondPath, "utf8")).toBe(secondOriginal);
  });
});

describe("首次接管撞上端口占用", () => {
  it("EADDRINUSE 时自动换空闲端口重试，新端口写进客户端配置", async () => {
    const http = await import("node:http");
    const { profileStore, historyStore } = createTestStores(root);
    const profileService = new ProfileService(profileStore, testVault);
    const gatewayStore = new JsonFileStore(
      path.join(root, "data", "gateway.json"),
      GatewayStoreSchema,
      defaultGatewayStore,
    );
    const gatewayBaselineStore = new JsonFileStore(
      path.join(root, "data", "gateway-recovery.json"),
      GatewayBaselineStoreSchema,
      defaultGatewayBaselineStore,
    );
    const gatewayService = new GatewayService({ profileService, store: gatewayStore, vault: testVault });
    const codexPath = path.join(root, ".codex", "config.toml");
    await fs.mkdir(path.dirname(codexPath), { recursive: true });
    // 接管 codex 要求配置里已有活跃的 model_provider，给个最小但合法的
    await fs.writeFile(codexPath, [
      'model_provider = "custom"',
      'model = "user-model"',
      "",
      "[model_providers.custom]",
      'name = "Custom"',
      'base_url = "https://custom.example/v1"',
      'wire_api = "responses"',
    ].join("\n") + "\n", "utf8");
    const adapters = createAdapters({
      claude: { config: path.join(root, ".claude", "settings.json") },
      codex: { config: codexPath },
      opencode: {
        config: path.join(root, ".config", "opencode", "opencode.json"),
        auth: path.join(root, ".local", "share", "opencode", "auth.json"),
      },
      gemini: {
        config: path.join(root, ".gemini", "settings.json"),
        env: path.join(root, ".gemini", ".env"),
      },
    });
    const applyService = new ApplyService({
      profileService,
      adapters,
      historyStore,
      backupDirectory: path.join(root, "data", "backups"),
      vault: testVault,
      gatewayService,
      gatewayBaselineStore,
    });
    const profile = await profileService.save({
      name: "首次方案",
      protocol: "openai-responses",
      baseUrl: "https://relay.example/v1",
      apiKey: "sk-first-run",
      model: "gpt-5-codex",
      authMode: "bearer",
      targets: ["codex"],
    });
    await applyService.assignProfile(profile.id, ["codex"]);

    // 别的程序占着默认端口——首次用户撞上的就是这一幕
    const squatter = http.default.createServer(() => {});
    await new Promise((resolve) => squatter.listen(0, "127.0.0.1", resolve));
    const takenPort = squatter.address().port;

    try {
      /*
       * 修复前这里直接把 EADDRINUSE 甩给用户，首次配置就地卡死；
       * 现在应当自动换一个空闲端口接管成功，且新端口写进 codex 配置。
       */
      await applyService.startGateway({ port: takenPort, targets: ["codex"] });
      const state = gatewayService.getPublicState();
      expect(state.status).toBe("running");
      expect(state.port).not.toBe(takenPort);
      expect(state.engaged).toEqual(["codex"]);

      const written = TOML.parse(await fs.readFile(codexPath, "utf8"));
      expect(written.model_providers.custom.base_url)
        .toContain(`127.0.0.1:${state.port}`);
    } finally {
      await gatewayService.stop().catch(() => {});
      await new Promise((resolve) => squatter.close(resolve));
    }
  });

  it("已有客户端在接管中时绝不自动换端口——它们的配置写着旧端口", async () => {
    const { profileStore, historyStore } = createTestStores(root);
    const profileService = new ProfileService(profileStore, testVault);
    const gatewayStore = new JsonFileStore(
      path.join(root, "data", "gateway.json"),
      GatewayStoreSchema,
      defaultGatewayStore,
    );
    const gatewayBaselineStore = new JsonFileStore(
      path.join(root, "data", "gateway-recovery.json"),
      GatewayBaselineStoreSchema,
      defaultGatewayBaselineStore,
    );
    const gatewayService = new GatewayService({ profileService, store: gatewayStore, vault: testVault });
    let reassigned = false;
    const originalReassign = gatewayService.reassignPort.bind(gatewayService);
    gatewayService.reassignPort = async () => {
      reassigned = true;
      return originalReassign();
    };
    const codexPath = path.join(root, ".codex", "config.toml");
    const claudePath = path.join(root, ".claude", "settings.json");
    await fs.mkdir(path.dirname(codexPath), { recursive: true });
    // 接管 codex 要求配置里已有活跃的 model_provider，给个最小但合法的
    await fs.writeFile(codexPath, [
      'model_provider = "custom"',
      'model = "user-model"',
      "",
      "[model_providers.custom]",
      'name = "Custom"',
      'base_url = "https://custom.example/v1"',
      'wire_api = "responses"',
    ].join("\n") + "\n", "utf8");
    const adapters = createAdapters({
      claude: { config: claudePath },
      codex: { config: codexPath },
      opencode: {
        config: path.join(root, ".config", "opencode", "opencode.json"),
        auth: path.join(root, ".local", "share", "opencode", "auth.json"),
      },
      gemini: {
        config: path.join(root, ".gemini", "settings.json"),
        env: path.join(root, ".gemini", ".env"),
      },
    });
    const applyService = new ApplyService({
      profileService,
      adapters,
      historyStore,
      backupDirectory: path.join(root, "data", "backups"),
      vault: testVault,
      gatewayService,
      gatewayBaselineStore,
    });
    const codexProfile = await profileService.save({
      name: "Codex 方案",
      protocol: "openai-responses",
      baseUrl: "https://relay.example/v1",
      apiKey: "sk-two",
      model: "gpt-5-codex",
      authMode: "bearer",
      targets: ["codex"],
    });
    const claudeProfile = await profileService.save({
      name: "Claude 方案",
      protocol: "anthropic",
      baseUrl: "https://relay.example",
      apiKey: "sk-two-claude",
      model: "claude-sonnet-4-5",
      authMode: "bearer",
      targets: ["claude"],
    });
    await applyService.assignProfile(codexProfile.id, ["codex"]);
    await applyService.assignProfile(claudeProfile.id, ["claude"]);

    try {
      // 先接管 codex，网关跑起来
      await applyService.startGateway({ port: 0, targets: ["codex"] });
      const runningPort = gatewayService.getPublicState().port;

      // 再接管 claude 时传一个「被占的端口」——其实就是网关自己正在用的端口。
      // 服务器已经在跑，不该也不会重绑；关键是绝不能触发自动换端口。
      await applyService.startGateway({ port: runningPort, targets: ["claude"] });
      expect(reassigned).toBe(false);
      expect(gatewayService.getPublicState().port).toBe(runningPort);
      expect(new Set(gatewayService.getPublicState().engaged)).toEqual(new Set(["codex", "claude"]));
    } finally {
      await gatewayService.stop().catch(() => {});
    }
  });
});

describe("首次使用 Codex（配置里没有 provider）", () => {
  function freshHarness() {
    const { profileStore, historyStore } = createTestStores(root);
    const profileService = new ProfileService(profileStore, testVault);
    const gatewayStore = new JsonFileStore(
      path.join(root, "data", "gateway.json"),
      GatewayStoreSchema,
      defaultGatewayStore,
    );
    const gatewayBaselineStore = new JsonFileStore(
      path.join(root, "data", "gateway-recovery.json"),
      GatewayBaselineStoreSchema,
      defaultGatewayBaselineStore,
    );
    const gatewayService = new GatewayService({ profileService, store: gatewayStore, vault: testVault });
    const codexPath = path.join(root, ".codex", "config.toml");
    const adapters = createAdapters({
      claude: { config: path.join(root, ".claude", "settings.json") },
      codex: { config: codexPath },
      opencode: {
        config: path.join(root, ".config", "opencode", "opencode.json"),
        auth: path.join(root, ".local", "share", "opencode", "auth.json"),
      },
      gemini: {
        config: path.join(root, ".gemini", "settings.json"),
        env: path.join(root, ".gemini", ".env"),
      },
    });
    const applyService = new ApplyService({
      profileService,
      adapters,
      historyStore,
      backupDirectory: path.join(root, "data", "backups"),
      vault: testVault,
      gatewayService,
      gatewayBaselineStore,
    });
    return {
      profileService,
      gatewayService,
      gatewayBaselineStore,
      applyService,
      codexPath,
    };
  }

  async function freshProfile(profileService) {
    return profileService.save({
      name: "首次方案",
      protocol: "openai-responses",
      baseUrl: "https://relay.example/v1",
      apiKey: "sk-first-run",
      model: "gpt-5-codex",
      authMode: "bearer",
      targets: ["codex"],
    });
  }

  it("config.toml 完全不存在：接管整段新建，断开整段拆掉", async () => {
    const { profileService, gatewayService, applyService, codexPath } = freshHarness();
    const profile = await freshProfile(profileService);
    await applyService.assignProfile(profile.id, ["codex"]);

    try {
      // 修复前在这里就炸：Codex config.toml must define an active model_provider
      await applyService.startGateway({ port: 0, targets: ["codex"] });
      const state = gatewayService.getPublicState();
      expect(state.engaged).toEqual(["codex"]);

      const written = TOML.parse(await fs.readFile(codexPath, "utf8"));
      expect(written.model_provider).toBe("agentgate_gateway");
      expect(written.model).toBe("gpt-5-codex");
      expect(written.model_providers.agentgate_gateway).toMatchObject({
        wire_api: "responses",
        requires_openai_auth: false,
      });
      expect(written.model_providers.agentgate_gateway.base_url)
        .toContain(`127.0.0.1:${state.port}/codex/`);
      // 上游 Key 绝不进客户端配置
      expect(await fs.readFile(codexPath, "utf8")).not.toContain("sk-first-run");

      // 断开：我们建的整段拆干净，回到「本来就没有」
      await applyService.stopGateway({ targets: ["codex"] });
      const restored = TOML.parse(await fs.readFile(codexPath, "utf8"));
      expect(restored.model_provider).toBeUndefined();
      expect(restored.model).toBeUndefined();
      expect(restored.model_providers?.agentgate_gateway).toBeUndefined();
    } finally {
      await gatewayService.stop().catch(() => {});
    }
  });

  it("生命周期事务内可以恢复目标而不重入自身锁", async () => {
    const { profileService, gatewayService, applyService } = freshHarness();
    const profile = await freshProfile(profileService);
    await applyService.assignProfile(profile.id, ["codex"]);

    try {
      await applyService.startGateway({ port: 0, targets: ["codex"] });
      await expect(applyService.withLifecycleLock(({ stopGateway }) => (
        stopGateway({ targets: ["codex"] })
      ))).resolves.toMatchObject({ engaged: [] });
    } finally {
      await gatewayService.stop().catch(() => {});
    }
  });

  it("有 model 和 mcp、没有 provider：接管留住 mcp，断开按原样放回 model", async () => {
    const { profileService, gatewayService, applyService, codexPath } = freshHarness();
    await fs.mkdir(path.dirname(codexPath), { recursive: true });
    // 真实场景：用过 codex 但从没配置 provider（默认走 ChatGPT 登录），还挂了 MCP
    await fs.writeFile(codexPath, [
      'model = "o3"',
      "",
      "[mcp_servers.demo]",
      'command = "node"',
    ].join("\n") + "\n", "utf8");
    const profile = await freshProfile(profileService);
    await applyService.assignProfile(profile.id, ["codex"]);

    try {
      await applyService.startGateway({ port: 0, targets: ["codex"] });
      const written = TOML.parse(await fs.readFile(codexPath, "utf8"));
      expect(written.model_provider).toBe("agentgate_gateway");
      expect(written.model).toBe("gpt-5-codex");
      // 用户自己的 MCP 一个字都不动
      expect(written.mcp_servers.demo.command).toBe("node");

      await applyService.stopGateway({ targets: ["codex"] });
      const restored = TOML.parse(await fs.readFile(codexPath, "utf8"));
      expect(restored.model_provider).toBeUndefined();
      expect(restored.model).toBe("o3");
      expect(restored.model_providers?.agentgate_gateway).toBeUndefined();
      expect(restored.mcp_servers.demo.command).toBe("node");
    } finally {
      await gatewayService.stop().catch(() => {});
    }
  });

  it("恢复官方保留 Codex 登录、用户配置，并清除路由和启动恢复意图", async () => {
    const {
      profileService,
      gatewayService,
      gatewayBaselineStore,
      applyService,
      codexPath,
    } = freshHarness();
    const authPath = path.join(path.dirname(codexPath), "auth.json");
    const auth = '{"tokens":{"access_token":"用户当前登录"}}\n';
    const original = `# 用户设置必须保留
model_provider = "custom"
model = "o3"
approval_policy = "never"

[model_providers.custom]
name = "Custom"
base_url = "https://custom.example/v1"
wire_api = "responses"

[model_providers.agentgate]
name = "旧 Agent;Gate 直连"
base_url = "https://old-agentgate.example/v1"
wire_api = "responses"

[mcp_servers.demo]
command = "node"
`;
    await fs.mkdir(path.dirname(codexPath), { recursive: true });
    await fs.writeFile(codexPath, original, "utf8");
    await fs.writeFile(authPath, auth, "utf8");
    const profile = await freshProfile(profileService);
    await applyService.assignProfile(profile.id, ["codex"]);

    try {
      await applyService.startGateway({ port: 0, targets: ["codex"] });
      expect(TOML.parse(await fs.readFile(codexPath, "utf8"))
        .model_providers.custom.base_url).toMatch(/^http:\/\/127\.0\.0\.1:/);

      await applyService.restoreCodexOfficial();

      const restoredSource = await fs.readFile(codexPath, "utf8");
      const restored = TOML.parse(restoredSource);
      expect(restoredSource).toContain("# 用户设置必须保留");
      expect(restored.model_provider).toBeUndefined();
      expect(restored.model).toBe("o3");
      expect(restored.approval_policy).toBe("never");
      expect(restored.model_providers.custom.base_url).toBe("https://custom.example/v1");
      expect(restored.model_providers.agentgate).toBeUndefined();
      expect(restored.mcp_servers.demo.command).toBe("node");
      expect(await fs.readFile(authPath, "utf8")).toBe(auth);
      expect(gatewayService.getPublicState()).toMatchObject({
        status: "stopped",
        targets: [],
        engaged: [],
        routes: [],
      });
      expect(gatewayService.getLifecycleState().resumeTargets).toEqual([]);
      expect((await gatewayBaselineStore.read()).baselines.codex).toBeUndefined();

      await applyService.reconcileGatewayOnLaunch({ start: true });
      expect(gatewayService.getPublicState().engaged).toEqual([]);
    } finally {
      await gatewayService.stop().catch(() => {});
    }
  });

  it("恢复官方不覆盖接管期间用户手动修改的自定义 provider", async () => {
    const { profileService, gatewayService, applyService, codexPath } = freshHarness();
    await fs.mkdir(path.dirname(codexPath), { recursive: true });
    await fs.writeFile(codexPath, `model_provider = "custom"

[model_providers.custom]
base_url = "https://before.example/v1"
wire_api = "responses"
`, "utf8");
    const profile = await freshProfile(profileService);
    await applyService.assignProfile(profile.id, ["codex"]);

    try {
      await applyService.startGateway({ port: 0, targets: ["codex"] });
      const takenOver = await fs.readFile(codexPath, "utf8");
      await fs.writeFile(
        codexPath,
        takenOver.replace(/base_url = "http:\/\/127\.0\.0\.1:[^"]+"/, 'base_url = "https://user-edit.example/v1"'),
        "utf8",
      );

      await applyService.restoreCodexOfficial();

      const restored = TOML.parse(await fs.readFile(codexPath, "utf8"));
      expect(restored.model_provider).toBeUndefined();
      expect(restored.model_providers.custom.base_url).toBe("https://user-edit.example/v1");
    } finally {
      await gatewayService.stop().catch(() => {});
    }
  });

  it("首次接管后恢复官方保留当前模型，不回滚到接管前模型", async () => {
    const { profileService, gatewayService, applyService, codexPath } = freshHarness();
    await fs.mkdir(path.dirname(codexPath), { recursive: true });
    await fs.writeFile(codexPath, 'model = "before-takeover"\n', "utf8");
    const profile = await freshProfile(profileService);
    await applyService.assignProfile(profile.id, ["codex"]);

    try {
      await applyService.startGateway({ port: 0, targets: ["codex"] });
      const takenOver = await fs.readFile(codexPath, "utf8");
      await fs.writeFile(
        codexPath,
        takenOver.replace('model = "gpt-5-codex"', 'model = "current-user-model"'),
        "utf8",
      );

      await applyService.restoreCodexOfficial();

      const restored = TOML.parse(await fs.readFile(codexPath, "utf8"));
      expect(restored.model_provider).toBeUndefined();
      expect(restored.model).toBe("current-user-model");
      expect(restored.model_providers?.agentgate_gateway).toBeUndefined();
    } finally {
      await gatewayService.stop().catch(() => {});
    }
  });

  it("恢复官方清理持久状态失败时回滚配置和 Codex 路由", async () => {
    const {
      profileService,
      gatewayService,
      gatewayBaselineStore,
      applyService,
      codexPath,
    } = freshHarness();
    const profile = await freshProfile(profileService);
    await applyService.assignProfile(profile.id, ["codex"]);

    try {
      await applyService.startGateway({ port: 0, targets: ["codex"] });
      const takenOver = await fs.readFile(codexPath, "utf8");
      const originalWrite = gatewayBaselineStore.write.bind(gatewayBaselineStore);
      let failCleanup = true;
      vi.spyOn(gatewayBaselineStore, "write").mockImplementation(async (value) => {
        if (failCleanup && !value.baselines.codex) {
          throw new Error("simulated official cleanup failure");
        }
        return originalWrite(value);
      });

      await expect(applyService.restoreCodexOfficial())
        .rejects.toThrow("simulated official cleanup failure");
      expect(await fs.readFile(codexPath, "utf8")).toBe(takenOver);
      expect(gatewayService.getPublicState()).toMatchObject({
        status: "running",
        targets: ["codex"],
        engaged: ["codex"],
        routes: [{ target: "codex", profileId: profile.id }],
      });

      failCleanup = false;
      await applyService.restoreCodexOfficial();
    } finally {
      await gatewayService.stop().catch(() => {});
    }
  });
});
