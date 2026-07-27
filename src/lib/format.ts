/**
 * 将 ISO 时间转换为适合状态栏展示的相对时间。
 *
 * 交给 Intl.RelativeTimeFormat 处理复数与语序——中文「3 分钟前」、日文
 * 「3 分前」、英文「3 minutes ago」的规则各不相同，不该由我们手写。
 *
 * @param value ISO 时间；缺失时表示从未发生。
 * @param locale 界面语言。
 * @param neverLabel 缺失时展示的文本。
 * @returns 本地化的相对时间文本。
 */
export function relativeTime(value: string | undefined, locale: string, neverLabel: string): string {
  if (!value) return neverLabel;

  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return neverLabel;

  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const delta = Date.now() - timestamp;
  const minutes = Math.max(0, Math.floor(delta / 60_000));
  if (minutes < 1) return format.format(0, "minute");
  if (minutes < 60) return format.format(-minutes, "minute");

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return format.format(-hours, "hour");
  return format.format(-Math.floor(hours / 24), "day");
}

/**
 * 将 ISO 时间格式化为本地月日和时分，供历史记录使用。
 *
 * @param value 有效的 ISO 时间。
 * @param locale 界面语言。
 * @returns 本地化后的日期时间文本。
 */
export function formatDateTime(value: string, locale: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "--";
  return new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** 将精确时间固定显示为紧凑的 M/D HH:mm:ss。 */
export function formatCompactDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "--";
  const twoDigits = (part: number): string => String(part).padStart(2, "0");
  return `${date.getMonth() + 1}/${date.getDate()} ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}:${twoDigits(date.getSeconds())}`;
}

/**
 * 将未知异常转换为可展示文本，避免界面直接依赖异常类型。
 *
 * @param error 捕获到的任意异常值。
 * @returns 可供提示条展示的错误信息。
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 将 Token 数量压缩为 K/M/B 短格式。
 *
 * @param value Token 数；缺失或非数字时返回 "--"。
 * @returns 例如 "12.4K"、"1.05M"、"1.25B"。
 */
export function formatTokenCount(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "--";
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(value < 10_000_000_000 ? 2 : 1)}B`;
  }
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 2 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}K`;
  return Math.round(value).toLocaleString();
}

/**
 * 将毫秒格式化为 ms/s 时长文本。
 *
 * @param milliseconds 时长；缺失时返回 "--"。
 * @returns 例如 "642 ms"、"4.98 s"。
 */
export function formatDuration(milliseconds?: number): string {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return "--";
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))} ms`;
  return `${(milliseconds / 1_000).toFixed(2)} s`;
}
