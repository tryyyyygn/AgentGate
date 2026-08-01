import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  MAX_DETECTION_BUFFER_BYTES,
  MAX_LINE_BYTES,
  RETENTION_WINDOW_MS,
  RequestLogStoreSchema,
  RequestMonitorService,
  StreamScanner,
  extractRequestMetadata,
  extractTokenUsage,
  extractTokenUsageFromSource,
} = require("../electron/services/request-monitor-service.cjs");

describe("活动请求监视", () => {
  it("独立跟踪并发请求并在结束后保留最近记录", () => {
    let now = 1_000;
    const onChange = vi.fn();
    const monitor = new RequestMonitorService({ now: () => now, onChange });
    const first = monitor.start({
      client: "codex",
      profileId: "profile-a",
      profileName: "方案 A",
      upstreamUrl: "https://a.example/v1",
      protocol: "openai-responses",
    });
    now += 5;
    const second = monitor.start({
      client: "codex",
      profileName: "方案 B",
      upstreamUrl: "https://b.example/v1",
      protocol: "openai-chat",
    });

    // 最新的永远在最上面：不按「活跃优先」分组，也不按完成时间排
    expect(monitor.list().map((request) => request.id)).toEqual([second, first]);
    now += 25;
    expect(monitor.end(first)).toBe(true);
    // first 刚刚完成，但它开始得早，所以仍排在还活着的 second 下面
    expect(monitor.list().map((request) => request.id)).toEqual([second, first]);
    expect(monitor.list()[1]).toMatchObject({
      id: first,
      state: "completed",
      outcome: "completed",
      durationMs: 30,
    });
    expect(onChange).toHaveBeenLastCalledWith({
      type: "active-requests-changed",
      activeRequests: [
        expect.objectContaining({ id: first, state: "completed" }),
      ],
      patch: true,
      revision: expect.any(Number),
    });
  });

  it("按三天窗口保留完成记录，超时的丢弃", () => {
    let now = Date.parse("2026-07-13T12:00:00.000Z");
    const monitor = new RequestMonitorService({ now: () => now });

    const retained = monitor.start({ profileName: "两天前" });
    monitor.end(retained);

    now += 2 * 24 * 60 * 60_000;
    const fresh = monitor.start({ profileName: "刚刚" });
    monitor.end(fresh);
    expect(monitor.list().map((entry) => entry.profileName)).toEqual(["刚刚", "两天前"]);

    now += RETENTION_WINDOW_MS + 1;
    const newest = monitor.start({ profileName: "三天后" });
    monitor.end(newest);

    const records = monitor.list();
    expect(records.map((entry) => entry.profileName)).toEqual(["三天后"]);
  });

  it("没有新请求时 list 也会淘汰过期记录并持久化", async () => {
    let now = Date.parse("2026-07-13T12:00:00.000Z");
    const writes = [];
    const monitor = new RequestMonitorService({
      now: () => now,
      store: {
        write: async (value) => {
          writes.push(value);
          return value;
        },
      },
    });
    const id = monitor.start({ profileName: "将过期" });
    monitor.end(id);

    now += RETENTION_WINDOW_MS + 1;
    expect(monitor.list()).toEqual([]);
    await monitor.flush();
    expect(writes.at(-1).entries).toEqual([]);
  });

  it("同一保留窗口内超过旧上限也不截断", () => {
    let now = Date.parse("2026-07-13T12:00:00.000Z");
    const monitor = new RequestMonitorService({ now: () => now });
    const count = 2_010;
    for (let index = 0; index < count; index += 1) {
      const id = monitor.start({ profileName: `方案 ${index}` });
      now += 1; // 全部落在同一小时内
      monitor.end(id);
    }
    const records = monitor.list();
    expect(records).toHaveLength(count);
    expect(RequestLogStoreSchema.safeParse({ version: 1, entries: records }).success).toBe(true);
  });

  it.each([
    [
      "Responses",
      "openai-responses",
      'data: {"type":"response.output_text.delta","delta":"你"}\n\n',
    ],
    [
      "Responses 通用事件名",
      "openai-responses",
      'event: message\ndata: {"type":"response.output_text.delta","delta":"你"}\n\n',
    ],
    [
      "Chat",
      "openai-chat",
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
    ],
    [
      "Anthropic",
      "anthropic",
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"你"}}\n\n',
    ],
    [
      "Anthropic 通用事件名",
      "anthropic",
      'event: message\ndata: {"type":"content_block_delta","delta":{"text":"你"}}\n\n',
    ],
    [
      "Gemini",
      "gemini",
      '{"candidates":[{"content":{"parts":[{"text":"你"}]}}]}\n',
    ],
  ])("识别 %s 的首个正文增量", (_name, protocol, payload) => {
    let now = 2_000;
    const monitor = new RequestMonitorService({ now: () => now });
    const id = monitor.start({
      client: "codex",
      profileName: "测试方案",
      upstreamUrl: "https://relay.example/v1",
      protocol,
      streaming: true,
    });
    monitor.responseStarted(id, { statusCode: 200, streaming: true });
    now += 37;

    const splitAt = Math.floor(payload.length / 2);
    expect(monitor.observeChunk(id, Buffer.from(payload.slice(0, splitAt), "utf8"))).toBe(false);
    expect(monitor.observeChunk(id, Buffer.from(payload.slice(splitAt), "utf8"))).toBe(true);
    expect(monitor.list()[0]).toMatchObject({
      state: "streaming",
      firstTokenLatencyMs: 37,
      statusCode: 200,
      receivedBytes: Buffer.byteLength(payload, "utf8"),
    });
  });

  it.each([
    [
      "Responses content part 完整正文",
      "openai-responses",
      'event: response.content_part.done\ndata: {"type":"response.content_part.done","part":{"type":"output_text","text":"你好"}}\n\n',
    ],
    [
      "Responses output item 完整正文",
      "openai-responses",
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"你好"}]}}\n\n',
    ],
    [
      "Anthropic content block 完整正文",
      "anthropic",
      'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"text","text":"你好"}}\n\n',
    ],
  ])("%s 是首个实际可见文本时仍能记录", (_name, protocol, payload) => {
    let now = 2_500;
    const monitor = new RequestMonitorService({ now: () => now });
    const id = monitor.start({ profileName: "完整正文事件", protocol, streaming: true });
    monitor.responseStarted(id, { statusCode: 200, streaming: true });

    now += 45;
    expect(monitor.observeChunk(id, payload)).toBe(true);
    expect(monitor.list()[0].firstTokenLatencyMs).toBe(45);
  });

  it("Responses 完整 reasoning 输出可以记录首 token", () => {
    let now = 2_800;
    const monitor = new RequestMonitorService({ now: () => now });
    const id = monitor.start({
      profileName: "推理与正文",
      protocol: "openai-responses",
      streaming: true,
    });
    monitor.responseStarted(id, { statusCode: 200, streaming: true });

    now += 20;
    expect(monitor.observeChunk(id,
      'data: {"type":"response.completed","response":{"output":[{"type":"reasoning","content":[{"type":"reasoning_text","text":"内部分析"}]}]}}\n\n')).toBe(true);
    expect(monitor.list()[0].firstTokenLatencyMs).toBe(20);

    now += 30;
    monitor.observeChunk(
      id,
      'data: {"type":"response.output_text.delta","delta":"对用户可见"}\n\n',
    );
    expect(monitor.list()[0].firstTokenLatencyMs).toBe(20);
  });

  it("Responses 创建空 reasoning 项时立即记录首 token，后续正文不覆盖", () => {
    let now = 10_000;
    const monitor = new RequestMonitorService({ now: () => now });
    const id = monitor.start({
      profileName: "隐藏推理",
      protocol: "openai-responses",
      streaming: true,
    });
    monitor.responseStarted(id, { statusCode: 200, streaming: true });

    now += 1_000;
    expect(monitor.observeChunk(
      id,
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"reasoning","summary":[]}}\n\n',
    )).toBe(true);
    expect(monitor.list()[0].firstTokenLatencyMs).toBe(1_000);

    now += 5 * 60_000;
    monitor.observeChunk(id, 'data: {"type":"response.output_text.delta","delta":"完成"}\n\n');
    expect(monitor.list()[0].firstTokenLatencyMs).toBe(1_000);
  });

  it.each([
    [
      "Responses 推理",
      "openai-responses",
      'event: response.reasoning_summary_text.delta\ndata: {"delta":"分析"}\n\n',
    ],
    [
      "Chat 推理",
      "openai-chat",
      'data: {"choices":[{"delta":{"reasoning_content":"分析"}}]}\n\n',
    ],
    [
      "Anthropic thinking",
      "anthropic",
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"thinking":"分析"}}\n\n',
    ],
    [
      "Gemini thought",
      "gemini",
      '{"candidates":[{"content":{"parts":[{"text":"分析","thought":true}]}}]}\n',
    ],
  ])("%s 作为首个生成 token 立即记录", (_name, protocol, payload) => {
    let now = 3_000;
    const monitor = new RequestMonitorService({ now: () => now });
    const id = monitor.start({ profileName: "推理 token", protocol, streaming: true });
    monitor.responseStarted(id, { statusCode: 200, streaming: true });

    now += 25;
    expect(monitor.observeChunk(id, payload)).toBe(true);
    expect(monitor.list()[0].firstTokenLatencyMs).toBe(25);
  });

  it.each([
    [
      "Responses 工具参数",
      "openai-responses",
      'event: response.function_call_arguments.delta\ndata: {"delta":"{\\"path\\":"}\n\n',
    ],
    [
      "Chat 工具参数",
      "openai-chat",
      'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{}"}}]}}]}\n\n',
    ],
    [
      "Anthropic 工具参数",
      "anthropic",
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"query\\":"}}\n\n',
    ],
    [
      "Gemini 工具调用",
      "gemini",
      '{"candidates":[{"content":{"parts":[{"functionCall":{"name":"search","args":{"query":"x"}}}]}}]}\n',
    ],
  ])("%s 作为计费输出记录首 token", (_name, protocol, payload) => {
    let now = 3_000;
    const monitor = new RequestMonitorService({ now: () => now });
    const id = monitor.start({ profileName: "工具输出", protocol, streaming: true });
    monitor.responseStarted(id, { statusCode: 200, streaming: true });

    now += 25;
    expect(monitor.observeChunk(id, payload)).toBe(true);
    expect(monitor.list()[0].firstTokenLatencyMs).toBe(25);
  });

  it("同一响应 chunk 的首包和首 token 共用到达时间，不计入解析开销", () => {
    const times = [1_000, 1_040];
    let nowCalls = 0;
    const monitor = new RequestMonitorService({
      now: () => times[Math.min(nowCalls++, times.length - 1)],
    });
    const id = monitor.start({ profileName: "计时", protocol: "openai-responses", streaming: true });
    monitor.responseStarted(id, { statusCode: 200, streaming: true });
    monitor.observeChunk(id, 'data: {"type":"response.output_text.delta","delta":"首"}\n\n');

    expect(nowCalls).toBe(2);
    expect(monitor.list()[0]).toMatchObject({
      firstByteLatencyMs: 40,
      firstTokenLatencyMs: 40,
    });
  });

  it("非流式结构化响应只记录首包，不把完整正文到达误报成 TTFT", () => {
    let now = 5_000;
    const monitor = new RequestMonitorService({ now: () => now });
    const id = monitor.start({
      client: "codex",
      profileName: "非流式方案",
      upstreamUrl: "https://relay.example/v1",
      protocol: "openai-responses",
    });
    monitor.responseStarted(id, {
      statusCode: 200,
      contentType: "application/json",
    });
    now += 12;
    monitor.observeChunk(id, Buffer.from(JSON.stringify({
      output: [{ type: "message", content: [{ type: "output_text", text: "private response body" }] }],
    }), "utf8"));

    const publicRequest = monitor.list()[0];
    expect(publicRequest.firstByteLatencyMs).toBe(12);
    expect(publicRequest.firstTokenLatencyMs).toBeUndefined();
    expect(publicRequest.state).toBe("streaming");
    expect(JSON.stringify(publicRequest)).not.toContain("private response body");
    expect(Object.keys(publicRequest)).not.toContain("detectionBuffer");
  });

  it("请求虽声明流式，但上游实际返回 JSON 整包时只记录 TTFB", () => {
    let now = 5_500;
    const monitor = new RequestMonitorService({ now: () => now });
    const id = monitor.start({
      client: "codex",
      profileName: "忽略 stream 的中转",
      protocol: "openai-responses",
      streaming: true,
    });
    monitor.responseStarted(id, {
      statusCode: 200,
      contentType: "application/json; charset=utf-8",
    });
    now += 18;
    monitor.observeChunk(id, JSON.stringify({
      output: [{ type: "message", content: [{ type: "output_text", text: "完整响应" }] }],
    }));

    expect(monitor.list()[0]).toMatchObject({
      streaming: false,
      firstByteLatencyMs: 18,
    });
    expect(monitor.list()[0].firstTokenLatencyMs).toBeUndefined();
  });

  it("响应头锁定 JSON 后，晚到的请求 stream 元数据不能改回 TTFT", () => {
    let now = 5_700;
    const monitor = new RequestMonitorService({ now: () => now });
    const id = monitor.start({
      profileName: "响应先到",
      protocol: "openai-responses",
      streaming: true,
    });
    monitor.responseStarted(id, { statusCode: 200, contentType: "application/json" });
    monitor.updateMetadata(id, { streaming: true });
    now += 9;
    monitor.observeChunk(id, JSON.stringify({
      output: [{ type: "message", content: [{ type: "output_text", text: "整包" }] }],
    }));

    expect(monitor.list()[0]).toMatchObject({ streaming: false, firstByteLatencyMs: 9 });
    expect(monitor.list()[0].firstTokenLatencyMs).toBeUndefined();
  });

  it("非流式未知响应只记录首包", () => {
    let now = 6_000;
    const monitor = new RequestMonitorService({ now: () => now });
    const id = monitor.start({ profileName: "未知格式", protocol: "openai-responses" });
    monitor.responseStarted(id, { statusCode: 200, contentType: "application/octet-stream" });
    now += 16;
    monitor.observeChunk(id, Buffer.from("opaque body", "utf8"));

    expect(monitor.list()[0]).toMatchObject({ firstByteLatencyMs: 16 });
    expect(monitor.list()[0].firstTokenLatencyMs).toBeUndefined();
  });

  it("未知流只记录首包且完成后冻结总耗时", () => {
    let now = 8_000;
    const monitor = new RequestMonitorService({ now: () => now });
    const id = monitor.start({
      profileName: "未知中转格式",
      protocol: "openai-responses",
      streaming: true,
    });
    monitor.responseStarted(id, { streaming: true });
    now += 350;
    monitor.observeChunk(id, 'data: {"type":"response.created"}\n\n');
    expect(monitor.list()[0]).toMatchObject({ firstByteLatencyMs: 350 });
    expect(monitor.list()[0].firstTokenLatencyMs).toBeUndefined();
    now += 1_650;
    monitor.end(id);
    expect(monitor.list()[0]).toMatchObject({ durationMs: 2_000, outcome: "completed" });
  });

  it("只回错误事件的 200 流记为 failed，而不是 completed", () => {
    // 真实事故：中转校验请求失败后仍以 HTTP 200 开流，只发一个
    // response.failed 就结束；此前会被记成「已完成」且无任何 token。
    const onRequestEnded = vi.fn();
    const monitor = new RequestMonitorService({ now: () => 1_000, onRequestEnded });
    const id = monitor.start({ profileName: "中转", protocol: "openai-responses", streaming: true });
    monitor.responseStarted(id, { statusCode: 200, streaming: true });
    monitor.observeChunk(id, 'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"code":"invalid_id_prefix"}}}\n\n');
    monitor.end(id);
    expect(monitor.list()[0]).toMatchObject({ state: "failed", outcome: "failed" });
    expect(onRequestEnded).toHaveBeenCalledWith(
      expect.not.objectContaining({ channelFailure: expect.anything() }),
      { channelFailure: true },
    );
  });

  it("请求结束来源标记只传给内部订阅者，不进入公开历史", () => {
    const onRequestEnded = vi.fn();
    const monitor = new RequestMonitorService({ now: () => 1_000, onRequestEnded });
    const id = monitor.start({ profileName: "本地失败" });

    monitor.end(id, { outcome: "failed", channelFailure: false });

    expect(onRequestEnded).toHaveBeenCalledWith(
      expect.not.objectContaining({ channelFailure: expect.anything() }),
      { channelFailure: false },
    );
    expect(monitor.list()[0]).not.toHaveProperty("channelFailure");
  });

  it("先产出正文再收到 response.failed 的 200 流仍记为 failed", () => {
    const monitor = new RequestMonitorService({ now: () => 1_000 });
    const id = monitor.start({ profileName: "中转", protocol: "openai-responses", streaming: true });
    monitor.responseStarted(id, { statusCode: 200, streaming: true });
    monitor.observeChunk(id, 'data: {"type":"response.output_text.delta","delta":"部分正文"}\n\n');
    monitor.observeChunk(id, 'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"code":"upstream_failed"}}}\n\n');
    monitor.end(id);

    expect(monitor.list()[0]).toMatchObject({ state: "failed", outcome: "failed" });
  });

  it("正文里出现 error 字样但已产出内容的流仍是 completed", () => {
    const monitor = new RequestMonitorService({ now: () => 1_000 });
    const id = monitor.start({ profileName: "中转", protocol: "openai-responses", streaming: true });
    monitor.responseStarted(id, { statusCode: 200, streaming: true });
    monitor.observeChunk(id, 'data: {"type":"response.output_text.delta","delta":"讲讲 event: response.failed 和 \\"type\\":\\"error\\" 事件"}\n\n');
    monitor.observeChunk(id, 'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5}}}\n\n');
    monitor.end(id);
    expect(monitor.list()[0]).toMatchObject({ state: "completed", outcome: "completed" });
  });

  it("提取请求模型、推理强度和真实 usage", () => {
    expect(extractRequestMetadata({
      model: "gpt-5.2-codex",
      stream: true,
      reasoning: { effort: "high" },
      input: "不得公开",
    })).toEqual({ model: "gpt-5.2-codex", streaming: true, reasoningEffort: "high" });
    expect(extractTokenUsage({
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          total_tokens: 125,
          input_tokens_details: { cached_tokens: 40 },
          output_tokens_details: { reasoning_tokens: 8 },
        },
      },
    })).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      cachedTokens: 40,
      reasoningTokens: 8,
      totalTokens: 125,
    });
  });

  it("Anthropic：input 不含缓存，必须补回来——否则用量少算、命中率恒等于 100%", () => {
    /*
     * Anthropic 的 input_tokens 只是「未命中缓存的新输入」，缓存读写是两个
     * 独立字段。老代码直接拿 input 当分母、把缓存写入算成命中：
     *   cached/input = (20000+12000)/5 = 6400 → 被 Math.min 夹成 100%
     * 而 total = input+output = 305，把 3.2 万个缓存 token 全丢了。
     */
    expect(extractTokenUsage({
      usage: {
        input_tokens: 5,
        cache_read_input_tokens: 20_000,
        cache_creation_input_tokens: 12_000,
        output_tokens: 300,
      },
    })).toEqual({
      inputTokens: 32_005,        // 5 + 20000 + 12000：归一化成「全部提示 token」
      outputTokens: 300,
      cachedTokens: 20_000,       // 只有「读」算命中
      cacheWriteTokens: 12_000,   // 「写」是 miss，还按 1.25× 计费
      totalTokens: 32_305,        // 不再漏掉缓存
    });
  });

  it("缓存写入不是命中：全新建缓存的请求命中率必须是 0，而不是 100%", () => {
    const usage = extractTokenUsage({
      usage: {
        input_tokens: 80,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 30,
      },
    });
    expect(usage).toEqual({
      inputTokens: 110,          // 80 + 0 + 30
      outputTokens: 20,
      cachedTokens: 0,           // 一个字都没命中
      cacheWriteTokens: 30,
      totalTokens: 130,
    });
    // 这正是最贵的一次请求，绝不能显示成「100% 命中」
    expect(usage.cachedTokens / usage.inputTokens).toBe(0);
  });

  it("OpenAI / Gemini：prompt 已含缓存，不能重复加", () => {
    // OpenAI：prompt_tokens 里已经包含 cached_tokens
    expect(extractTokenUsage({
      usage: {
        prompt_tokens: 25_000,
        completion_tokens: 800,
        prompt_tokens_details: { cached_tokens: 20_000 },
        completion_tokens_details: { reasoning_tokens: 640 },
      },
    })).toEqual({
      inputTokens: 25_000,       // 原样，不能再加 20000
      outputTokens: 800,
      cachedTokens: 20_000,
      reasoningTokens: 640,      // 已含在 output 里，只为显示
      totalTokens: 25_800,
    });

    // Gemini：promptTokenCount 里已经包含 cachedContentTokenCount
    expect(extractTokenUsage({
      usageMetadata: {
        promptTokenCount: 9_000,
        candidatesTokenCount: 500,
        cachedContentTokenCount: 7_200,
        thoughtsTokenCount: 210,
        totalTokenCount: 9_500,
      },
    })).toEqual({
      inputTokens: 9_000,
      outputTokens: 500,
      cachedTokens: 7_200,
      reasoningTokens: 210,
      totalTokens: 9_500,
    });
  });

  it("Gemini 工具调用参数算首个计费输出", () => {
    let now = 12_000;
    const monitor = new RequestMonitorService({ now: () => now });
    const id = monitor.start({ profileName: "Gemini", protocol: "gemini", streaming: true });
    monitor.responseStarted(id, { streaming: true });
    now += 24;
    expect(monitor.observeChunk(id, JSON.stringify({
      candidates: [{ content: { parts: [{ functionCall: { name: "search", args: { query: "x" } } }] } }],
    }))).toBe(true);
    expect(monitor.list()[0].firstTokenLatencyMs).toBe(24);
  });

  it("大事件截断正文后仍从尾部提取 usage", () => {
    const payload = `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        output: [{ type: "message", content: [{ text: "x".repeat(70_000) }] }],
        usage: {
          input_tokens: 321,
          output_tokens: 45,
          total_tokens: 366,
          input_tokens_details: { cached_tokens: 120 },
        },
      },
    })}\n\n`;
    expect(extractTokenUsageFromSource(payload)).toEqual({
      inputTokens: 321,
      outputTokens: 45,
      cachedTokens: 120,
      totalTokens: 366,
    });

    let now = 20_000;
    const monitor = new RequestMonitorService({ now: () => now });
    const id = monitor.start({ profileName: "大响应", protocol: "openai-responses", streaming: true });
    monitor.responseStarted(id, { streaming: true });
    now += 30;
    monitor.observeChunk(id, 'data: {"type":"response.output_text.delta","delta":"首"}\n\n');
    now += 40;
    monitor.observeChunk(id, payload);
    expect(monitor.list()[0].tokenUsage).toEqual({
      inputTokens: 321,
      outputTokens: 45,
      cachedTokens: 120,
      totalTokens: 366,
    });
  });
});

describe("请求记录持久化", () => {
  it("启动时加载存储并在请求结束后写回最近 100 条", async () => {
    const persisted = {
      version: 1,
      entries: [{
        id: "old-1",
        client: "codex",
        profileName: "旧记录",
        upstreamUrl: "https://a.example/v1",
        state: "completed",
        startedAt: new Date(1_000).toISOString(),
        outcome: "completed",
        receivedBytes: 12,
      }],
    };
    const writes = [];
    const store = {
      read: async () => persisted,
      write: async (value) => { writes.push(value); return value; },
    };
    let now = 50_000;
    const monitor = new RequestMonitorService({ now: () => now, store });
    await monitor.initialize();
    expect(monitor.list().map((entry) => entry.id)).toEqual(["old-1"]);

    const id = monitor.start({ client: "codex", profileName: "新请求" });
    now += 20;
    monitor.end(id);
    await monitor.flush();

    expect(writes.at(-1).entries.map((entry) => entry.profileName)).toEqual(["新请求", "旧记录"]);
    expect(writes.at(-1).entries).toHaveLength(2);
  });
});

describe("中止归类", () => {
  it("流中已出现完成标记时，socket 中止改判为已完成", () => {
    let now = 30_000;
    const monitor = new RequestMonitorService({ now: () => now });
    const id = monitor.start({
      client: "codex",
      profileName: "子代理请求",
      protocol: "anthropic",
      streaming: true,
    });
    monitor.responseStarted(id, { statusCode: 200, streaming: true });
    now += 40;
    monitor.observeChunk(id, 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"好"}}\n\n');
    monitor.observeChunk(id, 'event: message_stop\ndata: {"type":"message_stop"}\n\n');
    now += 5;
    monitor.end(id, { outcome: "aborted" });

    expect(monitor.list()[0]).toMatchObject({ state: "completed", outcome: "completed" });
  });

  it("没有完成标记的中止保持已中止", () => {
    let now = 31_000;
    const monitor = new RequestMonitorService({ now: () => now });
    const id = monitor.start({
      client: "codex",
      profileName: "真实中止",
      protocol: "openai-responses",
      streaming: true,
    });
    monitor.responseStarted(id, { statusCode: 200, streaming: true });
    now += 40;
    monitor.observeChunk(id, 'data: {"type":"response.output_text.delta","delta":"部分"}\n\n');
    monitor.end(id, { outcome: "aborted" });

    expect(monitor.list()[0]).toMatchObject({ state: "aborted", outcome: "aborted" });
  });

  it("后开始的请求排在前面，跟谁先完成无关", () => {
    let now = 40_000;
    const monitor = new RequestMonitorService({ now: () => now });
    const early = monitor.start({ profileName: "先发起" });
    now += 10;
    const late = monitor.start({ profileName: "后发起" });

    // 后发起的先完成——老写法按完成时间 unshift，会把它排到已完成组的最前面，
    // 而 early 还活着又被「活跃优先」顶到最上面，时间戳列于是乱的。
    now += 5;
    monitor.end(late);
    now += 5;
    monitor.end(early);

    expect(monitor.list().map((request) => request.profileName))
      .toEqual(["后发起", "先发起"]);
  });

  it("多字节字符被 chunk 从中间劈开也不会解错", () => {
    let now = 50_000;
    const monitor = new RequestMonitorService({ now: () => now });
    const id = monitor.start({ profileName: "分片", protocol: "openai-responses", streaming: true });
    monitor.responseStarted(id, { statusCode: 200, streaming: true });

    const payload = Buffer.from(
      'data: {"type":"response.output_text.delta","delta":"世界线"}\n\n',
      "utf8",
    );
    // 「世」是 3 字节，切在它中间。逐字节 toString('utf8') 会解出替换字符，
    // 整块 JSON 就废了；StringDecoder 会把残字节留到下一片。
    const cut = payload.indexOf(Buffer.from("世", "utf8")) + 1;
    now += 20;
    expect(monitor.observeChunk(id, payload.subarray(0, cut))).toBe(false);
    expect(monitor.observeChunk(id, payload.subarray(cut))).toBe(true);
    expect(monitor.list()[0]).toMatchObject({ firstTokenLatencyMs: 20, state: "streaming" });
  });

  it("传输途中只推活跃请求，不把整部历史重发一遍", () => {
    let now = 70_000;
    const events = [];
    const monitor = new RequestMonitorService({
      now: () => now,
      onChange: (event) => events.push(event),
    });

    // 攒一点历史
    for (let index = 0; index < 5; index += 1) {
      const old = monitor.start({ profileName: `历史 ${index}`, protocol: "openai-responses" });
      monitor.end(old);
    }

    const id = monitor.start({ profileName: "在跑", protocol: "openai-responses", streaming: true });
    monitor.responseStarted(id, { statusCode: 200, streaming: true });
    monitor.observeChunk(id, 'data: {"type":"response.output_text.delta","delta":"首"}\n\n');
    events.length = 0;

    // 传输途中：节流窗口过了，应当只推还在跑的那一条
    now += 300;
    monitor.observeChunk(id, 'data: {"type":"response.output_text.delta","delta":"续"}\n\n');
    const progress = events.at(-1);
    expect(progress.patch).toBe(true);
    expect(progress.activeRequests).toHaveLength(1);
    expect(progress.activeRequests[0].id).toBe(id);

    /*
     * 历史记录只在请求「结束」时才变，传输途中一条都不该跟着重发——这段代码同步压在
     * 网关的转发路径上，实测 4 条并发流跑 30 秒会白推一百万条记录，吃掉八成六的 CPU。
     */
    now += 300;
    monitor.end(id);
    const final = events.at(-1);
    expect(final.patch).toBe(true);
    expect(final.activeRequests).toHaveLength(1);
    expect(final.activeRequests[0].id).toBe(id);
  });

  it("所有请求状态事件都只传变动行，并用 revision 对齐 bootstrap", () => {
    let now = Date.parse("2026-07-14T10:00:00.000Z");
    const events = [];
    const monitor = new RequestMonitorService({
      now: () => now,
      onChange: (event) => events.push(event),
    });

    for (let index = 0; index < 120; index += 1) {
      const old = monitor.start({ profileName: `历史 ${index}` });
      monitor.end(old);
    }
    events.length = 0;

    const id = monitor.start({ profileName: "活跃" });
    monitor.updateMetadata(id, { model: "gpt-5.2" });
    expect(events.every((event) => event.patch === true)).toBe(true);
    expect(events.every((event) => event.activeRequests.length === 1)).toBe(true);
    expect(events.every((event) => event.activeRequests[0].id === id)).toBe(true);
    expect(events.map((event) => event.revision)).toEqual([expect.any(Number), expect.any(Number)]);

    const snapshot = monitor.getActiveRequestsSnapshot();
    expect(snapshot.activeRequests).toHaveLength(121);
    expect(snapshot.activeRequestsRevision).toBe(events.at(-1).revision);
  });

  it("过期记录通过 removedRequestIds 增量淘汰", () => {
    let now = Date.parse("2026-07-14T10:00:00.000Z");
    const events = [];
    const monitor = new RequestMonitorService({
      now: () => now,
      onChange: (event) => events.push(event),
    });
    const stale = monitor.start({ profileName: "过期" });
    monitor.end(stale);

    now += RETENTION_WINDOW_MS + 1;
    const fresh = monitor.start({ profileName: "新记录" });
    monitor.end(fresh);
    const event = events.at(-1);
    expect(event.patch).toBe(true);
    expect(event.activeRequests.map((entry) => entry.id)).toEqual([fresh]);
    expect(event.removedRequestIds).toEqual([stale]);
  });

  it("首 token 前的大量事件不会拖慢转发（增量解析，不重扫缓冲区）", () => {
    const monitor = new RequestMonitorService({ now: () => 60_000 });
    const id = monitor.start({ profileName: "长前导", protocol: "openai-responses", streaming: true });
    monitor.responseStarted(id, { statusCode: 200, streaming: true });

    /*
     * 首 token 之前塞 4000 个非有效事件——推理模型开流后常先刷一串状态事件。
     *
     * 老写法每来一片就把整个累积缓冲区重新 split + JSON.parse 一遍（还切两遍、
     * 每行 parse 两次），这段代码又同步卡在网关的转发路径上：实测 800 个事件就给
     * 首 token 硬加了 1.4 秒。这里 4000 个，老写法要跑几十秒；增量解析是几毫秒。
     * 上限拍在 2 秒——离新写法有几百倍余量，又稳稳卡死 O(n²) 的回归。
     */
    const started = performance.now();
    for (let index = 0; index < 4_000; index += 1) {
      monitor.observeChunk(
        id,
        `event: response.in_progress\ndata: ${JSON.stringify({
          type: "response.in_progress",
          sequence_number: index,
        })}\n\n`,
      );
    }
    const elapsed = performance.now() - started;

    expect(monitor.list()[0].firstTokenLatencyMs).toBeUndefined();
    expect(monitor.observeChunk(id, 'data: {"type":"response.output_text.delta","delta":"来"}\n\n')).toBe(true);
    expect(elapsed).toBeLessThan(2_000);
  });

  it("单字节碎片按线性成本解析，超长行丢弃到换行后可恢复", () => {
    const scanner = new StreamScanner();
    const payload = Buffer.from(JSON.stringify({
      choices: [{ delta: { content: "ok" } }],
      padding: "x".repeat(96_000),
    }), "utf8");
    const parsed = [];
    const started = performance.now();
    for (let index = 0; index < payload.length; index += 1) {
      parsed.push(...scanner.push(payload.subarray(index, index + 1)));
    }
    parsed.push(...scanner.end());
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(parsed).toHaveLength(1);

    const recovered = new StreamScanner();
    recovered.push(Buffer.alloc(MAX_LINE_BYTES + 1, 0x78));
    const events = recovered.push(Buffer.from(
      '\n\ndata: {"type":"response.output_text.delta","delta":"恢复"}\n\n',
      "utf8",
    ));
    expect(events).toEqual([expect.objectContaining({
      payload: expect.objectContaining({ delta: "恢复" }),
    })]);
  });

  it("超长 SSE data 行丢弃整个 frame，且下一 frame 可恢复", () => {
    let now = 80_000;
    const monitor = new RequestMonitorService({ now: () => now });
    const id = monitor.start({
      profileName: "超长 frame",
      protocol: "openai-responses",
      streaming: true,
    });
    monitor.responseStarted(id, { statusCode: 200, streaming: true });

    monitor.observeChunk(
      id,
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"不应记为首 token"}\n',
    );
    monitor.observeChunk(id, `data: ${"x".repeat(MAX_LINE_BYTES + 1)}\n\n`);
    expect(monitor.list()[0].firstTokenLatencyMs).toBeUndefined();

    now += 25;
    expect(monitor.observeChunk(
      id,
      'data: {"type":"response.output_text.delta","delta":"恢复"}\n\n',
    )).toBe(true);
    expect(monitor.list()[0].firstTokenLatencyMs).toBe(25);
  });

  it("单个超大 chunk 的尾部窗口仍受 UTF-8 字节上限约束", () => {
    const scanner = new StreamScanner();
    const suffix = JSON.stringify({ usage: { input_tokens: 7, output_tokens: 3 } });
    scanner.push(Buffer.from(`${"中".repeat(MAX_DETECTION_BUFFER_BYTES)}${suffix}`, "utf8"));
    scanner.push(Buffer.from("z".repeat(3_000), "utf8"));

    const tail = scanner.tailSource();
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(MAX_DETECTION_BUFFER_BYTES);
    expect(tail).toContain('"usage"');
    expect(tail).toContain("z");
  });

  it("SSE data 聚合按 UTF-8 字节限额，超限 frame 不误认前半段首 token", () => {
    let now = 90_000;
    const monitor = new RequestMonitorService({ now: () => now });
    const id = monitor.start({
      profileName: "多字节 data frame",
      protocol: "openai-responses",
      streaming: true,
    });
    monitor.responseStarted(id, { statusCode: 200, streaming: true });
    const paddingA = "é".repeat(280_000);
    const paddingB = "é".repeat(280_000);
    monitor.observeChunk(
      id,
      `data: [{"type":"response.output_text.delta","delta":"不应记为首 token"},{"padding":"${paddingA}"},\n`,
    );
    monitor.observeChunk(id, `data: {"padding":"${paddingB}"}]\n\n`);
    expect(monitor.list()[0].firstTokenLatencyMs).toBeUndefined();

    now += 15;
    expect(monitor.observeChunk(
      id,
      'data: {"type":"response.output_text.delta","delta":"恢复"}\n\n',
    )).toBe(true);
    expect(monitor.list()[0].firstTokenLatencyMs).toBe(15);
  });
});
