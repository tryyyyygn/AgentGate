import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testVault } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { JsonFileStore } = require("../electron/services/storage.cjs");
const {
  WalletService,
  WalletStoreSchema,
  normalizeSiteUrl,
} = require("../electron/services/wallet-service.cjs");
const { SUB2API_SESSION_SCRIPT } = require("../electron/services/wallet-login-service.cjs");

let root;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "agentgate-wallet-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function createStore() {
  return new JsonFileStore(
    path.join(root, "wallets.json"),
    WalletStoreSchema,
    () => ({ version: 1, wallets: [] }),
  );
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("独立钱包服务", () => {
  it("拒绝在站点 URL 中夹带凭据或片段", () => {
    expect(() => normalizeSiteUrl("https://user:pass@relay.example")).toThrow(/credentials/);
    expect(() => normalizeSiteUrl("https://relay.example/#secret")).toThrow(/fragments/);
  });

  it("公网钱包强制 HTTPS，但允许本机开发地址使用 HTTP", () => {
    expect(() => normalizeSiteUrl("http://relay.example")).toThrow(/HTTPS/);
    expect(normalizeSiteUrl("http://localhost:3000/api/v1")).toBe("http://localhost:3000");
    expect(normalizeSiteUrl("http://127.0.0.1:3000/v1")).toBe("http://127.0.0.1:3000");
    expect(normalizeSiteUrl("http://[::1]:3000/v1")).toBe("http://[::1]:3000");
  });

  it("Sub2API 无需 API Key，并把复制来的 /v1 API 地址还原为站点地址", async () => {
    const service = new WalletService({
      store: createStore(),
      vault: testVault,
      fetchImpl: vi.fn(),
    });

    const wallet = await service.save({
      name: "主钱包",
      siteUrl: "https://relay.example/api/v1/",
      template: "sub2api",
      lowBalanceUsd: 5,
    });

    expect(wallet).toMatchObject({
      name: "主钱包",
      siteUrl: "https://relay.example",
      template: "sub2api",
      credentialKind: "session",
      credentialStatus: "missing",
      lowBalanceUsd: 5,
    });
    expect(wallet).not.toHaveProperty("encryptedKey");
    const source = await fs.readFile(path.join(root, "wallets.json"), "utf8");
    expect(source).not.toContain("encryptedKey");
  });

  it("Codex 导入仅在根模型路由不可用时补上 /v1", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url === "https://versioned.example/models") return json({ message: "not found" }, 404);
      if (url === "https://versioned.example/v1/models") {
        return json({ data: [{ id: "gpt-5.6" }] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const service = new WalletService({ store: createStore(), vault: testVault, fetchImpl });

    const resolved = await service.resolveSub2ApiImportProfile({
      name: "Codex",
      protocol: "openai-responses",
      baseUrl: "https://versioned.example",
      apiKey: "sk-versioned-codex",
      model: "",
      authMode: "bearer",
      targets: ["codex", "opencode"],
    });

    expect(resolved.baseUrl).toBe("https://versioned.example/v1");
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://versioned.example/models",
      "https://versioned.example/v1/models",
    ]);
  });

  it("从网页登录会话读取 Sub2API 账户余额，且明文令牌不落盘", async () => {
    const store = createStore();
    const fetchImpl = vi.fn(async (url, options) => {
      if (url.endsWith("/api/v1/subscriptions/active")) {
        return json({ code: 0, data: [] });
      }
      expect(url).toBe("https://sub.example/api/v1/auth/me");
      expect(options.headers.Authorization).toBe("Bearer access-initial");
      expect(options.headers["User-Agent"]).toBe("AgentGate Login UA");
      expect(options.redirect).toBe("manual");
      return json({
        code: 0,
        data: { id: 42, email: "user@sub.example", balance: 3.25 },
      });
    });
    const service = new WalletService({ store, vault: testVault, fetchImpl });
    const wallet = await service.save({
      name: "Sub2API",
      siteUrl: "https://sub.example",
      template: "sub2api",
      lowBalanceUsd: 5,
    });

    await expect(service.importSub2ApiSession(wallet.id, {
      accessToken: "access-initial",
      refreshToken: "refresh-initial",
      tokenExpiresAt: Date.now() + 3_600_000,
      userId: "42",
      username: "user@sub.example",
      userAgent: "AgentGate Login UA",
    })).resolves.toMatchObject({
      credentialKind: "session",
      credentialStatus: "ready",
      credentialHint: "user@sub.example",
      balance: {
        status: "low",
        scope: "account",
        remainingUsd: 3.25,
      },
    });

    const source = await fs.readFile(path.join(root, "wallets.json"), "utf8");
    expect(source).not.toContain("access-initial");
    expect(source).not.toContain("refresh-initial");
    expect(source).not.toContain("AgentGate Login UA");
  });

  it("Sub2API 订阅只保留每日额度，不保存周或月统计", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith("/api/v1/auth/me")) {
        return json({ code: 0, data: { id: 42, email: "daily@sub.example", balance: 18 } });
      }
      if (url.endsWith("/api/v1/subscriptions/active")) {
        return json({
          code: 0,
          data: [
            {
              id: 1,
              daily_usage_usd: 4.43,
              daily_window_start: "2026-07-27T14:56:35+08:00",
              weekly_usage_usd: 410.82,
              weekly_window_start: "2026-07-21T14:56:35+08:00",
              monthly_usage_usd: 410.82,
              monthly_window_start: "2026-07-01T14:56:35+08:00",
              expires_at: "2026-08-04T00:00:00+08:00",
              group: {
                name: "30刀订阅",
                daily_limit_usd: 30,
                weekly_limit_usd: 210,
                monthly_limit_usd: 930,
              },
            },
            {
              id: 2,
              daily_usage_usd: 0.31,
              daily_window_start: null,
              group: {
                name: "不限额订阅",
                daily_limit_usd: null,
              },
            },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const service = new WalletService({ store: createStore(), vault: testVault, fetchImpl });
    const wallet = await service.save({
      name: "每日订阅",
      siteUrl: "https://sub.example",
      template: "sub2api",
      lowBalanceUsd: 5,
    });

    const loggedIn = await service.importSub2ApiSession(wallet.id, {
      accessToken: "access-daily",
      refreshToken: "refresh-daily",
      tokenExpiresAt: Date.now() + 3_600_000,
      userAgent: "AgentGate Login UA",
    });

    expect(loggedIn.balance.subscriptions).toEqual([
      {
        id: 1,
        name: "30刀订阅",
        dailyUsedUsd: 4.43,
        dailyLimitUsd: 30,
        expiresAt: "2026-08-03T16:00:00.000Z",
        resetsAt: "2026-07-28T06:56:35.000Z",
      },
      {
        id: 2,
        name: "不限额订阅",
        dailyUsedUsd: 0.31,
      },
    ]);
    expect(JSON.stringify(loggedIn.balance.subscriptions)).not.toMatch(/weekly|monthly/i);
  });

  it("用登录会话读取完整 Sub2API Key 并只把密钥交给主进程方案服务", async () => {
    const profileService = {
      importProfiles: vi.fn(async (input) => ({
        status: "complete",
        groupId: "00000000-0000-4000-8000-000000000301",
        groupName: input.groupName,
        imported: input.profiles.length,
        reused: 0,
        skipped: 0,
        profileIds: [
          "00000000-0000-4000-8000-000000000302",
          "00000000-0000-4000-8000-000000000303",
        ],
      })),
    };
    const fetchImpl = vi.fn(async (url, options) => {
      if (url.endsWith("/api/v1/auth/me")) {
        return json({ code: 0, data: { id: 31, email: "keys@sub.example", balance: 20 } });
      }
      if (url.endsWith("/api/v1/subscriptions/active")) return json({ code: 0, data: [] });
      if (url === "https://sub.example/models") {
        expect(options.headers.Authorization).toBe("Bearer sk-sub2api-codex");
        return json({ data: [{ id: "gpt-5.6" }] });
      }
      if (url.includes("/api/v1/keys?")) {
        return json({
          code: 0,
          data: {
            items: [{
              id: 1,
              name: "Claude 组",
              key: "sk-sub2api-claude",
              status: "active",
              group: { id: 11, platform: "anthropic" },
            }, {
              id: 2,
              name: "Codex 组",
              key: "sk-sub2api-codex",
              status: "active",
              group: { id: 12, platform: "openai" },
            }, {
              id: 3,
              name: "Gemini 组",
              key: "sk-sub2api-gemini",
              status: "active",
              group: { id: 13, platform: "gemini" },
            }, {
              id: 4,
              name: "未知平台",
              key: "sk-sub2api-unknown",
              status: "active",
              group: { id: 14, platform: "unknown" },
            }],
            total: 4,
            page: 1,
            page_size: 1000,
            pages: 1,
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const service = new WalletService({
      store: createStore(),
      vault: testVault,
      fetchImpl,
      profileService,
    });
    const wallet = await service.save({
      name: "我的钱包",
      siteUrl: "https://sub.example",
      template: "sub2api",
      lowBalanceUsd: 5,
    });
    await service.importSub2ApiSession(wallet.id, {
      accessToken: "access-keys",
      refreshToken: "refresh-keys",
      tokenExpiresAt: Date.now() + 3_600_000,
      userAgent: "AgentGate Login UA",
    });

    const result = await service.importSub2ApiKeys(wallet.id);
    expect(result).toMatchObject({
      status: "complete",
      groupName: "我的钱包",
      imported: 2,
      skipped: 2,
      profileIds: [
        "00000000-0000-4000-8000-000000000302",
        "00000000-0000-4000-8000-000000000303",
      ],
    });
    expect(profileService.importProfiles).toHaveBeenCalledWith({
      groupName: "我的钱包",
      groupMode: undefined,
      profiles: [{
        name: "Claude 组",
        protocol: "anthropic",
        baseUrl: "https://sub.example",
        apiKey: "sk-sub2api-claude",
        model: "",
        authMode: "bearer",
        targets: ["claude"],
      }, {
        name: "Codex 组",
        protocol: "openai-responses",
        baseUrl: "https://sub.example",
        apiKey: "sk-sub2api-codex",
        model: "",
        authMode: "bearer",
        targets: ["codex"],
      }],
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://sub.example/models", expect.any(Object));
    expect(fetchImpl.mock.calls.some(([url]) => url === "https://sub.example/v1/models")).toBe(false);
    expect(JSON.stringify(result)).not.toContain("sk-sub2api");
  });

  it("钱包只看到不支持的平台时不创建空分组也不导入", async () => {
    const profileService = { importProfiles: vi.fn() };
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith("/api/v1/auth/me")) {
        return json({ code: 0, data: { id: 32, email: "unsupported@sub.example", balance: 20 } });
      }
      if (url.endsWith("/api/v1/subscriptions/active")) return json({ code: 0, data: [] });
      if (url.includes("/api/v1/keys?")) {
        return json({
          code: 0,
          data: {
            items: [{
              id: 5,
              name: "Gemini 组",
              key: "sk-sub2api-gemini",
              status: "active",
              group: { id: 15, platform: "gemini" },
            }],
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const service = new WalletService({
      store: createStore(),
      vault: testVault,
      fetchImpl,
      profileService,
    });
    const wallet = await service.save({
      name: "只含未支持平台",
      siteUrl: "https://sub.example",
      template: "sub2api",
      lowBalanceUsd: 5,
    });
    await service.importSub2ApiSession(wallet.id, {
      accessToken: "access-unsupported",
      refreshToken: "refresh-unsupported",
      tokenExpiresAt: Date.now() + 3_600_000,
      userAgent: "AgentGate Login UA",
    });

    await expect(service.importSub2ApiKeys(wallet.id)).resolves.toEqual({
      status: "complete",
      groupName: "只含未支持平台",
      imported: 0,
      reused: 0,
      skipped: 1,
      profileIds: [],
    });
    expect(profileService.importProfiles).not.toHaveBeenCalled();
  });

  it("订阅接口拒绝旧 Access Token 时只刷新一次并用新会话重试", async () => {
    let activeCalls = 0;
    const fetchImpl = vi.fn(async (url, options) => {
      if (url.endsWith("/api/v1/auth/me")) {
        return json({ code: 0, data: { id: 7, email: "rotate@sub.example", balance: 12 } });
      }
      if (url.endsWith("/api/v1/subscriptions/active")) {
        activeCalls += 1;
        if (activeCalls === 1) return json({ message: "access expired" }, 401);
        expect(options.headers.Authorization).toBe("Bearer access-new");
        return json({
          code: 0,
          data: [{
              id: 7,
              daily_usage_usd: 2,
              daily_window_start: "2026-07-27T09:30:00+08:00",
              group: { name: "每日 10 美元", daily_limit_usd: 10 },
            }],
        });
      }
      if (url.endsWith("/api/v1/auth/refresh")) {
        expect(JSON.parse(options.body)).toEqual({ refresh_token: "refresh-old" });
        return json({
          code: 0,
          data: {
            access_token: "access-new",
            refresh_token: "refresh-new",
            expires_in: 3600,
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const store = createStore();
    const service = new WalletService({ store, vault: testVault, fetchImpl });
    const wallet = await service.save({
      name: "订阅刷新",
      siteUrl: "https://sub.example",
      template: "sub2api",
      lowBalanceUsd: 5,
    });

    const loggedIn = await service.importSub2ApiSession(wallet.id, {
      accessToken: "access-old",
      refreshToken: "refresh-old",
      tokenExpiresAt: Date.now() + 3_600_000,
      userAgent: "AgentGate Login UA",
    });

    expect(loggedIn.balance.subscriptions).toEqual([{
      id: 7,
      name: "每日 10 美元",
      dailyUsedUsd: 2,
      dailyLimitUsd: 10,
      resetsAt: "2026-07-28T01:30:00.000Z",
    }]);
    expect(fetchImpl.mock.calls.filter(([url]) => url.endsWith("/api/v1/auth/refresh"))).toHaveLength(1);
    const stored = await store.read();
    expect(JSON.parse(testVault.decrypt(stored.wallets[0].encryptedSession))).toMatchObject({
      accessToken: "access-new",
      refreshToken: "refresh-new",
    });
  });

  it("Access Token 临近到期时自动刷新并保存轮换后的 Refresh Token", async () => {
    const store = createStore();
    const fetchImpl = vi.fn(async (url, options) => {
      if (url.endsWith("/api/v1/auth/refresh")) {
        expect(options.headers["User-Agent"]).toBe("AgentGate Login UA");
        expect(JSON.parse(options.body)).toEqual({ refresh_token: "refresh-old" });
        return json({
          code: 0,
          data: {
            access_token: "access-new",
            refresh_token: "refresh-new",
            expires_in: 3600,
          },
        });
      }
      if (url.endsWith("/api/v1/auth/me")) {
        expect(["Bearer access-old", "Bearer access-new"]).toContain(options.headers.Authorization);
        expect(options.headers["User-Agent"]).toBe("AgentGate Login UA");
        return json({ code: 0, data: { id: 7, email: "rotate@sub.example", balance: 12 } });
      }
      if (url.endsWith("/api/v1/subscriptions/active")) {
        return json({ code: 0, data: [] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const service = new WalletService({ store, vault: testVault, fetchImpl });
    const wallet = await service.save({
      name: "轮换测试",
      siteUrl: "https://sub.example",
      template: "sub2api",
      lowBalanceUsd: 5,
    });
    await service.importSub2ApiSession(wallet.id, {
      accessToken: "access-old",
      refreshToken: "refresh-old",
      tokenExpiresAt: Date.now() + 3_600_000,
      userAgent: "AgentGate Login UA",
    });

    const before = await store.read();
    const session = JSON.parse(testVault.decrypt(before.wallets[0].encryptedSession));
    before.wallets[0].encryptedSession = testVault.encrypt(JSON.stringify({
      ...session,
      tokenExpiresAt: Date.now() + 30_000,
    }));
    await store.write(before);

    const [first, second] = await Promise.all([
      service.check(wallet.id),
      service.check(wallet.id),
    ]);
    expect(first).toMatchObject({
      credentialStatus: "ready",
      balance: { status: "ok", remainingUsd: 12 },
    });
    expect(second).toEqual(first);
    expect(fetchImpl.mock.calls.filter(([url]) => url.endsWith("/api/v1/auth/refresh"))).toHaveLength(1);
    const after = await store.read();
    const rotated = JSON.parse(testVault.decrypt(after.wallets[0].encryptedSession));
    expect(rotated).toMatchObject({
      accessToken: "access-new",
      refreshToken: "refresh-new",
      userAgent: "AgentGate Login UA",
    });
    const source = await fs.readFile(path.join(root, "wallets.json"), "utf8");
    expect(source).not.toContain("refresh-old");
    expect(source).not.toContain("refresh-new");
  });

  it("用 New API 的公开 quota_per_unit 把内部额度换算为美元", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith("/api/status")) {
        return json({ success: true, data: { quota_per_unit: 500000 } });
      }
      if (url.endsWith("/api/usage/token/")) {
        return json({
          code: true,
          data: {
            total_granted: 5_000_000,
            total_used: 1_500_000,
            total_available: 3_500_000,
            unlimited_quota: false,
            expires_at: 0,
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const service = new WalletService({ store: createStore(), vault: testVault, fetchImpl });
    const wallet = await service.save({
      name: "New API",
      siteUrl: "https://new.example",
      template: "new-api",
      apiKey: "sk-new-secret",
      lowBalanceUsd: 0,
    });

    await expect(service.check(wallet.id)).resolves.toMatchObject({
      balance: {
        status: "ok",
        scope: "key",
        remainingUsd: 7,
        totalUsd: 10,
        usedUsd: 3,
      },
    });
  });

  it("通过 One API 两个 Billing 接口计算站点口径余额", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith("/api/status")) {
        return json({ success: true, data: { quota_per_unit: 500000, display_in_currency: true } });
      }
      if (url.endsWith("/v1/dashboard/billing/subscription")) {
        return json({ hard_limit_usd: 25, access_until: 0 });
      }
      if (url.endsWith("/v1/dashboard/billing/usage")) {
        return json({ total_usage: 925 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const service = new WalletService({ store: createStore(), vault: testVault, fetchImpl });
    const wallet = await service.save({
      name: "One API",
      siteUrl: "https://one.example",
      template: "one-api",
      apiKey: "sk-one-secret",
      lowBalanceUsd: 20,
    });

    await expect(service.check(wallet.id)).resolves.toMatchObject({
      balance: {
        status: "low",
        scope: "site",
        remainingUsd: 15.75,
        totalUsd: 25,
        usedUsd: 9.25,
      },
    });
  });

  it("Refresh Token 确定失效后标记为登录过期，后续检测不再请求站点", async () => {
    let imported = false;
    const fetchImpl = vi.fn(async (url) => {
      if (!imported && url.endsWith("/api/v1/auth/me")) {
        return json({ code: 0, data: { id: 9, email: "expired@sub.example", balance: 9 } });
      }
      if (!imported && url.endsWith("/api/v1/subscriptions/active")) {
        return json({ code: 0, data: [] });
      }
      if (url.endsWith("/api/v1/auth/me")) return json({ message: "access expired" }, 401);
      if (url.endsWith("/api/v1/auth/refresh")) return json({ message: "refresh expired" }, 401);
      throw new Error(`Unexpected URL: ${url}`);
    });
    const service = new WalletService({ store: createStore(), vault: testVault, fetchImpl });
    const wallet = await service.save({
      name: "失效钱包",
      siteUrl: "https://bad.example",
      template: "sub2api",
      lowBalanceUsd: 1,
    });
    await service.importSub2ApiSession(wallet.id, {
      accessToken: "access-expired",
      refreshToken: "refresh-expired",
      tokenExpiresAt: Date.now() + 3_600_000,
      userAgent: "AgentGate Login UA",
    });
    imported = true;

    const checked = await service.check(wallet.id);
    expect(checked.credentialStatus).toBe("expired");
    expect(checked.balance).toMatchObject({
      status: "error",
      message: "Sub2API login has expired; sign in again",
    });
    expect(checked.balance).not.toHaveProperty("remainingUsd");
    await expect(service.list()).resolves.toEqual([checked]);

    const callsAfterExpiry = fetchImpl.mock.calls.length;
    await expect(service.check(wallet.id)).resolves.toMatchObject({ credentialStatus: "expired" });
    expect(fetchImpl).toHaveBeenCalledTimes(callsAfterExpiry);
  });

  it("密钥导入和余额检测共用同一会话刷新，不会把新会话误判为过期", async () => {
    const store = createStore();
    let releaseRefresh;
    let markRefreshStarted;
    const refreshStarted = new Promise((resolve) => { markRefreshStarted = resolve; });
    const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
    let refreshCalls = 0;
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith("/api/v1/auth/refresh")) {
        refreshCalls += 1;
        if (refreshCalls > 1) return json({ message: "refresh token invalid" }, 401);
        markRefreshStarted();
        await refreshGate;
        return json({
          code: 0,
          data: {
            access_token: "access-new",
            refresh_token: "refresh-new",
            expires_in: 3600,
          },
        });
      }
      if (url.endsWith("/api/v1/auth/me")) {
        return json({ code: 0, data: { id: 9, email: "user@sub.example", balance: 9 } });
      }
      if (url.endsWith("/api/v1/subscriptions/active")) return json({ code: 0, data: [] });
      if (url.includes("/api/v1/keys?")) return json({ code: 0, data: { items: [], total: 0, pages: 1 } });
      throw new Error(`Unexpected URL: ${url}`);
    });
    const service = new WalletService({
      store,
      vault: testVault,
      fetchImpl,
      profileService: { importProfiles: vi.fn() },
    });
    const wallet = await service.save({
      name: "Sub2API",
      siteUrl: "https://sub.example",
      template: "sub2api",
      lowBalanceUsd: 0,
    });
    const data = await store.read();
    data.wallets[0].encryptedSession = testVault.encrypt(JSON.stringify({
      accessToken: "access-old",
      refreshToken: "refresh-old",
      tokenExpiresAt: Date.now() + 1_000,
    }));
    await store.write(data);

    const importing = service.importSub2ApiKeys(wallet.id);
    await refreshStarted;
    const checking = service.check(wallet.id);
    releaseRefresh();

    await expect(importing).resolves.toMatchObject({ status: "complete" });
    await expect(checking).resolves.toMatchObject({ credentialStatus: "ready" });
    expect(refreshCalls).toBe(1);
    const stored = (await store.read()).wallets[0];
    expect(stored.sessionExpired).not.toBe(true);
    expect(JSON.parse(testVault.decrypt(stored.encryptedSession))).toMatchObject({
      accessToken: "access-new",
      refreshToken: "refresh-new",
    });
  });

  it("超过 500 把 Sub2API Key 时明确拒绝，不静默导入第一页", async () => {
    const store = createStore();
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith("/api/v1/auth/me")) {
        return json({ code: 0, data: { id: 9, email: "user@sub.example", balance: 9 } });
      }
      if (url.endsWith("/api/v1/subscriptions/active")) return json({ code: 0, data: [] });
      if (url.includes("/api/v1/keys?")) {
        return json({ code: 0, data: { items: [], total: 501, page: 1, page_size: 500, pages: 2 } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const service = new WalletService({
      store,
      vault: testVault,
      fetchImpl,
      profileService: { importProfiles: vi.fn() },
    });
    const wallet = await service.save({
      name: "Sub2API",
      siteUrl: "https://sub.example",
      template: "sub2api",
      lowBalanceUsd: 0,
    });
    const data = await store.read();
    data.wallets[0].encryptedSession = testVault.encrypt(JSON.stringify({ accessToken: "access-token" }));
    await store.write(data);

    await expect(service.importSub2ApiKeys(wallet.id)).rejects.toThrow(/500/);
    expect(service.profileService.importProfiles).not.toHaveBeenCalled();
    const requestUrl = new URL(fetchImpl.mock.calls.find(([url]) => url.includes("/api/v1/keys?"))[0]);
    expect(requestUrl.searchParams.get("page_size")).toBe("500");
  });

  it("登录页脚本只提取 Sub2API 会话所需字段", () => {
    const storage = new Map([
      ["auth_token", "access-token"],
      ["refresh_token", "refresh-token"],
      ["token_expires_at", "1999999999999"],
      ["auth_user", JSON.stringify({
        id: 23,
        email: "login@sub.example",
        role: "admin",
        password: "must-not-leak",
      })],
    ]);
    const result = vm.runInNewContext(SUB2API_SESSION_SCRIPT, {
      localStorage: { getItem: (key) => storage.get(key) ?? null },
      navigator: { userAgent: "AgentGate Login UA" },
    });

    expect({ ...result }).toEqual({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenExpiresAt: 1_999_999_999_999,
      userId: "23",
      username: "login@sub.example",
      userAgent: "AgentGate Login UA",
    });
  });
});
