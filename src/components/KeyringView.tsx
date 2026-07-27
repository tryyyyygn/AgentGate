import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Copy,
  CopyPlus,
  Gauge,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { DragEvent as ReactDragEvent, ReactElement } from "react";
import { CLIENT_META, PROTOCOL_META } from "../config";
import { useI18n } from "../i18n";
import type { Messages } from "../i18n";
import { cacheRateTier, getEndpointMetrics, getHealthBarTone, LIMITED_LATENCY_MS } from "../lib/health";
import { RollingNumber } from "./RollingNumber";
import type { EndpointMetrics } from "../lib/health";
import { formatTokenCount, relativeTime } from "../lib/format";
import { useFlipList } from "../lib/useFlipList";
import type { ClientTarget, GatewayState, Profile, ProfileEndpoint } from "../types";
import type { BusyAction } from "../ui-types";

const BAR_FILL = {
  healthy: "var(--good)",
  limited: "var(--warn)",
  failed: "var(--bad)",
} as const;

const MAX_BARS = 24;

/** 并列项分隔符：中日用顿号，英文用逗号。 */
const LIST_SEPARATOR: Record<string, string> = { zh: "、", "zh-TW": "、", ja: "、", en: ", " };

/** 24 小时健康时间线：最近样本映射为红黄绿柱状图。 */
function HealthBars({ endpoint, label }: { endpoint?: ProfileEndpoint; label: string }): ReactElement {
  const samples = (endpoint?.healthTimeline?.length
    ? endpoint.healthTimeline
    : endpoint?.healthHistory ?? []).slice(-MAX_BARS);
  if (samples.length === 0) {
    return (
      <svg className="health-bars" viewBox="0 0 180 40" preserveAspectRatio="none" role="img" aria-label={label}>
        <path d="M2 38 H178" stroke="var(--line)" strokeWidth="1.5" />
      </svg>
    );
  }
  const latencies = samples
    .map((sample) => sample.latencyMs)
    .filter((latency): latency is number => Number.isFinite(latency));
  const ceiling = Math.max(LIMITED_LATENCY_MS, ...latencies);
  const bars = samples.map((sample, index) => {
    const tone = getHealthBarTone(sample);
    const latency = Number.isFinite(sample.latencyMs) ? sample.latencyMs ?? ceiling : ceiling * .65;
    const normalized = Math.min(Math.max(latency / ceiling, 0), 1);
    const height = tone === "failed" ? 8 : Math.round(10 + (1 - normalized) * 18);
    return { tone, height, index, key: `${sample.checkedAt}-${index}` };
  });
  return (
    <svg
      className="health-bars animate"
      viewBox="0 0 180 40"
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      {bars.map((bar) => (
        <rect
          key={bar.key}
          x={Math.round((bar.index * 7.5 + 1.65) * 10) / 10}
          y={38 - bar.height}
          width="4.2"
          height={bar.height}
          rx="1.4"
          fill={BAR_FILL[bar.tone]}
          style={{ animationDelay: `${bar.index * 12}ms` }}
        />
      ))}
    </svg>
  );
}

function healthSummary(profile: Profile, m: Messages): { label: string; className: string } {
  const status = profile.health?.status ?? "unknown";
  if (status === "healthy") return { label: `${profile.health?.latencyMs ?? 0} ms`, className: "good" };
  if (status === "limited") return { label: m.keys.limited, className: "warn" };
  if (status === "unhealthy") return { label: m.keys.down, className: "bad" };
  return { label: "———", className: "unknown" };
}

function endpointDot(endpoint: ProfileEndpoint): string {
  const status = endpoint.health?.status;
  if (status === "healthy") return "dot-good";
  if (status === "limited") return "dot-warn";
  if (status === "unhealthy") return "dot-bad";
  return "dot-unknown";
}

/** 累计平均缓存率：累计缓存命中 ÷ 累计输入，返回 0–1 的比值。 */
function cumulativeCacheRate(profile: Profile): number | undefined {
  const input = profile.tokenInputTotal;
  const cached = profile.tokenCachedTotal;
  if (!input || cached === undefined || !Number.isFinite(input) || !Number.isFinite(cached)) {
    return undefined;
  }
  // 分母已归一化成「含缓存读写的全部提示 token」，比值天然 ≤ 1，不必再夹
  return cached / input;
}

function endpointLatency(endpoint: ProfileEndpoint, m: Messages): string {
  if (endpoint.health?.status === "healthy" || endpoint.health?.status === "limited") {
    return `${endpoint.health.latencyMs ?? 0} ms`;
  }
  return endpoint.health ? m.keys.down : "———";
}

interface KeyringViewProps {
  profiles: Profile[];
  gateway: GatewayState;
  busy: BusyAction | null;
  busyId?: string;
  loading: boolean;
  error?: string;
  onCreate: () => void;
  onEdit: (profile: Profile) => void;
  onDuplicate: (profile: Profile) => Promise<Profile | undefined>;
  onDelete: (profile: Profile) => void;
  onApply: (id: string, targets: ClientTarget[]) => void;
  onTest: (id: string) => void;
  onTestAll: () => void;
  /** 正在检测端点的方案 ID；检测不锁定其他操作。 */
  testingIds: ReadonlySet<string>;
  onDiscoverModels: (id: string) => void;
  onProbe: (id: string) => void;
  onCopyKey: (profile: Profile) => void;
  onReorder: (ids: string[]) => void;
  onRetry: () => void;
  active?: boolean;
}

/**
 * 密钥页：以可展开、可拖拽排序的列表管理全部连接方案。
 *
 * 行首展示健康时间线、累计 Token 与统计；行尾提供一键切换与检测；
 * 展开后可查看端点明细、密钥摘要并执行编辑/复制/删除。
 */
export function KeyringView({
  profiles,
  gateway,
  busy,
  busyId,
  loading,
  error,
  onCreate,
  onEdit,
  onDuplicate,
  onDelete,
  onApply,
  onTest,
  onTestAll,
  testingIds,
  onDiscoverModels,
  onProbe,
  onCopyKey,
  onReorder,
  onRetry,
  active = true,
}: KeyringViewProps): ReactElement {
  const { locale, m, fill } = useI18n();
  const [expandedId, setExpandedId] = useState<string>();
  const [dragId, setDragId] = useState<string>();
  const [dragOverId, setDragOverId] = useState<string>();
  const gatewayOn = gateway.status === "running" || gateway.status === "starting";
  const listRef = useFlipList(profiles.map((profile) => profile.id));

  useEffect(() => {
    if (!expandedId) return undefined;
    function handleKey(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setExpandedId(undefined);
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [expandedId]);

  useEffect(() => {
    setExpandedId((current) => current && profiles.some((profile) => profile.id === current)
      ? current
      : undefined);
  }, [profiles]);

  function handleDrop(event: ReactDragEvent<HTMLElement>, targetId: string): void {
    event.preventDefault();
    const sourceId = dragId;
    setDragId(undefined);
    setDragOverId(undefined);
    if (!sourceId || sourceId === targetId) return;
    const ids = profiles.map((profile) => profile.id).filter((id) => id !== sourceId);
    const insertAt = ids.indexOf(targetId);
    if (insertAt === -1) return;
    ids.splice(insertAt, 0, sourceId);
    onReorder(ids);
  }

  async function handleDuplicate(profile: Profile): Promise<void> {
    const duplicate = await onDuplicate(profile);
    if (duplicate) setExpandedId(duplicate.id);
  }

  return (
    <main className="page-scroll" aria-label={m.keys.title} hidden={!active}>
      <div className="page-inner">
        <div className="section-head rise">
          <h1>{m.keys.title}</h1>
          <span className="head-note">{fill(m.keys.subtitle, { count: profiles.length })}</span>
          <button
            type="button"
            className="ghost-pill"
            style={{ marginLeft: "auto" }}
            title={m.keys.testEndpoints}
            disabled={profiles.length === 0 || testingIds.size > 0}
            onClick={onTestAll}
          >
            {testingIds.size > 0
              ? <LoaderCircle size={13} className="spin" />
              : <Gauge size={13} />}
            {m.keys.testAll}
          </button>
          <button
            type="button"
            className="primary-pill"
            style={{ marginLeft: 0 }}
            disabled={Boolean(busy)}
            onClick={onCreate}
          >
            <Plus size={13} />{m.keys.create}
          </button>
        </div>

        {loading && profiles.length === 0 ? (
          <div className="empty-state">
            <LoaderCircle size={24} className="spin" />
            <h2>{m.keys.loading}</h2>
          </div>
        ) : error && profiles.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon error-icon"><AlertCircle size={22} /></div>
            <h2>{m.keys.loadError}</h2>
            <p>{error}</p>
            <button type="button" className="ghost-pill" onClick={onRetry}>
              <RefreshCw size={13} />{m.keys.retry}
            </button>
          </div>
        ) : profiles.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon"><KeyRound size={22} /></div>
            <h2>{m.keys.emptyTitle}</h2>
            <p>{m.keys.emptyHint}</p>
            <button type="button" className="primary-pill" onClick={onCreate}>
              <Plus size={13} />{m.keys.create}
            </button>
          </div>
        ) : (
          <div className="keyring-list" ref={listRef}>
            {profiles.map((profile, index) => {
              const expanded = expandedId === profile.id;
              const inUse = gateway.routes.some((route) => route.profileId === profile.id);
              const tone = PROTOCOL_META[profile.protocol].tone;
              const summary = healthSummary(profile, m);
              const activeEndpoint = profile.endpoints
                .find((endpoint) => endpoint.url === profile.baseUrl) ?? profile.endpoints[0];
              const metrics: EndpointMetrics = activeEndpoint
                ? getEndpointMetrics(activeEndpoint)
                : { sampleCount: 0 };
              const cacheRate = cumulativeCacheRate(profile);
              const testing = testingIds.has(profile.id);
              const discovering = busy === "test" && busyId === profile.id;
              const probing = busy === "probe" && busyId === profile.id;
              const applying = busy === "apply" && busyId === profile.id;
              const rowClass = [
                "keyring-row",
                dragId === profile.id ? "dragging" : "",
                dragOverId === profile.id && dragId !== profile.id ? "drag-over" : "",
              ].filter(Boolean).join(" ");
              return (
                <article
                  className={rowClass}
                  key={profile.id}
                  data-flip-id={profile.id}
                  style={{ animationDelay: `${60 + index * 50}ms` }}
                  draggable={!busy}
                  onDragStart={(event) => {
                    setDragId(profile.id);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", profile.id);
                  }}
                  onDragOver={(event) => {
                    if (!dragId || dragId === profile.id) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    setDragOverId(profile.id);
                  }}
                  onDragLeave={() => {
                    setDragOverId((current) => current === profile.id ? undefined : current);
                  }}
                  onDrop={(event) => handleDrop(event, profile.id)}
                  onDragEnd={() => {
                    setDragId(undefined);
                    setDragOverId(undefined);
                  }}
                >
                  <div className="keyring-head">
                    <button
                      type="button"
                      className="keyring-open"
                      aria-expanded={expanded}
                      aria-label={fill(m.keys.expand, { name: profile.name })}
                      onClick={() => setExpandedId(expanded ? undefined : profile.id)}
                    >
                      <span className={`keyring-glyph ${inUse ? "on" : ""}`}>
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="keyring-name">
                        <span className="keyring-name-line">
                          <strong>{profile.name}</strong>
                          {inUse && (
                            <small className={`tag-inuse ${gatewayOn ? "pulse" : ""}`}>{m.keys.active}</small>
                          )}
                        </span>
                        <span className="keyring-meta-line">
                          <code className="keyring-meta">
                            {PROTOCOL_META[profile.protocol].short.toUpperCase()} · {profile.baseUrl.replace(/^https?:\/\//, "")} · {profile.keyHint}
                          </code>
                          <span className="keyring-targets" aria-hidden="true">
                            {profile.targets.map((target) => (
                              <i
                                key={target}
                                className={`tone-${CLIENT_META[target].tone}`}
                                title={CLIENT_META[target].label}
                              />
                            ))}
                          </span>
                        </span>
                      </span>
                      <span className="keyring-usage">
                        <RollingNumber value={formatTokenCount(profile.tokenUsageTotal ?? 0)} />
                        <small>{m.keys.tokens}</small>
                      </span>
                      <span className="keyring-usage">
                        <RollingNumber
                          className={cacheRateTier(cacheRate === undefined ? undefined : cacheRate * 100)}
                          value={cacheRate === undefined ? "———" : `${(cacheRate * 100).toFixed(1)}%`}
                        />
                        <small>{m.keys.cache}</small>
                      </span>
                      <HealthBars endpoint={activeEndpoint} label={m.keys.awaitingSamples} />
                      <span className="keyring-stat">
                        <RollingNumber as="strong" className={summary.className} value={summary.label} />
                        <small>
                          {metrics.sampleCount > 0
                            ? fill(m.keys.statLine, {
                              availability: metrics.availability ?? 0,
                              latency: metrics.averageLatencyMs === undefined
                                ? "———"
                                : `${metrics.averageLatencyMs}ms`,
                            })
                            : m.keys.awaitingSamples}
                        </small>
                      </span>
                    </button>
                    <span className="keyring-tools">
                      <button
                        type="button"
                        className="icon-ghost"
                        title={inUse ? m.keys.inUseHint : fill(m.keys.switchTo, { name: profile.name })}
                        aria-label={fill(m.keys.switchTo, { name: profile.name })}
                        disabled={Boolean(busy)}
                        onClick={(event) => {
                          event.stopPropagation();
                          onApply(profile.id, [...profile.targets]);
                        }}
                      >
                        {applying
                          ? <LoaderCircle size={14} className="spin" />
                          : <Zap size={14} fill={inUse ? "currentColor" : "none"} className={inUse ? "tier-good" : ""} />}
                      </button>
                      <button
                        type="button"
                        className="icon-ghost"
                        title={m.keys.testEndpoints}
                        aria-label={m.keys.testEndpoints}
                        disabled={testing}
                        onClick={(event) => {
                          event.stopPropagation();
                          onTest(profile.id);
                        }}
                      >
                        {testing ? <LoaderCircle size={14} className="spin" /> : <Gauge size={14} />}
                      </button>
                      <button
                        type="button"
                        className="icon-ghost"
                        title={m.keys.probeHint}
                        aria-label={`${m.keys.probe} ${profile.name}`}
                        disabled={Boolean(busy)}
                        onClick={(event) => {
                          event.stopPropagation();
                          onProbe(profile.id);
                        }}
                      >
                        {probing ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}
                      </button>
                      {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                    </span>
                  </div>
                  <div className={`keyring-expand ${expanded ? "open" : ""}`}>
                    <div>
                      <div className="keyring-detail">
                        <div style={{ minWidth: 0 }}>
                          <div className="endpoint-table">
                            {profile.endpoints.map((endpoint) => (
                              <div
                                className={`endpoint-line ${endpoint.url === profile.baseUrl ? "active" : ""}`}
                                title={endpoint.health?.message ?? endpoint.url}
                                key={endpoint.url}
                              >
                                <i className={endpointDot(endpoint)} />
                                <code>{endpoint.url}</code>
                                <small>{endpointLatency(endpoint, m)}</small>
                                <small>{endpoint.models.length} {m.keys.models}</small>
                              </div>
                            ))}
                          </div>
                          {profile.availableModels.length > 0 && (
                            <div className="model-chips">
                              {profile.availableModels.map((model) => (
                                <code key={model}>{model}</code>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="assign-col">
                          <dl className="keyring-facts" style={{ margin: 0 }}>
                            <dt>{m.keys.key}</dt>
                            <dd className="with-copy">
                              <code>{profile.keyHint}</code>
                              <button
                                type="button"
                                className="icon-mini"
                                title={m.keys.copyKey}
                                aria-label={m.keys.copyKey}
                                disabled={Boolean(busy)}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onCopyKey(profile);
                                }}
                              >
                                <Copy size={12} />
                              </button>
                            </dd>
                            {profile.protocol === "anthropic" && (
                              <>
                                <dt>{m.keys.authHeader}</dt>
                                <dd>{profile.authMode === "bearer" ? "Bearer Token" : "x-api-key"}</dd>
                              </>
                            )}
                            <dt>{m.keys.targets}</dt>
                            <dd>
                              {profile.targets.map((target, targetIndex) => (
                                <span key={target}>
                                  {targetIndex > 0 && (LIST_SEPARATOR[locale] ?? ", ")}
                                  <b className={`tone-${CLIENT_META[target].tone}`} style={{ color: "var(--tone)", fontWeight: 650 }}>
                                    {CLIENT_META[target].short}
                                  </b>
                                </span>
                              ))}
                            </dd>
                            {/*
                              Token 拆解。READ 是缓存命中（便宜），WRITE 是缓存写入
                              （1.25× 计费）；REASONING 已含在输出里，单列只为看清钱花在哪。
                            */}
                            {(profile.tokenInputTotal || profile.tokenUsageTotal) ? (
                              <>
                                <dt>{m.keys.breakdown}</dt>
                                <dd>
                                  IN {formatTokenCount(profile.tokenInputTotal ?? 0)}
                                  {" · "}
                                  <span className="tier-good">
                                    READ {formatTokenCount(profile.tokenCachedTotal ?? 0)}
                                  </span>
                                  {profile.tokenCacheWriteTotal ? (
                                    <>
                                      {" · "}
                                      <span className="tier-warn">
                                        WRITE {formatTokenCount(profile.tokenCacheWriteTotal)}
                                      </span>
                                    </>
                                  ) : null}
                                  {profile.tokenReasoningTotal ? (
                                    <>
                                      {" · "}
                                      <span className="tier-info">
                                        REASONING {formatTokenCount(profile.tokenReasoningTotal)}
                                      </span>
                                    </>
                                  ) : null}
                                </dd>
                              </>
                            ) : null}
                            <dt>{m.keys.autoSwitch}</dt>
                            <dd>{profile.autoSwitch.enabled ? m.keys.autoSwitchOn : m.keys.autoSwitchOff}</dd>
                            <dt>{m.keys.lastApplied}</dt>
                            <dd>{relativeTime(profile.lastAppliedAt, locale, m.keys.never)}</dd>
                          </dl>
                          <span className="keyring-actions">
                            <button
                              type="button"
                              className="ghost-pill"
                              disabled={Boolean(busy)}
                              onClick={() => onDiscoverModels(profile.id)}
                            >
                              {discovering
                                ? <LoaderCircle size={12} className="spin" />
                                : <RefreshCw size={12} />}
                              {m.keys.discoverModels}
                            </button>
                            <button
                              type="button"
                              className="ghost-pill"
                              disabled={Boolean(busy)}
                              onClick={() => onEdit(profile)}
                            >
                              <Pencil size={12} />{m.keys.edit}
                            </button>
                            <button
                              type="button"
                              className="ghost-pill"
                              disabled={Boolean(busy)}
                              onClick={() => void handleDuplicate(profile)}
                            >
                              <CopyPlus size={12} />{m.keys.duplicate}
                            </button>
                            <button
                              type="button"
                              className="danger-pill"
                              disabled={Boolean(busy)}
                              onClick={() => onDelete(profile)}
                            >
                              <Trash2 size={12} />{m.keys.delete}
                            </button>
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
