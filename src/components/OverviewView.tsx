import { ArrowRight, ChevronDown, Repeat2, RotateCcw } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { CLIENT_META, CLIENT_TARGET_ORDER, PROTOCOL_META } from "../config";
import { useI18n } from "../i18n";
import {
  computeDivergence,
  formatDivergence,
  formatRate,
  formatTokenTotal,
  todayCacheRate,
  todayRequestCount,
  todayTokenTotal,
} from "../lib/divergence";
import type {
  ActiveRequest,
  ClientStatus,
  ClientTarget,
  GatewayState,
  HealthState,
  Profile,
} from "../types";
import { NixieTubes } from "./NixieTubes";
import { RollingNumber } from "./RollingNumber";

const HEALTH_DOT: Record<HealthState, string> = {
  healthy: "dot-good",
  limited: "dot-warn",
  unhealthy: "dot-bad",
  unknown: "dot-unknown",
};

/** 菜单底部要让开的空间：24px 页脚 + 一点呼吸。 */
const PICKER_GUTTER = 34;
/** 再挤也留这么高，否则菜单小到没法用，不如让它压住页脚。 */
const PICKER_MIN = 132;

/**
 * 鼠标滚轮一格在 Chromium 上是 100px 的大增量；触控板是一串几像素的小增量。
 * 用这个阈值把两者分开——只接管滚轮，触控板本来就是像素级平滑滚动，别插手。
 */
const WHEEL_NOTCH_MIN = 50;

/** 量一项有多高（含间距）。两项以上就用它们的间距，那才是真正的一格。 */
function itemStep(node: HTMLElement): number {
  const items = node.querySelectorAll<HTMLElement>(".picker-item");
  if (items.length >= 2) return items[1].offsetTop - items[0].offsetTop;
  return items[0]?.offsetHeight ?? 44;
}

/**
 * 方案菜单：最大高度按「卡片下方在当前窗口里还剩多少」现算，内部滚动。
 *
 * 写死一个 max-height 没用——窗口高度是用户随便拖的，卡片本身的 y 坐标又随
 * 仪表盘内容浮动。所以挂载时量一次，窗口尺寸变了再量。
 */
function PickerMenu({ label, children }: { label: string; children: ReactNode }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [maxHeight, setMaxHeight] = useState<number>();
  /** 滚动目标位。连着拨滚轮时得从上一次的目标接着算，而不是从还在路上的实时位置。 */
  const goal = useRef<number>(undefined);

  useLayoutEffect(() => {
    function measure(): void {
      const node = ref.current;
      if (!node) return;
      const top = node.getBoundingClientRect().top;
      setMaxHeight(Math.max(PICKER_MIN, window.innerHeight - top - PICKER_GUTTER));
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // 滚轮一格滚一项。系统默认一格 100px，在这个高度的菜单里一下就窜过去两三项。
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;

    function onWheel(event: WheelEvent): void {
      const menu = ref.current;
      if (!menu) return;
      const limit = menu.scrollHeight - menu.clientHeight;
      // 装得下就不拦：让滚轮事件冒上去滚页面
      if (limit <= 1 || Math.abs(event.deltaY) < WHEEL_NOTCH_MIN) return;
      event.preventDefault();
      const from = goal.current ?? menu.scrollTop;
      const next = Math.min(limit, Math.max(0, from + Math.sign(event.deltaY) * itemStep(menu)));
      goal.current = next;
      menu.scrollTo({ top: next, behavior: "smooth" });
    }
    // 滚停了就把目标交还给真实位置，免得跟键盘聚焦滚动之类的别的滚动源打架
    function onScrollEnd(): void {
      goal.current = undefined;
    }

    node.addEventListener("wheel", onWheel, { passive: false });
    node.addEventListener("scrollend", onScrollEnd);
    return () => {
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("scrollend", onScrollEnd);
    };
  }, []);

  return (
    <div className="picker-menu" role="menu" aria-label={label} ref={ref} style={{ maxHeight }}>
      {children}
    </div>
  );
}

interface OverviewViewProps {
  active?: boolean;
  profiles: Profile[];
  clients: ClientStatus[];
  gateway: GatewayState;
  /** 最近一小时的请求记录，用于窗口指标。 */
  requests: ActiveRequest[];
  activeRequestCount: number;
  busy: boolean;
  onApply: (id: string, target: ClientTarget) => void;
  /** 只接管这一个客户端。 */
  onEngage: (target: ClientTarget) => void;
  /** 只放掉这一个客户端。 */
  onRelease: (target: ClientTarget) => void;
  /** 恢复 Codex 官方登录模式并解除网关分配。 */
  onRestoreOfficial: () => void;
  onGoActivity: () => void;
}

/**
 * 概览页：DIVERGENCE METER 与客户端铭牌。
 *
 * 仪表三格各司其职：左边告诉你「该不该换线路」（分歧率），中间「省不省钱」
 * （缓存率），右边「用了多少」（累计 Token）。
 */
export function OverviewView({
  active = true,
  profiles,
  clients,
  gateway,
  requests,
  activeRequestCount,
  busy,
  onApply,
  onEngage,
  onRelease,
  onRestoreOfficial,
  onGoActivity,
}: OverviewViewProps): ReactElement {
  const { m, fill } = useI18n();
  const [pickerFor, setPickerFor] = useState<ClientTarget>();
  const [flashTarget, setFlashTarget] = useState<ClientTarget>();
  const flashTimer = useRef<number>(undefined);
  const gatewayOn = gateway.status === "running" || gateway.status === "starting";

  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  useEffect(() => {
    if (!active || !pickerFor) return undefined;
    function handleKey(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setPickerFor(undefined);
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [active, pickerFor]);

  function healthTag(profile: Profile): { text: string; className: string } {
    const status = profile.health?.status ?? "unknown";
    if (status === "healthy") return { text: `${profile.health?.latencyMs ?? 0} ms`, className: "tier-good" };
    if (status === "limited") return { text: m.keys.limited, className: "tier-warn" };
    if (status === "unhealthy") return { text: m.keys.down, className: "tier-bad" };
    return { text: "", className: "tier-quiet" };
  }

  function pick(profileId: string, target: ClientTarget): void {
    setPickerFor(undefined);
    onApply(profileId, target);
    setFlashTarget(target);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashTarget(undefined), 500);
  }

  const routeCount = gateway.routes
    .filter((route) => profiles.some((profile) => profile.id === route.profileId))
    .length;
  const divergence = computeDivergence(profiles, gateway);
  const cacheRate = todayCacheRate(requests);
  const cacheRequests = todayRequestCount(requests);
  const tokenToday = todayTokenTotal(profiles);
  const cacheText = formatRate(cacheRate);
  const tokenText = formatTokenTotal(tokenToday);

  const heroTitle = gateway.status === "starting"
    ? m.overview.heroStarting
    : gateway.status === "stopping"
      ? m.overview.heroStopping
      : gateway.status === "error"
        ? m.overview.heroFault
        : gatewayOn ? m.overview.heroOnline : m.overview.heroOffline;
  const heroSub = gateway.status === "error"
    ? gateway.error ?? m.overview.faultHint
    : gatewayOn
      ? fill(m.overview.routesBound, { routes: routeCount, profiles: profiles.length })
      : m.overview.directToUpstream;
  const liveText = activeRequestCount > 0
    ? fill(m.overview.streaming, { count: activeRequestCount })
    : m.overview.idle;

  return (
    <main className="page-scroll" aria-label={m.nav.overview} hidden={!active}>
      {active && pickerFor && (
        <button
          type="button"
          className="overlay-scrim"
          aria-label={m.editor.close}
          onClick={() => setPickerFor(undefined)}
        />
      )}
      <div className="page-inner">
        <section aria-label={m.gateway.online} className="hero rise">
          <h1 key={heroTitle} className="swap-text">{heroTitle}</h1>
          <p>
            <span key={heroSub} className="swap-text">{heroSub}</span>
            <button
              type="button"
              className={`live-link ${activeRequestCount > 0 ? "live" : ""}`}
              onClick={onGoActivity}
            >
              <i />
              <span key={liveText} className="swap-text">{liveText}</span>
              <ArrowRight size={11} />
            </button>
          </p>
        </section>

        <section className="meter rise-1" aria-label={m.overview.divergence}>
          <div className="meter-cell">
            <div className="meter-label">D I V E R G E N C E</div>
            <NixieTubes
              value={divergence ? formatDivergence(divergence.ratio) : undefined}
              tier={divergence?.tier}
              label={divergence
                ? fill(m.overview.baselineOf, {
                  current: divergence.currentMs,
                  baseline: divergence.baselineMs,
                  profile: divergence.profileName,
                })
                : m.overview.awaitingBaseline}
            />
            <div
              className={`meter-sub ${divergence?.tier === "critical"
                ? "tier-bad"
                : divergence?.tier === "diverging" ? "tier-warn" : ""}`}
            >
              {divergence
                ? fill(m.overview.baselineOf, {
                  current: divergence.currentMs,
                  baseline: divergence.baselineMs,
                  profile: divergence.profileName,
                })
                : gatewayOn ? m.overview.awaitingBaseline : m.gateway.offline}
            </div>
          </div>

          <div className="meter-divider" />

          <div className="meter-cell">
            <div className="meter-label">C A C H E &nbsp; H I T</div>
            <RollingNumber
              as="div"
              className={`meter-plain ${cacheRate === undefined ? "dim" : ""}`}
              value={cacheText}
            />
            <div className="meter-sub">{fill(m.overview.cacheToday, { count: cacheRequests })}</div>
          </div>

          <div className="meter-divider" />

          <div className="meter-cell">
            <div className="meter-label">T O K E N S</div>
            <RollingNumber
              as="div"
              className={`meter-plain ${tokenToday === 0 ? "dim" : ""}`}
              value={tokenText}
            />
            <div className="meter-sub">{m.overview.todayResets}</div>
          </div>
        </section>

        <section aria-label={m.overview.clients} className="rise-2" style={{ marginTop: 22 }}>
          <div className="section-head">
            <span className="kicker">{m.overview.clients}</span>
            <h2>{m.overview.worldLines}</h2>
          </div>
          <div className="socket-grid">
            {CLIENT_TARGET_ORDER.map((target, index) => {
              const client = clients.find((item) => item.target === target);
              const route = gateway.routes.find((item) => item.target === target);
              const profile = route
                ? profiles.find((item) => item.id === route.profileId)
                : undefined;
              const options = profiles.filter((item) => item.targets.includes(target));
              const open = active && pickerFor === target;
              const cardClass = [
                "socket-card",
                `tone-${CLIENT_META[target].tone}`,
                profile ? "" : "empty",
                gateway.engaged.includes(target) ? "engaged" : "",
                open ? "picker-open" : "",
                flashTarget === target ? "flash" : "",
              ].filter(Boolean).join(" ");
              const dotClass = profile
                ? gatewayOn ? HEALTH_DOT[profile.health?.status ?? "unknown"] : "dot-warn"
                : "dot-unknown";
              const detail = client?.drifted
                ? m.overview.externalEdit
                : profile
                  ? profile.baseUrl.replace(/^https?:\/\//, "")
                  : route
                    ? m.overview.profileRemoved
                    : client && !client.installed
                      ? m.overview.clientNotDetected
                      : m.overview.noProfileBound;
              const boundName = profile?.name ?? route?.profileName ?? m.overview.unbound;
              const hasProfile = Boolean(profile);
              const engaged = gateway.engaged.includes(target);
              return (
                <div className="socket-cell" key={target}>
                  <button
                    type="button"
                    className={cardClass}
                    style={{ animationDelay: `${80 + index * 45}ms` }}
                    aria-pressed={engaged}
                    aria-label={hasProfile
                      ? fill(engaged ? m.overview.release : m.overview.engage,
                        { client: CLIENT_META[target].label })
                      : fill(m.overview.editToEnable, { client: CLIENT_META[target].label })}
                    disabled={busy}
                    onClick={() => {
                      // 还没分配方案的客户端点了先选方案——没方案可接管
                      if (!hasProfile) setPickerFor(open ? undefined : target);
                      else if (engaged) onRelease(target);
                      else onEngage(target);
                    }}
                  >
                    {/* 接管时由下往上涨满，断开时退回去 */}
                    <span className="socket-fill" aria-hidden="true" />
                    <span className="socket-no">{String(index + 1).padStart(2, "0")}</span>
                    <span className="socket-title">
                      <strong>{CLIENT_META[target].label.toUpperCase()}</strong>
                      {target !== "codex" && (
                        <small>{m.overview.experimental}</small>
                      )}
                    </span>
                    <span className="socket-profile">
                      <span className="socket-profile-line">
                        <i className={`socket-dot ${dotClass}`} />
                        <strong key={boundName} className="swap-text">{boundName}</strong>
                      </span>
                      <code className={`socket-detail ${client?.drifted ? "warn" : ""}`} title={detail}>
                        {detail}
                      </code>
                    </span>
                    <span className={`socket-state ${engaged ? "on" : ""}`}>
                      <span key={engaged ? "on" : "off"} className="swap-text">
                        {engaged ? m.overview.engaged : m.overview.notEngaged}
                      </span>
                    </span>
                  </button>
                  {target === "codex" ? (
                    <button
                      type="button"
                      className="socket-swap"
                      aria-label={m.overview.restoreOfficial}
                      disabled={busy}
                      onClick={onRestoreOfficial}
                    >
                      <RotateCcw size={12} />
                      <span className="swap-text">{m.overview.restoreOfficial}</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={`socket-swap ${open ? "open" : ""}`}
                      aria-expanded={open}
                      aria-label={fill(m.overview.editToEnable, { client: CLIENT_META[target].label })}
                      disabled={busy}
                      onClick={() => setPickerFor(open ? undefined : target)}
                    >
                      <Repeat2 size={12} />
                      <span key={boundName} className="swap-text">{m.overview.swapProfile}</span>
                      <ChevronDown size={12} className={open ? "flip" : ""} />
                    </button>
                  )}
                  {open && (
                    <PickerMenu label={m.overview.worldLines}>
                      {options.length > 0 ? options.map((option) => {
                        const current = route?.profileId === option.id;
                        const tag = current
                          ? { text: m.overview.current, className: "tier-orange" }
                          : healthTag(option);
                        return (
                          <button
                            type="button"
                            role="menuitem"
                            className={`picker-item ${current ? "current" : ""}`}
                            key={option.id}
                            disabled={current || busy}
                            onClick={() => pick(option.id, target)}
                          >
                            <i className={HEALTH_DOT[option.health?.status ?? "unknown"]} />
                            <span style={{ minWidth: 0 }}>
                              <strong>{option.name}</strong>
                              <code>
                                {PROTOCOL_META[option.protocol].short.toUpperCase()} ·{" "}
                                {option.model || m.overview.clientDefault}
                              </code>
                            </span>
                            <small className={tag.className}>{tag.text}</small>
                          </button>
                        );
                      }) : (
                        <button type="button" role="menuitem" className="picker-item" disabled>
                          <i className="dot-unknown" />
                          <span style={{ minWidth: 0 }}>
                            <strong>{m.overview.noCompatibleProfile}</strong>
                            <code>{fill(m.overview.editToEnable, { client: CLIENT_META[target].label })}</code>
                          </span>
                          <small />
                        </button>
                      )}
                    </PickerMenu>
                  )}
                </div>
              );
            })}
          </div>

        </section>
      </div>
    </main>
  );
}
