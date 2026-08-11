# Codex 网关首字延迟调查断点

更新时间：2026-08-07 18:21（Asia/Shanghai）

## 公开网关源码对照（已核实）

### New API

- 仓库：[QuantumNous/new-api](https://github.com/QuantumNous/new-api)，核对提交：`e926e5cacee22fc838d94e8b95b438e825508e11`。
- [`service/http_transport_sharded.go`](https://github.com/QuantumNous/new-api/blob/e926e5cacee22fc838d94e8b95b438e825508e11/service/http_transport_sharded.go) 为同一 origin 创建 N 个独立 `http.Transport`，每个 transport 维护自己的可复用 HTTP/2 连接，并按 origin 轮询分片。
- 这直接对应待验证假设：大型 Codex 请求上传与其他并发流共用单 H2 会话时，连接级带宽或流控竞争可能扩大新请求 TTFB；可用本地 H2 mock 对比单会话与多会话。
- [`relay/responses_handler.go`](https://github.com/QuantumNous/new-api/blob/e926e5cacee22fc838d94e8b95b438e825508e11/relay/responses_handler.go) 同时支持原始请求体 pass-through 和 JSON 转换路径；其成熟实现并不依赖完全跳过 JSON 解析才能保持低延迟。
- 流响应使用 scanner 按完整 SSE 行处理；客户端断开后关闭上游 `resp.Body`，但构造上游请求时没有把下游 context 直接绑定到 `http.Request`，因此不照搬其取消实现。

### Portkey Gateway

- 仓库：[Portkey-AI/gateway](https://github.com/Portkey-AI/gateway)，核对提交：`669825cbe89ee51569918b8f78a9db486fd69dd4`。
- [`src/handlers/modelResponsesHandler.ts`](https://github.com/Portkey-AI/gateway/blob/669825cbe89ee51569918b8f78a9db486fd69dd4/src/handlers/modelResponsesHandler.ts) 先解析 JSON；[`handlerUtils.ts`](https://github.com/Portkey-AI/gateway/blob/669825cbe89ee51569918b8f78a9db486fd69dd4/src/handlers/handlerUtils.ts) 再 `JSON.stringify` 后发送上游，说明解析/重编码不是成熟网关必然规避的步骤。
- [`src/handlers/streamHandler.ts`](https://github.com/Portkey-AI/gateway/blob/669825cbe89ee51569918b8f78a9db486fd69dd4/src/handlers/streamHandler.ts) 缓冲到完整 SSE 分隔符后转发，并对首个完整 chunk 主动等待 25ms；这只能解释几十毫秒，不能解释 AgentGate 的 1～5 秒差。
- [`retryHandler.ts`](https://github.com/Portkey-AI/gateway/blob/669825cbe89ee51569918b8f78a9db486fd69dd4/src/handlers/retryHandler.ts) 的 `AbortController` 服务于网关自身 timeout，尚未发现把下游断开信号完整绑定到上游请求的证据，因此不把它作为取消传播范本。

### LiteLLM

- 仓库：[BerriAI/litellm](https://github.com/BerriAI/litellm)，当前核对提交：`e1717c5e9c90c637a594b394d1ae558939631232`。
- [`streaming_handler.py`](https://github.com/BerriAI/litellm/blob/e1717c5e9c90c637a594b394d1ae558939631232/litellm/proxy/pass_through_endpoints/streaming_handler.py) 对 `response.aiter_bytes()` 的每个原始 chunk 先记录首块时间，随后立即 `yield chunk`；完整流重建与日志进入结束后的后台 logging worker，不阻塞逐块转发。
- HTTP 客户端通过 [`get_async_httpx_client`](https://github.com/BerriAI/litellm/blob/e1717c5e9c90c637a594b394d1ae558939631232/litellm/llms/custom_httpx/http_handler.py) 缓存复用；默认使用共享连接池的 aiohttp transport，而不是每个请求新建客户端。
- 客户端中断测试只验证生成器 `finally` 中仍记录部分 usage；该 OpenAI 流式分支没有明确调用 `response.aclose()`，因此不把它作为取消上游的完整范本。

### Helicone

- 仓库：[Helicone/helicone](https://github.com/Helicone/helicone)，核对提交：`67df07b8d807a960f2e53d9ec2a9c49513ca2379`。
- [`ReadableInterceptor.ts`](https://github.com/Helicone/helicone/blob/67df07b8d807a960f2e53d9ec2a9c49513ca2379/worker/src/lib/util/ReadableInterceptor.ts) 在每次 `reader.read()` 后先 `controller.enqueue(value)`，再执行首块计时、解码和监控；数据库日志通过 Cloudflare `waitUntil` 脱离响应热路径。
- 其取消分支会尝试取消上游 stream，但该 stream 已由 `getReader()` 锁定，代码调用的是 `stream.cancel(reason)` 而非 `reader.cancel(reason)`，存在 Web Streams 锁定语义疑点，不能直接照搬。
- LiteLLM 与 Helicone 的共同可用结论是：首个上游原始字节应先进入下游写队列，统计和完整内容重建不得成为转发前置条件。

### 当前由外部实现导出的候选修复

1. 对已确认支持压缩的 Sub2API 大型 Codex JSON 请求启用请求体 gzip，减少网关到中转站的上传字节。
2. H2 多会话分片保留为次级候选；本地限速 mock 证明它能减少并发排队，但收益不足以单独解释 5 秒差。

## 2026-08-07 实证结果与当前修改

### H2 单会话与双会话限速 mock

- 本地 TLS/H2 服务端前增加每 TCP 连接 `256 KiB/s` 的上传限速，先发 1 MiB 请求，再发 1 KiB 请求。
- 单 H2 会话：大请求约 `4383ms`，小请求首包约 `268ms`。
- 两个独立 H2 Agent：大请求约 `4345ms`，小请求首包约 `48ms`。
- 分片减少小请求约 `220ms`，证明 New API 的方案确实能降低并发排队；但大请求自身上传仍约 4.35 秒，因此它不是当前 1～5 秒差的主要修复。

### Lucen gzip 能力探针（无模型调用）

- 通过当前 AgentGate 向 Lucen `/responses` 提交 gzip 压缩的 `{}`，没有提供模型名（对应公开 Sub2API 的 [`body.go`](https://github.com/Wei-Shaw/sub2api/blob/32e4de79420f747ddef741e15474ff5e6515000a/backend/internal/pkg/httputil/body.go) 解压路径）。
- 实例返回 `400` 与 `model is required`，证明线上实例已成功解压并进入 JSON 字段校验；该请求在模型调度前结束，不生成 token。
- 因此可以仅对已验证的 `https://lucen.cc` Codex `/responses` 启用请求 gzip，不对其他兼容上游推断支持。

### gzip 成本与体积

- 使用 Node `gzipSync(..., Z_BEST_SPEED)` 模拟 Codex JSON：
  - 256 KiB：压到 29.7%，约 3.5ms。
  - 512 KiB：压到 28.9%，约 4.5ms。
  - 1 MiB：压到 28.7%，约 8ms。
  - 2 MiB：压到 28.6%，约 18.6ms。
- 在 `256 KiB/s` 上传下，1 MiB 可由约 4 秒缩短到约 1.15 秒，节省约 2.85 秒，量级与现象一致。

### 已实施与验证

- `electron/services/gateway-service.cjs`：只对 `lucen.cc`、只对 64 KiB 以上、只对尚未带 `Content-Encoding` 的 Codex Responses 请求使用最快级 gzip；无收益或压缩失败时原样发送。
- 压缩后同步更新 `Content-Encoding: gzip` 与 `Content-Length`；原始请求体仍用于本地元数据提取。
- `tests/gateway-service.test.mjs`：新增压缩阈值、域名约束、可逆解压测试；针对性测试已通过。

### 当前运行状态

- 已完成完整相关测试（全套 `423 passed / 1 skipped`）、`pnpm build` 和 Windows portable/NSIS 打包。
- 当前运行版本：`release-next-gzip/win-unpacked/AgentGate.exe`，已监听 `127.0.0.1:17863`；旧 `release-next-h2-warm` 进程已停止。
- 运行态 256 KiB 无模型 gzip 路径探针返回 `400 model is required`，没有发起模型生成请求。

## 当前目标

优先把 Codex `/responses` 经本地网关后的额外首字延迟压到 0.5 秒内；先用本地 mock 分段测量，再做最小修改。不发真实上游请求试错。

## 已确认事实

- 历史记录 `40e81fd9-656c-4b5a-bb80-f8f8ae20b1a1`：`firstByteLatencyMs=10359`、`firstTokenLatencyMs=10558`、`durationMs=35045`。
- 该请求上游为 `https://lucen.cc/responses`，`protocol=openai-responses`，`streaming=true`，`upstreamHttpVersion="2.0"`。
- 因此该样本不能归因于 HTTP/1.1；首字指标内部还存在约 199ms 的“首字节→首有效 Responses 事件”间隔。
- 当前 `/responses` 路径会完整读请求体，并在必要时 JSON 改写 `stream`/`instructions`；Codex HTTPS 路径使用 `http2-wrapper.auto` 与自建 Agent/预热逻辑。
- 当前 monitor 的 `durationMs` 从客户端请求开始算，首字从 `upstreamRequest.finish` 后的计时点算；这两个口径不同。

## 待验证的三个阶段

1. 请求体读完、JSON 解析/重编码耗时。
2. H2 ALPN/会话获取和上游请求写完到响应头耗时。
3. 上游首帧到网关下游真正可读之间是否被监控解析或 pipeline 阻塞。

## 下一步（可重复、无真实付费请求）

- 用本地 HTTP/1.1 与 HTTPS/H2 mock 记录：收到请求、请求体 end、上游 request finish、response、首 data、首有效 SSE 事件、客户端首 data。
- 若 mock 证明改写是主要开销：对已经 `stream:true` 且已有有效 `instructions` 的请求走原始字节快路径；只在确实需要兼容时重编码。
- 若 mock 证明 H2 预热增加等待：移除请求级等待或改为后台预热，保留连接复用。
- 若 mock 证明下游转发被阻塞：确保先写响应头/flush，再做监控旁路解析，且旁路不得同步阻塞 data 转发。

## 修改/验证规则

- 只改与上述阶段直接相关的代码。
- 先补回归测试，再运行针对性 Vitest，最后 `pnpm build`。
- 不回滚工作树中用户已有的其他改动。

## 2026-08-07 18:36 最新 Sol 样本（已逐条对齐）

- 网关记录 `1fbc04a0-8771-449c-ab9d-1ff7f232fc86`：`gpt-5.6-sol`，上游为 `https://lucen.plus/responses`、HTTP/2、输入 `229,571` token、响应 `695,382` 字节。
- 中转站同一请求：首字 `16.60s`、总耗时 `90.00s`。
- 网关同一请求：首包/首 token `18.249s`、总耗时 `99.903s`。
- 可计算的实际差额：首字前 `+1.649s`；首字后流式尾部为中转站 `73.40s`、网关 `81.654s`，额外 `+8.254s`；总计 `+9.903s`。因此这条的总耗时差主要发生在首字之后，不能用大请求上传单独解释。

### 直接发现与修复状态

- 此样本实际走 `lucen.plus`，而此前请求 gzip 仅精确放行 `lucen.cc`，故该请求没有被压缩。这解释首字前的一部分差距，但不能单独解释首字后的 `8.254s`。
- 旧网关代码对所有上游强制 `Accept-Encoding: identity`；这会让该 `695KB` SSE 回包以未压缩形态跨公网传输，是首字后额外耗时的当前最强代码级候选。
- 已用当前运行中的已授权网关把 gzip 的 `{}` 转发至 `lucen.plus/responses`；返回 `400 model is required`，表明实例已解压并进入 JSON 字段校验，未进入模型调度。
- 源码已改为同时允许 `lucen.cc` 与 `lucen.plus` 的大 Codex 请求 gzip；Codex Responses 上游改为协商 `Accept-Encoding: gzip`，网关用流式 gunzip 后再转发给本地 Codex，以保留 SSE 监控和本地客户端兼容。
- 新增本地 gzip SSE 集成测试，确认首个解压事件在上游结束前已到达客户端、响应头不再错误保留 `Content-Encoding`、首 token 统计仍可用。针对性测试 `113/113`、完整测试 `424 passed / 1 skipped`、`pnpm build` 均通过。
- 已独立打包并切换运行到 `release-next-response-gzip/win-unpacked/AgentGate.exe`，旧 `release-next-gzip` 的四个进程已停止；新实例已监听 `127.0.0.1:17863`。
- 新运行包再以未压缩的 `256KiB`、缺少 `model` JSON 走 `lucen.plus` 路径验证，约 `205ms` 返回 `400 model is required`。该请求没有进入模型调度；真实流式线上对照仍待下一条 Codex 请求。

## 2026-08-07 19:20 当前观察与诊断包

- 用户最新对照显示：此前约 `10s` 的总耗时尾部差距目前未再出现；普通请求的首字与总耗时残差主要落在 `1–2s`，这不能视为已达到 `0.5s` 目标。
- `gateway-service.cjs` 已加入仅诊断的阶段数据：客户端请求体读完、上游请求写完、响应头、上游首字节、上游响应结束，以及请求/响应编码；不改变转发逻辑。
- 该诊断字段已通过完整测试 `425 passed / 1 skipped`、`pnpm build`，并随当前运行包保留；下一条真实请求后读取 `requests.json` 才能把残差归因到具体阶段。
- 当前运行包为 `release-next-ui-model/win-unpacked/AgentGate.exe`，监听 `127.0.0.1:17863`。本次 UI 调整只移除了动态行的值详情悬停提示，并将模型名字号调至 `15px`；不影响网关计时。

## 2026-08-07 19:42 字体统一后的运行态

- `--sans`、`--mono` 已收敛为现有 `--serif` 字体栈；动态模型、推理强度与渠道状态名/模型均为 `15px` 衬线字，数字对齐属性保留。
- 浏览器烟测通过：宽屏与紧凑布局无溢出、四语切换无控制台错误；完整测试仍为 `425 passed / 1 skipped`。
- 当前运行包为 `release-next-font-unified/win-unpacked/AgentGate.exe`，监听 `127.0.0.1:17863`。
