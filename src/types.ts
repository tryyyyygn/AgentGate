export type Protocol =
  | "anthropic"
  | "openai-responses"
  | "openai-chat"
  | "gemini";

export type ClientTarget = "claude" | "codex" | "opencode" | "gemini";

export type AuthMode = "api-key" | "bearer";

export type HealthState = "unknown" | "healthy" | "limited" | "unhealthy";

export interface HealthSample {
  checkedAt: string;
  reachable?: boolean;
  latencyMs?: number;
  statusCode?: number;
  message?: string;
}

export interface HealthResult {
  status: HealthState;
  latencyMs?: number;
  checkedAt?: string;
  statusCode?: number;
  message?: string;
}

export interface ProfileEndpoint {
  url: string;
  health?: HealthResult;
  healthHistory?: HealthSample[];
  healthTimeline?: HealthSample[];
  models: string[];
}

export interface AutoSwitchSettings {
  enabled: boolean;
  intervalMinutes: number;
}

export interface Profile {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  endpoints: ProfileEndpoint[];
  availableModels: string[];
  keyHint: string;
  model: string;
  authMode: AuthMode;
  targets: ClientTarget[];
  enableToolSearch?: boolean;
  autoSwitch: AutoSwitchSettings;
  createdAt: string;
  updatedAt: string;
  lastAppliedAt?: string;
  health?: HealthResult;
  modelsCheckedAt?: string;
  /** 该 Key 经网关转发累计消耗的 Token 数。 */
  tokenUsageTotal?: number;
  /** 累计输入 Token，用于计算平均缓存率。 */
  tokenInputTotal?: number;
  /** 累计缓存命中 Token。 */
  tokenCachedTotal?: number;
  /** 累计缓存写入 token。 */
  tokenCacheWriteTotal?: number;
  /** 累计推理 token（已含在输出里）。 */
  tokenReasoningTotal?: number;
  /** 当日用量所属的本地日期（YYYY-MM-DD）；跨日后重新计数。 */
  tokenDayKey?: string;
  /** 当日累计 Token，本地 0 点重置。 */
  tokenUsageToday?: number;
}

export interface SaveProfileInput {
  id?: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  endpoints: Array<{ url: string }>;
  apiKey?: string;
  model: string;
  authMode: AuthMode;
  targets: ClientTarget[];
  enableToolSearch?: boolean;
  autoSwitch: AutoSwitchSettings;
}

export interface ClientStatus {
  target: ClientTarget;
  label: string;
  path: string;
  installed: boolean;
  activeProfileId?: string;
  activeProfileName?: string;
  baseUrl?: string;
  drifted?: boolean;
  warning?: string;
  viaGateway?: boolean;
}

export interface HistoryEntry {
  id: string;
  profileId: string;
  profileName: string;
  targets: ClientTarget[];
  createdAt: string;
  success: boolean;
  message?: string;
  canUndo: boolean;
  source?: "manual" | "auto";
  connectionMode?: "direct" | "gateway";
}

export type GatewayRuntimeStatus =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "error";

export interface GatewayRoute {
  target: ClientTarget;
  profileId: string;
  profileName: string;
  protocol: Protocol;
  activatedAt: string;
}

export interface GatewayState {
  status: GatewayRuntimeStatus;
  host: "127.0.0.1";
  port: number;
  /** 已分配方案的客户端。 */
  targets: ClientTarget[];
  /** 配置真的被改写成走网关的客户端；必为 targets 的子集。 */
  engaged: ClientTarget[];
  routes: GatewayRoute[];
  startedAt?: string;
  error?: string;
}

export interface GatewayRuntimeEvent {
  status: GatewayRuntimeStatus;
  host: "127.0.0.1";
  port: number;
  targets: ClientTarget[];
  engaged: ClientTarget[];
  routes: Array<Pick<GatewayRoute, "target" | "profileId">>;
  localBaseUrls: Partial<Record<ClientTarget, string>>;
  startedAt?: string;
  error?: string;
}

export interface GatewayStartSettings {
  port?: number;
  /** 只接管这几个客户端；省略则接管全部已分配的。 */
  targets?: ClientTarget[];
}

export interface GatewayStopSettings {
  /** 只放掉这几个客户端；省略则全部放掉并停掉网关。 */
  targets?: ClientTarget[];
}

export type AppTheme = "system" | "light" | "dark";

export type AppLanguage = "system" | "zh" | "zh-TW" | "ja" | "en";

export interface AppSettings {
  launchAtLogin: boolean;
  closeToTray: boolean;
  startGatewayOnLaunch: boolean;
  theme: AppTheme;
  language: AppLanguage;
}

export type ActiveRequestState =
  | "connecting"
  | "waiting-first-token"
  | "streaming"
  | "completed"
  | "failed"
  | "aborted"
  | "cancelled";

export interface RequestTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** 缓存命中（读）——便宜。 */
  cachedTokens?: number;
  /** 缓存写入——按 1.25× 计费，是 miss 不是命中。 */
  cacheWriteTokens?: number;
  /** 推理 token。已含在 outputTokens 里，单列只为显示，不再加总。 */
  reasoningTokens?: number;
  totalTokens?: number;
}

export interface ActiveRequest {
  id: string;
  client: ClientTarget | string;
  profileId?: string;
  profileName: string;
  keyHint?: string;
  upstreamUrl: string;
  protocol?: Protocol;
  state: ActiveRequestState;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  firstTokenLatencyMs?: number;
  firstByteLatencyMs?: number;
  statusCode?: number;
  model?: string;
  reasoningEffort?: string;
  streaming?: boolean;
  outcome?: "completed" | "failed" | "aborted" | "cancelled";
  tokenUsage?: RequestTokenUsage;
  receivedBytes?: number;
}

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "up-to-date"
  | "error";

/** 应用更新状态。便携版不能就地更新，只提示新版本。 */
export interface UpdateState {
  state: UpdateStatus;
  currentVersion: string;
  portable: boolean;
  version?: string;
  percent?: number;
  message?: string;
  releaseNotes?: string;
}

export type StateChangedEvent =
  | {
      type: "profile-tested" | "auto-switch-error";
      profileId: string;
      switched?: boolean;
      previousBaseUrl?: string;
      baseUrl?: string;
      targets?: ClientTarget[];
      message?: string;
    }
  | {
      type: "gateway-state-changed";
      gateway: GatewayRuntimeEvent;
    }
  | {
      type: "active-requests-changed";
      activeRequests: ActiveRequest[];
      /** 只带变动记录：按 id upsert，别整表替换。 */
      patch?: boolean;
      /** 本次状态变更淘汰的历史记录。 */
      removedRequestIds?: string[];
      /** 与 bootstrap 对齐的单调版本号。 */
      revision?: number;
    }
  | {
      type: "settings-changed";
      settings: AppSettings;
    }
  | {
      type: "update-state-changed";
      update: UpdateState;
    };

export interface BootstrapData {
  profiles: Profile[];
  clients: ClientStatus[];
  history: HistoryEntry[];
  gateway: GatewayState;
  settings?: AppSettings;
  activeRequests?: ActiveRequest[];
  /** activeRequests 对应的请求监控版本；旧 preload/ mock 可省略。 */
  activeRequestsRevision?: number;
  update?: UpdateState;
  gatewayRecovery?: {
    skippedTargets: ClientTarget[];
  };
  /** 主进程启动恢复失败；首次 bootstrap 后由界面提示。 */
  startupError?: string;
}

/** 渠道实测结果：发送最小消息后的可用性、时延与上游计量摘要。 */
export interface ProbeResult {
  ok: boolean;
  statusCode?: number;
  firstByteMs: number;
  totalMs: number;
  model: string;
  checkedAt: string;
  /** 上游响应中报告的 Token 计量；用于识别中转注入的前缀。 */
  tokenUsage?: RequestTokenUsage;
  message?: string;
}

export interface ApplyResult {
  profile: Profile;
  clients: ClientStatus[];
  gateway: GatewayState;
  assignedTargets: ClientTarget[];
  historyEntry?: HistoryEntry;
}

/**
 * preload 向渲染进程公开的受限主进程接口。
 *
 * 所有 Promise 都可能因参数校验、DPAPI、网络或文件系统错误而拒绝；调用方必须
 * 显式处理失败。接口不会返回明文 Key。
 */
/** 本机 agent 的一次会话。id 是 `<客户端>:<原生 id>`。 */
export interface AgentSession {
  id: string;
  client: "claude" | "codex" | "opencode";
  nativeId: string;
  /** Claude 会话所在的 projects 子目录；同一 UUID 跨项目重复时用于区分会话。 */
  project?: string;
  title: string;
  /** 会话开始时所在的目录。Claude Code 的目录名编码是有损的，只能从正文里读。 */
  workspace: string;
  updatedAt?: string;
  sizeBytes: number;
  messages?: number;
  archived?: boolean;
  /** Codex 的任务来源及子代理关系；其他客户端不提供。 */
  threadSource?: string;
  agentNickname?: string;
  agentRole?: string;
  parentNativeId?: string;
}

export interface SessionScanError {
  client: AgentSession["client"];
  reason: string;
}

export interface SessionListResult {
  sessions: AgentSession[];
  errors: SessionScanError[];
}

/** 会话里的一条发言。 */
export interface SessionMessage {
  role: "user" | "assistant";
  text: string;
  at?: string;
}

export interface SessionTranscript {
  messages: SessionMessage[];
  /** 还有更早的没读到。 */
  truncated: boolean;
}

/**
 * 删除演练：要删什么，以及**特意不删什么**。
 *
 * kept 不是凑数的——Codex 的附件是跨会话共享的，OpenCode 的快照是个指向用户真实
 * 代码目录的 git 仓库。这两样按会话删都会毁掉别的东西，所以只报告、不动手。
 */
export interface SessionRemovalPlan {
  id: string;
  nativeId: string;
  /** Claude 会话所在的 projects 子目录。 */
  project?: string;
  client: string;
  title: string;
  workspace: string;
  files: { path: string; bytes: number }[];
  rows: { kind: string; file: string }[];
  kept: string[];
}

export interface AgentGateBridge {
  /** 读取方案、客户端扫描状态和公开历史。 */
  getBootstrap(): Promise<BootstrapData>;
  /** 新建或更新方案；编辑时缺失 apiKey 表示保留现有密文。 */
  saveProfile(input: SaveProfileInput): Promise<Profile>;
  /** 在主进程内复制方案设置并重新加密同一 Key。 */
  duplicateProfile(id: string): Promise<Profile>;
  /** 按给定顺序持久化方案排序。旧版 preload 可能暂未提供。 */
  reorderProfiles?(ids: string[]): Promise<Profile[]>;
  /** 删除管理库中的方案，不修改客户端配置。 */
  deleteProfile(id: string): Promise<void>;
  /** 由主进程将方案 Key 写入系统剪贴板。 */
  copyProfileKey(id: string): Promise<void>;
  /** 直接探测全部 URL 的模型列表并返回更新后的公开方案。 */
  testProfile(id: string): Promise<Profile>;
  /** 使用未保存的编辑器连接参数识别活动 URL 的模型，不持久化草稿。 */
  testProfileDraft?(input: SaveProfileInput): Promise<string[]>;
  /** 无凭据检测全部 URL 的可达性和延迟，不识别模型。 */
  checkProfileHealth(id: string): Promise<Profile>;
  /** 用真实 Key 发送最小消息实测渠道可用性与时延。旧版 preload 可能暂未提供。 */
  probeProfile?(id: string, model?: string): Promise<ProbeResult>;
  /** 将方案分配给指定客户端，缺失 targets 时使用方案的全部适用客户端。 */
  applyProfile(id: string, targets?: ClientTarget[]): Promise<ApplyResult>;
  /** 在当前配置未被外部修改时恢复指定事务的加密快照。 */
  undoHistory(id: string): Promise<BootstrapData>;
  /** 在资源管理器中打开客户端配置位置。 */
  openConfig(target: ClientTarget): Promise<void>;
  /** 启动本地透明网关并接管已有方案分配的客户端。 */
  startGateway(settings: GatewayStartSettings): Promise<BootstrapData>;
  reassignPort(): Promise<BootstrapData>;
  /** 恢复接管前的受管字段，保留方案分配并停止网关。 */
  stopGateway(settings?: GatewayStopSettings): Promise<BootstrapData>;
  /** 更新应用行为设置。旧版 preload 可能暂未提供。 */
  updateSettings?(patch: Partial<AppSettings>): Promise<AppSettings | BootstrapData>;
  /** 扫描本机 agent 的会话。不进 bootstrap——要翻上百个正文文件加两个 SQLite。 */
  listSessions?(): Promise<SessionListResult | AgentSession[]>;
  /** 读会话最后的若干条发言。limit=0 表示尽量多。 */
  readSessionMessages?(id: string, limit?: number): Promise<SessionTranscript>;
  /** 数发言条数。要扫全文，所以只在用户选中会话后调用，结果按文件指纹缓存。 */
  countSessionMessages?(ids: string[]): Promise<Record<string, number>>;
  /** 演练：删这些会话会动到哪些文件和数据库行。 */
  planSessionRemoval?(ids: string[]): Promise<SessionRemovalPlan[]>;
  /** 真删。不可逆。渲染进程只递 id，删什么由主进程算。 */
  removeSessions?(ids: string[]): Promise<{ removed: string[]; failed: { id: string; reason: string }[] }>;
  /** 无边框窗口的最小化/最大化/关闭控制。仅桌面环境提供。 */
  windowControl?(action: "minimize" | "maximize" | "close"): Promise<void>;
  /** 检查 GitHub Releases 上是否有新版本。 */
  checkForUpdate?(): Promise<UpdateState>;
  /** 下载已发现的更新；便携版改为打开下载页。 */
  downloadUpdate?(): Promise<UpdateState>;
  /** 停止网关、恢复客户端配置后退出并安装更新。 */
  installUpdate?(): Promise<{ ok: boolean }>;
  /** 订阅主进程定时检测和自动切换事件。 */
  onStateChanged(listener: (event: StateChangedEvent) => void): () => void;
}

declare global {
  interface Window {
    agentgate?: AgentGateBridge;
  }
}
