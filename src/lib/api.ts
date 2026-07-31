import type {
  AgentSession,
  SessionListResult,
  SessionMessage,
  BootstrapData,
  ClientStatus,
  ClientTarget,
  GatewayStartSettings,
  GatewayStopSettings,
  GatewayState,
  HistoryEntry,
  AgentGateBridge,
  Profile,
  ProfileGroup,
  ProfileOrganizationInput,
  SaveProfileInput,
  AppSettings,
  HealthSample,
  SaveWalletInput,
  Wallet,
  WalletKeyImportGroupMode,
  WalletKeyImportResult,
} from "../types";
import { DEFAULT_SETTINGS } from "../config";

const now = new Date();
const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const minutesAgo = (minutes: number) =>
  new Date(now.getTime() - minutes * 60_000).toISOString();
const secondsAgo = (seconds: number) =>
  new Date(now.getTime() - seconds * 1_000).toISOString();

const healthSamples = (baseLatency: number, failedAt: number[] = []): HealthSample[] => (
  Array.from({ length: 60 }, (_, index) => ({
    checkedAt: minutesAgo((59 - index) * 2),
    reachable: !failedAt.includes(index),
    ...(!failedAt.includes(index) ? { latencyMs: baseLatency + ((index * 17) % 74) - 28, statusCode: 204 } : { message: "连接超时" }),
  }))
);

const healthData = (baseLatency: number, failedAt: number[] = []) => {
  const healthTimeline = healthSamples(baseLatency, failedAt);
  return { healthHistory: healthTimeline.slice(-30), healthTimeline };
};

const MOCK_GROUP_MAIN = "00000000-0000-4000-8000-000000000101";
const MOCK_GROUP_LABS = "00000000-0000-4000-8000-000000000102";

let mockProfileGroups: ProfileGroup[] = [{
  id: MOCK_GROUP_MAIN,
  name: "日常渠道",
  createdAt: minutesAgo(2_500),
  updatedAt: minutesAgo(18),
}, {
  id: MOCK_GROUP_LABS,
  name: "实验渠道",
  createdAt: minutesAgo(1_000),
  updatedAt: minutesAgo(90),
}];

let mockProfiles: Profile[] = [
  {
    id: "relay-a",
    groupId: MOCK_GROUP_MAIN,
    name: "主力中转",
    protocol: "anthropic",
    baseUrl: "https://api.relay-a.example",
    endpoints: [
      {
        url: "https://api.relay-a.example",
        models: ["claude-sonnet-4-5", "claude-opus-4-1"],
        health: { status: "healthy", latencyMs: 186, checkedAt: minutesAgo(2) },
        ...healthData(186),
      },
      {
        url: "https://api.relay-a-backup.example",
        models: ["claude-sonnet-4-5"],
        health: { status: "healthy", latencyMs: 268, checkedAt: minutesAgo(2) },
        ...healthData(268, [5]),
      },
    ],
    availableModels: ["claude-sonnet-4-5", "claude-opus-4-1"],
    keyHint: "•••• 18F2",
    model: "claude-sonnet-4-5",
    authMode: "bearer",
    targets: ["claude", "opencode"],
    enableToolSearch: true,
    autoSwitch: { enabled: true, intervalMinutes: 2 },
    createdAt: minutesAgo(2400),
    updatedAt: minutesAgo(18),
    lastAppliedAt: minutesAgo(18),
    health: { status: "healthy", latencyMs: 186, checkedAt: minutesAgo(2) },
    tokenUsageTotal: 1_248_000_000,
    tokenInputTotal: 11_260_000,
    tokenCachedTotal: 10_620_000,
    tokenCacheWriteTotal: 384_000,
    tokenReasoningTotal: 1_240_000,
    tokenDayKey: todayKey,
    tokenUsageToday: 842_310,
  },
  {
    id: "openai-main",
    groupId: MOCK_GROUP_MAIN,
    name: "Codex 日常",
    protocol: "openai-responses",
    baseUrl: "https://gateway.work.example/v1",
    endpoints: [{
      url: "https://gateway.work.example/v1",
      models: ["gpt-5.2-codex", "gpt-5.2"],
      health: { status: "healthy", latencyMs: 243, checkedAt: minutesAgo(8) },
      ...healthData(243, [9, 10]),
    }],
    availableModels: ["gpt-5.2-codex", "gpt-5.2"],
    keyHint: "•••• 71C3",
    model: "gpt-5.2-codex",
    authMode: "bearer",
    targets: ["codex", "opencode"],
    autoSwitch: { enabled: false, intervalMinutes: 2 },
    createdAt: minutesAgo(1800),
    updatedAt: minutesAgo(51),
    health: { status: "healthy", latencyMs: 243, checkedAt: minutesAgo(8) },
    tokenUsageTotal: 863_200,
    tokenInputTotal: 741_000,
    tokenCachedTotal: 668_000,
    tokenCacheWriteTotal: 41_500,
    tokenReasoningTotal: 96_300,
    tokenDayKey: todayKey,
    tokenUsageToday: 128_940,
  },
  {
    id: "gemini-fast",
    groupId: MOCK_GROUP_LABS,
    name: "Gemini 快速",
    protocol: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    endpoints: [{
      url: "https://generativelanguage.googleapis.com",
      models: [],
    }],
    availableModels: [],
    keyHint: "•••• 90A1",
    model: "gemini-2.5-flash",
    authMode: "api-key",
    targets: ["gemini"],
    autoSwitch: { enabled: false, intervalMinutes: 2 },
    createdAt: minutesAgo(900),
    updatedAt: minutesAgo(90),
    health: { status: "unknown" },
  },
];

let mockWallets: Wallet[] = [
  {
    id: "00000000-0000-4000-8000-000000000201",
    name: "主力余额",
    siteUrl: "https://api.relay-a.example",
    template: "sub2api",
    credentialKind: "session",
    credentialStatus: "ready",
    credentialHint: "demo@relay-a.example",
    lowBalanceUsd: 5,
    createdAt: minutesAgo(1_400),
    updatedAt: minutesAgo(12),
    balance: {
      status: "ok",
      scope: "account",
      remainingUsd: 42.68,
      checkedAt: minutesAgo(4),
      plan: "钱包余额",
      subscriptions: [{
        id: 1,
        name: "30刀订阅",
        dailyUsedUsd: 4.43,
        dailyLimitUsd: 30,
        expiresAt: new Date(Date.now() + 8 * 24 * 60 * 60_000).toISOString(),
        resetsAt: new Date(Date.now() + 20 * 60 * 60_000).toISOString(),
      }],
    },
  },
  {
    id: "00000000-0000-4000-8000-000000000202",
    name: "Codex 备用站",
    siteUrl: "https://gateway.work.example",
    template: "new-api",
    credentialKind: "api-key",
    credentialStatus: "ready",
    credentialHint: "•••• 71C3",
    lowBalanceUsd: 8,
    createdAt: minutesAgo(920),
    updatedAt: minutesAgo(31),
    balance: {
      status: "low",
      scope: "key",
      remainingUsd: 3.72,
      totalUsd: 25,
      usedUsd: 21.28,
      checkedAt: minutesAgo(7),
    },
  },
  {
    id: "00000000-0000-4000-8000-000000000203",
    name: "旧站余额",
    siteUrl: "https://one.example",
    template: "one-api",
    credentialKind: "api-key",
    credentialStatus: "ready",
    credentialHint: "•••• 90A1",
    lowBalanceUsd: 3,
    createdAt: minutesAgo(610),
    updatedAt: minutesAgo(45),
  },
];

let mockClients: ClientStatus[] = [
  {
    target: "claude",
    label: "Claude Code",
    path: "~/.claude/settings.json",
    installed: true,
    activeProfileId: "relay-a",
    activeProfileName: "主力中转",
    baseUrl: "https://api.relay-a.example",
  },
  {
    target: "codex",
    label: "Codex",
    path: "~/.codex/config.toml",
    installed: true,
    activeProfileName: "外部配置",
    baseUrl: "https://api.openai.com/v1",
  },
  {
    target: "opencode",
    label: "OpenCode",
    path: "~/.config/opencode/opencode.json",
    installed: true,
  },
  {
    target: "gemini",
    label: "Gemini CLI",
    path: "~/.gemini/.env",
    installed: false,
  },
];

let mockClientBaselines: Partial<Record<ClientTarget, ClientStatus>> = {};

let mockHistory: HistoryEntry[] = [
  {
    id: "history-1",
    profileId: "relay-a",
    profileName: "主力中转",
    targets: ["claude", "opencode"],
    createdAt: minutesAgo(18),
    success: true,
    canUndo: true,
  },
];

let mockGateway: GatewayState = {
  status: "stopped",
  host: "127.0.0.1",
  port: 17863,
  engaged: [],
  targets: ["claude", "opencode"],
  routes: ["claude", "opencode"].map((target) => ({
    target: target as ClientTarget,
    profileId: "relay-a",
    profileName: "主力中转",
    protocol: "anthropic" as const,
    activatedAt: minutesAgo(18),
  })),
};

let mockSettings: AppSettings = { ...DEFAULT_SETTINGS };

const mockRequests = [
  {
    id: "request-active",
    client: "codex" as const,
    profileId: "openai-main",
    profileName: "Codex 日常",
    keyHint: "•••• 71C3",
    upstreamUrl: "https://gateway.work.example/v1/responses",
    protocol: "openai-responses" as const,
    state: "streaming" as const,
    startedAt: secondsAgo(8),
    firstByteLatencyMs: 312,
    firstTokenLatencyMs: 842,
    statusCode: 200,
    model: "gpt-5.2-codex",
    reasoningEffort: "high",
    streaming: true,
    receivedBytes: 84_320,
    tokenUsage: { inputTokens: 25_249, outputTokens: 1_832, cachedTokens: 14_720, reasoningTokens: 640, totalTokens: 27_081 },
  },
  {
    id: "request-completed",
    client: "codex" as const,
    profileId: "openai-main",
    profileName: "Codex 日常",
    keyHint: "•••• 71C3",
    upstreamUrl: "https://gateway.work.example/v1/responses",
    protocol: "openai-responses" as const,
    state: "completed" as const,
    outcome: "completed" as const,
    startedAt: secondsAgo(75),
    completedAt: secondsAgo(60),
    durationMs: 15_300,
    firstByteLatencyMs: 288,
    firstTokenLatencyMs: 2_440,
    statusCode: 200,
    model: "gpt-5.2-codex",
    reasoningEffort: "medium",
    streaming: true,
    receivedBytes: 147_200,
    // Anthropic 口径：input 已归一化成含缓存读写的全部提示 token
    tokenUsage: { inputTokens: 21_904, outputTokens: 2_118, cachedTokens: 10_240, cacheWriteTokens: 6_180, reasoningTokens: 384, totalTokens: 24_022 },
  },
  {
    id: "request-failed",
    client: "claude" as const,
    profileId: "relay-a",
    profileName: "主力中转",
    keyHint: "•••• 18F2",
    upstreamUrl: "https://api.relay-a.example/v1/messages",
    protocol: "anthropic" as const,
    state: "failed" as const,
    outcome: "failed" as const,
    startedAt: secondsAgo(145),
    completedAt: secondsAgo(143),
    durationMs: 1_860,
    firstByteLatencyMs: 1_820,
    statusCode: 502,
    model: "claude-sonnet-4-5",
    reasoningEffort: "high",
    streaming: true,
    receivedBytes: 226,
  },
];

const clone = <T,>(value: T): T => structuredClone(value);

function getMockWalletCredentialHint(input: SaveWalletInput, existing?: Wallet): string | undefined {
  if (input.template === "sub2api") return existing?.credentialHint;
  const apiKey = input.apiKey?.trim();
  if (apiKey) return `•••• ${apiKey.slice(-4).toUpperCase()}`;
  return existing?.credentialHint ?? "•••• NEW";
}

function getMockKeyHint(input: SaveProfileInput, existing?: Profile): string {
  const apiKey = input.apiKey?.trim();
  if (apiKey) return `•••• ${apiKey.slice(-4).toUpperCase()}`;
  return existing?.keyHint ?? "•••• NEW";
}

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

let mockSessions: AgentSession[] = [
  {
    id: "codex:019f5fdc-7324-7911-8c9d-7e39f784efa6",
    client: "codex",
    nativeId: "019f5fdc-7324-7911-8c9d-7e39f784efa6",
    title: "先探索理解一下当前项目内的东西",
    workspace: "E:\\godot的游戏\\怪物区驿站",
    updatedAt: hoursAgo(0.4),
    sizeBytes: 41_003_520,
  },
  {
    id: "codex:019f5fe0-1e64-7ca1-9128-8e74f5f0d3f2",
    client: "codex",
    nativeId: "019f5fe0-1e64-7ca1-9128-8e74f5f0d3f2",
    title: "先探索理解一下当前项目内的东西",
    workspace: "E:\\godot的游戏\\怪物区驿站",
    updatedAt: hoursAgo(0.3),
    sizeBytes: 6_410_240,
    threadSource: "subagent",
    agentNickname: "Bacon",
    agentRole: "reviewer",
    parentNativeId: "019f5fdc-7324-7911-8c9d-7e39f784efa6",
  },
  {
    id: "claude:e8fee807-a093-449b-95bc-512795b85513",
    client: "claude",
    nativeId: "e8fee807-a093-449b-95bc-512795b85513",
    title: "把网关的首字延迟修一下",
    workspace: "D:\\AI\\Keydeck",
    updatedAt: hoursAgo(1.2),
    sizeBytes: 8_912_896,
  },
  {
    id: "opencode:ses_17ebba7f2ffeaR1wt3zBk6zIM5",
    client: "opencode",
    nativeId: "ses_17ebba7f2ffeaR1wt3zBk6zIM5",
    title: "角色移速与场景地图关联的bug检查",
    workspace: "E:\\godot的游戏\\修仙宗门模拟器",
    updatedAt: hoursAgo(26),
    sizeBytes: 2_310_144,
    messages: 412,
  },
  {
    id: "codex:019f4a24-1c88-7ab0-9d31-0e4b7c9a1f22",
    client: "codex",
    nativeId: "019f4a24-1c88-7ab0-9d31-0e4b7c9a1f22",
    title: "检查当前可用工具、MCP 资源和插件暴露情况",
    workspace: "C:\\Users\\TRYGN\\Documents\\codex",
    updatedAt: hoursAgo(73),
    sizeBytes: 279_412_736,
  },
  {
    id: "claude:44940e55-2b71-4c3d-8f19-6a2e0d5b7c81",
    client: "claude",
    nativeId: "44940e55-2b71-4c3d-8f19-6a2e0d5b7c81",
    title: "cdesktop 窗口层级重构",
    workspace: "D:\\AI\\cdesktop",
    updatedAt: hoursAgo(190),
    sizeBytes: 36_700_160,
  },
];

const mockBridge: AgentGateBridge = {
  async getBootstrap(): Promise<BootstrapData> {
    return clone({
      profiles: mockProfiles,
      profileGroups: mockProfileGroups,
      clients: mockClients,
      history: mockHistory,
      gateway: mockGateway,
      settings: mockSettings,
      activeRequests: mockRequests,
    });
  },

  async saveProfile(input: SaveProfileInput) {
    const existing = input.id
      ? mockProfiles.find((profile) => profile.id === input.id)
      : undefined;
    const timestamp = new Date().toISOString();
    const endpoints = input.endpoints.map((endpoint) => {
      const previous = existing?.endpoints.find((item) => item.url === endpoint.url);
      return previous ?? { url: endpoint.url, models: [] };
    });
    const activeEndpoint = endpoints.find((endpoint) => endpoint.url === input.baseUrl)
      ?? endpoints[0];
    const profile: Profile = {
      ...input,
      groupId: input.groupId === undefined ? existing?.groupId : input.groupId ?? undefined,
      baseUrl: activeEndpoint.url,
      endpoints,
      availableModels: activeEndpoint.models,
      id: existing?.id ?? crypto.randomUUID(),
      keyHint: getMockKeyHint(input, existing),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      lastAppliedAt: existing?.lastAppliedAt,
      health: existing?.health ?? { status: "unknown" },
    };
    delete (profile as Profile & { apiKey?: string }).apiKey;
    if (existing) {
      mockProfiles = mockProfiles.map((item) => (
        item.id === profile.id ? profile : item
      ));
    } else {
      mockProfiles = [profile, ...mockProfiles];
    }
    return existing ? clone(profile) : mockBridge.testProfile!(profile.id);
  },

  async reorderProfiles(ids: string[]) {
    const byId = new Map(mockProfiles.map((profile) => [profile.id, profile]));
    const ordered: Profile[] = [];
    for (const id of ids) {
      const profile = byId.get(id);
      if (!profile) continue;
      byId.delete(id);
      ordered.push(profile);
    }
    for (const profile of mockProfiles) {
      if (byId.has(profile.id)) ordered.push(profile);
    }
    mockProfiles = ordered;
    return clone(mockProfiles);
  },

  async createProfileGroup(name: string, profileIds: string[]) {
    if (mockProfileGroups.some((group) => group.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new Error("分组名称已存在");
    }
    const timestamp = new Date().toISOString();
    const group: ProfileGroup = {
      id: crypto.randomUUID(),
      name,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const selected = new Set(profileIds);
    mockProfileGroups = [...mockProfileGroups, group];
    mockProfiles = mockProfiles.map((profile) => selected.has(profile.id)
      ? { ...profile, groupId: group.id }
      : profile);
    return clone(group);
  },

  async renameProfileGroup(id: string, name: string) {
    const group = mockProfileGroups.find((item) => item.id === id);
    if (!group) throw new Error("分组不存在");
    const updated = { ...group, name, updatedAt: new Date().toISOString() };
    mockProfileGroups = mockProfileGroups.map((item) => item.id === id ? updated : item);
    return clone(updated);
  },

  async updateProfileGroupMembers(id: string, profileIds: string[]) {
    const selected = new Set(profileIds);
    mockProfiles = mockProfiles.map((profile) => {
      if (selected.has(profile.id)) return { ...profile, groupId: id };
      if (profile.groupId !== id) return profile;
      const { groupId: _groupId, ...ungrouped } = profile;
      return ungrouped;
    });
    return clone(mockProfiles);
  },

  async deleteProfileGroup(id: string) {
    mockProfileGroups = mockProfileGroups.filter((group) => group.id !== id);
    mockProfiles = mockProfiles.map((profile) => {
      if (profile.groupId !== id) return profile;
      const { groupId: _groupId, ...ungrouped } = profile;
      return ungrouped;
    });
    return { ok: true };
  },

  async organizeProfiles(input: ProfileOrganizationInput) {
    const groups = new Map(mockProfileGroups.map((group) => [group.id, group]));
    mockProfileGroups = [
      ...input.groupIds.map((id) => groups.get(id)).filter((group): group is ProfileGroup => Boolean(group)),
      ...mockProfileGroups.filter((group) => !input.groupIds.includes(group.id)),
    ];
    const profiles = new Map(mockProfiles.map((profile) => [profile.id, profile]));
    mockProfiles = [
      ...input.profiles.map(({ id, groupId }) => {
        const profile = profiles.get(id);
        if (!profile) return undefined;
        profiles.delete(id);
        return { ...profile, groupId: groupId ?? undefined };
      }).filter((profile) => profile !== undefined),
      ...mockProfiles.filter((profile) => profiles.has(profile.id)),
    ];
    return clone({ groups: mockProfileGroups, profiles: mockProfiles });
  },

  async duplicateProfile(id: string) {
    const sourceIndex = mockProfiles.findIndex((profile) => profile.id === id);
    if (sourceIndex === -1) throw new Error("方案不存在");
    const source = mockProfiles[sourceIndex];
    const timestamp = new Date().toISOString();
    const duplicate: Profile = {
      ...clone(source),
      id: crypto.randomUUID(),
      name: `${source.name} 副本`,
      endpoints: source.endpoints.map((endpoint) => ({ url: endpoint.url, models: [] })),
      availableModels: [],
      autoSwitch: { ...source.autoSwitch, enabled: false },
      createdAt: timestamp,
      updatedAt: timestamp,
      lastAppliedAt: undefined,
      health: undefined,
      modelsCheckedAt: undefined,
    };
    mockProfiles.splice(sourceIndex + 1, 0, duplicate);
    return clone(duplicate);
  },

  async deleteProfile(id: string) {
    mockProfiles = mockProfiles.filter((profile) => profile.id !== id);
  },

  async copyProfileKey() {
    await navigator.clipboard?.writeText("mock-key-hidden-in-browser-preview");
  },

  async testProfile(id: string): Promise<Profile> {
    const source = mockProfiles.find((profile) => profile.id === id);
    if (!source) throw new Error("方案不存在");
    const discoveredModels = source.protocol === "gemini"
      ? ["gemini-2.5-flash", "gemini-2.5-pro"]
      : source.protocol === "anthropic"
        ? ["claude-sonnet-4-5", "claude-opus-4-1"]
        : ["gpt-5.2-codex", "gpt-5.2"];
    const checkedAt = new Date().toISOString();
    const endpoints = source.endpoints.map((endpoint, index) => ({
      ...endpoint,
      models: discoveredModels,
      health: {
        status: "healthy" as const,
        latencyMs: 128 + index * 86,
        checkedAt,
      },
    }));
    const activeEndpoint = endpoints.find((endpoint) => endpoint.url === source.baseUrl)
      ?? endpoints[0];
    const tested: Profile = {
      ...source,
      endpoints,
      availableModels: activeEndpoint.models,
      model: source.model || activeEndpoint.models[0] || "",
      health: activeEndpoint.health,
      modelsCheckedAt: checkedAt,
    };
    mockProfiles = mockProfiles.map((profile) => profile.id === id ? tested : profile);
    return clone(tested);
  },

  async testProfileDraft(input: SaveProfileInput): Promise<string[]> {
    return input.protocol === "gemini"
      ? ["gemini-2.5-flash", "gemini-2.5-pro"]
      : input.protocol === "anthropic"
        ? ["claude-sonnet-4-5", "claude-opus-4-1"]
        : ["gpt-5.2-codex", "gpt-5.2"];
  },

  async probeProfile(id: string, modelOverride?: string) {
    const source = mockProfiles.find((profile) => profile.id === id);
    if (!source) throw new Error("方案不存在");
    const model = modelOverride?.trim() || source.model || source.availableModels[0];
    if (!model) throw new Error("请先设置模型 ID 或识别模型后再实测");
    await new Promise((resolve) => setTimeout(resolve, 700));
    return {
      ok: true,
      statusCode: 200,
      firstByteMs: 486,
      totalMs: 1_240,
      model,
      checkedAt: new Date().toISOString(),
      tokenUsage: { inputTokens: 9, outputTokens: 12, totalTokens: 21 },
    };
  },

  async checkProfileHealth(id: string): Promise<Profile> {
    const source = mockProfiles.find((profile) => profile.id === id);
    if (!source) throw new Error("方案不存在");
    const checkedAt = new Date().toISOString();
    const endpoints = source.endpoints.map((endpoint, index) => {
      const sample = {
        checkedAt,
        reachable: true,
        latencyMs: 156 + index * 88,
        statusCode: 204,
        message: "端点可达",
      };
      return {
        ...endpoint,
        health: { status: "healthy" as const, ...sample },
        healthHistory: [...(endpoint.healthHistory ?? []), sample].slice(-30),
        healthTimeline: [
          ...(endpoint.healthTimeline?.length ? endpoint.healthTimeline : endpoint.healthHistory ?? []),
          sample,
        ].slice(-60),
      };
    });
    const activeEndpoint = endpoints.find((endpoint) => endpoint.url === source.baseUrl)
      ?? endpoints[0];
    const tested: Profile = { ...source, endpoints, health: activeEndpoint.health };
    mockProfiles = mockProfiles.map((profile) => profile.id === id ? tested : profile);
    return clone(tested);
  },

  async applyProfile(id: string, targets?: ClientTarget[]) {
    const profile = mockProfiles.find((item) => item.id === id);
    if (!profile) throw new Error("方案不存在");
    const appliedTargets = targets?.length ? targets : profile.targets;
    const timestamp = new Date().toISOString();
    const gatewayTargets = appliedTargets;
    const nextProfile = { ...profile, lastAppliedAt: timestamp };
    mockProfiles = mockProfiles.map((item) => (item.id === id ? nextProfile : item));
    if (gatewayTargets.length > 0) {
      const retainedRoutes = mockGateway.routes.filter(
        (route) => !gatewayTargets.includes(route.target),
      );
      mockGateway = {
        ...mockGateway,
        targets: [...new Set([...mockGateway.targets, ...gatewayTargets])],
        routes: [
          ...retainedRoutes,
          ...gatewayTargets.map((target) => ({
            target,
            profileId: profile.id,
            profileName: profile.name,
            protocol: profile.protocol,
            activatedAt: timestamp,
          })),
        ],
      };
    }
    mockClients = mockClients.map((client) =>
      appliedTargets.includes(client.target) && mockGateway.status === "running"
        ? {
            ...client,
            installed: true,
            activeProfileId: id,
            activeProfileName: profile.name,
            baseUrl: gatewayTargets.includes(client.target) && mockGateway.status === "running"
              ? `http://127.0.0.1:${mockGateway.port}/${client.target}`
              : client.baseUrl,
            drifted: false,
            viaGateway: gatewayTargets.includes(client.target) && mockGateway.status === "running",
          }
        : client,
    );
    return clone({
      profile: nextProfile,
      clients: mockClients,
      gateway: mockGateway,
      assignedTargets: appliedTargets,
    });
  },

  async undoHistory(id: string) {
    mockHistory = mockHistory.map((entry) =>
      entry.id === id ? { ...entry, canUndo: false } : entry,
    );
    return clone({
      profiles: mockProfiles,
      clients: mockClients,
      history: mockHistory,
      gateway: mockGateway,
    });
  },

  async openConfig() {},

  async startGateway(settings: GatewayStartSettings): Promise<BootstrapData> {
    if (mockGateway.routes.length === 0) throw new Error("请先把方案分配给至少一个客户端");
    const timestamp = new Date().toISOString();
    const port = settings.port ?? mockGateway.port ?? 17863;
    const assigned = mockGateway.routes.map((route) => route.target);
    // 只接管点名的；省略则全部接管。已接管的保持不变。
    const requested = settings.targets?.filter((target) => assigned.includes(target)) ?? assigned;
    const engaged = [...new Set([...mockGateway.engaged, ...requested])];
    mockGateway = {
      status: "running",
      host: "127.0.0.1",
      port,
      targets: assigned,
      engaged,
      routes: mockGateway.routes,
      startedAt: mockGateway.startedAt ?? timestamp,
    };
    mockClients = mockClients.map((client) => {
      if (!engaged.includes(client.target)) return client;
      const route = mockGateway.routes.find((item) => item.target === client.target);
      if (!route) return client;
      if (!mockClientBaselines[client.target]) {
        mockClientBaselines[client.target] = clone(client);
      }
      const profile = mockProfiles.find((item) => item.id === route.profileId);
      return {
        ...client,
        activeProfileId: profile?.id,
        activeProfileName: profile?.name,
        baseUrl: `http://127.0.0.1:${port}/${client.target}`,
        drifted: false,
        viaGateway: true,
      };
    });
    return clone({ profiles: mockProfiles, clients: mockClients, history: mockHistory, gateway: mockGateway });
  },

  async reassignPort(): Promise<BootstrapData> {
    if (mockGateway.status === "running") throw new Error("请先关闭网关再更换端口");
    // 和主进程一样随机取，不是 +1——否则预览里验到的是假行为
    const port = 20_000 + Math.floor(Math.random() * 25_001);
    mockGateway = { ...mockGateway, port };
    return clone({ profiles: mockProfiles, clients: mockClients, history: mockHistory, gateway: mockGateway });
  },

  async stopGateway(settings?: GatewayStopSettings): Promise<BootstrapData> {
    const releasing = settings?.targets?.filter((target) => mockGateway.engaged.includes(target))
      ?? [...mockGateway.engaged];
    mockClients = mockClients.map((client) => {
      if (!releasing.includes(client.target)) return client;
      const baseline = mockClientBaselines[client.target];
      delete mockClientBaselines[client.target];
      return baseline ? clone(baseline) : client;
    });
    const engaged = mockGateway.engaged.filter((target) => !releasing.includes(target));
    mockGateway = {
      // 还有客户端接管着就继续跑
      status: engaged.length > 0 ? "running" : "stopped",
      host: "127.0.0.1",
      port: mockGateway.port,
      targets: mockGateway.targets,
      engaged,
      routes: mockGateway.routes,
    };
    return clone({ profiles: mockProfiles, clients: mockClients, history: mockHistory, gateway: mockGateway });
  },

  async restoreCodexOfficial(): Promise<BootstrapData> {
    const target = "codex";
    delete mockClientBaselines[target];
    mockClients = mockClients.map((client) => {
      if (client.target !== target) return client;
      const { activeProfileId, activeProfileName, baseUrl, drifted, viaGateway, ...official } = client;
      void activeProfileId;
      void activeProfileName;
      void baseUrl;
      void drifted;
      void viaGateway;
      return official;
    });
    const routes = mockGateway.routes.filter((route) => route.target !== target);
    const targets = mockGateway.targets.filter((item) => item !== target);
    const engaged = mockGateway.engaged.filter((item) => item !== target);
    mockGateway = {
      ...mockGateway,
      status: engaged.length > 0 ? "running" : "stopped",
      targets,
      engaged,
      routes,
    };
    return clone({ profiles: mockProfiles, clients: mockClients, history: mockHistory, gateway: mockGateway });
  },

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    mockSettings = { ...mockSettings, ...patch };
    return clone(mockSettings);
  },

  async listWallets(): Promise<Wallet[]> {
    return clone(mockWallets);
  },

  async saveWallet(input: SaveWalletInput): Promise<Wallet> {
    const existing = input.id ? mockWallets.find((wallet) => wallet.id === input.id) : undefined;
    const timestamp = new Date().toISOString();
    const siteUrl = input.siteUrl.replace(/\/+$/, "");
    const preserveSession = input.template === "sub2api"
      && existing?.template === "sub2api"
      && existing.siteUrl === siteUrl;
    const credentialSource = input.template === "sub2api"
      ? preserveSession ? existing : undefined
      : existing;
    const connectionChanged = !existing
      || existing.siteUrl !== siteUrl
      || existing.template !== input.template
      || existing.lowBalanceUsd !== input.lowBalanceUsd
      || Boolean(input.apiKey?.trim());
    const wallet: Wallet = {
      id: existing?.id ?? crypto.randomUUID(),
      name: input.name,
      siteUrl,
      template: input.template,
      credentialKind: input.template === "sub2api" ? "session" : "api-key",
      credentialStatus: input.template === "sub2api"
        ? preserveSession ? existing.credentialStatus : "missing"
        : "ready",
      ...(getMockWalletCredentialHint(input, credentialSource)
        ? { credentialHint: getMockWalletCredentialHint(input, credentialSource) }
        : {}),
      lowBalanceUsd: input.lowBalanceUsd,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      ...(!connectionChanged && existing?.balance ? { balance: existing.balance } : {}),
    };
    mockWallets = existing
      ? mockWallets.map((item) => item.id === wallet.id ? wallet : item)
      : [wallet, ...mockWallets];
    return clone(wallet);
  },

  async loginWallet(id: string) {
    const wallet = mockWallets.find((item) => item.id === id);
    if (!wallet) throw new Error("钱包不存在");
    await new Promise((resolve) => setTimeout(resolve, 700));
    const updated: Wallet = {
      ...wallet,
      credentialKind: "session",
      credentialStatus: "ready",
      credentialHint: "demo@sub2api.local",
      balance: {
        status: "ok",
        scope: "account",
        remainingUsd: 42.68,
        subscriptions: [{
          id: 1,
          name: "30刀订阅",
          dailyUsedUsd: 4.43,
          dailyLimitUsd: 30,
          expiresAt: new Date(Date.now() + 8 * 24 * 60 * 60_000).toISOString(),
          resetsAt: new Date(Date.now() + 20 * 60 * 60_000).toISOString(),
        }],
        checkedAt: new Date().toISOString(),
      },
    };
    mockWallets = mockWallets.map((item) => item.id === id ? updated : item);
    return clone({ cancelled: false, wallet: updated });
  },

  async importWalletKeys(
    id: string,
    groupMode?: WalletKeyImportGroupMode,
  ): Promise<WalletKeyImportResult> {
    const wallet = mockWallets.find((item) => item.id === id);
    if (!wallet) throw new Error("钱包不存在");
    const existing = mockProfileGroups.find((group) => group.name === wallet.name);
    if (existing && groupMode === undefined) {
      return { status: "group-conflict", groupName: wallet.name };
    }
    let group = groupMode === "existing" ? existing : undefined;
    if (!group) {
      let name = wallet.name;
      let suffix = 2;
      while (mockProfileGroups.some((item) => item.name === name)) {
        name = `${wallet.name} (${suffix})`;
        suffix += 1;
      }
      const timestamp = new Date().toISOString();
      group = { id: crypto.randomUUID(), name, createdAt: timestamp, updatedAt: timestamp };
      mockProfileGroups = [...mockProfileGroups, group];
    }
    const timestamp = new Date().toISOString();
    const profile: Profile = {
      id: crypto.randomUUID(),
      groupId: group.id,
      name: `${wallet.name} Key`,
      protocol: "openai-responses",
      baseUrl: wallet.siteUrl.replace(/\/+$/, ""),
      endpoints: [{ url: wallet.siteUrl.replace(/\/+$/, ""), models: [] }],
      availableModels: [],
      keyHint: "•••• DEMO",
      model: "",
      authMode: "bearer",
      targets: ["codex"],
      autoSwitch: { enabled: false, intervalMinutes: 2 },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    mockProfiles = [...mockProfiles, profile];
    await mockBridge.testProfile!(profile.id);
    return {
      status: "complete",
      groupId: group.id,
      groupName: group.name,
      imported: 1,
      reused: 0,
      skipped: 0,
    };
  },

  async deleteWallet(id: string) {
    mockWallets = mockWallets.filter((wallet) => wallet.id !== id);
    return { ok: true };
  },

  async checkWallet(id: string): Promise<Wallet> {
    const wallet = mockWallets.find((item) => item.id === id);
    if (!wallet) throw new Error("钱包不存在");
    await new Promise((resolve) => setTimeout(resolve, 420 + mockWallets.indexOf(wallet) * 180));
    const remainingUsd = wallet.template === "sub2api" ? 42.68
      : wallet.template === "new-api" ? 3.72
        : 12.4;
    const updated: Wallet = {
      ...wallet,
      balance: {
        status: remainingUsd <= 0 ? "empty"
          : wallet.lowBalanceUsd > 0 && remainingUsd <= wallet.lowBalanceUsd ? "low"
            : "ok",
        scope: wallet.template === "new-api" ? "key"
          : wallet.template === "one-api" ? "site"
            : "account",
        remainingUsd,
        ...(wallet.template !== "sub2api" ? { totalUsd: 25, usedUsd: 25 - remainingUsd } : {}),
        ...(wallet.template === "sub2api" ? {
          subscriptions: [{
            id: 1,
            name: "30刀订阅",
            dailyUsedUsd: 4.43,
            dailyLimitUsd: 30,
            expiresAt: new Date(Date.now() + 8 * 24 * 60 * 60_000).toISOString(),
            resetsAt: new Date(Date.now() + 20 * 60 * 60_000).toISOString(),
          }],
        } : {}),
        checkedAt: new Date().toISOString(),
      },
    };
    mockWallets = mockWallets.map((item) => item.id === id ? updated : item);
    return clone(updated);
  },

  async listSessions() {
    await new Promise((resolve) => setTimeout(resolve, 260));
    return clone<SessionListResult>({ sessions: mockSessions, errors: [] });
  },

  async readSessionMessages(id: string, limit = 30) {
    await new Promise((resolve) => setTimeout(resolve, 320));
    const session = mockSessions.find((item) => item.id === id);
    const script: Array<[SessionMessage["role"], string]> = [
      ["user", "先探索理解一下当前项目内的东西，别急着改代码。"],
      ["assistant", "看完了。这是一个 Godot 4 项目，场景树的入口在 `main.tscn`，角色控制器挂在 `Player` 节点上，移动逻辑用的是 `CharacterBody2D.move_and_slide()`。\n\n有一处可疑：`_physics_process` 里每帧都在 `get_node()`，这在移动端会很吃 CPU。"],
      ["user", "那个卡顿是不是就是这个引起的？"],
      ["assistant", "不是。`get_node()` 有缓存，真正的开销在 `TileMap` 的 `update_dirty_quadrants()` —— 你每帧都在改 tile，触发了整块重建。"],
      ["user", "怎么改"],
      ["assistant", "把 tile 的写入攒起来，一帧只提交一次。我先把复现脚本跑一遍确认。"],
    ];
    const want = limit > 0 ? limit : script.length;
    const messages: SessionMessage[] = script.slice(-want).map(([role, text], index) => ({
      role,
      text,
      at: new Date(Date.now() - (script.length - index) * 240_000).toISOString(),
    }));
    return { messages, truncated: want < script.length || Boolean(session && session.sizeBytes > 5e7) };
  },

  async countSessionMessages(ids: string[]) {
    await new Promise((resolve) => setTimeout(resolve, 380));
    const counts: Record<string, number> = {};
    for (const id of ids) {
      const session = mockSessions.find((item) => item.id === id);
      // 假数据里按体积估一个像样的条数，真机是扫全文数出来的
      if (session) counts[id] = Math.max(2, Math.round(session.sizeBytes / 620_000));
    }
    return counts;
  },

  async planSessionRemoval(ids: string[]) {
    return clone(mockSessions.filter((s) => ids.includes(s.id)).map((s) => ({
      id: s.id,
      nativeId: s.nativeId,
      client: s.client,
      title: s.title,
      workspace: s.workspace,
      files: [{ path: `…/${s.nativeId}.jsonl`, bytes: s.sizeBytes }],
      rows: s.client === "claude" ? [] : [{ kind: "sqlite", file: "…/state.sqlite" }],
      // 预览里也要如实体现：这两样是共享的，删会话时绝不碰
      kept: s.client === "codex" ? ["attachments", "auth", "config"]
        : s.client === "opencode" ? ["snapshot", "auth"]
          : ["memory", "settings", "credentials"],
    })));
  },

  async removeSessions(ids: string[]) {
    await new Promise((resolve) => setTimeout(resolve, 420));
    mockSessions = mockSessions.filter((s) => !ids.includes(s.id));
    return { removed: [...ids], failed: [] };
  },

  async checkForUpdate() {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return {
      state: "up-to-date" as const,
      currentVersion: "0.7.8",
      portable: false,
    };
  },

  async downloadUpdate() {
    return {
      state: "up-to-date" as const,
      currentVersion: "0.7.8",
      portable: false,
    };
  },

  async installUpdate() {
    return { ok: true };
  },

  onStateChanged() {
    return () => {};
  },
};

/**
 * 渲染进程统一 API。Electron 中使用隔离的 preload 桥，纯浏览器预览使用内存实现。
 */
export const api: AgentGateBridge = window.agentgate ?? mockBridge;

/** 当前页面是否运行在具备本地文件权限的 Electron 容器中。 */
export const isDesktop = Boolean(window.agentgate);
