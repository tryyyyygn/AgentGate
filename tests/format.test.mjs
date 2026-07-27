import { describe, expect, it } from "vitest";
import { formatCompactDateTime, formatDateTime, relativeTime } from "../src/lib/format";

describe("time formatting", () => {
  it("非法非空时间使用安全占位而不是抛出异常", () => {
    expect(relativeTime("not-a-date", "zh-CN", "从未")).toBe("从未");
    expect(formatDateTime("not-a-date", "zh-CN")).toBe("--");
  });

  it("检测时间使用紧凑且精确到秒的绝对时间", () => {
    const localTime = new Date(2026, 6, 27, 18, 51, 10).toISOString();
    expect(formatCompactDateTime(localTime)).toBe("7/27 18:51:10");
  });
});
