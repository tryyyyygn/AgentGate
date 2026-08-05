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
const { ModelName } = await import("../src/components/ModelName");
const { OverviewView } = await import("../src/components/OverviewView");
const { ClientRouteSettings, failoverDraftChanged } = await import("../src/components/ClientRouteSettings");
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
  failoverSettingsChanged,
  StatusView,
  parseStoredProbeRecords,
  parseStoredProbeModels,
  probeP95,
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
const { formatTokenCount, formatTokenCountFull } = await import("../src/lib/format");
const { responseLatencyTier } = await import("../src/lib/health");
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
    expect(formatTokenCountFull(37_000)).toBe((37_000).toLocaleString());
  });

  it("GPT-5.6 的 luna、terra、sol 只给后缀分配语义色类", () => {
    const renderModel = (value) => renderToStaticMarkup(React.createElement(ModelName, { value }));

    expect(renderModel("gpt-5.6-luna")).toContain("gpt-5.6-<span class=\"model-variant model-variant-luna\">luna</span>");
    expect(renderModel("gpt-5.6-terra")).toContain("gpt-5.6-<span class=\"model-variant model-variant-terra\">terra</span>");
    expect(renderModel("gpt-5.6-sol")).toContain("gpt-5.6-<span class=\"model-variant model-variant-sol\">sol</span>");
    expect(renderModel("gpt-5.6")).not.toContain("model-variant");
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

  it("配置历史区分手动/自动、直连/网关和可撤销状态", () => {
    const html = renderToStaticMarkup(React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(SettingsView, {
        settings: {
          ...DEFAULT_SETTINGS,
          language: "en",
        },
        busy: false,
        version: "1.8.3",
        history: [
          {
            id: "history-applied",
            profileId: "relay-a",
            profileName: "Primary relay",
            targets: ["codex"],
            createdAt: "2026-07-31T08:00:00.000Z",
            status: "applied",
            success: true,
            canUndo: true,
            source: "manual",
            connectionMode: "direct",
          },
          {
            id: "history-superseded",
            profileId: "relay-b",
            profileName: "Backup relay",
            targets: ["claude"],
            createdAt: "2026-07-31T08:01:00.000Z",
            status: "superseded",
            success: true,
            canUndo: false,
            source: "auto",
            connectionMode: "gateway",
          },
        ],
        onChange: vi.fn(),
        onCheckUpdate: vi.fn(),
        onDownloadUpdate: vi.fn(),
        onInstallUpdate: vi.fn(),
        onUndoHistory: vi.fn(),
      }),
    ));

    expect(html).toContain("MANUAL");
    expect(html).toContain("AUTO");
    expect(html).toContain("DIRECT");
    expect(html).toContain("GATEWAY");
    expect(html).toContain("APPLIED");
    expect(html).toContain("SUPERSEDED");
    expect(html).toContain("tier-warn");
    expect(html).toContain("Codex");
    expect(html).toContain("Claude Code");
  });

  it("Keyring 主行不再显示缓存率和一小时统计摘要", () => {
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

    expect(html).not.toContain("99.0%");
    expect(html).not.toContain("1H ");
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
    expect(responseLatencyTier(undefined)).toBe("tier-quiet");
    expect(responseLatencyTier(4_999)).toBe("tier-good");
    expect(responseLatencyTier(5_000)).toBe("tier-info");
    expect(responseLatencyTier(10_000)).toBe("tier-warn");
    expect(responseLatencyTier(60_000)).toBe("tier-bad");
    expect(probeP95([sample(true, 200), sample(false, 200), sample(true, 200)])).toBeUndefined();
    expect(probeP95([
      sample(true, 100),
      sample(true, 200),
      sample(false, 300),
      sample(true, 400),
      sample(true, 500),
    ])).toBe(500);

    const history = Array.from({ length: 31 }, (_, index) => ({
      ...sample(index !== 0, 200),
      checkedAt: new Date(Date.parse("2026-07-27T00:00:00.000Z") + index * 600_000).toISOString(),
    }));
    const visible = visibleProbeSamples(history);
    expect(visible).toHaveLength(30);
    expect(visible[0].checkedAt).toBe(history[1].checkedAt);
    expect(probeP95(visible)).toBe(200);
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

  it("状态页只在分配按钮标示当前已分配的渠道", () => {
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

    expect(html).not.toMatch(/class="status-row [^"]*current/);
    expect(html).not.toContain(MESSAGES.en.keys.active);
    expect(html).toContain("lucide-zap assigned");
  });

  it("状态页只给 P95 使用延迟色阶，总耗时保持中性", () => {
    const current = profile("00000000-0000-4000-8000-000000000045", "Latency", "codex");
    const samples = Array.from({ length: 100 }, (_, index) => ({
      ok: true,
      firstByteMs: 80,
      totalMs: index < 6 ? 60_000 : 5_000,
      model: "gpt-test",
      checkedAt: new Date(Date.parse("2026-08-05T10:20:30.000Z") + index * 1_000).toISOString(),
    }));
    const previousStorage = window.localStorage;
    const values = new Map([["agentgate.status.records.v1", JSON.stringify({ [current.id]: { samples } })]]);
    window.localStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    };

    try {
      const html = renderToStaticMarkup(React.createElement(
        I18nProvider,
        { locale: "en" },
        React.createElement(StatusView, { profiles: [current] }),
      ));

      expect(html).toContain('class="status-row-latency" role="cell"><strong class="tier-info">5.00 s');
      expect(html).toContain('class="status-row-p95" role="cell"><strong>60.00 s');
    } finally {
      if (previousStorage === undefined) delete window.localStorage;
      else window.localStorage = previousStorage;
    }
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

  it("故障切换弹窗展示自动择优的失败计数、冷却和候选排除摘要，而状态页不重复占位", () => {
    const current = profile("00000000-0000-0000-0000-000000000051", "Current", "codex");
    const incompatible = { ...profile("00000000-0000-0000-0000-000000000052", "Incompatible", "codex"), protocol: "anthropic" };
    const autoSwitch = {
      profiles: {},
      failover: {
        claude: { enabled: false, failureCount: 0, failureThreshold: 3, reason: "idle", excluded: [], history: [] },
        codex: {
          enabled: true,
          failureCount: 2,
          failureThreshold: 3,
          reason: "failure-counting",
          excluded: [{ profileId: current.id, reason: "current" }],
          history: [],
          cooldownUntil: "2026-07-31T00:00:00.000Z",
        },
        opencode: { enabled: false, failureCount: 0, failureThreshold: 3, reason: "idle", excluded: [], history: [] },
        gemini: { enabled: false, failureCount: 0, failureThreshold: 3, reason: "idle", excluded: [], history: [] },
      },
    };
    const statusHtml = renderToStaticMarkup(React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(StatusView, {
        profiles: [current],
        gateway: { routes: [{ target: "codex", profileId: current.id, profileName: current.name }] },
        autoSwitch,
      }),
    ));
    const dialogHtml = renderToStaticMarkup(React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(FailoverDialog, {
        profiles: [current, incompatible],
        gateway: { routes: [{ target: "codex", profileId: current.id, profileName: current.name }] },
        settings: DEFAULT_SETTINGS,
        autoSwitch,
        busy: false,
        onSave: vi.fn(),
        onClose: vi.fn(),
      }),
    ));

    expect(statusHtml).not.toContain("FAILOVER TRACE");
    expect(statusHtml).not.toContain(MESSAGES.en.status.decision);
    expect(dialogHtml).toContain("FAILURES 2/3");
    expect(dialogHtml).toContain(MESSAGES.en.status.decisionFailureCounting);
    expect(dialogHtml).toContain("1 candidates excluded");
    expect(dialogHtml).not.toContain("Incompatible");
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
        onOpenClientSettings: vi.fn(),
        onGoActivity: vi.fn(),
      }),
    ));

    expect(html.match(/EXPERIMENTAL/g)).toHaveLength(3);
    expect(html).not.toMatch(/CODEX[^<]*EXPERIMENTAL/);
    expect(html).toContain(MESSAGES.en.overview.restoreOfficial);
    expect(html.match(/SELECT KEY/g)).toHaveLength(3);
  });

  it("客户端设置入口只展示当前客户端兼容的候选库", () => {
    const codex = profile("codex-route", "Codex Main", "codex");
    const claude = {
      ...profile("claude-route", "Claude Only", "claude"),
      protocol: "anthropic",
    };
    const html = renderToStaticMarkup(React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(ClientRouteSettings, {
        target: "codex",
        profiles: [codex, claude],
        groups: [],
        clients: [],
        gateway: {
          status: "stopped",
          host: "127.0.0.1",
          port: 17863,
          targets: ["codex"],
          engaged: [],
          routes: [{
            target: "codex",
            profileId: codex.id,
            profileName: codex.name,
            protocol: codex.protocol,
            activatedAt: codex.updatedAt,
          }],
        },
        settings: DEFAULT_SETTINGS,
        busy: false,
        onSave: vi.fn().mockResolvedValue(true),
        onClose: vi.fn(),
      }),
    ));

    expect(html).toContain("Codex Main");
    expect(html).not.toContain("Claude Only");
    expect(html).toContain("Failover settings");
  });

  it("客户端路由设置草稿关闭前能识别未保存改动", () => {
    const initial = { enabled: false, profileIds: ["profile-a"] };

    expect(failoverDraftChanged(initial, { enabled: false, profileIds: ["profile-a"] })).toBe(false);
    expect(failoverDraftChanged(initial, { enabled: true, profileIds: ["profile-a"] })).toBe(true);
    expect(failoverDraftChanged(initial, { enabled: false, profileIds: ["profile-b"] })).toBe(true);
  });

  it("状态页故障切换草稿关闭前能识别未保存改动", () => {
    const initial = {
      claude: { enabled: false, profileIds: [] },
      codex: { enabled: true, profileIds: ["profile-a"] },
      opencode: { enabled: false, profileIds: [] },
      gemini: { enabled: false, profileIds: [] },
    };

    expect(failoverSettingsChanged(initial, structuredClone(initial))).toBe(false);
    expect(failoverSettingsChanged(initial, {
      ...initial,
      codex: { enabled: false, profileIds: ["profile-a"] },
    })).toBe(true);
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
    const longSamples = Array.from({ length: 101 }, (_, index) => ({
      ...sample,
      checkedAt: new Date(Date.parse(sample.checkedAt) + index * 60_000).toISOString(),
    }));
    const truncated = parseStoredProbeRecords(JSON.stringify({ long: { samples: longSamples } }));
    expect(truncated.long.samples).toHaveLength(100);
    expect(truncated.long.samples[0].checkedAt).toBe(longSamples[1].checkedAt);
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

  it("动态页只显示首字数值，不重复显示解释性提示", () => {
    const html = renderToStaticMarkup(React.createElement(
      I18nProvider,
      { locale: "zh" },
      React.createElement(ActivityView, {
        requests: [{
          id: "request-hint",
          client: "codex",
          profileName: "Streaming",
          upstreamUrl: "https://api.example/v1/responses",
          state: "completed",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          firstTokenLatencyMs: 1_000,
          streaming: true,
          outcome: "completed",
          receivedBytes: 64,
        }],
      }),
    ));

    expect(html).toContain("首字 ");
    expect(html).toContain('class="tier-good">1.00 s</span>');
    expect(html).not.toContain("request-sub");
    expect(html).not.toContain("https://api.example/v1/responses");
    expect(html).not.toContain("First valid reasoning, text, or tool event");
    expect(html).not.toContain('title="First valid reasoning');
  });

  it("动态页独立显示推理强度并统一 MAX 文案", () => {
    const html = renderToStaticMarkup(React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(ActivityView, {
        requests: [{
          id: "request-reasoning",
          client: "codex",
          profileName: "Reasoning",
          upstreamUrl: "https://api.example/v1/responses",
          state: "completed",
          startedAt: "2026-08-05T10:20:30.000Z",
          completedAt: "2026-08-05T10:20:31.000Z",
          durationMs: 1_000,
          firstTokenLatencyMs: 4_999,
          reasoningEffort: "max",
          streaming: true,
          outcome: "completed",
          tokenUsage: {
            inputTokens: 37_000,
            outputTokens: 2_200,
            cachedTokens: 35_000,
            cacheWriteTokens: 1_000,
            reasoningTokens: 2_100,
          },
          receivedBytes: 64,
        }, {
          id: "request-ultra",
          client: "codex",
          profileName: "Ultra",
          upstreamUrl: "https://api.example/v1/responses",
          state: "completed",
          startedAt: "2026-08-05T10:20:30.000Z",
          completedAt: "2026-08-05T10:20:31.000Z",
          durationMs: 1_000,
          reasoningEffort: "ultra",
          streaming: false,
          outcome: "completed",
          receivedBytes: 64,
        }],
      }),
    ));

    expect(html).toContain('class="request-reasoning"');
    expect(html).toMatch(/class="request-transport streaming"><strong>STREAM<\/strong>/);
    expect(html).toMatch(/class="request-transport sync"><strong>SYNC<\/strong>/);
    expect(html).toContain(">MAX<");
    expect(html).toContain(">ULTRA<");
    expect(html).toContain('class="request-time"');
    expect(html).not.toContain("request-state-label");
    expect(html).toContain("↓1,000");
    expect(html).toContain("↑2,200");
    expect(html).toContain("C 35K");
    expect(html).toContain("W 1.0K");
    expect(html).toContain("R 2,100");
    expect(html).not.toContain("↑2.2K");
    expect(html).not.toContain("↓37K");
  });

  it("首字时延按 5 秒、10 秒和 60 秒分级", () => {
    const request = (id, firstTokenLatencyMs) => ({
      id,
      client: "codex",
      profileName: id,
      upstreamUrl: "https://api.example/v1/responses",
      state: "completed",
      startedAt: new Date().toISOString(),
      firstTokenLatencyMs,
      streaming: true,
      outcome: "completed",
      receivedBytes: 64,
    });
    const html = renderToStaticMarkup(React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(ActivityView, {
        requests: [
          request("green", 4_999),
          request("blue", 5_000),
          request("yellow", 10_000),
          request("red", 60_000),
        ],
      }),
    ));

    expect(html).toMatch(/<small>FIRST TOKEN <span class="tier-good">/);
    expect(html).toMatch(/<small>FIRST TOKEN <span class="tier-info">/);
    expect(html).toMatch(/<small>FIRST TOKEN <span class="tier-warn">/);
    expect(html).toMatch(/<small>FIRST TOKEN <span class="tier-bad">/);
    expect(html).not.toMatch(/<small class="tier-(?:good|info|warn|bad)">/);
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

    expect(html).toContain("FIRST TOKEN ");
    expect(html).toContain('class="tier-quiet">--</span>');
    expect(html).not.toContain("TTFB");
    expect(html).not.toContain("FIRST TOKEN 120 ms");
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
