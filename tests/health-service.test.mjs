import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestStores, testVault } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const {
  HealthService,
  MAX_MODEL_RESPONSE_BYTES,
  parseModelIds,
  probeEndpoint,
} = require("../electron/services/health-service.cjs");
const { ProfileService } = require("../electron/services/profile-service.cjs");

const API_KEY = "sk-health-secret";
const PRIMARY_URL = "https://relay-a.example";
const SECONDARY_URL = "https://relay-b.example/api";

let root;

/**
 * 创建带 JSON 内容类型的 Fetch 响应。
 *
 * @param {unknown} payload 将被序列化的响应载荷。
 * @param {ResponseInit} [init] 可选的状态与响应头。
 * @returns {Response} 不依赖网络的标准 Fetch 响应。
 */
function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

/**
 * 新建供健康检测使用的 OpenAI 兼容方案。
 *
 * @param {ProfileService} service 隔离存储对应的方案服务。
 * @param {object} [overrides] 需要覆盖的方案字段。
 * @returns {Promise<object>} 不含密钥密文的公开方案。
 */
function saveOpenAiProfile(service, overrides = {}) {
  return service.save({
    name: "健康检测夹具",
    protocol: "openai-responses",
    baseUrl: PRIMARY_URL,
    endpoints: [{ url: PRIMARY_URL }],
    apiKey: API_KEY,
    model: "",
    authMode: "bearer",
    targets: ["codex"],
    ...overrides,
  });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "keydeck-health-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe("模型列表解析", () => {
  it.each([
    ["OpenAI", "openai-responses", ["gpt-5.2", "gpt-5.2-codex"]],
    ["Anthropic", "anthropic", ["claude-sonnet-4-5", "claude-opus-4-1"]],
  ])("识别 %s data[].id", (_name, protocol, expected) => {
    const payload = { data: expected.map((id) => ({ id })) };

    expect(parseModelIds(protocol, payload)).toEqual(expected);
  });

  it("识别 Gemini models[].name 并移除 models/ 前缀", () => {
    const payload = {
      models: [
        { name: "models/gemini-2.5-pro" },
        { name: "models/gemini-2.5-flash" },
      ],
    };

    expect(parseModelIds("gemini", payload)).toEqual([
      "gemini-2.5-pro",
      "gemini-2.5-flash",
    ]);
  });
});

describe("端点探测边界", () => {
  const profile = {
    protocol: "openai-responses",
    baseUrl: PRIMARY_URL,
    authMode: "bearer",
  };
  const endpoint = { url: PRIMARY_URL };

  it("将 401 记录为不健康且不返回响应正文", async () => {
    const privateBody = "private-provider-error-detail";
    const fetchMock = vi.fn(async () => new Response(privateBody, { status: 401 }));

    const result = await probeEndpoint(profile, API_KEY, endpoint, fetchMock);

    expect(result).toMatchObject({
      url: PRIMARY_URL,
      models: [],
      health: {
        status: "unhealthy",
        statusCode: 401,
        message: "Endpoint returned HTTP 401",
      },
    });
    expect(JSON.stringify(result)).not.toContain(privateBody);
  });

  it.each([
    {
      name: "畸形 JSON",
      privateBody: "private-malformed-model-detail",
      response() {
        return new Response('{"data":[{"id":"private-malformed-model-detail"}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
    {
      name: "超大 content-length",
      privateBody: "private-oversized-model-detail",
      response() {
        return new Response("private-oversized-model-detail", {
          status: 200,
          headers: {
            "content-length": String(MAX_MODEL_RESPONSE_BYTES + 1),
            "content-type": "application/json",
          },
        });
      },
    },
  ])("$name 只返回通用提示，不暴露响应内容", async ({ privateBody, response }) => {
    const fetchMock = vi.fn(async () => response());

    const result = await probeEndpoint(profile, API_KEY, endpoint, fetchMock);

    expect(result).toMatchObject({
      models: [],
      health: {
        status: "unhealthy",
        statusCode: 200,
        message: "Endpoint model list could not be verified",
      },
    });
    expect(JSON.stringify(result)).not.toContain(privateBody);
  });
});

describe("健康检测结果提交", () => {
  it("草稿识别使用表单里的新 URL，并为已有方案复用保存的 Key", async () => {
    const profileService = {
      getSecret: vi.fn().mockResolvedValue(API_KEY),
    };
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ id: "gpt-draft" }] }));
    const service = new HealthService(profileService, fetchMock);
    const id = "11111111-1111-4111-8111-111111111111";

    const models = await service.discoverDraftModels({
      id,
      protocol: "openai-responses",
      baseUrl: SECONDARY_URL,
      endpoints: [{ url: SECONDARY_URL }],
      apiKey: "",
      authMode: "bearer",
    });

    expect(models).toEqual(["gpt-draft"]);
    expect(profileService.getSecret).toHaveBeenCalledWith(id);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${SECONDARY_URL}/models`);
  });

  it("检测全部端点并分别写入可用模型", async () => {
    const { profileStore } = createTestStores(root);
    const profileService = new ProfileService(profileStore, testVault);
    const created = await saveOpenAiProfile(profileService, {
      endpoints: [{ url: PRIMARY_URL }, { url: SECONDARY_URL }],
    });
    const fetchMock = vi.fn(async (requestUrl) => {
      const url = new URL(requestUrl);
      return url.hostname === "relay-a.example"
        ? jsonResponse({ data: [{ id: "gpt-primary" }, { id: "gpt-shared" }] })
        : jsonResponse({ data: [{ id: "gpt-secondary" }] });
    });
    const healthService = new HealthService(profileService, fetchMock);

    const checked = await healthService.test(created.id);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(checked.model).toBe("gpt-primary");
    expect(checked.availableModels).toEqual(["gpt-primary", "gpt-shared"]);
    expect(checked.endpoints).toEqual([
      expect.objectContaining({
        url: PRIMARY_URL,
        models: ["gpt-primary", "gpt-shared"],
        health: expect.objectContaining({ status: "healthy", statusCode: 200 }),
      }),
      expect.objectContaining({
        url: SECONDARY_URL,
        models: ["gpt-secondary"],
        health: expect.objectContaining({ status: "healthy", statusCode: 200 }),
      }),
    ]);

    const persisted = await profileStore.read();
    expect(persisted.profiles[0].endpoints.map(({ url, models }) => ({ url, models }))).toEqual([
      { url: PRIMARY_URL, models: ["gpt-primary", "gpt-shared"] },
      { url: SECONDARY_URL, models: ["gpt-secondary"] },
    ]);
  });

  it("活动端点失败且模型为空时采用最快健康端点的模型", async () => {
    const { profileStore } = createTestStores(root);
    const profileService = new ProfileService(profileStore, testVault);
    const created = await saveOpenAiProfile(profileService, {
      endpoints: [{ url: PRIMARY_URL }, { url: SECONDARY_URL }],
    });
    const fetchMock = vi.fn(async (requestUrl) => (
      new URL(requestUrl).hostname === "relay-a.example"
        ? new Response("", { status: 503 })
        : jsonResponse({ data: [{ id: "gpt-backup" }] })
    ));
    const healthService = new HealthService(profileService, fetchMock);

    const checked = await healthService.test(created.id);

    expect(checked.model).toBe("gpt-backup");
    expect(checked.baseUrl).toBe(PRIMARY_URL);
    expect(checked.health.status).toBe("unhealthy");
  });

  it("检测期间 connectionRevision 变化时拒绝旧结果", async () => {
    const { profileStore } = createTestStores(root);
    const profileService = new ProfileService(profileStore, testVault);
    const created = await saveOpenAiProfile(profileService);
    const initialRevision = (await profileService.getStored(created.id)).connectionRevision;
    let releaseFetch;
    let markFetchStarted;
    const fetchStarted = new Promise((resolve) => {
      markFetchStarted = resolve;
    });
    const fetchMock = vi.fn(() => {
      markFetchStarted();
      return new Promise((resolve) => {
        releaseFetch = resolve;
      });
    });
    const healthService = new HealthService(profileService, fetchMock);

    const pendingCheck = healthService.test(created.id);
    await fetchStarted;
    await saveOpenAiProfile(profileService, {
      id: created.id,
      apiKey: "sk-replaced-health-secret",
    });
    const rejection = expect(pendingCheck).rejects.toThrow(
      "Profile connection changed while endpoints were being tested",
    );
    releaseFetch(jsonResponse({ data: [{ id: "stale-model" }] }));
    await rejection;

    const persisted = await profileStore.read();
    expect(persisted.profiles[0].connectionRevision).toBe(initialRevision + 1);
    expect(persisted.profiles[0].endpoints[0].models).toEqual([]);
    expect(persisted.profiles[0].modelsCheckedAt).toBeUndefined();
  });

  it("外层检查通过后停止仍会在提交事务内拒绝旧结果", async () => {
    const { profileStore } = createTestStores(root);
    const profileService = new ProfileService(profileStore, testVault);
    const created = await saveOpenAiProfile(profileService);
    const controller = new AbortController();
    const originalRead = profileStore.read.bind(profileStore);
    let readCount = 0;
    vi.spyOn(profileStore, "read").mockImplementation(async () => {
      const data = await originalRead();
      readCount += 1;
      if (readCount === 2) {
        controller.abort();
      }
      return data;
    });
    const commitSpy = vi.spyOn(profileService, "commitEndpointResults");
    const healthService = new HealthService(
      profileService,
      vi.fn(async () => jsonResponse({ data: [{ id: "stopped-model" }] })),
    );

    await expect(healthService.test(created.id, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
      message: "Endpoint test was stopped",
    });

    expect(commitSpy).toHaveBeenCalledOnce();
    expect(commitSpy.mock.calls[0][3]).toEqual({ signal: controller.signal });
    expect(readCount).toBe(2);
    const persisted = await originalRead();
    expect(persisted.profiles[0].endpoints[0].models).toEqual([]);
    expect(persisted.profiles[0].endpoints[0].health).toBeUndefined();
    expect(persisted.profiles[0].modelsCheckedAt).toBeUndefined();
  });
});

describe("渠道实测", () => {
  function probeService(profile, fetchMock) {
    const profileService = {
      getConnection: async () => ({ profile, apiKey: API_KEY }),
    };
    return new HealthService(profileService, fetchMock);
  }

  const baseProfile = {
    protocol: "anthropic",
    authMode: "api-key",
    baseUrl: PRIMARY_URL,
    model: "claude-sonnet-4-5",
    endpoints: [{ url: PRIMARY_URL, models: [] }],
  };

  it("Anthropic 实测按客户端方式拼接路径并使用 x-api-key", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      id: "msg_1",
      usage: { input_tokens: 9, output_tokens: 12 },
    }, { status: 200 }));
    const service = probeService(baseProfile, fetchMock);
    const result = await service.probeProfile("11111111-1111-4111-8111-111111111111");

    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.model).toBe("claude-sonnet-4-5");
    expect(result.totalMs).toBeGreaterThanOrEqual(result.firstByteMs);
    expect(result.tokenUsage).toEqual({ inputTokens: 9, outputTokens: 12, totalTokens: 21 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${PRIMARY_URL}/v1/messages`);
    expect(init.headers["x-api-key"]).toBe(API_KEY);
    expect(init.headers["anthropic-version"]).toBeDefined();
    const body = JSON.parse(init.body);
    expect(body.messages[0].content).toBe("hi");
    expect(body.max_tokens).toBe(16);
  });

  it("允许为单次实测覆盖模型且不改方案默认值", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "msg_1" }, { status: 200 }));
    const service = probeService(baseProfile, fetchMock);
    const result = await service.probeProfile(
      "11111111-1111-4111-8111-111111111111",
      "claude-haiku-4-5",
    );

    expect(result.model).toBe("claude-haiku-4-5");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe("claude-haiku-4-5");
    expect(baseProfile.model).toBe("claude-sonnet-4-5");
  });

  it("Responses 实测命中 /responses 且失败时提取上游错误", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(
      { error: { message: "Invalid API key provided" } },
      { status: 401 },
    ));
    const service = probeService({
      ...baseProfile,
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: `${PRIMARY_URL}/v1`,
      model: "gpt-5-codex",
    }, fetchMock);
    const result = await service.probeProfile("11111111-1111-4111-8111-111111111111");

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(401);
    expect(result.message).toBe("Invalid API key provided");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${PRIMARY_URL}/v1/responses`);
    expect(init.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(init.body)).toMatchObject({
      input: "hi",
      instructions: "Reply with OK.",
    });
  });

  it("未设置模型时拒绝实测", async () => {
    const service = probeService({ ...baseProfile, model: "" }, vi.fn());
    await expect(service.probeProfile("11111111-1111-4111-8111-111111111111"))
      .rejects.toThrow("请先设置模型 ID 或识别模型后再实测");
  });
});
