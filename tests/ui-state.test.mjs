import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

globalThis.window = {};

const {
  KeyringView,
  organizeGroupDrop,
  organizeProfileDrop,
} = await import("../src/components/KeyringView");
const { ActivityView } = await import("../src/components/ActivityView");
const { OverviewView } = await import("../src/components/OverviewView");
const { Toast } = await import("../src/components/Toast");
const {
  cascadeSessionIds,
  groupedSessionRows,
  isCodexSubagent,
  matchesSessionSearch,
  normalizeSessionListResult,
  topLevelSessionIds,
} = await import("../src/components/SessionsView");
const { SettingsView } = await import("../src/components/SettingsView");
const { NAV_ORDER } = await import("../src/App");
const {
  WALLET_AUTO_REFRESH_MS,
  WALLET_CHECK_CONCURRENCY,
  WalletView,
  primaryWalletSubscription,
} = await import("../src/components/WalletView");
const {
  FailoverDialog,
  StatusView,
  parseStoredProbeRecords,
  parseStoredProbeModels,
  probeAvailability,
  probeCountdownSeconds,
  probeModelOptions,
  probeProfilesTogether,
  probeState,
  storedAutoProbeEnabled,
  storedProbeInterval,
  visibleProbeSamples,
} = await import("../src/components/StatusView");
const { BLANK_PROFILE_INPUT, DEFAULT_SETTINGS } = await import("../src/config");
const { I18nProvider, MESSAGES } = await import("../src/i18n");
const {
  computeDivergence,
  formatRate,
  todayCacheRate,
  todayRequestCount,
} = await import("../src/lib/divergence");
const { formatTokenCount } = await import("../src/lib/format");
const {
  isCodexGatewayConflict,
  mergeProfileUsage,
} = await import("../src/hooks/useAgentGateController");

function profile(id, name, target, latency = 100) {
  const checkedAt = new Date().toISOString();
  return {
    id,
    name,
    protocol: "openai-responses",
    baseUrl: `https://${name.toLowerCase()}.example/v1`,
    endpoints: [{
      url: `https://${name.toLowerCase()}.example/v1`,
      models: [],
      health: { status: "healthy", latencyMs: latency, checkedAt },
      healthHistory: [80, 100, 120].map((value) => ({
        checkedAt,
        reachable: true,
        latencyMs: value,
        statusCode: 204,
      })),
    }],
    availableModels: [],
    keyHint: "sk-…test",
    model: "gpt-test",
    authMode: "bearer",
    targets: [target],
    enableToolSearch: false,
    autoSwitch: { enabled: false, intervalMinutes: 2 },
    createdAt: checkedAt,
    updatedAt: checkedAt,
  };
}

function codexSession(id, parentNativeId) {
  return {
    id: `codex:${id}`,
    client: "codex",
    nativeId: id,
    title: id,
    workspace: "D:\\AI\\Keydeck",
    sizeBytes: 1,
    parentNativeId,
  };
}

describe("gateway error actions", () => {
  it("只把 Codex 的网关配置冲突引导到恢复官方", () => {
    expect(isCodexGatewayConflict("Local gateway configuration conflict for codex; route changed"))
      .toBe(true);
    expect(isCodexGatewayConflict("Local gateway configuration conflict for claude; token changed"))
      .toBe(false);
    expect(isCodexGatewayConflict("Local gateway is unavailable")).toBe(false);
  });

  it("错误提示完整展示消息与恢复操作", () => {
    const html = renderToStaticMarkup(React.createElement(
      I18nProvider,
      { locale: "zh" },
      React.createElement(Toast, {
        toast: {
          kind: "error",
          message: "Codex 配置冲突的完整说明",
          action: { label: "恢复官方", onClick: vi.fn() },
        },
        onClose: vi.fn(),
      }),
    ));

    expect(html).toContain("Codex 配置冲突的完整说明");
    expect(html).toContain("恢复官方");
  });
});

describe("frontend state boundaries", () => {
  it("钱包导航位于概览之后、密钥之前", () => {
    expect(NAV_ORDER.slice(0, 3)).toEqual(["overview", "wallet", "keyring"]);
  });

  it("新建方案默认使用 OpenAI Responses 并指向 Codex", () => {
    expect(BLANK_PROFILE_INPUT.protocol).toBe("openai-responses");
    expect(BLANK_PROFILE_INPUT.targets).toEqual(["codex"]);
    expect(BLANK_PROFILE_INPUT.enableToolSearch).toBe(false);
  });

  it("只用实际 engaged 的路由计算分歧率", () => {
    const first = profile("00000000-0000-4000-8000-000000000001", "First", "claude", 400);
    const second = profile("00000000-0000-4000-8000-000000000002", "Second", "codex", 200);
    const result = computeDivergence([first, second], {
      status: "running",
      host: "127.0.0.1",
      port: 17863,
      targets: ["claude", "codex"],
      engaged: ["codex"],
      routes: [
        { target: "claude", profileId: first.id, profileName: first.name, protocol: first.protocol, activatedAt: first.updatedAt },
        { target: "codex", profileId: second.id, profileName: second.name, protocol: second.protocol, activatedAt: second.updatedAt },
      ],
    });

    expect(result?.profileName).toBe("Second");
  });

  it("多条接管线路显示分歧最严重的一条", () => {
    const first = profile("00000000-0000-4000-8000-000000000001", "First", "claude", 150);
    const second = profile("00000000-0000-4000-8000-000000000002", "Second", "codex", 400);
    const result = computeDivergence([first, second], {
      status: "running",
      host: "127.0.0.1",
      port: 17863,
      targets: ["claude", "codex"],
      engaged: ["claude", "codex"],
      routes: [
        { target: "claude", profileId: first.id, profileName: first.name, protocol: first.protocol, activatedAt: first.updatedAt },
        { target: "codex", profileId: second.id, profileName: second.name, protocol: second.protocol, activatedAt: second.updatedAt },
      ],
    });

    expect(result?.profileName).toBe("Second");
  });

  it("首页缓存只统计本地当天，并以百分比显示", () => {
    const now = new Date(2026, 6, 17, 12, 0, 0);
    const request = (startedAt, inputTokens, cachedTokens) => ({
      id: startedAt,
      client: "codex",
      profileName: "Cache",
      upstreamUrl: "https://api.example/v1/responses",
      state: "completed",
      startedAt,
      receivedBytes: 1,
      tokenUsage: { inputTokens, cachedTokens },
    });
    const requests = [
      request(new Date(2026, 6, 16, 23, 59, 0).toISOString(), 1_000, 1_000),
      request(new Date(2026, 6, 17, 0, 1, 0).toISOString(), 800, 400),
      request(new Date(2026, 6, 17, 11, 0, 0).toISOString(), 200, 100),
    ];

    expect(todayCacheRate(requests, now)).toBe(0.5);
    expect(todayRequestCount(requests, now)).toBe(2);
    expect(formatRate(0.5)).toBe("0.500000");
  });

  it("Token 短格式支持十亿级 B", () => {
    expect(formatTokenCount(1_250_000_000)).toBe("1.25B");
    expect(formatTokenCount(12_500_000_000)).toBe("12.5B");
  });

  it("全选使用完整筛选结果的顶层行，不受渲染行数截断影响", () => {
    expect(topLevelSessionIds([
      { session: { id: "codex:root" }, depth: 0 },
      { session: { id: "codex:child" }, depth: 1 },
      { session: { id: "codex:hidden-root" }, depth: 0 },
    ])).toEqual(["codex:root", "codex:hidden-root"]);
  });

  it("会话搜索可用标题、工作区、原始 ID 或带客户端前缀的 ID 精确定位", () => {
    const session = {
      id: "codex:019f69d3-287b-7573-8d3e-fc0d3bf740b3",
      nativeId: "019f69d3-287b-7573-8d3e-fc0d3bf740b3",
      title: "修复会话管理",
      workspace: "D:\\AI\\Keydeck",
    };

    expect(matchesSessionSearch(session, "会话管理")).toBe(true);
    expect(matchesSessionSearch(session, "keydeck")).toBe(true);
    expect(matchesSessionSearch(session, "019F69D3-287B-7573-8D3E-FC0D3BF740B3")).toBe(true);
    expect(matchesSessionSearch(session, "codex:019f69d3")).toBe(true);
    expect(matchesSessionSearch(session, "not-this-session")).toBe(false);
  });

  it("会话扫描兼容旧数组，并保留新版逐客户端错误", () => {
    const sessions = [codexSession("root")];
    expect(normalizeSessionListResult(sessions)).toEqual({ sessions, errors: [] });

    const detailed = {
      sessions,
      errors: [{ client: "claude", reason: "permission denied" }],
    };
    expect(normalizeSessionListResult(detailed)).toBe(detailed);
  });

  it("Codex 旧记录只有父会话 ID 时也识别为子代理", () => {
    expect(isCodexSubagent({
      client: "codex",
      parentNativeId: "019f69d3-287b-7573-8d3e-fc0d3bf740b3",
    })).toBe(true);
    expect(isCodexSubagent({ client: "codex" })).toBe(false);
    expect(isCodexSubagent({
      client: "claude",
      parentNativeId: "019f69d3-287b-7573-8d3e-fc0d3bf740b3",
    })).toBe(false);
  });

  it("Codex 主任务折叠挂靠子代理，删除时递归包含全部后代", () => {
    const root = codexSession("root");
    const child = codexSession("child", "root");
    const grandchild = codexSession("grandchild", "child");
    const other = codexSession("other");
    const sessions = [root, child, grandchild, other];

    expect(cascadeSessionIds(sessions, new Set([root.id, child.id]))).toEqual([
      grandchild.id,
      child.id,
      root.id,
    ]);
    expect(groupedSessionRows(sessions, new Set()).map((row) => ({
      id: row.session.id,
      depth: row.depth,
      descendants: row.descendantCount,
    }))).toEqual([
      { id: root.id, depth: 0, descendants: 2 },
      { id: other.id, depth: 0, descendants: 0 },
    ]);
    expect(groupedSessionRows(sessions, new Set([root.id, child.id])).map((row) => ({
      id: row.session.id,
      depth: row.depth,
    }))).toEqual([
      { id: root.id, depth: 0 },
      { id: child.id, depth: 1 },
      { id: grandchild.id, depth: 2 },
      { id: other.id, depth: 0 },
    ]);
  });

  it("下载中显示禁用的进度按钮而不是检查更新", () => {
    const html = renderToStaticMarkup(React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(SettingsView, {
        settings: {
          launchAtLogin: false,
          closeToTray: true,
          startGatewayOnLaunch: true,
          theme: "system",
          language: "en",
        },
        busy: false,
        update: { state: "downloading", currentVersion: "1.6.4", portable: false, percent: 42 },
        version: "1.6.4",
        onChange: vi.fn(),
        onCheckUpdate: vi.fn(),
        onDownloadUpdate: vi.fn(),
        onInstallUpdate: vi.fn(),
      }),
    ));

    expect(html).toContain("42%");
    expect(html).not.toContain(MESSAGES.en.config.checkUpdate);
    expect(html).toContain("disabled");
    expect(html).not.toContain("tool bridge");
    expect(html).not.toContain("Starts to tray");
  });

  it("Keyring 把 99% 缓存命中率显示为绿色", () => {
    const cached = {
      ...profile("00000000-0000-4000-8000-000000000003", "Cached", "codex"),
      tokenInputTotal: 100,
      tokenCachedTotal: 99,
    };
    const html = renderToStaticMarkup(React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(KeyringView, {
        profiles: [cached],
        gateway: {
          status: "stopped",
          host: "127.0.0.1",
          port: 17863,
          targets: [],
          engaged: [],
          routes: [],
        },
        busy: null,
        loading: false,
        testingIds: new Set(),
        onCreate: vi.fn(),
        onEdit: vi.fn(),
        onDuplicate: vi.fn(),
        onDelete: vi.fn(),
        onApply: vi.fn(),
        onTest: vi.fn(),
        onTestAll: vi.fn(),
        onDiscoverModels: vi.fn(),
        onCopyKey: vi.fn(),
        onSaveGroup: vi.fn(),
        onDeleteGroup: vi.fn(),
        onOrganize: vi.fn(),
        onReorder: vi.fn(),
        onRetry: vi.fn(),
      }),
    ));

    expect(html).toContain("tier-good");
    expect(html).toContain("99.0%");
    expect(html).toContain("ASSIGN");
    expect(html).not.toContain('aria-label="Probe Cached"');
  });

  it("密钥与分组都能拖到目标末尾，并即时给出完整排序预览", () => {
    const first = profile("00000000-0000-4000-8000-000000000031", "First", "codex");
    const second = profile("00000000-0000-4000-8000-000000000032", "Second", "codex");
    const third = profile("00000000-0000-4000-8000-000000000033", "Third", "codex");
    const primary = {
      id: "00000000-0000-4000-8000-000000000034",
      name: "Primary",
      createdAt: first.createdAt,
      updatedAt: first.updatedAt,
    };
    const backup = {
      id: "00000000-0000-4000-8000-000000000035",
      name: "Backup",
      createdAt: first.createdAt,
      updatedAt: first.updatedAt,
    };
    const profiles = [
      { ...first, groupId: primary.id },
      { ...second, groupId: primary.id },
      { ...third, groupId: primary.id },
    ];

    expect(organizeProfileDrop(
      [primary, backup],
      profiles,
      first.id,
      primary.id,
      third.id,
      "after",
    )?.profiles.map((item) => item.id)).toEqual([second.id, third.id, first.id]);
    expect(organizeGroupDrop(
      [primary, backup],
      profiles,
      primary.id,
      backup.id,
      "after",
    )?.groupIds).toEqual([backup.id, primary.id]);
  });

  it("渠道实测按 5 秒和 10 秒分四级，任何不可用都标为故障", () => {
    const sample = (ok, totalMs) => ({
      ok,
      firstByteMs: Math.min(totalMs, 200),
      totalMs,
      model: "gpt-test",
      checkedAt: new Date().toISOString(),
    });

    expect(probeState(sample(true, 4_999))).toBe("healthy");
    expect(probeState(sample(true, 5_000))).toBe("healthy");
    expect(probeState(sample(true, 5_001))).toBe("smooth");
    expect(probeState(sample(true, 10_000))).toBe("smooth");
    expect(probeState(sample(true, 10_001))).toBe("limited");
    expect(probeState({ ...sample(false, 200), statusCode: 408 })).toBe("unhealthy");
    expect(probeState({ ...sample(false, 200), statusCode: 429 })).toBe("unhealthy");
    expect(probeState({ ...sample(false, 200), statusCode: 503 })).toBe("unhealthy");
    expect(probeState(sample(false, 200))).toBe("unhealthy");
    expect(probeAvailability([sample(true, 200), sample(false, 200), sample(true, 200)])).toBe(67);

    const history = Array.from({ length: 31 }, (_, index) => ({
      ...sample(index !== 0, 200),
      checkedAt: new Date(Date.parse("2026-07-27T00:00:00.000Z") + index * 600_000).toISOString(),
    }));
    const visible = visibleProbeSamples(history);
    expect(visible).toHaveLength(30);
    expect(visible[0].checkedAt).toBe(history[1].checkedAt);
    expect(probeAvailability(visible)).toBe(100);
  });

  it("状态倒计时按秒显示，手动检测不需要改变固定时钟", () => {
    const now = Date.parse("2026-07-27T00:00:00.000Z");
    expect(probeCountdownSeconds(now + 300_000, now)).toBe(300);
    expect(probeCountdownSeconds(now + 299_001, now)).toBe(300);
    expect(probeCountdownSeconds(now - 1, now)).toBe(0);
  });

  it("状态页隐藏时仍保持挂载", () => {
    const html = renderToStaticMarkup(React.createElement(
      I18nProvider,
      { locale: "zh" },
      React.createElement(StatusView, { profiles: [], active: false }),
    ));

    expect(html).toContain('class="page-scroll status-page"');
    expect(html).toContain('hidden=""');
  });

  it("状态页高亮当前已分配的渠道", () => {
    const current = profile("00000000-0000-4000-8000-000000000041", "Current", "codex");
    const standby = profile("00000000-0000-4000-8000-000000000042", "Standby", "codex");
    const html = renderToStaticMarkup(React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(StatusView, {
        profiles: [current, standby],
        gateway: { routes: [{ target: "codex", profileId: current.id }] },
      }),
    ));

    expect(html).toMatch(/class="status-row [^"]*current/);
    expect(html).toContain(MESSAGES.en.keys.active);
  });

  it("状态页提供按客户端配置的故障切换入口和候选密钥库", () => {
    const current = profile("00000000-0000-4000-8000-000000000043", "Current", "codex");
    const standby = profile("00000000-0000-4000-8000-000000000044", "Standby", "codex");
    const statusHtml = renderToStaticMarkup(React.createElement(
      I18nProvider,
      { locale: "zh" },
      React.createElement(StatusView, {
        profiles: [current, standby],
        settings: DEFAULT_SETTINGS,
        onSettingsChange: vi.fn(),
      }),
    ));
    const dialogHtml = renderToStaticMarkup(React.createElement(
      I18nProvider,
      { locale: "zh" },
      React.createElement(FailoverDialog, {
        profiles: [current, standby],
        gateway: { routes: [{ target: "codex", profileId: current.id }] },
        settings: DEFAULT_SETTINGS,
        busy: false,
        onSave: vi.fn(),
        onClose: vi.fn(),
      }),
    ));

    expect(statusHtml).toContain(MESSAGES.zh.status.failover);
    expect(statusHtml).toContain('aria-haspopup="dialog"');
    expect(dialogHtml).toContain(MESSAGES.zh.status.failoverTitle);
    expect(dialogHtml).toContain("Claude Code");
    expect(dialogHtml).toContain("Codex");
    expect(dialogHtml).toContain("OpenCode");
    expect(dialogHtml).toContain("Gemini CLI");
    expect(dialogHtml).toContain("Current");
    expect(dialogHtml).toContain("Standby");
    expect(dialogHtml.match(/class="switch-input"/g)).toHaveLength(4);
  });

  it("钱包固定每 5 分钟刷新，并优先显示每日额度使用率最高的订阅", () => {
    expect(WALLET_AUTO_REFRESH_MS).toBe(300_000);
    expect(WALLET_CHECK_CONCURRENCY).toBe(3);
    expect(primaryWalletSubscription([
      { id: 1, name: "A", dailyUsedUsd: 2, dailyLimitUsd: 20 },
      { id: 2, name: "B", dailyUsedUsd: 8, dailyLimitUsd: 10 },
      { id: 3, name: "C", dailyUsedUsd: 99 },
    ])?.id).toBe(2);

    const html = renderToStaticMarkup(React.createElement(
      I18nProvider,
      { locale: "zh" },
      React.createElement(WalletView, {
        active: false,
        onToast: vi.fn(),
        onProfilesChanged: vi.fn(),
      }),
    ));
    expect(html).toContain('class="page-scroll wallet-page"');
    expect(html).toContain('hidden=""');
  });

  it("密钥页和动态页隐藏时也保持挂载", () => {
    const common = {
      profiles: [],
      gateway: {
        status: "stopped",
        host: "127.0.0.1",
        port: 17863,
        targets: [],
        engaged: [],
        routes: [],
      },
      busy: null,
      loading: false,
      testingIds: new Set(),
      onCreate: vi.fn(),
      onEdit: vi.fn(),
      onDuplicate: vi.fn(),
      onDelete: vi.fn(),
      onApply: vi.fn(),
      onTest: vi.fn(),
      onTestAll: vi.fn(),
      onDiscoverModels: vi.fn(),
      onCopyKey: vi.fn(),
      onSaveGroup: vi.fn(),
      onDeleteGroup: vi.fn(),
      onOrganize: vi.fn(),
      onReorder: vi.fn(),
      onRetry: vi.fn(),
      active: false,
    };
    const keys = renderToStaticMarkup(React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(KeyringView, common),
    ));
    const activity = renderToStaticMarkup(React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(ActivityView, { requests: [], active: false }),
    ));

    expect(keys).toContain('hidden=""');
    expect(activity).toContain('hidden=""');
  });

  it("首页仅将非 Codex 客户端标为实验性", () => {
    const html = renderToStaticMarkup(React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(OverviewView, {
        profiles: [],
        clients: [],
        gateway: {
          status: "stopped",
          host: "127.0.0.1",
          port: 17863,
          targets: [],
          engaged: [],
          routes: [],
        },
        requests: [],
        activeRequestCount: 0,
        busy: false,
        onApply: vi.fn(),
        onEngage: vi.fn(),
        onRelease: vi.fn(),
        onRestoreOfficial: vi.fn(),
        onGoActivity: vi.fn(),
      }),
    ));

    expect(html.match(/EXPERIMENTAL/g)).toHaveLength(3);
    expect(html).not.toMatch(/CODEX[^<]*EXPERIMENTAL/);
    expect(html).toContain(MESSAGES.en.overview.restoreOfficial);
    expect(html.match(/SELECT KEY/g)).toHaveLength(3);
  });

  it("同一轮渠道实测会同时发出，并在各自完成时立即回传", async () => {
    const pending = new Map();
    const called = [];
    const settled = [];
    const batch = probeProfilesTogether([{ id: "first" }, { id: "second" }], (id) => {
      called.push(id);
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    }, (item) => settled.push(item));

    expect(called).toEqual(["first", "second"]);
    pending.get("first").resolve({
      ok: true,
      firstByteMs: 80,
      totalMs: 120,
      model: "gpt-test",
      checkedAt: "2026-07-26T00:00:00.000Z",
    });
    await Promise.resolve();
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ profile: { id: "first" }, result: { ok: true } });

    pending.get("second").reject(new Error("second unavailable"));

    const result = await batch;
    expect(result[0].result.ok).toBe(true);
    expect(result[1].error).toContain("second unavailable");
    expect(settled[1]).toMatchObject({ profile: { id: "second" } });
    expect(settled[1].error).toContain("second unavailable");
  });

  it("状态页恢复暂停、间隔和历史记录时不会恢复伪检测状态", () => {
    expect(storedAutoProbeEnabled("false")).toBe(false);
    expect(storedAutoProbeEnabled(null)).toBe(true);
    expect(storedProbeInterval("300000")).toBe(300_000);
    expect(storedProbeInterval("1234")).toBe(120_000);

    const sample = {
      ok: true,
      firstByteMs: 80,
      totalMs: 120,
      model: "gpt-test",
      checkedAt: "2026-07-26T00:00:00.000Z",
    };
    const restored = parseStoredProbeRecords(JSON.stringify({
      first: { samples: [sample], checking: true },
      invalid: { samples: [{ ok: "yes" }] },
    }));

    expect(restored.first).toEqual({
      samples: [sample],
      result: sample,
      checking: false,
      error: undefined,
    });
    expect(restored.invalid).toBeUndefined();
  });

  it("状态页按渠道恢复检测模型，并合并默认与已识别模型", () => {
    const source = profile("00000000-0000-4000-8000-000000000012", "Models", "codex");
    source.model = "gpt-default";
    source.availableModels = ["gpt-default", "gpt-cheap"];
    source.endpoints[0].models = ["gpt-cheap", "gpt-fast"];

    expect(probeModelOptions(source)).toEqual(["gpt-default", "gpt-cheap", "gpt-fast"]);
    expect(parseStoredProbeModels(JSON.stringify({
      [source.id]: "  gpt-cheap  ",
      empty: "",
      invalid: 123,
    }))).toEqual({ [source.id]: "gpt-cheap" });
  });

  it("非流式请求即使残留 firstToken 字段也只显示 TTFB", () => {
    const startedAt = new Date().toISOString();
    const html = renderToStaticMarkup(React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(ActivityView, {
        requests: [{
          id: "request-1",
          client: "codex",
          profileName: "Non-streaming",
          upstreamUrl: "https://api.example/v1/responses",
          state: "completed",
          startedAt,
          completedAt: startedAt,
          durationMs: 500,
          firstTokenLatencyMs: 450,
          firstByteLatencyMs: 120,
          streaming: false,
          outcome: "completed",
          receivedBytes: 128,
        }],
      }),
    ));

    expect(html).toContain("TTFB");
    expect(html).toContain("120 ms");
    expect(html).not.toContain("TTFT");
    expect(html).toContain("tint-complete");
  });

  it("流式请求等待首内容时不先显示 TTFB 再中途换指标", () => {
    const html = renderToStaticMarkup(React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(ActivityView, {
        requests: [{
          id: "request-2",
          client: "codex",
          profileName: "Streaming",
          upstreamUrl: "https://api.example/v1/responses",
          state: "waiting-first-token",
          startedAt: new Date().toISOString(),
          firstByteLatencyMs: 120,
          streaming: true,
          receivedBytes: 64,
        }],
      }),
    ));

    expect(html).toContain("TTFT --");
    expect(html).not.toContain("TTFB");
    expect(html).not.toContain("TTFT 120 ms");
  });

  it("用量事件只替换对应方案，不触发全量状态重建", () => {
    const first = profile("00000000-0000-4000-8000-000000000010", "First", "codex");
    const second = profile("00000000-0000-4000-8000-000000000011", "Second", "claude");
    const updated = { ...second, tokenUsageTotal: 123 };
    const merged = mergeProfileUsage([first, second], updated);

    expect(merged).toEqual([first, updated]);
    expect(merged[0]).toBe(first);
    expect(mergeProfileUsage([first], updated)).toEqual([first]);
  });
});
