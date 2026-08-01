import type {
  ActiveRequest,
  GatewayState,
  HealthSample,
  Profile,
  ProfileEndpoint,
} from "../types";

/** 计算基准所需的最少样本数；不足时视为无基准。 */
const MIN_BASELINE_SAMPLES = 3;
const BASELINE_WINDOW_MS = 60 * 60_000;

export type DivergenceTier = "nominal" | "diverging" | "critical";

export interface Divergence {
  /** 当前延迟 ÷ 基准中位延迟。1.0 表示与平时一致。 */
  ratio: number;
  currentMs: number;
  baselineMs: number;
  profileName: string;
  tier: DivergenceTier;
}

function isReachable(sample: HealthSample): boolean {
  if (typeof sample.reachable === "boolean") return sample.reachable;
  return Boolean(sample.statusCode && sample.statusCode >= 200 && sample.statusCode < 500);
}

/**
 * 取端点最近一小时内可达样本的中位延迟作为基准。
 *
 * 用中位数而非平均值：单次超时尖峰不应抬高基准，否则线路真的变慢时反而显示正常。
 *
 * @returns 中位延迟；样本不足 3 个时返回 undefined。
 */
function baselineLatency(endpoint: ProfileEndpoint): number | undefined {
  const now = Date.now();
  const latencies = (endpoint.healthHistory ?? [])
    .filter((sample) => {
      const checkedAt = Date.parse(sample.checkedAt);
      return Number.isFinite(checkedAt)
        && checkedAt >= now - BASELINE_WINDOW_MS
        && isReachable(sample);
    })
    .map((sample) => sample.latencyMs)
    .filter((latency): latency is number => Number.isFinite(latency) && (latency ?? 0) > 0)
    .sort((left, right) => left - right);

  if (latencies.length < MIN_BASELINE_SAMPLES) return undefined;
  const midpoint = Math.floor(latencies.length / 2);
  return latencies.length % 2 === 0
    ? (latencies[midpoint - 1] + latencies[midpoint]) / 2
    : latencies[midpoint];
}

function tierOf(ratio: number): DivergenceTier {
  if (ratio >= 2) return "critical";
  if (ratio >= 1.3) return "diverging";
  return "nominal";
}

/**
 * 计算当前活跃线路的分歧率。
 *
 * 分歧率 = 当前探测延迟 ÷ 该线路自身一小时中位延迟。它衡量「这条线现在相比它平时
 * 的状态」，因此天然在 1.0 附近浮动：1.68 表示比平时慢 68%，0.87 表示今天更快。
 *
 * 分子分母都取自无凭据 HEAD 探测，不含模型推理时间，所以不会被「推理强度高所以
 * 首 token 慢」这类与线路无关的因素污染。
 *
 * @param profiles 全部方案。
 * @param gateway 当前网关状态；未运行或无路由时无分歧率可言。
 * @returns 最偏离基准的活跃线路；无可计算线路时返回 undefined。
 */
export function computeDivergence(
  profiles: Profile[],
  gateway: GatewayState,
): Divergence | undefined {
  const running = gateway.status === "running" || gateway.status === "starting";
  if (!running || gateway.routes.length === 0) return undefined;

  // routes 只是已分配集合；只有 engaged 中的客户端真的在经过本地网关。
  const engaged = new Set(gateway.engaged);
  let worst: Divergence | undefined;
  for (const route of gateway.routes) {
    if (!engaged.has(route.target)) continue;
    const profile = profiles.find((item) => item.id === route.profileId);
    if (!profile) continue;
    const endpoint = profile.endpoints.find((item) => item.url === profile.baseUrl)
      ?? profile.endpoints[0];
    if (!endpoint || endpoint.health?.status === "unhealthy") continue;
    const currentMs = endpoint.health?.latencyMs;
    const baselineMs = baselineLatency(endpoint);
    if (!Number.isFinite(currentMs) || (currentMs ?? 0) <= 0 || baselineMs === undefined) continue;
    const ratio = (currentMs as number) / baselineMs;
    if (!worst || ratio > worst.ratio) {
      worst = {
        ratio,
        currentMs: Math.round(currentMs as number),
        baselineMs: Math.round(baselineMs),
        profileName: profile.name,
        tier: tierOf(ratio),
      };
    }
  }
  return worst;
}

/**
 * 把分歧率格式化为分歧仪的固定位数：一位整数 + 六位小数。
 *
 * 超过 9.999999 时封顶显示，因为辉光仪只有八管。
 *
 * @param ratio 分歧率。
 * @returns 例如 "1.048596"。
 */
export function formatDivergence(ratio: number): string {
  return Math.min(ratio, 9.999999).toFixed(6);
}

/** 缓存率沿用分歧仪的固定位数读数，保留六位小数。 */
export function formatRate(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "———";
  return value.toFixed(6);
}

/** Token 总量：三位分组，仪表读数式。 */
export function formatTokenTotal(value?: number): string {
  if (!value || !Number.isFinite(value)) return "0";
  return Math.round(value).toLocaleString("en-US").replace(/,/g, " ");
}

/**
 * 本地当天的缓存命中率，0 点自然重置。
 *
 * 直接从请求记录聚合，而不是用方案上的终身累计：仪表三格统一为近期视角，
 * 终身数字会把当下的异常淹没在历史里。
 *
 * @param requests 请求记录（监控服务保留最近三天）。
 * @param now 当前本地时间，测试可注入。
 * @returns 0–1 的比值；当天没有可用输入 Token 时返回 undefined。
 */
export function todayCacheRate(
  requests: ActiveRequest[],
  now = new Date(),
): number | undefined {
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  let input = 0;
  let cached = 0;
  for (const request of requests) {
    const startedAt = Date.parse(request.startedAt);
    if (!Number.isFinite(startedAt) || startedAt < cutoff) continue;
    input += request.tokenUsage?.inputTokens ?? 0;
    cached += request.tokenUsage?.cachedTokens ?? 0;
  }
  if (input <= 0) return undefined;
  return Math.min(1, cached / input);
}

export function todayRequestCount(requests: ActiveRequest[], now = new Date()): number {
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return requests.filter((request) => {
    const startedAt = Date.parse(request.startedAt);
    return Number.isFinite(startedAt) && startedAt >= cutoff;
  }).length;
}

/**
 * 全部方案的当日 Token 总量。
 *
 * 只累加日期键为今天的方案，跨日后主进程会在下一次记账时归零。
 */
export function todayTokenTotal(profiles: Profile[]): number {
  const today = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  const key = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  return profiles.reduce((total, profile) => (
    profile.tokenDayKey === key ? total + (profile.tokenUsageToday ?? 0) : total
  ), 0);
}
