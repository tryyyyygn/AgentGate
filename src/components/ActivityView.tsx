import {
  AlertCircle,
  CheckCircle2,
  CircleDot,
  LoaderCircle,
} from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { CLIENT_META } from "../config";
import { useI18n } from "../i18n";
import type { Messages } from "../i18n";
import { formatDuration, formatTokenCount, formatTokenCountFull } from "../lib/format";
import { cacheRateTier, responseLatencyTier } from "../lib/health";
import { RollingNumber } from "./RollingNumber";
import { ModelName } from "./ModelName";
import type { ActiveRequest, ClientTarget } from "../types";
import type { RequestFilter } from "../ui-types";

interface RequestMeta {
  label: string;
  tint: string;
  icon: "loader" | "dot" | "check" | "alert";
  breathe?: boolean;
  spin?: boolean;
}

function requestMeta(m: Messages): Record<ActiveRequest["state"], RequestMeta> {
  const s = m.stream.states;
  return {
    connecting: { label: s.connect, tint: "tint-accent", icon: "loader", spin: true },
    "waiting-first-token": { label: s.wait, tint: "tint-accent", icon: "loader", spin: true },
    streaming: { label: s.stream, tint: "tint-good", icon: "dot", breathe: true },
    completed: { label: s.done, tint: "tint-complete", icon: "check" },
    failed: { label: s.fail, tint: "tint-bad", icon: "alert" },
    aborted: { label: s.abort, tint: "tint-warn", icon: "dot" },
    cancelled: { label: s.cancel, tint: "tint-warn", icon: "dot" },
  };
}

/** 最多渲染多少行。数据仍保留三天，这里只是渲染窗口。 */
const MAX_VISIBLE_ROWS = 50;

const REASONING_LABEL: Record<string, string> = {
  minimal: "MIN",
  low: "LOW",
  medium: "MED",
  high: "HIGH",
  xhigh: "MAX",
  max: "MAX",
  ultra: "ULTRA",
};

function formatReasoningEffort(value?: string): string {
  const normalized = value?.trim().toLocaleLowerCase();
  if (!normalized) return "DEFAULT";
  return REASONING_LABEL[normalized] ?? normalized.toLocaleUpperCase();
}

function uncachedInputTokens(tokens?: ActiveRequest["tokenUsage"]): number | undefined {
  const input = tokens?.inputTokens;
  if (input === undefined || !Number.isFinite(input)) return undefined;
  const cached = Number.isFinite(tokens?.cachedTokens) ? tokens?.cachedTokens ?? 0 : 0;
  const cacheWrite = Number.isFinite(tokens?.cacheWriteTokens) ? tokens?.cacheWriteTokens ?? 0 : 0;
  return Math.max(0, input - cached - cacheWrite);
}

function clientLabel(client: ActiveRequest["client"]): string {
  return client in CLIENT_META
    ? CLIENT_META[client as ClientTarget].label
    : String(client);
}

/** 客户端品牌色类：Claude 橙 / Codex 绿 / Gemini 蓝 / OpenCode 紫。 */
function clientTone(client: ActiveRequest["client"]): string {
  return client in CLIENT_META
    ? `tone-${CLIENT_META[client as ClientTarget].tone}`
    : "";
}

/**
 * 缓存命中率 = 命中的提示 token ÷ 全部提示 token。
 *
 * inputTokens 已在主进程归一化成「含缓存读写的全部提示 token」，三家口径一致，
 * 正常情况下比值落在 0–1；展示层仍做边界保护，避免损坏或异常上游数据撑破布局。
 */
function cacheRate(request: ActiveRequest): number | undefined {
  const input = request.tokenUsage?.inputTokens;
  const cached = request.tokenUsage?.cachedTokens;
  if (input === undefined || cached === undefined || !Number.isFinite(input) || input <= 0) {
    return undefined;
  }
  return Math.max(0, Math.min(100, (cached / input) * 100));
}

function formatClock(value: string, clock: Intl.DateTimeFormat): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--" : clock.format(date);
}

function isActive(request: ActiveRequest): boolean {
  return !request.completedAt
    && ["connecting", "waiting-first-token", "streaming"].includes(request.state);
}

function matchesFilter(request: ActiveRequest, filter: RequestFilter): boolean {
  if (filter === "active") return isActive(request);
  if (filter === "completed") return request.outcome === "completed";
  if (filter === "failed") return ["failed", "aborted", "cancelled"].includes(request.outcome ?? "");
  return true;
}

function RequestStateIcon({ meta }: { meta: RequestMeta }): ReactElement {
  if (meta.icon === "loader") return <LoaderCircle size={15} className={meta.spin ? "spin" : ""} />;
  if (meta.icon === "check") return <CheckCircle2 size={15} />;
  if (meta.icon === "alert") return <AlertCircle size={15} />;
  return <CircleDot size={15} />;
}

interface RequestRowProps {
  request: ActiveRequest;
  /** 已完成的行这是个定值；只有还在跑的行会每秒变一次。 */
  elapsed?: number;
  state: RequestMeta;
  m: Messages;
  clock: Intl.DateTimeFormat;
}

/**
 * 一条请求。memo 包着，因为秒表每秒跳一次。
 *
 * 跳的只有还在跑的那几行，可原本每跳一次都要把 50 行、七千多个节点整个对账一遍。
 * 已完成的行 props 一个字都没变——request 对象的引用也是稳的（见
 * mergeActiveRequests：增量通知按 id 就地替换，没变的行还是原来那个对象），
 * 所以 memo 能实打实地把它们全部跳过。
 */
const RequestRow = memo(function RequestRow({
  request, elapsed, state, m, clock,
}: RequestRowProps): ReactElement {
  // 流式请求以首个生成信号（含隐藏推理开始）为首字时延。
  const contentTiming = request.streaming === true;
  const firstLatency = contentTiming ? request.firstTokenLatencyMs : request.firstByteLatencyMs;
  const firstLabel = contentTiming ? m.stream.firstToken : m.stream.firstByte;
  const transport = request.streaming === true
    ? m.stream.streamMode
    : request.streaming === false ? m.stream.syncMode : undefined;
  const transportClass = request.streaming === true ? "streaming" : request.streaming === false ? "sync" : "";
  const reasoning = formatReasoningEffort(request.reasoningEffort);
  const tokens = request.tokenUsage;
  const uncachedInput = uncachedInputTokens(tokens);
  const rate = cacheRate(request);
  // 行里是缩写，悬停补充口径
  const tokenBreakdown = tokens
    ? [
      `↓ ${m.stream.tipIn} ${formatTokenCountFull(uncachedInput)}`,
      `↑ ${m.stream.tipOut} ${formatTokenCountFull(tokens.outputTokens)}`,
      `C ${m.stream.tipCache} ${formatTokenCount(tokens.cachedTokens)}`,
      `W ${m.stream.tipWrite} ${formatTokenCount(tokens.cacheWriteTokens)}`,
      `R ${m.stream.tipReason} ${formatTokenCountFull(tokens.reasoningTokens)}`,
    ].join("\n")
    : undefined;

  return (
    <article className="request-row">
      <span
        className={`request-state-icon ${state.tint} ${state.breathe ? "breathe" : ""}`}
        role="img"
        aria-label={state.label}
      >
        <RequestStateIcon meta={state} />
      </span>
      <span className="request-main">
        <span className="request-title">
          <strong>{request.profileName}</strong>
          <small className={`tag-client ${clientTone(request.client)}`}>
            {clientLabel(request.client)}
          </small>
        </span>
      </span>
      <span className={`request-transport${transportClass ? ` ${transportClass}` : ""}`}>
        <strong>{transport ?? "———"}</strong>
      </span>
      <span className="request-model">
        <code data-hint={request.model}><ModelName value={request.model} /></code>
      </span>
      <span className="request-reasoning">
        <strong>{reasoning}</strong>
      </span>
      <span className="request-tokens">
        <span className="tok-io">
          <RollingNumber className="tok-in" value={`↓${formatTokenCountFull(uncachedInput)}`} />
          <RollingNumber className="tok-out" value={`↑${formatTokenCountFull(tokens?.outputTokens)}`} />
        </span>
        {/*
          四个口径一起列，谁也不顶替谁。
          C 是缓存命中（便宜），W 是缓存写入（按 1.25× 计费，最贵的一次），
          R 是推理 token——它已经含在 ↑ 输出里了，单列只为让你看见钱花在哪。
        */}
        <small className="tok-detail" data-hint={tokenBreakdown}>
          <RollingNumber as="span" className="tok-cache" value={`C ${formatTokenCount(tokens?.cachedTokens)}`} />
          <RollingNumber as="span" className="tok-write" value={`W ${formatTokenCount(tokens?.cacheWriteTokens)}`} />
          <RollingNumber as="span" className="tok-reason" value={`R ${formatTokenCountFull(tokens?.reasoningTokens)}`} />
        </small>
      </span>
      <span className="cache-rate">
        <RollingNumber
          className={cacheRateTier(rate)}
          value={rate === undefined ? "———" : (rate / 100).toFixed(3)}
        />
        <small>{m.stream.cache}</small>
      </span>
      <span className="request-timing">
        <RollingNumber ticker value={formatDuration(elapsed)} />
        <small>
          {firstLabel}{" "}
          <span className={responseLatencyTier(firstLatency)}>{formatDuration(firstLatency)}</span>
        </small>
      </span>
      <time className="request-time" dateTime={request.startedAt}>
        {formatClock(request.startedAt, clock)}
      </time>
    </article>
  );
});

interface ActivityViewProps {
  requests: ActiveRequest[];
  active?: boolean;
}

/**
 * 动态页：网关转发的实时请求流。
 *
 * 展示进行中与最近完成的请求，含模型、Token、缓存率与时延指标。
 */
export function ActivityView({ requests, active = true }: ActivityViewProps): ReactElement {
  const { locale, m, fill } = useI18n();
  const [filter, setFilter] = useState<RequestFilter>("all");
  const [now, setNow] = useState(() => Date.now());
  const activeCount = requests.filter(isActive).length;
  const matched = useMemo(
    () => requests.filter((request) => matchesFilter(request, filter)),
    [filter, requests],
  );
  // 记录完整保留三天，但只渲染最近这些。每行有六个滚轮读数、
  // 每个读数又是若干字位，全渲染会堆出几万个节点并让每次 300ms 的计时刷新
  // 扫过全部——数据不动，只收窄渲染窗口。
  const visibleRequests = useMemo(() => matched.slice(0, MAX_VISIBLE_ROWS), [matched]);
  const hiddenCount = matched.length - visibleRequests.length;
  const meta = useMemo(() => requestMeta(m), [m]);
  const clock = useMemo(() => new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }), [locale]);

  useEffect(() => {
    if (!active || activeCount === 0) return undefined;
    let timer: number | undefined;
    const syncTimer = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
      if (document.visibilityState !== "visible") return;
      setNow(Date.now());
      timer = window.setInterval(() => setNow(Date.now()), 1_000);
    };
    document.addEventListener("visibilitychange", syncTimer);
    syncTimer();
    return () => {
      document.removeEventListener("visibilitychange", syncTimer);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [active, activeCount]);

  const liveText = activeCount > 0 ? fill(m.stream.streaming, { count: activeCount }) : m.stream.idle;

  return (
    <main className="page-scroll activity-page" aria-label={m.stream.title} hidden={!active}>
      <div className="page-inner">
        <div className="section-head rise sticky-head" style={{ alignItems: "center" }}>
          <h1>{m.stream.title}</h1>
          <span className="head-note">
            <span key={liveText} className="swap-text">{liveText}</span> · {m.stream.retained}
          </span>
          <span style={{ marginLeft: "auto" }} />
          {(
            <div className="req-filters" role="radiogroup" aria-label={m.stream.title}>
              {([
                ["all", m.stream.all],
                ["active", m.stream.live],
                ["completed", m.stream.done],
                ["failed", m.stream.fail],
              ] as Array<[RequestFilter, string]>).map(([value, label]) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={filter === value}
                  className={filter === value ? "active" : ""}
                  key={value}
                  onClick={() => setFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          {visibleRequests.map((request) => {
            const startedAt = new Date(request.startedAt).getTime();
            /*
             * 已完成的行 elapsed 就是它的 durationMs——一个定值，跟 now 无关。
             * 所以秒表每秒跳一次时，只有还在跑的那几行 props 变了，其余的
             * 被 memo 挡在外面，不会重渲。
             */
            const elapsed = request.durationMs ?? (
              isActive(request) && Number.isFinite(startedAt)
                ? Math.max(0, now - startedAt)
                : undefined
            );
            return (
              <RequestRow
                key={request.id}
                request={request}
                elapsed={elapsed}
                state={meta[request.state]}
                m={m}
                clock={clock}
              />
            );
          })}
          {visibleRequests.length === 0 && (
            <p className="feed-empty">
              {requests.length === 0 ? m.stream.empty : m.stream.noMatch}
            </p>
          )}
          {hiddenCount > 0 && (
            <p className="feed-empty">
              {fill(m.stream.capped, { shown: visibleRequests.length, hidden: hiddenCount })}
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
