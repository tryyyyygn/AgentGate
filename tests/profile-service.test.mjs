import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestStores, testVault } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { ProfileService } = require("../electron/services/profile-service.cjs");

let root;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "keydeck-profile-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("方案服务", () => {
  it("仅在连接参数未变化时保留健康状态", async () => {
    const { profileStore } = createTestStores(root);
    const service = new ProfileService(profileStore, testVault);
    const created = await service.save({
      name: "健康状态夹具",
      protocol: "anthropic",
      baseUrl: "https://relay.example",
      apiKey: "sk-health-secret",
      model: "claude-sonnet-4-5",
      authMode: "bearer",
      targets: ["claude"],
    });
    const health = {
      status: "healthy",
      latencyMs: 120,
      checkedAt: new Date().toISOString(),
      statusCode: 200,
      message: "连接正常",
    };
    await service.updateHealth(created.id, health);

    const preserved = await service.save({
      id: created.id,
      name: "只改名称",
      protocol: "anthropic",
      baseUrl: "https://relay.example",
      model: "claude-opus-4-1",
      authMode: "bearer",
      targets: ["claude"],
    });
    expect(preserved.health).toEqual(health);

    const invalidated = await service.save({
      id: created.id,
      name: "切换端点",
      protocol: "anthropic",
      baseUrl: "https://another-relay.example",
      model: "claude-opus-4-1",
      authMode: "bearer",
      targets: ["claude"],
    });
    expect(invalidated.health).toBeUndefined();
  });

  it("修改名称或自动切换计划不会使已写配置的连接 revision 失效", async () => {
    const { profileStore } = createTestStores(root);
    const service = new ProfileService(profileStore, testVault);
    const created = await service.save({
      name: "计划前",
      protocol: "openai-responses",
      baseUrl: "https://relay.example/v1",
      endpoints: [
        { url: "https://relay.example/v1" },
        { url: "https://backup.example/v1" },
      ],
      apiKey: "sk-schedule-secret",
      model: "gpt-5.2-codex",
      authMode: "bearer",
      targets: ["codex"],
      autoSwitch: { enabled: false, intervalMinutes: 5 },
    });
    const before = await service.getStored(created.id);

    await service.save({
      id: created.id,
      name: "计划后",
      protocol: created.protocol,
      baseUrl: created.baseUrl,
      endpoints: created.endpoints.map(({ url }) => ({ url })),
      model: created.model,
      authMode: created.authMode,
      targets: created.targets,
      enableToolSearch: created.enableToolSearch,
      autoSwitch: { enabled: true, intervalMinutes: 15 },
    });

    const after = await service.getStored(created.id);
    expect(after.connectionRevision).toBe(before.connectionRevision);
    expect(after.name).toBe("计划后");
    expect(after.autoSwitch).toEqual({ enabled: true, intervalMinutes: 15 });
  });

  it("把旧版单 URL 存储安全迁移为 URL 池", async () => {
    const profilePath = path.join(root, "data", "profiles.json");
    const createdAt = new Date().toISOString();
    await fs.mkdir(path.dirname(profilePath), { recursive: true });
    await fs.writeFile(profilePath, `${JSON.stringify({
      version: 1,
      profiles: [{
        id: "00000000-0000-4000-8000-000000000101",
        name: "旧版方案",
        protocol: "anthropic",
        baseUrl: "https://legacy.example",
        model: "claude-sonnet-4-5",
        authMode: "bearer",
        targets: ["claude"],
        enableToolSearch: true,
        keyHint: "****cret",
        encryptedKey: testVault.encrypt("sk-legacy-secret"),
        createdAt,
        updatedAt: createdAt,
      }],
    }, null, 2)}\n`, "utf8");

    const { profileStore } = createTestStores(root);
    const service = new ProfileService(profileStore, testVault);
    const [migrated] = await service.list();

    expect(migrated.endpoints).toEqual([{
      url: "https://legacy.example",
      models: [],
      healthHistory: [],
      healthTimeline: [],
    }]);
    expect(migrated.autoSwitch).toEqual({ enabled: false, intervalMinutes: 2 });
    expect(await service.getSecret(migrated.id)).toBe("sk-legacy-secret");

    await service.save({
      id: migrated.id,
      name: "迁移后方案",
      protocol: migrated.protocol,
      baseUrl: migrated.baseUrl,
      endpoints: migrated.endpoints.map(({ url }) => ({ url })),
      model: migrated.model,
      authMode: migrated.authMode,
      targets: migrated.targets,
      enableToolSearch: migrated.enableToolSearch,
      autoSwitch: migrated.autoSwitch,
    });
    expect(JSON.parse(await fs.readFile(profilePath, "utf8")).version).toBe(3);
  });

  it("在主进程内复制方案和 Key，并重置运行时状态", async () => {
    const { profileStore } = createTestStores(root);
    const service = new ProfileService(profileStore, testVault);
    const source = await service.save({
      name: "主方案",
      protocol: "openai-responses",
      baseUrl: "https://primary.example/v1",
      endpoints: [
        { url: "https://primary.example/v1" },
        { url: "https://backup.example/v1" },
      ],
      apiKey: "sk-copy-secret",
      model: "gpt-5.2-codex",
      authMode: "bearer",
      targets: ["codex"],
      autoSwitch: { enabled: true, intervalMinutes: 15 },
    });
    const stored = await service.getStored(source.id);
    await service.updateEndpointResults(source.id, stored.endpoints.map((endpoint, index) => ({
      url: endpoint.url,
      models: ["gpt-5.2-codex"],
      health: {
        status: "healthy",
        latencyMs: 100 + index * 50,
        checkedAt: new Date().toISOString(),
        statusCode: 200,
        message: "连接正常",
      },
    })), stored.connectionRevision);
    await service.markApplied(source.id, new Date().toISOString());

    const duplicate = await service.duplicate(source.id);
    expect(duplicate.name).toBe("主方案 副本");
    expect(duplicate.id).not.toBe(source.id);
    expect(duplicate.endpoints).toEqual([
      { url: "https://primary.example/v1", models: [], healthHistory: [], healthTimeline: [] },
      { url: "https://backup.example/v1", models: [], healthHistory: [], healthTimeline: [] },
    ]);
    expect(duplicate.autoSwitch).toEqual({ enabled: false, intervalMinutes: 15 });
    expect(duplicate.lastAppliedAt).toBeUndefined();
    expect(duplicate.health).toBeUndefined();
    expect(duplicate.encryptedKey).toBeUndefined();
    expect(await service.getSecret(duplicate.id)).toBe("sk-copy-secret");
    expect(await fs.readFile(path.join(root, "data", "profiles.json"), "utf8"))
      .not.toContain("sk-copy-secret");
  });

  it("规范化路径尾斜杠但保留查询参数和路径大小写", async () => {
    const { profileStore } = createTestStores(root);
    const service = new ProfileService(profileStore, testVault);
    const saved = await service.save({
      name: "URL 规范化",
      protocol: "openai-chat",
      baseUrl: "https://EXAMPLE.com/API/?prefix=/",
      endpoints: [
        { url: "https://EXAMPLE.com/API/?prefix=/" },
        { url: "https://example.com/api/?prefix=/" },
      ],
      apiKey: "sk-url-secret",
      model: "gpt-test",
      authMode: "bearer",
      targets: ["codex"],
    });

    expect(saved.baseUrl).toBe("https://example.com/API?prefix=/");
    expect(saved.endpoints.map((endpoint) => endpoint.url)).toEqual([
      "https://example.com/API?prefix=/",
      "https://example.com/api?prefix=/",
    ]);
    await expect(service.save({
      id: saved.id,
      name: saved.name,
      protocol: saved.protocol,
      baseUrl: "https://user:secret@example.com/API#fragment",
      endpoints: [{ url: "https://user:secret@example.com/API#fragment" }],
      model: saved.model,
      authMode: saved.authMode,
      targets: saved.targets,
    })).rejects.toThrow("cannot contain credentials or fragments");
  });
});

describe("密钥分组", () => {
  it("把生产版 v2 数据迁移到现有密钥分组且不改变密钥", async () => {
    const profilePath = path.join(root, "data", "profiles.json");
    const createdAt = new Date().toISOString();
    await fs.mkdir(path.dirname(profilePath), { recursive: true });
    await fs.writeFile(profilePath, `${JSON.stringify({
      version: 2,
      profiles: [{
        id: "00000000-0000-4000-8000-000000000201",
        name: "生产版方案",
        protocol: "openai-responses",
        baseUrl: "https://relay.example/v1",
        endpoints: [{
          url: "https://relay.example/v1",
          models: [],
          healthHistory: [],
          healthTimeline: [],
        }],
        model: "gpt-5.6",
        authMode: "bearer",
        targets: ["codex"],
        enableToolSearch: false,
        autoSwitch: { enabled: false, intervalMinutes: 2 },
        connectionRevision: 1,
        keyHint: "****cret",
        encryptedKey: testVault.encrypt("sk-production-secret"),
        createdAt,
        updatedAt: createdAt,
      }],
    }, null, 2)}\n`, "utf8");

    const { profileStore } = createTestStores(root);
    const service = new ProfileService(profileStore, testVault);
    const [group] = await service.listGroups();
    const [profile] = await service.list();

    expect(group.name).toBe("现有密钥");
    expect(profile.groupId).toBe(group.id);
    expect(await service.getSecret(profile.id)).toBe("sk-production-secret");

    await service.renameGroup(group.id, "已有渠道");
    const persisted = JSON.parse(await fs.readFile(profilePath, "utf8"));
    expect(persisted.version).toBe(3);
    expect(persisted.groups[0].name).toBe("已有渠道");
    expect(persisted.profiles[0].groupId).toBe(group.id);
    expect(await service.getSecret(profile.id)).toBe("sk-production-secret");
  });

  it("支持创建、命名、调整成员与顺序，删除分组只移出密钥", async () => {
    const { profileStore } = createTestStores(root);
    const service = new ProfileService(profileStore, testVault);
    const first = await service.save({
      name: "第一把",
      protocol: "anthropic",
      baseUrl: "https://a.example",
      apiKey: "sk-group-first",
      model: "claude-sonnet-4-5",
      authMode: "bearer",
      targets: ["claude"],
    });
    const second = await service.save({
      name: "第二把",
      protocol: "openai-responses",
      baseUrl: "https://b.example/v1",
      apiKey: "sk-group-second",
      model: "gpt-5.6",
      authMode: "bearer",
      targets: ["codex"],
    });

    const primary = await service.createGroup("主用", [first.id, second.id]);
    const backup = await service.createGroup("备用", []);
    await service.renameGroup(primary.id, "常用");
    await service.updateGroupMembers(primary.id, [first.id]);
    await service.organize({
      groupIds: [backup.id, primary.id],
      profiles: [
        { id: second.id, groupId: backup.id },
        { id: first.id, groupId: primary.id },
      ],
    });

    expect((await service.listGroups()).map((group) => group.name)).toEqual(["备用", "常用"]);
    expect((await service.list()).map((profile) => [profile.name, profile.groupId])).toEqual([
      ["第二把", backup.id],
      ["第一把", primary.id],
    ]);

    await service.deleteGroup(backup.id);
    const afterDelete = await service.list();
    expect(afterDelete.find((profile) => profile.id === second.id)?.groupId).toBeUndefined();
    expect(await service.getSecret(second.id)).toBe("sk-group-second");
  });

  it("批量导入时按钱包名建组、提示同名冲突并跳过重复密钥", async () => {
    const { profileStore } = createTestStores(root);
    const service = new ProfileService(profileStore, testVault);
    const profiles = [{
      name: "Claude Key",
      protocol: "anthropic",
      baseUrl: "https://sub.example",
      apiKey: "sk-import-claude",
      model: "",
      authMode: "bearer",
      targets: ["claude", "opencode"],
    }, {
      name: "Codex Key",
      protocol: "openai-responses",
      baseUrl: "https://sub.example/v1",
      apiKey: "sk-import-codex",
      model: "",
      authMode: "bearer",
      targets: ["codex", "opencode"],
    }];

    const imported = await service.importProfiles({ groupName: "订阅钱包", profiles });
    expect(imported).toMatchObject({
      status: "complete",
      groupName: "订阅钱包",
      imported: 2,
      reused: 0,
    });
    expect(imported.profileIds).toHaveLength(2);
    await expect(service.importProfiles({ groupName: "订阅钱包", profiles }))
      .resolves.toEqual({ status: "group-conflict", groupName: "订阅钱包" });
    const reused = await service.importProfiles({
      groupName: "订阅钱包",
      groupMode: "existing",
      profiles,
    });
    expect(reused).toMatchObject({ status: "complete", imported: 0, reused: 2 });
    expect(new Set(reused.profileIds)).toEqual(new Set(imported.profileIds));
    const separate = await service.importProfiles({
      groupName: "订阅钱包",
      groupMode: "new",
      profiles: [{ ...profiles[1], apiKey: "sk-import-third", name: "第三把" }],
    });
    expect(separate).toMatchObject({ status: "complete", groupName: "订阅钱包 (2)", imported: 1 });
    await expect(service.importProfiles({
      groupName: "超限钱包",
      profiles: Array.from({ length: 501 }, (_, index) => ({
        ...profiles[0],
        name: `Key ${index + 1}`,
        apiKey: `sk-import-${index + 1}`,
      })),
    })).rejects.toThrow();

    const source = await fs.readFile(path.join(root, "data", "profiles.json"), "utf8");
    expect(source).not.toContain("sk-import-claude");
    expect(source).not.toContain("sk-import-codex");
    expect(source).not.toContain("sk-import-third");
  });
});

describe("Token 用量统计", () => {
  it("按请求累计总量、输入与缓存命中", async () => {
    const { profileStore } = createTestStores(root);
    const profileService = new ProfileService(profileStore, testVault);
    const created = await profileService.save({
      name: "统计方案",
      protocol: "openai-responses",
      baseUrl: "https://usage.example/v1",
      apiKey: "sk-usage-secret",
      model: "gpt-5-codex",
      authMode: "bearer",
      targets: ["codex"],
    });

    await profileService.addTokenUsage(created.id, {
      totalTokens: 1_000,
      inputTokens: 900,
      cachedTokens: 700,
    });
    await profileService.addTokenUsage(created.id, {
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 50,
    });
    await profileService.addTokenUsage(created.id, undefined);
    await profileService.addTokenUsage("not-a-uuid", { totalTokens: 5 });

    const [profile] = await profileService.list();
    expect(profile.tokenUsageTotal).toBe(1_120);
    expect(profile.tokenInputTotal).toBe(1_000);
    expect(profile.tokenCachedTotal).toBe(750);
  });

  it("编辑方案不清空累计用量", async () => {
    const { profileStore } = createTestStores(root);
    const profileService = new ProfileService(profileStore, testVault);
    const created = await profileService.save({
      name: "改前",
      protocol: "anthropic",
      baseUrl: "https://usage.example",
      apiKey: "sk-usage-secret",
      model: "claude-sonnet-4-5",
      authMode: "bearer",
      targets: ["claude"],
    });
    await profileService.addTokenUsage(created.id, {
      totalTokens: 32_305,
      inputTokens: 32_000,
      cachedTokens: 30_000,
      cacheWriteTokens: 1_500,
      reasoningTokens: 200,
      outputTokens: 305,
    });

    /*
     * save() 是从零重建方案对象的——这些账是网关一条条请求攒出来的，不是这次
     * 编辑的输入，编辑一次名字就归零等于把密钥页的累计和缓存率全部清掉。
     * 连 Key、URL 一起换也照样保留：账记在「方案」名下。
     */
    const renamed = await profileService.save({
      id: created.id,
      name: "改后（连 Key 和 URL 一起换）",
      protocol: "anthropic",
      baseUrl: "https://other.example",
      apiKey: "sk-brand-new-secret",
      model: "claude-sonnet-4-5",
      authMode: "bearer",
      targets: ["claude"],
    });

    expect(renamed.tokenUsageTotal).toBe(32_305);
    expect(renamed.tokenInputTotal).toBe(32_000);
    expect(renamed.tokenCachedTotal).toBe(30_000);
    expect(renamed.tokenCacheWriteTotal).toBe(1_500);
    expect(renamed.tokenReasoningTotal).toBe(200);
    expect(renamed.tokenUsageToday).toBe(32_305);
    expect(renamed.tokenDayKey).toBeTruthy();

    // 编辑之后继续记账，要接着累计而不是另起炉灶
    await profileService.addTokenUsage(created.id, { totalTokens: 100, inputTokens: 90 });
    const [after] = await profileService.list();
    expect(after.tokenUsageTotal).toBe(32_405);
  });
});

describe("当日 Token 统计", () => {
  it("同日累加，跨日归零", async () => {
    const { profileStore } = createTestStores(root);
    const profileService = new ProfileService(profileStore, testVault);
    const created = await profileService.save({
      name: "当日统计",
      protocol: "openai-responses",
      baseUrl: "https://day.example/v1",
      apiKey: "sk-day-secret",
      model: "gpt-5-codex",
      authMode: "bearer",
      targets: ["codex"],
    });

    await profileService.addTokenUsage(created.id, { totalTokens: 1_000 });
    await profileService.addTokenUsage(created.id, { totalTokens: 500 });

    let [profile] = await profileService.list();
    expect(profile.tokenUsageToday).toBe(1_500);
    expect(profile.tokenUsageTotal).toBe(1_500);

    // 模拟跨日：把日期键改成昨天，下一次记账应从 0 起算
    const data = await profileStore.read();
    data.profiles[0].tokenDayKey = "2020-01-01";
    await profileStore.write(data);

    await profileService.addTokenUsage(created.id, { totalTokens: 200 });

    [profile] = await profileService.list();
    expect(profile.tokenUsageToday).toBe(200);
    expect(profile.tokenUsageTotal).toBe(1_700);
  });
});
