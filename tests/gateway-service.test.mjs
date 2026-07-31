import http from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  ANTHROPIC_COUNT_BODY_LIMIT_BYTES,
  ANTHROPIC_COUNT_BODY_SLOTS,
  GatewayService,
  GatewayStoreSchema,
  conservativeAnthropicInputTokens,
  createRequestMetadataTap,
  defaultGatewayStore,
} = require("../electron/services/gateway-service.cjs");
const { RequestMonitorService } = require("../electron/services/request-monitor-service.cjs");

it("请求元数据 Tap 透明转发且只发布允许字段", async () => {
  const metadata = [];
  const tap = createRequestMetadataTap((patch) => metadata.push(patch));
  const chunks = [];
  tap.on("data", (chunk) => chunks.push(chunk));
  const ended = once(tap, "end");
  const body = JSON.stringify({
    model: "gpt-5.2-codex",
    stream: true,
    reasoning: { effort: "high" },
    input: [{ role: "user", content: "private prompt" }],
  });
  tap.end(body);
  await ended;
  expect(Buffer.concat(chunks).toString("utf8")).toBe(body);
  expect(metadata).toEqual(expect.arrayContaining([
    { model: "gpt-5.2-codex" },
    { streaming: true },
    { reasoningEffort: "high" },
  ]));
  expect(JSON.stringify(metadata)).not.toContain("private prompt");
});

it("请求元数据 Tap 丢弃超长字段且保持请求字节不变", async () => {
  const metadata = [];
  const tap = createRequestMetadataTap((patch) => metadata.push(patch));
  const chunks = [];
  tap.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const ended = once(tap, "end");
  const body = Buffer.from(JSON.stringify({
    model: "m".repeat(20_000),
    reasoning: { effort: "e".repeat(2_000) },
    input: "private-body",
  }), "utf8");
  tap.end(body);
  await ended;

  expect(Buffer.concat(chunks)).toEqual(body);
  expect(metadata).toEqual([]);
});

it("Anthropic 本地计数对英文、中文和工具定义保守估算且拒绝媒体输入", () => {
  const englishText = "The quick brown fox jumps over the lazy dog. ".repeat(20);
  const englishBody = Buffer.from(JSON.stringify({
    model: "claude-test",
    messages: [{ role: "user", content: englishText }],
  }), "utf8");
  const chineseText = "修复网关令牌统计问题，保持上下文准确。".repeat(20);
  const chineseBody = Buffer.from(JSON.stringify({
    model: "claude-test",
    messages: [{ role: "user", content: chineseText }],
  }), "utf8");
  const toolBody = Buffer.from(JSON.stringify({
    model: "claude-test",
    messages: [{ role: "user", content: "hi" }],
    tools: [{
      name: "read_file",
      description: "Read a UTF-8 file from disk",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
      },
    }],
  }), "utf8");
  const noToolBody = Buffer.from(JSON.stringify({
    model: "claude-test",
    messages: [{ role: "user", content: "hi" }],
  }), "utf8");

  const english = conservativeAnthropicInputTokens(englishBody);
  const chinese = conservativeAnthropicInputTokens(chineseBody);
  const tool = conservativeAnthropicInputTokens(toolBody);
  const noTool = conservativeAnthropicInputTokens(noToolBody);
  expect(english).toBeGreaterThan(Math.ceil(Buffer.byteLength(englishText, "utf8") / 3));
  expect(english).toBeLessThan(englishBody.length);
  expect(chinese).toBeGreaterThan([...chineseText].length);
  expect(tool).toBeGreaterThan(noTool + 350);
  expect(conservativeAnthropicInputTokens(Buffer.from("not json"))).toBeUndefined();
  expect(conservativeAnthropicInputTokens(Buffer.from(JSON.stringify({
    model: "claude-test",
    messages: [{
      role: "user",
      content: [{ type: "image", source: { type: "base64", data: "AA==" } }],
    }],
  })))).toBeUndefined();
});

const PROFILE_A = "11111111-1111-4111-8111-111111111111";
const PROFILE_B = "22222222-2222-4222-8222-222222222222";
const activeServices = new Set();
const activeServers = new Set();

function memoryStore(initial = defaultGatewayStore()) {
  let value = structuredClone(initial);
  return {
    writes: [],
    async read() {
      return structuredClone(value);
    },
    async write(next) {
      value = GatewayStoreSchema.parse(structuredClone(next));
      this.writes.push(structuredClone(value));
      return structuredClone(value);
    },
    current() {
      return structuredClone(value);
    },
  };
}

const vault = {
  encrypt(value) {
    return Buffer.from(`gateway:${value}`, "utf8").toString("base64");
  },
  decrypt(value) {
    const clear = Buffer.from(value, "base64").toString("utf8");
    if (!clear.startsWith("gateway:")) throw new Error("测试网关密文无效");
    return clear.slice("gateway:".length);
  },
};

function profileService(connections) {
  return {
    async getConnection(id) {
      const connection = connections[id];
      if (!connection) throw new Error("Profile not found");
      return connection;
    },
  };
}

async function listen(handler, requestedPort = 0) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, "127.0.0.1", resolve);
  });
  activeServers.add(server);
  const { port } = server.address();
  return {
    server,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
  };
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => server.close(resolve));
  activeServers.delete(server);
}

function rawRequest(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("aborted", () => reject(new Error("Response aborted")));
      response.once("error", reject);
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        chunks,
        body: Buffer.concat(chunks),
      }));
    });
    request.once("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

function abortUpload(url, headers) {
  return new Promise((resolve) => {
    const request = http.request(url, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/octet-stream",
        "content-length": "1048576",
      },
    });
    request.once("error", resolve);
    request.write(Buffer.alloc(1024, 7));
    request.destroy();
  });
}

function interruptRejectedUpload(url, headers = {}) {
  return new Promise((resolve, reject) => {
    let responseStatus;
    const request = http.request(url, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/octet-stream",
        "content-length": "1048576",
      },
    }, (response) => {
      responseStatus = response.statusCode;
      response.on("error", () => {});
      response.resume();
      request.destroy();
    });
    request.once("error", (error) => {
      if (responseStatus === undefined) reject(error);
    });
    request.once("close", () => resolve(responseStatus));
    request.write(Buffer.alloc(1024, 7));
  });
}

async function createGateway(connections, options = {}) {
  const store = options.store || memoryStore();
  const service = new GatewayService({
    profileService: profileService(connections),
    store,
    vault,
    ...(options.requestMonitor ? { requestMonitor: options.requestMonitor } : {}),
    ...(options.responsesFallbackIdleTimeoutMs
      ? { responsesFallbackIdleTimeoutMs: options.responsesFallbackIdleTimeoutMs }
      : {}),
    ...(options.responsesFallbackTotalTimeoutMs
      ? { responsesFallbackTotalTimeoutMs: options.responsesFallbackTotalTimeoutMs }
      : {}),
  });
  activeServices.add(service);
  if (options.initialize) await service.initialize();
  else await service.start({ port: options.port ?? 0, targets: options.targets || ["codex"] });
  return { service, store };
}

async function localCredential(service, profile, target = "codex", apiKey = "upstream-secret") {
  const prepared = await service.prepareConnection(profile, apiKey, target);
  return prepared.apiKey;
}

afterEach(async () => {
  await Promise.all([...activeServices].map(async (service) => {
    try {
      await service.stopAndWait();
    } catch {
      // 测试清理不能遮蔽原始断言错误。
    }
  }));
  activeServices.clear();
  await Promise.all([...activeServers].map((server) => closeServer(server)));
});

describe("GatewayService", () => {
  it("将旧版或未知版本网关状态归一化为 staged routes 的 v4 结构", () => {
    expect(GatewayStoreSchema.parse({
      version: 0,
      enabled: true,
      port: "invalid",
      routes: [
        { target: "codex", profileId: PROFILE_A },
        { target: "unknown", profileId: PROFILE_B },
      ],
      encryptedToken: "ciphertext",
      legacyField: "ignored",
    })).toEqual({
      version: 4,
      enabled: true,
      port: 17863,
      targets: ["codex"],
      // 老库没有 engaged 字段：当年「开着就全接管」，照此还原
      engaged: ["codex"],
      resumeTargets: ["codex"],
      routes: { codex: PROFILE_A },
      encryptedToken: "ciphertext",
    });
    expect(GatewayStoreSchema.parse({ version: 99, enabled: "yes" }))
      .toEqual(defaultGatewayStore());
  });

  it("迁移时过滤非法 profileId，但保留合法的已删除方案路由", () => {
    expect(GatewayStoreSchema.parse({
      version: 1,
      enabled: true,
      port: 17863,
      targets: ["codex", "claude", "gemini"],
      routes: {
        codex: "not-a-uuid",
        claude: PROFILE_A,
        gemini: "  ",
      },
    })).toEqual({
      version: 4,
      enabled: true,
      port: 17863,
      targets: ["codex", "claude", "gemini"],
      engaged: ["codex", "claude", "gemini"],
      resumeTargets: ["codex", "claude", "gemini"],
      routes: { claude: PROFILE_A },
    });
  });

  it("正常退出可清掉当前接管但保留独立恢复意图，显式停止则清掉意图", async () => {
    const store = memoryStore({
      ...defaultGatewayStore(),
      targets: ["codex"],
      engaged: ["codex"],
      resumeTargets: ["codex"],
      routes: { codex: PROFILE_A },
    });
    const service = new GatewayService({
      profileService: profileService({}),
      store,
      vault,
    });
    await service.initialize({ start: false });

    await service.stop({ preserveResumeIntent: true });
    expect(store.current()).toMatchObject({
      enabled: false,
      engaged: [],
      resumeTargets: ["codex"],
    });

    await service.setEngagedTargets(["codex"]);
    await service.stop();
    expect(store.current().resumeTargets).toEqual([]);
  });

  it("Codex 路径令牌加密持久化并在重启监听后保持不变", async () => {
    const store = memoryStore();
    const service = new GatewayService({
      profileService: profileService({}),
      store,
      vault,
    });
    activeServices.add(service);

    await service.start({ port: 0, targets: ["codex"] });
    const firstUrl = service.getPublicState().localBaseUrls.codex;
    const routeToken = firstUrl.split("/").at(-1);
    expect(routeToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(store.current().encryptedRouteToken).toBeTruthy();
    expect(JSON.stringify(store.current())).not.toContain(routeToken);

    const port = service.getPublicState().port;
    await service.stopAndWait();
    await service.start({ port, targets: ["codex"] });
    expect(service.getPublicState().localBaseUrls.codex).toBe(firstUrl);
  });

  it("initialize 恢复已启用网关时保留 engaged 子集", async () => {
    const reservation = await listen((_request, response) => response.end());
    const restoredPort = reservation.port;
    await closeServer(reservation.server);
    const profileA = {
      id: PROFILE_A,
      name: "Codex route",
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: "http://127.0.0.1:1",
      targets: ["codex"],
    };
    const profileB = {
      id: PROFILE_B,
      name: "Claude route",
      protocol: "anthropic",
      authMode: "bearer",
      baseUrl: "http://127.0.0.1:2",
      targets: ["claude"],
    };
    const store = memoryStore({
      version: 3,
      enabled: true,
      port: restoredPort,
      targets: ["codex", "claude"],
      engaged: ["codex"],
      routes: { codex: PROFILE_A, claude: PROFILE_B },
    });

    const { service } = await createGateway({
      [PROFILE_A]: { profile: profileA, apiKey: "key-a" },
      [PROFILE_B]: { profile: profileB, apiKey: "key-b" },
    }, { store, initialize: true });

    expect(service.getPublicState().engaged).toEqual(["codex"]);
    expect(service.isTargetEnabled("codex")).toBe(true);
    expect(service.isTargetEnabled("claude")).toBe(false);
    expect([...service.connectionCache.keys()]).toEqual([PROFILE_A]);
  });

  it("停止状态可预先分配路由并验证方案密钥，不启动监听器", async () => {
    const profile = {
      id: PROFILE_A,
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: "https://relay.example/v1",
      targets: ["codex"],
    };
    const getConnection = vi.fn().mockResolvedValue({ profile, apiKey: "upstream-key" });
    const store = memoryStore();
    const service = new GatewayService({
      profileService: { getConnection },
      store,
      vault,
    });
    activeServices.add(service);

    const previous = await service.assignRoutes(profile.id, ["codex"]);

    expect(previous).toEqual({
      targets: [],
      engaged: [],
      resumeTargets: [],
      routes: {},
    });
    expect(getConnection).toHaveBeenCalledWith(PROFILE_A);
    expect(service.getPublicState()).toMatchObject({
      status: "stopped",
      targets: ["codex"],
      routes: [{ target: "codex", profileId: PROFILE_A }],
    });
    expect(service.server).toBeUndefined();
    expect(service.connectionCache.size).toBe(0);
  });

  it("路由激活后复用内存连接快照，不在每个请求上读取和解密存储", async () => {
    const upstream = await listen((_request, response) => response.end("ok"));
    const profile = {
      id: PROFILE_A,
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: `${upstream.baseUrl}/v1`,
      targets: ["codex"],
    };
    const getConnection = vi.fn().mockResolvedValue({ profile, apiKey: "upstream-key" });
    const service = new GatewayService({
      profileService: { getConnection },
      store: memoryStore(),
      vault,
    });
    activeServices.add(service);
    await service.start({ port: 0, targets: ["codex"] });
    const prepared = await service.prepareConnection(profile, "upstream-key", "codex");
    await service.activateRoutes(profile, ["codex"]);
    const url = `${service.getPublicState().localBaseUrls.codex}/responses`;
    const headers = { authorization: `Bearer ${prepared.apiKey}` };

    expect((await rawRequest(url, { headers })).status).toBe(200);
    expect((await rawRequest(url, { headers })).status).toBe(200);
    expect(getConnection).toHaveBeenCalledTimes(1);
  });

  it("Codex 只接受持久路径令牌且忽略入站认证头", async () => {
    let upstreamCalls = 0;
    const upstream = await listen((_request, response) => {
      upstreamCalls += 1;
      response.end("unexpected");
    });
    const profile = {
      id: PROFILE_A,
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: `${upstream.baseUrl}/v1`,
      targets: ["codex"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "real-upstream-key" },
    });
    await service.activateRoutes(profile, ["codex"]);
    const state = service.getPublicState();
    const baseUrl = state.localBaseUrls.codex;
    const wrongBaseUrl = baseUrl.replace(/[^/]+$/, "wrong-route-token");

    expect((await rawRequest(`${wrongBaseUrl}/responses`)).status).toBe(401);
    expect((await rawRequest(`${wrongBaseUrl}/responses`, {
      headers: { authorization: "Bearer wrong-token" },
    })).status).toBe(401);
    expect((await rawRequest(`${baseUrl}/responses`, {
      headers: { authorization: "Bearer unrelated-codex-auth" },
    })).status).toBe(200);
    expect(upstreamCalls).toBe(1);
    expect(JSON.stringify(state)).not.toContain("real-upstream-key");
    expect(JSON.stringify(state)).not.toContain("encryptedToken");
    expect(JSON.stringify(state)).not.toContain("gateway:");
  });

  it("合并基础路径和查询参数，并移除入站凭据后按方案注入真实凭据", async () => {
    let received;
    const upstream = await listen((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        received = {
          url: request.url,
          headers: request.headers,
          body: Buffer.concat(chunks),
        };
        response.writeHead(201, { "content-type": "application/octet-stream" });
        response.end(Buffer.from([9, 8, 7]));
      });
    });
    const profile = {
      id: PROFILE_A,
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: `${upstream.baseUrl}/tenant/v1?region=cn`,
      targets: ["codex"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "upstream-secret" },
    });
    await service.activateRoutes(profile);
    const localToken = await localCredential(service, profile);
    const payload = Buffer.from([0, 255, 1, 2, 128, 10]);
    const response = await rawRequest(
      `${service.getPublicState().localBaseUrls.codex}/responses?key=${encodeURIComponent(localToken)}&stream=true`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer should-be-removed",
          "x-api-key": "also-remove",
          "x-goog-api-key": "remove-too",
          "content-type": "application/octet-stream",
          "content-length": String(payload.length),
        },
        body: payload,
      },
    );

    expect(response.status).toBe(201);
    expect(response.body).toEqual(Buffer.from([9, 8, 7]));
    expect(received.url).toBe("/tenant/v1/responses?region=cn&stream=true");
    expect(received.body).toEqual(payload);
    expect(received.headers.authorization).toBe("Bearer upstream-secret");
    expect(received.headers["x-api-key"]).toBeUndefined();
    expect(received.headers["x-goog-api-key"]).toBeUndefined();
  });

  it("保持二进制内容并逐块转发 SSE，不解析或重编码响应", async () => {
    const binary = Buffer.from(Array.from({ length: 256 }, (_value, index) => index));
    const sseChunks = [
      Buffer.from("event: message\ndata: {\"delta\":\"你\"}\n\n", "utf8"),
      Buffer.from("data: [DONE]\n\n", "utf8"),
    ];
    const upstream = await listen((request, response) => {
      if (request.url.endsWith("/binary")) {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(binary);
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      response.write(sseChunks[0]);
      setTimeout(() => response.end(sseChunks[1]), 25);
    });
    const profile = {
      id: PROFILE_A,
      protocol: "anthropic",
      authMode: "api-key",
      baseUrl: `${upstream.baseUrl}/api`,
      targets: ["codex"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "anthropic-secret" },
    });
    await service.activateRoutes(profile);
    const token = await localCredential(service, profile, "codex", "anthropic-secret");
    const baseUrl = service.getPublicState().localBaseUrls.codex;
    const headers = { "x-api-key": token };

    const binaryResponse = await rawRequest(`${baseUrl}/binary`, { headers });
    const sseResponse = await rawRequest(`${baseUrl}/events`, { headers });
    expect(binaryResponse.body).toEqual(binary);
    expect(sseResponse.body).toEqual(Buffer.concat(sseChunks));
    expect(sseResponse.chunks.length).toBeGreaterThanOrEqual(2);
    expect(sseResponse.chunks[0]).toEqual(sseChunks[0]);
  });

  it("Responses 同步请求从第一次起就改走流式并还原 JSON", async () => {
    let upstreamCalls = 0;
    const receivedBodies = [];
    const upstream = await listen((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = Buffer.concat(chunks);
        receivedBodies.push(JSON.parse(body.toString("utf8")));
        upstreamCalls += 1;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          "event: response.output_text.delta\n",
          'data: {"type":"response.output_text.delta","delta":"ok"}\n\n',
          "event: response.completed\n",
          'data: {"type":"response.completed","response":{"id":"resp_1","output":[],"usage":{"input_tokens":2,"output_tokens":1}}}\n\n',
          "data: [DONE]\n\n",
        ].join(""));
      });
    });
    const profile = {
      id: PROFILE_A,
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: `${upstream.baseUrl}/v1`,
      targets: ["codex"],
    };
    const monitor = new RequestMonitorService();
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "upstream-secret" },
    }, { requestMonitor: monitor });
    await service.activateRoutes(profile);
    const url = `${service.getPublicState().localBaseUrls.codex}/responses`;
    const body = Buffer.from(JSON.stringify({
      model: "gpt-5.6-sol",
      stream: false,
      input: [{ role: "user", content: "hello" }],
    }), "utf8");
    const options = {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(body.length) },
      body,
    };

    const first = await rawRequest(url, options);
    const second = await rawRequest(url, options);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(JSON.parse(first.body.toString("utf8"))).toMatchObject({ id: "resp_1" });
    expect(JSON.parse(second.body.toString("utf8"))).toMatchObject({ id: "resp_1" });
    expect(receivedBodies).toHaveLength(2);
    expect(receivedBodies.map((item) => item.stream)).toEqual([true, true]);
    expect(monitor.list().map((entry) => [entry.statusCode, entry.streaming, entry.outcome]))
      .toEqual([[200, true, "completed"], [200, true, "completed"]]);
    expect(monitor.list().every((entry) => Number.isFinite(entry.firstTokenLatencyMs))).toBe(true);
  });

  it("重启后从最近的同步 502 历史恢复流式兼容能力", async () => {
    const now = Date.now();
    let upstreamCalls = 0;
    const upstream = await listen((request, response) => {
      upstreamCalls += 1;
      const chunks = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        expect(JSON.parse(Buffer.concat(chunks).toString("utf8")).stream).toBe(true);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          "event: response.completed\n",
          'data: {"type":"response.completed","response":{"id":"resp_history","output":[]}}\n\n',
        ].join(""));
      });
    });
    const monitor = new RequestMonitorService({ now: () => now });
    const historyId = monitor.start({
      client: "codex",
      profileId: PROFILE_A,
      profileName: "Lucen",
      upstreamUrl: `${upstream.baseUrl}/v1/responses`,
      protocol: "openai-responses",
    });
    monitor.responseStarted(historyId, { statusCode: 502, contentType: "application/json" });
    monitor.observeChunk(historyId, Buffer.from('{"error":{"type":"upstream_error"}}'));
    monitor.end(historyId, { outcome: "failed" });
    const profile = {
      id: PROFILE_A,
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: `${upstream.baseUrl}/v1`,
      targets: ["codex"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "upstream-secret" },
    }, { requestMonitor: monitor });
    await service.activateRoutes(profile);
    const body = Buffer.from(JSON.stringify({ model: "gpt-5.6-sol", stream: false }), "utf8");
    const result = await rawRequest(`${service.getPublicState().localBaseUrls.codex}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(body.length) },
      body,
    });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body.toString("utf8")).id).toBe("resp_history");
    expect(upstreamCalls).toBe(1);
  });

  it("Responses 把显式或省略 stream 的同步请求都默认改为流式并还原 JSON", async () => {
    let upstreamCalls = 0;
    const receivedBodies = [];
    const upstream = await listen((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        receivedBodies.push(body);
        upstreamCalls += 1;
        if (body.stream !== true) {
          response.writeHead(502, { "content-type": "application/json" });
          response.end(JSON.stringify({
            error: { message: "sync unavailable", type: "upstream_error" },
          }));
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          "event: response.completed\n",
          'data: {"type":"response.completed","response":{"id":"resp_omitted","output":[]}}\n\n',
          "data: [DONE]\n\n",
        ].join(""));
      });
    });
    const profile = {
      id: PROFILE_A,
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: `${upstream.baseUrl}/v1`,
      targets: ["codex"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "upstream-secret" },
    });
    await service.activateRoutes(profile);
    const url = `${service.getPublicState().localBaseUrls.codex}/responses`;
    const firstBody = Buffer.from(JSON.stringify({
      model: "gpt-5.6-sol",
      stream: false,
      input: "hello",
    }), "utf8");
    const secondBody = Buffer.from(JSON.stringify({
      model: "gpt-5.6-sol",
      input: "hello",
    }), "utf8");

    const first = await rawRequest(url, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(firstBody.length) },
      body: firstBody,
    });
    const second = await rawRequest(url, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(secondBody.length) },
      body: secondBody,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(JSON.parse(first.body.toString("utf8"))).toMatchObject({ id: "resp_omitted" });
    expect(JSON.parse(second.body.toString("utf8"))).toMatchObject({ id: "resp_omitted" });
    expect(receivedBodies).toHaveLength(2);
    expect(receivedBodies.map((item) => item.stream)).toEqual([true, true]);
    expect(upstreamCalls).toBe(2);
  });

  it("Responses 默认流式不依赖失败缓存或同步探测", async () => {
    let upstreamCalls = 0;
    const receivedBodies = [];
    const upstream = await listen((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        receivedBodies.push(body);
        upstreamCalls += 1;
        if (body.stream !== true) {
          response.writeHead(409, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { type: "unexpected_sync_request" } }));
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          "event: response.completed\n",
          'data: {"type":"response.completed","response":{"id":"resp_default_stream","output":[]}}\n\n',
          "data: [DONE]\n\n",
        ].join(""));
      });
    });
    const profile = {
      id: PROFILE_A,
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: `${upstream.baseUrl}/v1`,
      targets: ["codex"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "upstream-secret" },
    });
    await service.activateRoutes(profile);
    const url = `${service.getPublicState().localBaseUrls.codex}/responses`;
    const body = Buffer.from(JSON.stringify({
      model: "gpt-5.6-sol",
      stream: false,
      input: "hello",
    }), "utf8");
    const options = {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(body.length) },
      body,
    };

    const first = await rawRequest(url, options);
    const second = await rawRequest(url, options);
    const third = await rawRequest(url, options);

    expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
    expect(JSON.parse(third.body.toString("utf8"))).toMatchObject({ id: "resp_default_stream" });
    expect(receivedBodies.map((item) => item.stream)).toEqual([true, true, true]);
  });

  it("Responses 默认流式会从第一次起协商 text/event-stream", async () => {
    let upstreamCalls = 0;
    const receivedHeaders = [];
    const receivedBodies = [];
    const upstream = await listen((request, response) => {
      const chunks = [];
      receivedHeaders.push(request.headers);
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        receivedBodies.push(body);
        upstreamCalls += 1;
        if (body.stream !== true
          || !String(request.headers.accept || "").toLowerCase().includes("text/event-stream")) {
          response.writeHead(406, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { type: "stream_accept_required" } }));
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          "event: response.completed\n",
          'data: {"type":"response.completed","response":{"id":"resp_accept","output":[]}}\n\n',
          "data: [DONE]\n\n",
        ].join(""));
      });
    });
    const profile = {
      id: PROFILE_A,
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: `${upstream.baseUrl}/v1`,
      targets: ["codex"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "upstream-secret" },
    });
    await service.activateRoutes(profile);
    const url = `${service.getPublicState().localBaseUrls.codex}/responses`;
    const body = Buffer.from(JSON.stringify({
      model: "gpt-5.6-sol",
      stream: false,
      input: "hello",
    }), "utf8");
    const options = {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "content-length": String(body.length),
      },
      body,
    };

    const first = await rawRequest(url, options);
    const second = await rawRequest(url, options);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(JSON.parse(first.body.toString("utf8"))).toMatchObject({ id: "resp_accept" });
    expect(JSON.parse(second.body.toString("utf8"))).toMatchObject({ id: "resp_accept" });
    expect(receivedBodies.map((item) => item.stream)).toEqual([true, true]);
    expect(receivedHeaders[0].accept).toContain("text/event-stream");
    expect(receivedHeaders[1].accept).toContain("text/event-stream");
  });

  it("Responses 并发同步请求全部直接走流式，不发送 stream=false 探测", async () => {
    const receivedBodies = [];
    const upstream = await listen((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        receivedBodies.push(body);
        if (body.stream !== true) {
          response.writeHead(502, { "content-type": "application/json" });
          response.end(JSON.stringify({
            error: { message: "unexpected sync request", type: "upstream_error" },
          }));
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          "event: response.completed\n",
          'data: {"type":"response.completed","response":{"id":"resp_concurrent","output":[]}}\n\n',
          "data: [DONE]\n\n",
        ].join(""));
      });
    });
    const profile = {
      id: PROFILE_A,
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: `${upstream.baseUrl}/v1`,
      targets: ["codex"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "upstream-secret" },
    });
    await service.activateRoutes(profile);
    const url = `${service.getPublicState().localBaseUrls.codex}/responses`;
    const body = Buffer.from(JSON.stringify({
      model: "gpt-5.6-sol",
      stream: false,
      input: "hello",
    }), "utf8");
    const options = {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(body.length) },
      body,
    };

    const results = await Promise.all([
      rawRequest(url, options),
      rawRequest(url, options),
      rawRequest(url, options),
    ]);

    expect(results.map((result) => result.status)).toEqual([200, 200, 200]);
    expect(receivedBodies.filter((item) => item.stream === false)).toHaveLength(0);
    expect(receivedBodies.filter((item) => item.stream === true)).toHaveLength(3);
  });

  it("Responses 默认流式仍能透传返回 JSON 的兼容上游", async () => {
    let requestCount = 0;
    const upstream = await listen((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        expect(body.stream).toBe(true);
        requestCount += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: `resp_json_${requestCount}`, output: [] }));
      });
    });
    const profile = {
      id: PROFILE_A,
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: `${upstream.baseUrl}/v1`,
      targets: ["codex"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "upstream-secret" },
    });
    await service.activateRoutes(profile);
    const url = `${service.getPublicState().localBaseUrls.codex}/responses`;
    const body = Buffer.from(JSON.stringify({ model: "gpt-5.6-sol", stream: false }), "utf8");
    const options = {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(body.length) },
      body,
    };

    const results = await Promise.all([
      rawRequest(url, options),
      rawRequest(url, options),
      rawRequest(url, options),
    ]);

    expect(results.map((result) => result.status)).toEqual([200, 200, 200]);
    expect(results.map((result) => JSON.parse(result.body.toString("utf8")).id).sort())
      .toEqual(["resp_json_1", "resp_json_2", "resp_json_3"]);
    expect(requestCount).toBe(3);
  });

  it("Responses 默认流式的 SSE 空闲超时会结束请求并清除能力缓存", async () => {
    let upstreamCalls = 0;
    const upstream = await listen((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        upstreamCalls += 1;
        if (body.stream !== true) {
          response.writeHead(502, { "content-type": "application/json" });
          response.end('{"error":{"type":"upstream_error"}}');
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(": waiting\n\n");
      });
      request.once("close", () => {
        if (!response.writableEnded) response.destroy();
      });
    });
    const profile = {
      id: PROFILE_A,
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: `${upstream.baseUrl}/v1`,
      targets: ["codex"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "upstream-secret" },
    }, {
      responsesFallbackIdleTimeoutMs: 50,
      responsesFallbackTotalTimeoutMs: 1_000,
    });
    await service.activateRoutes(profile);
    const url = `${service.getPublicState().localBaseUrls.codex}/responses`;
    const body = Buffer.from(JSON.stringify({ model: "gpt-5.6-sol", stream: false }), "utf8");
    const options = {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(body.length) },
      body,
    };

    const timedOut = await Promise.race([
      rawRequest(url, options),
      new Promise((_resolve, reject) => setTimeout(
        () => reject(new Error("fallback SSE idle timeout did not fire")),
        1_000,
      )),
    ]);

    expect(timedOut.status).toBe(502);
    expect(timedOut.body.toString("utf8")).toContain("compatibility conversion failed");
    expect(upstreamCalls).toBe(1);
  });

  it("Anthropic count_tokens 明确不受支持时返回保守计数并缓存端点能力", async () => {
    let upstreamCalls = 0;
    let received;
    const upstream = await listen((request, response) => {
      upstreamCalls += 1;
      const chunks = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        received = {
          url: request.url,
          headers: request.headers,
          body: Buffer.concat(chunks),
        };
        response.writeHead(501, { "content-type": "application/json" });
        response.end('{"type":"error","error":{"type":"not_supported"}}');
      });
    });
    const profile = {
      id: PROFILE_A,
      name: "Anthropic relay",
      protocol: "anthropic",
      authMode: "api-key",
      baseUrl: upstream.baseUrl,
      targets: ["claude"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "real-anthropic-key" },
    }, { targets: ["claude"] });
    await service.activateRoutes(profile, ["claude"]);
    const token = await localCredential(service, profile, "claude");
    const payload = Buffer.from(JSON.stringify({
      model: "claude-test",
      messages: [{ role: "user", content: "Count this tool definition" }],
      tools: [{
        name: "read_file",
        description: "Read one file",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      }],
    }), "utf8");
    const url = `${service.getPublicState().localBaseUrls.claude}/v1/messages/count_tokens?beta=true`;
    const options = {
      method: "POST",
      headers: {
        "x-api-key": token,
        "content-type": "application/json",
        "content-length": String(payload.length),
      },
      body: payload,
    };

    const first = await rawRequest(url, options);
    const second = await rawRequest(url, options);
    expect(first.status).toBe(200);
    expect(first.headers["x-agentgate-token-count"]).toBe("conservative-estimate");
    expect(JSON.parse(first.body.toString("utf8"))).toEqual({
      input_tokens: conservativeAnthropicInputTokens(payload),
    });
    expect(second.status).toBe(200);
    expect(upstreamCalls).toBe(1);
    expect(received.url).toBe("/v1/messages/count_tokens?beta=true");
    expect(received.headers["x-api-key"]).toBe("real-anthropic-key");
    expect(received.body).toEqual(payload);
  });

  it("Anthropic count_tokens 独立限制单请求和并发缓冲预算", async () => {
    expect(ANTHROPIC_COUNT_BODY_LIMIT_BYTES).toBe(16 * 1024 * 1024);
    expect(ANTHROPIC_COUNT_BODY_LIMIT_BYTES * ANTHROPIC_COUNT_BODY_SLOTS)
      .toBe(32 * 1024 * 1024);

    let upstreamCalls = 0;
    const upstream = await listen((request, response) => {
      upstreamCalls += 1;
      request.resume();
      request.once("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"input_tokens":12}');
      });
    });
    const profile = {
      id: PROFILE_A,
      protocol: "anthropic",
      authMode: "api-key",
      baseUrl: upstream.baseUrl,
      targets: ["claude"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "real-key" },
    }, { targets: ["claude"] });
    await service.activateRoutes(profile, ["claude"]);
    const token = await localCredential(service, profile, "claude");
    const body = Buffer.from(JSON.stringify({
      model: "claude-test",
      messages: [{ role: "user", content: "hello" }],
    }));
    const url = `${service.getPublicState().localBaseUrls.claude}/v1/messages/count_tokens`;
    const options = {
      method: "POST",
      headers: { "x-api-key": token, "content-type": "application/json" },
      body,
    };

    const releases = Array.from(
      { length: ANTHROPIC_COUNT_BODY_SLOTS },
      () => service._tryAcquireAnthropicCountBody(),
    );
    expect(releases.every((release) => typeof release === "function")).toBe(true);
    expect(service._tryAcquireAnthropicCountBody()).toBeUndefined();

    const saturated = await rawRequest(url, options);
    expect(saturated.status).toBe(503);
    expect(saturated.body.toString("utf8")).toContain("capacity is temporarily full");
    expect(upstreamCalls).toBe(0);

    releases.shift()();
    const forwarded = await rawRequest(url, options);
    expect(forwarded.status).toBe(200);
    expect(JSON.parse(forwarded.body.toString("utf8"))).toEqual({ input_tokens: 12 });
    expect(upstreamCalls).toBe(1);

    for (const release of releases) release();
    expect(service.anthropicCountBodyActive).toBe(0);
  });

  it("Anthropic count_tokens 原样透传临时故障、路由、鉴权和限流错误", async () => {
    let status = 503;
    let upstreamCalls = 0;
    const upstream = await listen((request, response) => {
      upstreamCalls += 1;
      request.resume();
      request.once("end", () => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { type: `status_${status}` } }));
      });
    });
    const profile = {
      id: PROFILE_A,
      protocol: "anthropic",
      authMode: "api-key",
      baseUrl: upstream.baseUrl,
      targets: ["claude"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "real-key" },
    }, { targets: ["claude"] });
    await service.activateRoutes(profile, ["claude"]);
    const token = await localCredential(service, profile, "claude");
    const payload = Buffer.from(JSON.stringify({
      model: "claude-test",
      messages: [{ role: "user", content: "hello" }],
    }));
    const url = `${service.getPublicState().localBaseUrls.claude}/v1/messages/count_tokens`;
    const options = {
      method: "POST",
      headers: { "x-api-key": token, "content-type": "application/json" },
      body: payload,
    };

    const failureStatuses = [503, 503, 503, 503, 404, 405, 401, 403, 429, 500];
    for (const failureStatus of failureStatuses) {
      status = failureStatus;
      const result = await rawRequest(url, options);
      expect(result.status).toBe(failureStatus);
      expect(JSON.parse(result.body.toString("utf8"))).toEqual({
        error: { type: `status_${failureStatus}` },
      });
    }
    expect(upstreamCalls).toBe(failureStatuses.length);
    expect(service.anthropicCountFallbacks.size).toBe(0);
  });

  it("Anthropic count_tokens 不把通用 upstream_error 400 视为不支持", async () => {
    let upstreamError = true;
    let upstreamCalls = 0;
    const upstream = await listen((request, response) => {
      upstreamCalls += 1;
      request.resume();
      request.once("end", () => {
        const body = upstreamError
          ? '{"error":{"message":"Upstream request failed","type":"upstream_error"},"type":"error"}'
          : '{"error":{"message":"invalid model","type":"invalid_request_error"},"type":"error"}';
        response.writeHead(400, {
          "content-type": "application/json; charset=utf-8",
          "content-length": String(Buffer.byteLength(body)),
        });
        response.end(body);
      });
    });
    const profile = {
      id: PROFILE_A,
      protocol: "anthropic",
      authMode: "api-key",
      baseUrl: upstream.baseUrl,
      targets: ["claude"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "real-key" },
    }, { targets: ["claude"] });
    await service.activateRoutes(profile, ["claude"]);
    const token = await localCredential(service, profile, "claude");
    const payload = Buffer.from(JSON.stringify({
      model: "claude-test",
      messages: [{ role: "user", content: "hello" }],
    }));
    const options = {
      method: "POST",
      headers: { "x-api-key": token, "content-type": "application/json" },
      body: payload,
    };
    const url = `${service.getPublicState().localBaseUrls.claude}/v1/messages/count_tokens`;

    const genericError = await rawRequest(url, options);
    expect(genericError.status).toBe(400);
    expect(JSON.parse(genericError.body.toString("utf8"))).toEqual({
      error: { message: "Upstream request failed", type: "upstream_error" },
      type: "error",
    });

    upstreamError = false;
    const invalid = await rawRequest(url, options);
    expect(invalid.status).toBe(400);
    expect(JSON.parse(invalid.body.toString("utf8"))).toEqual({
      error: { message: "invalid model", type: "invalid_request_error" },
      type: "error",
    });
    expect(upstreamCalls).toBe(2);
    expect(service.anthropicCountFallbacks.size).toBe(0);
  });

  it("Anthropic count_tokens 不为媒体输入或其他协议伪造计数", async () => {
    const upstream = await listen((request, response) => {
      request.resume();
      request.once("end", () => {
        response.writeHead(501, { "content-type": "application/json" });
        response.end('{"error":"unsupported"}');
      });
    });
    const mediaProfile = {
      id: PROFILE_A,
      protocol: "anthropic",
      authMode: "api-key",
      baseUrl: upstream.baseUrl,
      targets: ["claude"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile: mediaProfile, apiKey: "real-key" },
    }, { targets: ["claude"] });
    await service.activateRoutes(mediaProfile, ["claude"]);
    const token = await localCredential(service, mediaProfile, "claude");
    const url = `${service.getPublicState().localBaseUrls.claude}/v1/messages/count_tokens`;
    const body = Buffer.from(JSON.stringify({
      model: "claude-test",
      messages: [{
        role: "user",
        content: [{ type: "document", source: { type: "url", url: "https://example.test/a.pdf" } }],
      }],
    }));

    expect((await rawRequest(url, {
      method: "POST",
      headers: { "x-api-key": token, "content-type": "application/json" },
      body,
    })).status).toBe(501);

    mediaProfile.protocol = "openai-chat";
    await service.refreshProfile(mediaProfile.id);
    expect((await rawRequest(url, {
      method: "POST",
      headers: { "x-api-key": token, "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({
        model: "claude-test",
        messages: [{ role: "user", content: "plain text" }],
      })),
    })).status).toBe(501);
  });

  it("转发期间豁免本地 socket 空闲计时，响应收尾后恢复", async () => {
    // 真实事故：推理长静默期间 SSE 上下行都没有字节，五分钟空闲回收
    // 把活跃请求掐断，客户端报 stream disconnected（直连不受影响）。
    let releaseStream;
    const gate = new Promise((resolve) => { releaseStream = resolve; });
    const upstream = await listen(async (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"type":"response.created"}\n\n');
      await gate;
      response.end("data: [DONE]\n\n");
    });
    const profile = {
      id: PROFILE_A,
      name: "Idle",
      protocol: "openai-responses",
      authMode: "api-key",
      baseUrl: upstream.baseUrl,
      targets: ["codex"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "upstream-secret" },
    });
    await service.activateRoutes(profile);
    const token = await localCredential(service, profile);
    const baseUrl = service.getPublicState().localBaseUrls.codex;

    const responsePromise = rawRequest(`${baseUrl}/responses`, {
      headers: { "x-api-key": token },
    });
    // 等首包到达客户端，确认请求已在转发中
    await vi.waitFor(() => {
      expect([...service.sockets].length).toBeGreaterThan(0);
      expect([...service.sockets].some((socket) => socket.timeout === 0)).toBe(true);
    });

    releaseStream();
    const result = await responsePromise;
    expect(result.status).toBe(200);
    expect(result.body.toString("utf8")).toContain("[DONE]");
  });

  it("请求监控覆盖响应生命周期且不接触正文和认证", async () => {
    const monitor = {
      start: vi.fn().mockReturnValue("request-1"),
    responseStarted: vi.fn(),
    observeChunk: vi.fn(),
    updateMetadata: vi.fn(),
      end: vi.fn(),
      list: vi.fn().mockReturnValue([{ id: "request-1" }]),
      clear: vi.fn(),
    };
    const upstream = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"type":"response.output_text.delta","delta":"ok"}\n\n');
    });
    const profile = {
      id: PROFILE_A,
      name: "Monitored",
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: `${upstream.baseUrl}/v1?private=query`,
      targets: ["codex"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "upstream-secret" },
    }, { requestMonitor: monitor });
    await service.activateRoutes(profile);

    const response = await rawRequest(`${service.getPublicState().localBaseUrls.codex}/responses`);
    expect(response.status).toBe(200);
    expect(monitor.start).toHaveBeenCalledWith(expect.objectContaining({
      client: "codex",
      profileId: PROFILE_A,
      profileName: "正在载入方案",
      upstreamUrl: "",
    }));
    expect(monitor.updateMetadata).toHaveBeenCalledWith("request-1", expect.objectContaining({
      profileName: "Monitored",
      upstreamUrl: `${upstream.baseUrl}/v1/responses`,
      protocol: "openai-responses",
    }));
    expect(JSON.stringify(monitor.start.mock.calls)).not.toContain("upstream-secret");
    expect(JSON.stringify(monitor.start.mock.calls)).not.toContain("private=query");
    expect(monitor.responseStarted).toHaveBeenCalledWith("request-1", expect.objectContaining({
      statusCode: 200,
      streaming: true,
    }));
    expect(monitor.observeChunk).toHaveBeenCalled();
    expect(monitor.end).toHaveBeenCalledWith("request-1");
    expect(service.getActiveRequests()).toEqual([{ id: "request-1" }]);
  });

  it("真实请求监视器串联采集元数据、首字和 usage 且不公开正文或完整 Key", async () => {
    const monitor = new RequestMonitorService();
    let upstreamHeaders;
    const upstream = await listen((request, response) => {
      upstreamHeaders = request.headers;
      request.resume();
      request.once("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          'event: response.output_text.delta\n',
          'data: {"type":"response.output_text.delta","delta":"首"}\n\n',
          'event: response.completed\n',
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":5,"total_tokens":17}}}\n\n',
        ].join(""));
      });
    });
    const profile = {
      id: PROFILE_A,
      name: "真实监控",
      keyHint: "•••• 1234",
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: `${upstream.baseUrl}/v1`,
      targets: ["codex"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "upstream-secret" },
    }, { requestMonitor: monitor });
    await service.activateRoutes(profile);
    const response = await rawRequest(`${service.getPublicState().localBaseUrls.codex}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "accept-encoding": "gzip" },
      body: Buffer.from(JSON.stringify({
        model: "gpt-test",
        stream: true,
        reasoning: { effort: "high" },
        input: "private prompt body",
      }), "utf8"),
    });
    expect(response.status).toBe(200);
    expect(upstreamHeaders["accept-encoding"]).toBe("identity");
    const [record] = monitor.list();
    expect(record).toMatchObject({
      profileName: "真实监控",
      keyHint: "•••• 1234",
      model: "gpt-test",
      reasoningEffort: "high",
      firstTokenLatencyMs: expect.any(Number),
      tokenUsage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
      outcome: "completed",
    });
    expect(JSON.stringify(record)).not.toContain("private prompt body");
    expect(JSON.stringify(record)).not.toContain("upstream-secret");
  });

  it("热切换和回滚只替换持久化 profileId 路由", async () => {
    const upstreamA = await listen((_request, response) => response.end("A"));
    const upstreamB = await listen((_request, response) => response.end("B"));
    const profileA = {
      id: PROFILE_A,
      protocol: "openai-chat",
      authMode: "bearer",
      baseUrl: upstreamA.baseUrl,
      targets: ["codex"],
    };
    const profileB = { ...profileA, id: PROFILE_B, baseUrl: upstreamB.baseUrl };
    const { service, store } = await createGateway({
      [PROFILE_A]: { profile: profileA, apiKey: "key-a" },
      [PROFILE_B]: { profile: profileB, apiKey: "key-b" },
    });
    await service.activateRoutes(profileA);
    const token = await localCredential(service, profileA, "codex", "key-a");
    const url = `${service.getPublicState().localBaseUrls.codex}/chat`;
    const headers = { authorization: `Bearer ${token}` };
    expect((await rawRequest(url, { headers })).body.toString()).toBe("A");

    const previousRoutes = await service.activateRoutes(profileB);
    expect((await rawRequest(url, { headers })).body.toString()).toBe("B");
    expect(store.current().routes).toEqual({ codex: PROFILE_B });
    expect(store.current()).not.toHaveProperty("apiKey");

    await service.restoreRoutes(previousRoutes);
    expect((await rawRequest(url, { headers })).body.toString()).toBe("A");
    expect(service.activeTargetsForProfile(PROFILE_A)).toEqual(["codex"]);
    expect(service.getRouteGroups()).toEqual([{ profileId: PROFILE_A, targets: ["codex"] }]);
  });

  it("prepareConnection 在路由激活前不留下明文连接缓存", async () => {
    const profileA = {
      id: PROFILE_A,
      protocol: "openai-chat",
      authMode: "bearer",
      baseUrl: "http://127.0.0.1:1",
      targets: ["codex"],
    };
    const profileB = { ...profileA, id: PROFILE_B };
    const { service } = await createGateway({
      [PROFILE_A]: { profile: profileA, apiKey: "key-a" },
      [PROFILE_B]: { profile: profileB, apiKey: "key-b" },
    });
    await service.prepareConnection(profileA, "key-a", "codex");
    expect(service.connectionCache.size).toBe(0);

    await service.activateRoutes(profileA);
    expect([...service.connectionCache.keys()]).toEqual([PROFILE_A]);

    await service.prepareConnection(profileB, "key-b", "codex");
    expect([...service.connectionCache.keys()]).toEqual([PROFILE_A]);

    await service.activateRoutes(profileB);
    expect([...service.connectionCache.keys()]).toEqual([PROFILE_B]);
  });

  it("未 engaged 的方案不会回填明文缓存，加载竞态结束时再次校验", async () => {
    const profile = {
      id: PROFILE_A,
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: "http://127.0.0.1:1",
      targets: ["codex"],
    };
    let blockConnection = false;
    let releaseConnection;
    let connectionStarted;
    const gate = new Promise((resolve) => { releaseConnection = resolve; });
    const started = new Promise((resolve) => { connectionStarted = resolve; });
    const getConnection = vi.fn(async () => {
      if (blockConnection) {
        connectionStarted();
        await gate;
      }
      return { profile, apiKey: "key-a" };
    });
    const service = new GatewayService({
      profileService: { getConnection },
      store: memoryStore(),
      vault,
    });
    activeServices.add(service);
    await service.start({ port: 0, targets: [] });
    await service.assignRoutes(profile, ["codex"]);
    expect(service.connectionCache.size).toBe(0);

    getConnection.mockClear();
    await service.refreshProfile(PROFILE_A);
    expect(getConnection).not.toHaveBeenCalled();
    await service.setEngagedTargets(["codex"]);
    blockConnection = true;
    const loading = service._connection(PROFILE_A);
    await started;
    await service.setEngagedTargets([]);
    releaseConnection();

    await expect(loading).rejects.toThrow(/route changed/);
    expect(service.connectionCache.size).toBe(0);
  });

  it("运行中放掉一个客户端：保留它的方案分配，但立即驱逐明文连接缓存", async () => {
    const profileA = {
      id: PROFILE_A,
      protocol: "openai-chat",
      authMode: "bearer",
      baseUrl: "http://127.0.0.1:1",
      targets: ["codex"],
    };
    const profileB = {
      ...profileA,
      id: PROFILE_B,
      targets: ["claude"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile: profileA, apiKey: "key-a" },
      [PROFILE_B]: { profile: profileB, apiKey: "key-b" },
    }, { targets: ["codex", "claude"] });
    await service.activateRoutes(profileA, ["codex"]);
    await service.activateRoutes(profileB, ["claude"]);
    expect([...service.connectionCache.keys()].sort()).toEqual([PROFILE_A, PROFILE_B]);

    // 只放掉 claude
    await service.setEngagedTargets(["codex"]);

    // 分配保留：下次一键接管还要用
    expect(service.getPublicState().routes).toEqual([
      { target: "codex", profileId: PROFILE_A },
      { target: "claude", profileId: PROFILE_B },
    ]);
    expect(service.getPublicState().engaged).toEqual(["codex"]);
    // 但明文 Key 不能留在内存里：已经没有被接管的客户端指向 PROFILE_B 了
    expect([...service.connectionCache.keys()]).toEqual([PROFILE_A]);
    expect(service.isTargetEnabled("claude")).toBe(false);
    expect(service.isTargetEnabled("codex")).toBe(true);
  });

  it("接管是分配的子集：分配了不等于被接管", async () => {
    const profile = {
      id: PROFILE_A,
      protocol: "openai-chat",
      authMode: "bearer",
      baseUrl: "http://127.0.0.1:1",
      targets: ["codex", "claude"],
    };
    // 起步时什么都没接管
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "key-a" },
    }, { targets: [] });
    await service.activateRoutes(profile, ["codex", "claude"]);

    // 分配了两个，但一个都还没接管
    expect(service.getPublicState().targets.sort()).toEqual(["claude", "codex"]);
    expect(service.getPublicState().engaged).toEqual([]);
    expect(service.isTargetEnabled("codex")).toBe(false);

    // 只接管 codex —— claude 的配置文件不该被碰
    await service.setEngagedTargets(["codex"]);
    expect(service.isTargetEnabled("codex")).toBe(true);
    expect(service.isTargetEnabled("claude")).toBe(false);

    // 越界的接管请求（没分配过的客户端）被丢掉，不会把它悄悄提升为已分配
    await service.setEngagedTargets(["codex", "gemini"]);
    expect(service.getPublicState().engaged).toEqual(["codex"]);
    expect(service.getPublicState().targets.sort()).toEqual(["claude", "codex"]);
  });

  it("取消分配会连带取消接管，不留下指向空路由的接管项", async () => {
    const profile = {
      id: PROFILE_A,
      protocol: "openai-chat",
      authMode: "bearer",
      baseUrl: "http://127.0.0.1:1",
      targets: ["codex", "claude"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "key-a" },
    });
    await service.activateRoutes(profile, ["codex", "claude"]);
    await service.setEngagedTargets(["codex", "claude"]);

    await service.unassignRoutes(["claude"]);
    expect(service.getPublicState().engaged).toEqual(["codex"]);
    expect(service.isTargetEnabled("claude")).toBe(false);
  });

  it("未运行时随机换一个空闲端口；运行中拒绝换，否则已写入的客户端配置会指向旧端口", async () => {
    const { service } = await createGateway({}, { initialize: true });
    const before = service.getPublicState().port;

    const next = await service.reassignPort();
    expect(next.port).not.toBe(before);
    // 落在随机区间内：避开系统端口，也避开 49152+ 的临时端口段
    expect(next.port).toBeGreaterThanOrEqual(20_000);
    expect(next.port).toBeLessThanOrEqual(45_000);

    // 换到的端口必须真的能绑上
    const probe = await listen((_request, response) => response.end(), next.port);
    expect(probe.port).toBe(next.port);
    await closeServer(probe.server);

    // 是随机不是顺着爬：连摇几次不该总是同一个，也不该是 before+1、before+2……
    const drawn = new Set();
    for (let i = 0; i < 6; i += 1) drawn.add((await service.reassignPort()).port);
    expect(drawn.size).toBeGreaterThan(1);

    await service.start({ port: 0 });
    await expect(service.reassignPort()).rejects.toThrow(/Stop the local gateway/);
  });

  it("停止状态持久化失败时仍清除本地令牌和明文连接缓存", async () => {
    const profile = {
      id: PROFILE_A,
      protocol: "openai-chat",
      authMode: "bearer",
      baseUrl: "http://127.0.0.1:1",
      targets: ["codex"],
    };
    const store = memoryStore();
    const originalWrite = store.write.bind(store);
    let rejectWrites = false;
    store.write = async (next) => {
      if (rejectWrites) throw new Error("simulated gateway store failure");
      return originalWrite(next);
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "key-a" },
    }, { store });
    await service.activateRoutes(profile);
    expect(service.localToken).toBeTypeOf("string");
    expect([...service.connectionCache.keys()]).toEqual([PROFILE_A]);

    rejectWrites = true;
    await expect(service.stopAndWait()).rejects.toThrow("simulated gateway store failure");

    expect(service.server).toBeUndefined();
    expect(service.localToken).toBeUndefined();
    expect(service.connectionCache.size).toBe(0);
  });

  it("停止后刷新方案不会重新填充已清空的明文缓存", async () => {
    const profile = {
      id: PROFILE_A,
      protocol: "openai-chat",
      authMode: "bearer",
      baseUrl: "http://127.0.0.1:1",
      targets: ["codex"],
    };
    const getConnection = vi.fn().mockResolvedValue({ profile, apiKey: "key-a" });
    const service = new GatewayService({
      profileService: { getConnection },
      store: memoryStore(),
      vault,
    });
    activeServices.add(service);
    await service.start({ port: 0, targets: ["codex"] });
    await service.prepareConnection(profile, "key-a", "codex");
    await service.activateRoutes(profile);
    getConnection.mockClear();
    await service.stopAndWait();
    await service.refreshProfile(PROFILE_A);

    expect(service.connectionCache.size).toBe(0);
    expect(getConnection).not.toHaveBeenCalled();
  });

  it("上游响应中途断开时关闭当前响应且网关继续服务", async () => {
    const onRequestEnded = vi.fn();
    const monitor = new RequestMonitorService({ onRequestEnded });
    const upstream = await listen((request, response) => {
      if (request.url.endsWith("/reset")) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: first\n\n");
        setImmediate(() => response.destroy(new Error("simulated reset")));
        return;
      }
      response.end("ok");
    });
    const profile = {
      id: PROFILE_A,
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: upstream.baseUrl,
      targets: ["codex"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "upstream-key" },
    }, { requestMonitor: monitor });
    await service.activateRoutes(profile);
    const token = await localCredential(service, profile);
    const baseUrl = service.getPublicState().localBaseUrls.codex;
    const headers = { authorization: `Bearer ${token}` };

    await expect(rawRequest(`${baseUrl}/reset`, { headers })).rejects.toThrow();
    expect(onRequestEnded).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failed" }),
      { channelFailure: true },
    );
    expect((await rawRequest(`${baseUrl}/ok`, { headers })).body.toString()).toBe("ok");
  });

  it("客户端上传中断不会留下未处理流错误", async () => {
    const upstream = await listen((request, response) => {
      request.on("error", () => {});
      request.on("end", () => response.end("uploaded"));
      request.resume();
    });
    const profile = {
      id: PROFILE_A,
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: upstream.baseUrl,
      targets: ["codex"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "upstream-key" },
    });
    await service.activateRoutes(profile);
    const token = await localCredential(service, profile);
    const baseUrl = service.getPublicState().localBaseUrls.codex;
    const headers = { authorization: `Bearer ${token}` };

    await abortUpload(`${baseUrl}/upload`, headers);
    expect((await rawRequest(`${baseUrl}/upload`, {
      method: "POST",
      headers,
      body: Buffer.from("complete"),
    })).status).toBe(200);
  });

  it("首次连接加载期间上传中断不会形成未处理错误，网关之后仍可服务", async () => {
    let upstreamCalls = 0;
    const upstream = await listen((request, response) => {
      upstreamCalls += 1;
      request.resume();
      request.on("end", () => response.end("uploaded"));
    });
    const profile = {
      id: PROFILE_A,
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: upstream.baseUrl,
      targets: ["codex"],
    };
    let releaseConnection;
    let connectionRequested;
    const connectionGate = new Promise((resolve) => {
      releaseConnection = resolve;
    });
    const connectionStarted = new Promise((resolve) => {
      connectionRequested = resolve;
    });
    let connectionCalls = 0;
    const getConnection = vi.fn(async () => {
      connectionCalls += 1;
      if (connectionCalls > 1) {
        connectionRequested();
        await connectionGate;
      }
      return { profile, apiKey: "upstream-key" };
    });
    const service = new GatewayService({
      profileService: { getConnection },
      store: memoryStore(),
      vault,
    });
    activeServices.add(service);
    await service.start({ port: 0, targets: ["codex"] });
    await service.activateRoutes(profile);
    const token = await localCredential(service, profile);
    const url = `${service.getPublicState().localBaseUrls.codex}/upload`;
    const headers = { authorization: `Bearer ${token}` };
    service.connectionCache.clear();

    let uploadRequest;
    const interrupted = new Promise((resolve) => {
      uploadRequest = http.request(url, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/octet-stream",
          "content-length": "1048576",
        },
      });
      uploadRequest.on("error", () => {});
      uploadRequest.once("close", resolve);
      uploadRequest.write(Buffer.alloc(1024, 7));
    });
    await connectionStarted;
    uploadRequest.destroy();
    await interrupted;
    releaseConnection();
    await new Promise((resolve) => setImmediate(resolve));

    expect(upstreamCalls).toBe(0);
    expect((await rawRequest(url, {
      method: "POST",
      headers,
      body: Buffer.from("complete"),
    })).status).toBe(200);
    expect(upstreamCalls).toBe(1);
  });

  it("401 和 404 拒绝体中断不会重复销毁请求，网关之后仍可服务", async () => {
    const upstream = await listen((_request, response) => response.end("ok"));
    const profile = {
      id: PROFILE_A,
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: upstream.baseUrl,
      targets: ["codex"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "upstream-key" },
    });
    await service.activateRoutes(profile);
    const token = await localCredential(service, profile);
    const baseUrl = service.getPublicState().localBaseUrls.codex;

    const wrongBaseUrl = baseUrl.replace(/[^/]+$/, "wrong-route-token");
    expect(await interruptRejectedUpload(`${wrongBaseUrl}/upload`)).toBe(401);
    const rootUrl = new URL(baseUrl);
    expect(await interruptRejectedUpload(`${rootUrl.origin}/unknown/upload`, {
      authorization: `Bearer ${token}`,
    })).toBe(404);
    expect((await rawRequest(`${baseUrl}/ok`, {
      headers: { authorization: `Bearer ${token}` },
    })).body.toString()).toBe("ok");
  });

  it("请求处理 Promise 拒绝时返回 500 而不形成未处理拒绝", async () => {
    const { service } = await createGateway({});
    const originalHandleRequest = service._handleRequest.bind(service);
    service._handleRequest = vi.fn()
      .mockRejectedValueOnce(new Error("simulated handler failure"))
      .mockImplementation(originalHandleRequest);
    const baseUrl = service.getPublicState().localBaseUrls.codex;

    expect((await rawRequest(baseUrl)).status).toBe(500);
    expect((await rawRequest(baseUrl)).status).toBe(404);
  });

  it("限制本地连接数并为请求和空闲连接设置有限超时", async () => {
    const { service } = await createGateway({});
    expect(service.server.maxConnections).toBe(128);
    expect(service.server.requestTimeout).toBeGreaterThan(0);
    expect(service.server.timeout).toBeGreaterThan(0);
  });

  it("端口冲突不持久化启用状态，停止后关闭端口并保留 staged route", async () => {
    const occupied = await listen((_request, response) => response.end("occupied"));
    const store = memoryStore();
    const connections = {};
    const service = new GatewayService({
      profileService: profileService(connections),
      store,
      vault,
    });
    activeServices.add(service);

    await expect(service.start({ port: occupied.port, targets: ["codex"] }))
      .rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(store.current().enabled).toBe(false);
    await closeServer(occupied.server);

    await service.start({ port: occupied.port, targets: ["codex"] });
    const profile = {
      id: PROFILE_A,
      protocol: "openai-responses",
      authMode: "bearer",
      baseUrl: "http://127.0.0.1:1",
      targets: ["codex"],
    };
    connections[PROFILE_A] = { profile, apiKey: "upstream" };
    await service.activateRoutes(profile);
    expect(store.current().routes).toEqual({ codex: PROFILE_A });
    await service.stopAndWait();
    expect(store.current()).toMatchObject({ enabled: false, routes: { codex: PROFILE_A } });
    expect(service.getPublicState().status).toBe("stopped");
    await expect(rawRequest(`http://127.0.0.1:${occupied.port}/codex`)).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });
  });

  it("initialize 自动恢复已启用网关，但不暴露持久化令牌", async () => {
    const encryptedToken = vault.encrypt("stable-local-token");
    const store = memoryStore({
      version: 1,
      enabled: true,
      port: 0,
      targets: ["claude"],
      routes: { claude: PROFILE_A },
      encryptedToken,
    });
    // 持久化结构不允许端口 0，先取得一个随后释放的可用端口。
    const reservation = await listen((_request, response) => response.end());
    const restoredPort = reservation.port;
    await closeServer(reservation.server);
    store.write({ ...store.current(), port: restoredPort });
    const profile = {
      id: PROFILE_A,
      protocol: "anthropic",
      authMode: "bearer",
      baseUrl: "http://127.0.0.1:1",
      targets: ["claude"],
    };
    const { service } = await createGateway({
      [PROFILE_A]: { profile, apiKey: "upstream" },
    }, { store, initialize: true });

    const state = service.getPublicState();
    expect(state).toMatchObject({ status: "running", port: restoredPort });
    expect(state.routes).toEqual([{ target: "claude", profileId: PROFILE_A }]);
    expect(JSON.stringify(state)).not.toContain("stable-local-token");
    const prepared = await service.prepareConnection(profile, "upstream", "claude");
    expect(prepared.apiKey).toBe("stable-local-token");
    expect(prepared.profile.baseUrl).toBe(`http://127.0.0.1:${restoredPort}/claude`);
  });
});
