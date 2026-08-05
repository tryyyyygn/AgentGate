import type { HealthSample, ProfileEndpoint } from "../types";

export interface EndpointMetrics {
  availability?: number;
  averageLatencyMs?: number;
  sampleCount: number;
}

export type HealthBarTone = "healthy" | "limited" | "failed";

export const LIMITED_LATENCY_MS = 1_000;
const METRICS_WINDOW_MS = 60 * 60_000;

function isReachable(sample: HealthSample): boolean {
  if (typeof sample.reachable === "boolean") return sample.reachable;
  return Boolean(sample.statusCode && sample.statusCode >= 200 && sample.statusCode < 500);
}

/**
 * 将一个检测样本映射为时间线颜色。
 *
 * reachable 是主进程探测结果的明确判断；401/403 等认证响应仍属于可达，
 * 只有明显慢、限流或服务端错误才显示为黄色。连接、DNS、TLS 和超时失败显示红色。
 */
export function getHealthBarTone(sample: HealthSample): HealthBarTone {
  const message = sample.message?.toLocaleLowerCase() ?? "";
  const limitedByStatus = sample.statusCode === 408
    || sample.statusCode === 429
    || (sample.statusCode !== undefined && sample.statusCode >= 500);
  const limitedByMessage = /限流|rate[ -]?limit|throttl/i.test(message);
  const limitedByLatency = Number.isFinite(sample.latencyMs)
    && (sample.latencyMs ?? 0) >= LIMITED_LATENCY_MS;

  if (limitedByStatus || limitedByMessage) return "limited";
  if (!isReachable(sample)) return "failed";
  return limitedByLatency ? "limited" : "healthy";
}

/** 缓存率色阶：≥98% 绿、95-98% 蓝、90-95% 黄、<90% 红。 */
export function cacheRateTier(percent?: number): string {
  if (percent === undefined || !Number.isFinite(percent)) return "tier-quiet";
  if (percent >= 98) return "tier-good";
  if (percent >= 95) return "tier-info";
  if (percent >= 90) return "tier-warn";
  return "tier-bad";
}

/** 响应时延色阶：<5s 绿、5-10s 蓝、10-60s 黄、60s+ 红。 */
export function responseLatencyTier(milliseconds?: number): string {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return "tier-quiet";
  if (milliseconds < 5_000) return "tier-good";
  if (milliseconds < 10_000) return "tier-info";
  if (milliseconds < 60_000) return "tier-warn";
  return "tier-bad";
}

export function getEndpointMetrics(endpoint: ProfileEndpoint): EndpointMetrics {
  const now = Date.now();
  const samples = (endpoint.healthHistory ?? []).filter((sample) => {
    const checkedAt = Date.parse(sample.checkedAt);
    return Number.isFinite(checkedAt)
      && checkedAt >= now - METRICS_WINDOW_MS
      && checkedAt <= now + 60_000;
  });
  if (samples.length === 0) return { sampleCount: 0 };
  const reachable = samples.filter(isReachable);
  const latencies = reachable
    .map((sample) => sample.latencyMs)
    .filter((latency): latency is number => Number.isFinite(latency));
  const averageLatencyMs = latencies.length === 0
    ? undefined
    : Math.round(latencies.reduce((total, latency) => total + latency, 0) / latencies.length);
  return {
    availability: Math.round((reachable.length / samples.length) * 100),
    averageLatencyMs,
    sampleCount: samples.length,
  };
}
