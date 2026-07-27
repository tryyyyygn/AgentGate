import { ChevronDown, ChevronRight, FolderOpen, RotateCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { useI18n } from "../i18n";
import { api } from "../lib/api";
import { describeError, relativeTime } from "../lib/format";
import type {
  AgentSession,
  SessionListResult,
  SessionMessage,
  SessionRemovalPlan,
  SessionScanError,
} from "../types";
import { ConfirmDialog } from "./ConfirmDialog";
import { RollingNumber } from "./RollingNumber";
import { ScrollRail } from "./ScrollRail";

/** 会话来自哪个 agent。这些是产品名，不翻译。 */
const SESSION_CLIENT: Record<AgentSession["client"], { label: string; tone: string }> = {
  claude: { label: "Claude Code", tone: "tone-claude" },
  codex: { label: "Codex", tone: "tone-codex" },
  opencode: { label: "OpenCode", tone: "tone-opencode" },
};

type Filter = "all" | "subagent" | AgentSession["client"];

/**
 * 左栏最多渲染多少条。
 *
 * 这台机器上真实扫出来 490 个会话。全渲染就是几千个节点——和动态页当初卡住的是
 * 同一个病。只渲染一截，靠搜索去够更早的会话，而不是靠滚。
 */
const MAX_VISIBLE_ROWS = 80;
/** 选中时先读这么多条；不够看再要全部。 */
const PREVIEW_MESSAGES = 20;

export function normalizeSessionListResult(
  result: SessionListResult | AgentSession[],
): SessionListResult {
  if (!Array.isArray(result)) return result;
  const compatible = result as AgentSession[] & { scanErrors?: SessionScanError[] };
  return { sessions: result, errors: compatible.scanErrors ?? [] };
}

export function topLevelSessionIds(
  rows: ReadonlyArray<{ session: Pick<AgentSession, "id">; depth: number }>,
): string[] {
  return rows.filter((row) => row.depth === 0).map((row) => row.session.id);
}

export function matchesSessionSearch(
  session: Pick<AgentSession, "id" | "nativeId" | "title" | "workspace" | "project">,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [session.id, session.nativeId, session.title, session.workspace, session.project ?? ""]
    .some((value) => value.toLowerCase().includes(needle));
}

export function isCodexSubagent(
  session: Pick<AgentSession, "client" | "threadSource" | "parentNativeId">,
): boolean {
  return session.client === "codex"
    && (session.threadSource === "subagent" || Boolean(session.parentNativeId));
}

interface SessionTreeRow {
  session: AgentSession;
  depth: number;
  descendantCount: number;
}

function childSessionsByParent(
  sessions: ReadonlyArray<AgentSession>,
): Map<string, AgentSession[]> {
  const codexByNativeId = new Map(
    sessions
      .filter((session) => session.client === "codex")
      .map((session) => [session.nativeId, session]),
  );
  const children = new Map<string, AgentSession[]>();
  for (const session of sessions) {
    if (session.client !== "codex" || !session.parentNativeId) continue;
    const parent = codexByNativeId.get(session.parentNativeId);
    if (!parent || parent.id === session.id) continue;
    const siblings = children.get(parent.id) ?? [];
    siblings.push(session);
    children.set(parent.id, siblings);
  }
  return children;
}

/** 删除父任务时按后代优先的顺序返回整棵 Codex 子代理树。 */
export function cascadeSessionIds(
  sessions: ReadonlyArray<AgentSession>,
  picked: ReadonlySet<string>,
): string[] {
  const children = childSessionsByParent(sessions);
  const included = new Set<string>();
  const result: string[] = [];

  const append = (id: string): void => {
    if (included.has(id)) return;
    included.add(id);
    for (const child of children.get(id) ?? []) append(child.id);
    result.push(id);
  };
  for (const session of sessions) {
    if (picked.has(session.id)) append(session.id);
  }
  return result;
}

/** 主任务折叠成一行；展开时把子代理递归缩进到父任务下面。 */
export function groupedSessionRows(
  sessions: ReadonlyArray<AgentSession>,
  expanded: ReadonlySet<string>,
): SessionTreeRow[] {
  const children = childSessionsByParent(sessions);
  const attached = new Set([...children.values()].flat().map((session) => session.id));
  const visited = new Set<string>();
  const rows: SessionTreeRow[] = [];

  const descendantCount = (id: string): number => {
    const found = new Set<string>();
    const pending = [...(children.get(id) ?? [])];
    while (pending.length > 0) {
      const child = pending.pop();
      if (!child || found.has(child.id)) continue;
      found.add(child.id);
      pending.push(...(children.get(child.id) ?? []));
    }
    return found.size;
  };
  const append = (session: AgentSession, depth: number): void => {
    if (visited.has(session.id)) return;
    visited.add(session.id);
    rows.push({ session, depth, descendantCount: descendantCount(session.id) });
    if (expanded.has(session.id)) {
      for (const child of children.get(session.id) ?? []) append(child, depth + 1);
    }
  };

  for (const session of sessions) {
    if (!attached.has(session.id)) append(session, 0);
  }
  return rows;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "--";
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** 路径太长显示不下，掐中间——头尾才是认路的部分。 */
function shortenPath(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.ceil(max / 2) - 1)}…${value.slice(-Math.floor(max / 2))}`;
}

/**
 * 自绘的勾选框。
 *
 * 原生 checkbox 在这套界面里是外来物——圆角、系统配色、还带自己的一套聚焦环。
 * 这里画一个方框，勾中时填成警示色：勾中就意味着这条会话即将被删。
 */
function Tick({ on, disabled, label, onToggle }: {
  on: boolean;
  disabled: boolean;
  label: string;
  onToggle: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      className={`tick ${on ? "on" : ""}`}
      disabled={disabled}
      // 勾选是「选中待删」，点条目是「看内容」——别让这一下冒上去把正文也换了
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <span />
    </button>
  );
}

/** 右栏：选中会话的正文。会话一换就重读。 */
function Detail({ session, count }: { session: AgentSession; count?: number }): ReactElement {
  const { locale, m, fill } = useI18n();
  const [messages, setMessages] = useState<SessionMessage[]>();
  const [truncated, setTruncated] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const requestSequence = useRef(0);

  const load = useCallback(async (limit: number) => {
    const sequence = ++requestSequence.current;
    try {
      const result = await api.readSessionMessages?.(session.id, limit);
      if (sequence !== requestSequence.current) return;
      setMessages(result?.messages ?? []);
      setTruncated(Boolean(result?.truncated));
    } catch {
      if (sequence !== requestSequence.current) return;
      setMessages([]);
      setTruncated(false);
    }
  }, [session.id]);

  useEffect(() => {
    setMessages(undefined);
    void load(PREVIEW_MESSAGES);
    body.current?.scrollTo({ top: 0 });
    return () => { requestSequence.current += 1; };
  }, [load]);

  const meta = SESSION_CLIENT[session.client];
  const subagent = isCodexSubagent(session);

  return (
    <section className="detail" aria-live="polite">
      <header className="detail-head">
        <h2 data-hint={session.title}>{session.title}</h2>
        <div className="detail-meta">
          <small className={`tag-client ${meta.tone}`}>{meta.label}</small>
          <code data-hint={session.workspace || m.sessions.unknownWorkspace}>
            <FolderOpen size={11} />
            {session.workspace ? shortenPath(session.workspace, 48) : m.sessions.unknownWorkspace}
          </code>
          <span className="detail-dot" />
          <code>{formatBytes(session.sizeBytes)}</code>
          {count !== undefined && (
            <>
              <span className="detail-dot" />
              <code>{fill(m.sessions.messages, { count })}</code>
            </>
          )}
          <span className="detail-dot" />
          <code>{relativeTime(session.updatedAt, locale, m.keys.never)}</code>
        </div>
        <div className="detail-identifiers">
           <div className="detail-id">
             <span>{m.sessions.sessionId}</span>
             <code>{session.nativeId}</code>
           </div>
           {session.client === "claude" && session.project && (
             <div className="detail-id">
               <span>{m.sessions.project}</span>
               <code>{session.project}</code>
             </div>
           )}
          {session.client === "codex" && (
            <small className={`session-kind ${subagent ? "is-subagent" : ""}`}>
              {subagent ? m.sessions.subagent : m.sessions.mainTask}
              {session.agentNickname ? ` · ${session.agentNickname}` : ""}
            </small>
          )}
          {subagent && session.parentNativeId && (
            <div className="detail-id">
              <span>{m.sessions.parentSessionId}</span>
              <code>{session.parentNativeId}</code>
            </div>
          )}
        </div>
      </header>

      <div className="pane">
        <div className="detail-body" ref={body}>
          {messages === undefined && <p className="detail-note">{m.sessions.loading}</p>}
          {messages?.length === 0 && <p className="detail-note">{m.sessions.noMessages}</p>}

          {messages && messages.length > 0 && (
            <>
              {truncated && (
                <button
                  type="button"
                  className="detail-more"
                  disabled={loadingAll}
                  onClick={() => {
                    setLoadingAll(true);
                    // 0 = 尽量多。主进程有硬上限，不会真把 279 MB 端上来。
                    void load(0).finally(() => setLoadingAll(false));
                  }}
                >
                  {loadingAll ? m.sessions.loading : m.sessions.loadAll}
                </button>
              )}
              {messages.map((message, index) => (
                <article
                  className={`say say-${message.role}`}
                  key={`${message.at ?? ""}-${index}`}
                  style={{ animationDelay: `${Math.min(index, 14) * 22}ms` }}
                >
                  <span className="say-who">
                    {message.role === "user" ? m.sessions.you : m.sessions.agent}
                  </span>
                  <p>{message.text}</p>
                </article>
              ))}
              <p className="detail-note">{fill(m.sessions.showingMessages, { count: messages.length })}</p>
            </>
          )}
        </div>
        <ScrollRail scroller={body} />
      </div>
    </section>
  );
}

interface SessionsViewProps {
  onToast: (kind: "success" | "error" | "info", message: string) => void;
  /** 页面隐藏时保留筛选/选择状态，但不要首次扫描或继续触发刷新。 */
  active?: boolean;
}

/**
 * 会话页：左边一栏会话清单，右边是选中那条的正文。
 *
 * 删除不可逆，所以先跑演练：主进程算出到底会动哪些文件、哪些库行，以及**哪些东西
 * 特意不动**——Codex 的附件是跨会话共享的，OpenCode 的快照是个指着用户真实代码
 * 目录的 git 仓库。这两样按会话删都会毁掉别的东西。
 */
export function SessionsView({ onToast, active = true }: SessionsViewProps): ReactElement {
  const { locale, m, fill } = useI18n();
  const [sessions, setSessions] = useState<AgentSession[]>();
  const [scanError, setScanError] = useState<string>();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [current, setCurrent] = useState<string>();
  const [plans, setPlans] = useState<SessionRemovalPlan[]>();
  const [busy, setBusy] = useState(false);
  const index = useRef<HTMLDivElement>(null);

  /**
   * @param silent 留着现有清单重扫。删完之后不该把整栏闪回「正在扫描」——被删的
   *   已经当场拿掉了，剩下的没理由跟着消失一下再回来。
   */
  const scan = useCallback(async (silent = false) => {
    if (!silent) setSessions(undefined);
    setScanError(undefined);
    try {
      const result = normalizeSessionListResult(await api.listSessions?.() ?? []);
      setSessions(result.sessions);
      if (result.errors.length > 0) {
        setScanError(result.errors.map((error) => `${error.client}: ${error.reason}`).join("; "));
      }
      setCounts({});
    } catch (error) {
      setScanError(describeError(error));
      // 静默刷新失败时保留旧清单；首次扫描失败则用空数组承载错误状态，
      // 不能把「扫描失败」伪装成「本机没有会话」。
      setSessions((current) => current ?? []);
      setCounts({});
    }
  }, []);

  useEffect(() => {
    if (!active || sessions !== undefined) return;
    void scan();
  }, [active, scan, sessions]);

  const matched = useMemo(() => {
    return (sessions ?? []).filter((session) => (
      (filter === "all"
        || (filter === "subagent" ? isCodexSubagent(session) : session.client === filter))
      && matchesSessionSearch(session, query)
    ));
  }, [filter, query, sessions]);
  const grouped = !query.trim() && (filter === "all" || filter === "codex");
  const rows = useMemo(
    () => grouped
      ? groupedSessionRows(matched, expanded)
      : matched.map((session) => ({
        session,
        depth: 0,
        descendantCount: Math.max(
          0,
          cascadeSessionIds(sessions ?? [], new Set([session.id])).length - 1,
        ),
      })),
    [expanded, grouped, matched, sessions],
  );
  const shownRows = useMemo(() => rows.slice(0, MAX_VISIBLE_ROWS), [rows]);
  const shown = useMemo(() => shownRows.map((row) => row.session), [shownRows]);
  const hiddenCount = matched.length - shown.length;
  const removalIds = useMemo(
    () => cascadeSessionIds(sessions ?? [], picked),
    [picked, sessions],
  );
  const removalIdSet = useMemo(() => new Set(removalIds), [removalIds]);
  const pickedCount = removalIds.length;

  useEffect(() => {
    const available = new Set(matched.map((session) => session.id));
    setPicked((current) => {
      const next = new Set([...current].filter((id) => available.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [matched]);

  // 发言条数要扫全文，只在用户选中会话后按需计算。
  useEffect(() => {
    if (!current || counts[current] !== undefined) return undefined;
    let alive = true;
    void api.countSessionMessages?.([current])
      .then((result) => {
        if (alive && result) setCounts((current) => ({ ...current, ...result }));
      })
      .catch(() => {
        // 数不出来就不显示，别拿假数糊弄
      });
    return () => { alive = false; };
  }, [current, counts]);

  // 选中的会话被筛掉了（换了筛选/搜索/刚被删掉），右栏就跟着让出来
  const selected = shown.find((session) => session.id === current);

  const tally = useMemo(() => {
    const value = {
      all: sessions?.length ?? 0,
      claude: 0,
      codex: 0,
      opencode: 0,
      subagent: 0,
    };
    for (const session of sessions ?? []) {
      value[session.client] += 1;
      if (isCodexSubagent(session)) value.subagent += 1;
    }
    return value;
  }, [sessions]);

  function toggle(id: string): void {
    setPicked((value) => {
      const next = new Set(value);
      if (next.has(id)) next.delete(id);
      else {
        next.add(id);
        // 父任务已经代表整棵树，去掉冗余的显式子项，避免之后取消父任务仍残留选择。
        const descendants = cascadeSessionIds(sessions ?? [], new Set([id]));
        for (const descendant of descendants) {
          if (descendant !== id) next.delete(descendant);
        }
      }
      return next;
    });
  }

  function toggleExpanded(id: string): void {
    setExpanded((value) => {
      const next = new Set(value);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function openConfirm(): Promise<void> {
    if (removalIds.length === 0) return;
    setBusy(true);
    try {
      // 先演练。弹窗里摆的是主进程真算出来的东西，不是我猜的。
      setPlans(await api.planSessionRemoval?.(removalIds) ?? []);
    } catch {
      onToast("error", fill(m.sessions.removeFailed, { count: removalIds.length }));
    } finally {
      setBusy(false);
    }
  }

  async function confirmRemove(): Promise<void> {
    const ids = plans?.map((plan) => plan.id) ?? [];
    setPlans(undefined);
    setBusy(true);
    try {
      const result = await api.removeSessions?.(ids) ?? { removed: [], failed: [] };
      if (result.removed.length > 0) {
        const gone = new Set(result.removed);
        setSessions((value) => value?.filter((session) => !gone.has(session.id)));
        if (current && gone.has(current)) setCurrent(undefined);
        onToast("success", fill(m.sessions.removed, { count: result.removed.length }));
      }
      if (result.failed.length > 0) {
        // 正文被正在跑的 agent 占着时删不掉，说清楚为什么，别只报个失败
        onToast("error", `${fill(m.sessions.removeFailed, { count: result.failed.length })} · ${m.sessions.dbLocked}`);
      }
      await scan(true);
    } catch {
      onToast("error", fill(m.sessions.removeFailed, { count: ids.length }));
    } finally {
      // 成功那条路原本没复位，删完一次整页的勾选框就永远禁用了
      setBusy(false);
    }
  }

  const totalBytes = plans?.reduce(
    (sum, plan) => sum + plan.files.reduce((inner, file) => inner + file.bytes, 0),
    0,
  ) ?? 0;
  // 「处」= 要删的文件/目录，加上要清的数据库与状态文件
  const targetCount = plans?.reduce(
    (sum, plan) => sum + plan.files.length + plan.rows.length,
    0,
  ) ?? 0;
  const keptKinds = [...new Set(plans?.flatMap((plan) => plan.kept) ?? [])];
  const scanning = sessions === undefined;

  return (
    <main
      className="sessions-page"
      aria-label={m.sessions.title}
      hidden={!active}
    >
      <div className="sessions-head rise">
        <h1>{m.sessions.title}</h1>
        <span style={{ marginLeft: "auto" }} />
        <div className="req-filters" role="radiogroup" aria-label={m.sessions.title}>
          {([
            ["all", m.sessions.all],
            ["claude", SESSION_CLIENT.claude.label],
            ["codex", SESSION_CLIENT.codex.label],
            ["subagent", m.sessions.subagents],
            ["opencode", SESSION_CLIENT.opencode.label],
          ] as Array<[Filter, string]>).map(([value, label]) => (
            <button
              type="button"
              role="radio"
              aria-checked={filter === value}
              className={filter === value ? "active" : ""}
              key={value}
              disabled={value !== "all" && tally[value] === 0}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>

        {/* 搜索：一条下划线，没有原生的圆角框，也没有原生的清除叉 */}
        <div className={`finder ${query ? "has" : ""}`}>
          <input
            type="text"
            placeholder={m.sessions.search}
            aria-label={m.sessions.search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button type="button" aria-label={m.sessions.clear} onClick={() => setQuery("")}>
              <X size={11} />
            </button>
          )}
          <i aria-hidden="true" />
        </div>

        <button
          type="button"
          className="restat"
          data-hint={m.sessions.refresh}
          aria-label={m.sessions.refresh}
          disabled={busy || scanning}
          onClick={() => void scan()}
        >
          <RotateCw size={12} className={scanning ? "spin" : ""} />
        </button>
      </div>

      <div className="sessions-split rise-1">
        {/* 左栏：索引。SG 的 TIPS 那一页就是这个结构——左边一列词条，右边是词条正文。 */}
        <div className="pane">
          <div className="session-index" ref={index} role="list" aria-label={m.sessions.title}>
            {scanning && <p className="detail-note">{m.sessions.scanning}</p>}
            {scanError && !scanning && (
              <p className="detail-note session-scan-error">
                {m.keys.loadError}: {scanError}
              </p>
            )}

            {shownRows.map((row, position) => {
              const { session } = row;
              const meta = SESSION_CLIENT[session.client];
              const isPicked = removalIdSet.has(session.id);
              const isImplicitlyPicked = isPicked && !picked.has(session.id);
              const isCurrent = current === session.id;
              const subagent = isCodexSubagent(session);
              const isExpanded = expanded.has(session.id);
              const hasChildren = grouped && row.descendantCount > 0;
              const count = counts[session.id];
              return (
                <div
                  className={`index-item ${isCurrent ? "current" : ""} ${isPicked ? "picked" : ""}`}
                  key={session.id}
                  role="listitem"
                  aria-current={isCurrent ? "true" : undefined}
                  style={{
                    animationDelay: `${Math.min(position, 16) * 20}ms`,
                    paddingLeft: grouped ? `${4 + row.depth * 14}px` : undefined,
                  }}
                >
                  <Tick
                    on={isPicked}
                    disabled={busy || isImplicitlyPicked}
                    label={session.title}
                    onToggle={() => toggle(session.id)}
                  />
                  {hasChildren ? (
                    <button
                      type="button"
                      className="session-tree-toggle"
                      data-hint={fill(m.sessions.subagentCount, { count: row.descendantCount })}
                      aria-label={fill(m.sessions.subagentCount, { count: row.descendantCount })}
                      aria-expanded={isExpanded}
                      onClick={() => toggleExpanded(session.id)}
                    >
                      {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </button>
                  ) : grouped ? <span className="session-tree-spacer" /> : <span />}
                  <button
                    type="button"
                    className="index-open"
                    aria-label={session.title}
                    onClick={() => setCurrent(session.id)}
                  >
                    <span className="index-no">{String(position + 1).padStart(3, "0")}</span>
                    <span className="index-main">
                      <span className="index-titleline">
                        <strong data-hint={session.title}>{session.title}</strong>
                      </span>
                      <code data-hint={`${session.workspace || m.sessions.unknownWorkspace}\n${session.project ?? ""}\n${session.id}`}>
                        {session.workspace ? shortenPath(session.workspace, 20) : m.sessions.unknownWorkspace}
                        {` · …${session.nativeId.slice(-8)}`}
                        {session.project ? ` · ${shortenPath(session.project, 18)}` : ""}
                      </code>
                    </span>
                    <span className="index-side">
                      <span className="index-tags">
                        <small className={`tag-client ${meta.tone}`}>{meta.label}</small>
                        {session.client === "codex" && (
                          <small className={`session-kind ${subagent ? "is-subagent" : ""}`}>
                            {subagent ? m.sessions.subagent : m.sessions.mainTask}
                            {session.agentNickname ? ` · ${session.agentNickname}` : ""}
                            {row.descendantCount > 0
                              ? ` · ${fill(m.sessions.subagentCount, { count: row.descendantCount })}`
                              : ""}
                          </small>
                        )}
                      </span>
                      <span className="index-count">
                        <em className="index-when">{relativeTime(session.updatedAt, locale, m.keys.never)}</em>
                        <span className="index-message-total">
                          {count !== undefined && (
                            <>
                              <span aria-hidden="true">·</span>
                              <RollingNumber as="span" value={String(count)} />
                              <em>{m.sessions.msgUnit}</em>
                            </>
                          )}
                        </span>
                      </span>
                    </span>
                  </button>
                </div>
              );
            })}

            {!scanning && !scanError && shown.length === 0 && (
              <p className="detail-note">
                {sessions?.length === 0 ? m.sessions.empty : m.sessions.noMatch}
              </p>
            )}
            {hiddenCount > 0 && (
              <p className="detail-note">
                {fill(m.sessions.capped, { shown: shown.length, hidden: hiddenCount })}
              </p>
            )}
          </div>
          <ScrollRail scroller={index} />
        </div>

        {selected
          ? <Detail key={selected.id} session={selected} count={counts[selected.id]} />
          : (
            <section className="detail detail-empty">
              <p>{scanning ? m.sessions.scanning : m.sessions.pickOne}</p>
            </section>
          )}
      </div>

      {pickedCount > 0 && (
        <div className="session-bar">
          <span>{fill(m.sessions.selected, { count: pickedCount })}</span>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setPicked(new Set(
              topLevelSessionIds(rows),
            ))}
          >
            {m.sessions.selectAll}
          </button>
          <button type="button" className="btn-ghost" onClick={() => setPicked(new Set())}>
            {m.sessions.clear}
          </button>
          <button
            type="button"
            className="btn-danger"
            disabled={busy}
            onClick={() => void openConfirm()}
          >
            <Trash2 size={13} />
            {busy ? m.sessions.removing : m.sessions.remove}
          </button>
        </div>
      )}

      {plans && plans.length > 0 && (
        <ConfirmDialog
          danger
          title={fill(m.sessions.confirmTitle, { count: plans.length })}
          message={`${m.sessions.confirmBody} ${m.sessions.confirmIrreversible}`}
          confirmLabel={m.sessions.remove}
          onCancel={() => setPlans(undefined)}
          onConfirm={() => void confirmRemove()}
          details={(
            <div className="plan">
              {plans.map((plan) => (
                <div className="plan-row" key={plan.id}>
                  <span className="plan-label">
                    {SESSION_CLIENT[plan.client as AgentSession["client"]]?.label ?? plan.client}
                  </span>
                  <span
                    className="plan-target"
                    title={`${plan.title}\n${plan.workspace}`}
                  >
                    <code>
                      {plan.title} · {plan.workspace
                        ? shortenPath(plan.workspace, 36)
                        : m.sessions.unknownWorkspace}
                    </code>
                    <code>
                      {m.sessions.sessionId} · {plan.nativeId}
                      {plan.project ? ` · ${plan.project}` : ""}
                    </code>
                  </span>
                </div>
              ))}
              <div className="plan-row">
                <span className="plan-label">{m.sessions.willDelete}</span>
                {/* 「几处 · 多大」。处 = 文件/目录 + 要清的数据库行。 */}
                <code>{targetCount} · {formatBytes(totalBytes)}</code>
              </div>
              {keptKinds.length > 0 && (
                <div className="plan-row keep">
                  <span className="plan-label">{m.sessions.willKeep}</span>
                  <code>{keptKinds.join(" · ")}</code>
                </div>
              )}
              <p className="plan-hint">{m.sessions.keptHint}</p>
            </div>
          )}
        />
      )}
    </main>
  );
}
