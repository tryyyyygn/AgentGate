/**
 * 简体中文 / 繁體中文（台灣）/ 日本語 / English 四语文案。
 *
 * 固定不译的技术术语：DIVERGENCE / CACHE HIT / TOKENS / TTFT / TTFB / DPAPI /
 * 协议名 / 客户端名 / 状态码。它们是 SG 仪表读数语言的一部分，也是跨语言的共识符号。
 *
 * zh-TW 和 ja 都不是简体的逐词对译，而是按当地开发者的实际说法另写：
 *
 * - 台湾工程师不说「金鑰」「閘道」「連接埠」——他们就说 API Key / Gateway / Port。
 *   教科书译法在界面上看着像机器翻译。该用台湾词的地方照用（軟體 / 預設 / 介面 /
 *   系統匣 / 檔案），但技术词保留英文。
 * - 日文靠体言止め收紧，避免「〜されました」「〜を検出しました」这类中文直译腔。
 *
 * 改这两本字典时别拿简体逐句翻——先想「当地开发者会怎么讲这句」。
 */
export type Locale = "zh" | "zh-TW" | "ja" | "en";

export interface Messages {
  nav: { overview: string; keys: string; status: string; wallet: string; stream: string; config: string };
  status: {
    title: string;
    auto: string;
    pause: string;
    resume: string;
    refresh: string;
    interval: string;
    every2m: string;
    every5m: string;
    every10m: string;
    enabled: string;
    disabled: string;
    monitor: string;
    channel: string;
    model: string;
    state: string;
    history: string;
    defaultModel: string;
    probeModelLabel: string;
    enableProbe: string;
    disableProbe: string;
    healthy: string;
    smooth: string;
    limited: string;
    unhealthy: string;
    unknown: string;
    availability: string;
    response: string;
    firstByte: string;
    lastCheck: string;
    checking: string;
    countdown: string;
    action: string;
    noSamples: string;
    unsupported: string;
    failover: string;
    failoverTitle: string;
    failoverCandidates: string;
    failoverCurrent: string;
    failoverSelected: string;
    failoverNoProfiles: string;
    enableFailover: string;
    disableFailover: string;
  };
  gateway: {
    online: string;
    offline: string;
    syncing: string;
    fault: string;
    toggleOn: string;
    toggleOff: string;
    recover: string;
    hint: string;
  };
  overview: {
    heroOnline: string;
    heroOffline: string;
    heroStarting: string;
    heroStopping: string;
    heroFault: string;
    routesBound: string;
    directToUpstream: string;
    streaming: string;
    idle: string;
    faultHint: string;
    divergence: string;
    cacheHit: string;
    tokens: string;
    awaitingBaseline: string;
    baselineOf: string;
    cacheToday: string;
    todayResets: string;
    clients: string;
    worldLines: string;
    experimental: string;
    unbound: string;
    noProfileBound: string;
    clientNotDetected: string;
    profileRemoved: string;
    externalEdit: string;
    current: string;
    noCompatibleProfile: string;
    editToEnable: string;
    clientDefault: string;
    engage: string;
    release: string;
    restoreOfficial: string;
    swapProfile: string;
    engaged: string;
    notEngaged: string;
    portHint: string;
  };
  keys: {
    title: string;
    subtitle: string;
    testAll: string;
    create: string;
    active: string;
    tokens: string;
    cache: string;
    breakdown: string;
    awaitingSamples: string;
    statLine: string;
    switchTo: string;
    assign: string;
    inUseHint: string;
    testEndpoints: string;
    expand: string;
    key: string;
    authHeader: string;
    targets: string;
    autoSwitch: string;
    autoSwitchOn: string;
    autoSwitchOff: string;
    lastApplied: string;
    never: string;
    discoverModels: string;
    edit: string;
    duplicate: string;
    delete: string;
    copyKey: string;
    models: string;
    loading: string;
    loadError: string;
    retry: string;
    emptyTitle: string;
    emptyHint: string;
    limited: string;
    down: string;
    untested: string;
    createGroup: string;
    renameGroup: string;
    deleteGroup: string;
    groupName: string;
    groupMembers: string;
    groupNoKeys: string;
    ungrouped: string;
    moveGroup: string;
    groupCount: string;
    expandGroup: string;
    collapseGroup: string;
    deleteGroupTitle: string;
    deleteGroupMessage: string;
  };
  wallet: {
    title: string;
    count: string;
    checkAll: string;
    check: string;
    name: string;
    namePlaceholder: string;
    siteUrl: string;
    apiKey: string;
    keyKeepHint: string;
    accountLogin: string;
    notSignedIn: string;
    loginExpired: string;
    login: string;
    relogin: string;
    saveAndLogin: string;
    loginSuccess: string;
    importKeys: string;
    importConflictTitle: string;
    importConflictMessage: string;
    importCreateGroup: string;
    importExistingGroup: string;
    importSuccess: string;
    template: string;
    balance: string;
    threshold: string;
    thresholdInvalid: string;
    actions: string;
    createTitle: string;
    editTitle: string;
    ok: string;
    low: string;
    empty: string;
    unlimited: string;
    error: string;
    unchecked: string;
    scopeKey: string;
    scopeAccount: string;
    scopeSite: string;
    dailyUsage: string;
    dailyUnlimited: string;
    resetsAt: string;
    daysRemaining: string;
    moreSubscriptions: string;
    loading: string;
    loadError: string;
    emptyTitle: string;
    emptyHint: string;
    deleteTitle: string;
    deleteMessage: string;
    saved: string;
    deleted: string;
    checkFailed: string;
  };
  stream: {
    title: string;
    streaming: string;
    idle: string;
    retained: string;
    capped: string;
    all: string;
    live: string;
    done: string;
    fail: string;
    cache: string;
    /** 请求行里 ↓↑CWR 五个缩写的全称，只在悬停提示里出现。 */
    tipIn: string;
    tipOut: string;
    tipCache: string;
    tipWrite: string;
    tipReason: string;
    empty: string;
    noMatch: string;
    resolving: string;
    states: {
      connect: string;
      wait: string;
      stream: string;
      done: string;
      fail: string;
      abort: string;
      cancel: string;
    };
  };
  sessions: {
    title: string;
    /** 展开看发言。 */
    loading: string;
    noMessages: string;
    pickOne: string;
    loadAll: string;
    showingMessages: string;
    you: string;
    agent: string;
    search: string;
    capped: string;
    refresh: string;
    scanning: string;
    empty: string;
    emptyHint: string;
    noMatch: string;
    all: string;
    subagents: string;
    mainTask: string;
    subagent: string;
    subagentCount: string;
    sessionId: string;
    project: string;
    parentSessionId: string;
    workspace: string;
    unknownWorkspace: string;
    messages: string;
    /** 列表里跟在条数后面的量词，越短越好。 */
    msgUnit: string;
    selected: string;
    selectAll: string;
    clear: string;
    remove: string;
    removing: string;
    /** 删除确认弹窗。会话没有回收站，删了就没了。 */
    confirmTitle: string;
    confirmBody: string;
    confirmIrreversible: string;
    willDelete: string;
    willKeep: string;
    keptHint: string;
    removed: string;
    removeFailed: string;
    dbLocked: string;
  };
  config: {
    title: string;
    launchAtLogin: string;
    closeToTray: string;
    startGateway: string;
    updateCurrent: string;
    updateAvailable: string;
    updateDownloading: string;
    updateReady: string;
    updateLatest: string;
    updateFailed: string;
    checkUpdate: string;
    download: string;
    goDownload: string;
    installRestart: string;
    attractorField: string;
    system: string;
    language: string;
    security: string;
  };
  editor: {
    createTitle: string;
    editTitle: string;
    name: string;
    namePlaceholder: string;
    protocol: string;
    apiUrl: string;
    activeUrlHint: string;
    addUrl: string;
    autoSwitch: string;
    autoSwitchHint: string;
    apiKey: string;
    keyKeepHint: string;
    keyPlaceholder: string;
    keyPlaceholderNew: string;
    model: string;
    modelsAvailable: string;
    discoverModels: string;
    modelEmpty: string;
    modelNoMatch: string;
    authMode: string;
    targets: string;
    viaGateway: string;
    incompatible: string;
    toolSearch: string;
    toolSearchDesc: string;
    cancel: string;
    save: string;
    saving: string;
    saveAndUse: string;
    setActive: string;
    removeUrl: string;
    showKey: string;
    hideKey: string;
    notDetected: string;
    unavailable: string;
    close: string;
  };
  confirm: {
    deleteTitle: string;
    deleteMessage: string;
    deleteConfirm: string;
    discardTitle: string;
    discardMessage: string;
    discardConfirm: string;
    cancel: string;
  };
  toast: {
    saved: string;
    duplicated: string;
    deleted: string;
    keyCopied: string;
    reordered: string;
    orderFailed: string;
    gatewayStarted: string;
    gatewayStopped: string;
    codexGatewayConflict: string;
    codexOfficialRestored: string;
    portReassigned: string;
    gatewaySkipped: string;
    settingsSaved: string;
    modelsFound: string;
    noModels: string;
    healthDone: string;
    healthAllDone: string;
    autoSwitched: string;
    autoSwitchFailed: string;
    failoverSwitched: string;
    failoverFailed: string;
    refreshFailed: string;
    upToDate: string;
    updateCheckFailed: string;
    unsupported: string;
    assignedRunning: string;
    assignedStopped: string;
    close: string;
    undo: string;
  };
  errors: {
    profileNotFound: string;
    nameRequired: string;
    urlInvalid: string;
    urlCredentials: string;
    urlDuplicate: string;
    urlActiveRequired: string;
    keyRequired: string;
    targetRequired: string;
    urlAtLeastOne: string;
  };
  window: { minimize: string; maximize: string; close: string };
  footer: { sealed: string; profiles: string; clients: string; preview: string };
}

const zh: Messages = {
  nav: { overview: "概览", keys: "密钥", status: "状态", wallet: "钱包", stream: "动态", config: "设置" },
  status: {
    title: "渠道状态",
    auto: "自动检测",
    pause: "暂停",
    resume: "继续",
    refresh: "立即检测",
    interval: "检测间隔",
    every2m: "2 分钟",
    every5m: "5 分钟",
    every10m: "10 分钟",
    enabled: "启用",
    disabled: "已关闭",
    monitor: "监测",
    channel: "渠道",
    model: "模型",
    state: "状态",
    history: "最近记录",
    defaultModel: "默认 · {model}",
    probeModelLabel: "「{name}」检测模型",
    enableProbe: "启用「{name}」监测",
    disableProbe: "关闭「{name}」监测",
    healthy: "正常",
    smooth: "流畅",
    limited: "延迟",
    unhealthy: "故障",
    unknown: "未检测",
    availability: "可用率",
    response: "总耗时",
    firstByte: "首包",
    lastCheck: "最近检测",
    checking: "检测中",
    countdown: "{seconds} 秒",
    action: "切换",
    noSamples: "等待首轮实测",
    unsupported: "当前版本不支持 Key 实测",
    failover: "故障切换",
    failoverTitle: "故障切换设置",
    failoverCandidates: "允许切换的密钥",
    failoverCurrent: "当前",
    failoverSelected: "已选 {count}",
    failoverNoProfiles: "没有适用于此客户端的密钥",
    enableFailover: "启用 {client} 故障切换",
    disableFailover: "关闭 {client} 故障切换",
  },
  gateway: {
    online: "网关运行中",
    offline: "网关已关闭",
    syncing: "正在同步",
    fault: "需要处理",
    toggleOn: "开启本地网关",
    toggleOff: "关闭本地网关",
    recover: "恢复配置并关闭本地网关",
    hint: "客户端固定连接本地地址；切换方案不改客户端配置",
  },
  overview: {
    heroOnline: "网关运行中",
    heroOffline: "网关已关闭",
    heroStarting: "网关正在启动",
    heroStopping: "网关正在停止",
    heroFault: "网关需要处理",
    routesBound: "{routes} 条路由生效 · {profiles} 个方案就绪",
    directToUpstream: "客户端直连上游 · 点客户端卡片接管",
    streaming: "{count} 个请求进行中",
    idle: "当前空闲",
    faultHint: "配置被外部修改，请断开该客户端后重新接管",
    divergence: "分歧率",
    cacheHit: "缓存命中",
    tokens: "用量",
    awaitingBaseline: "等待基准 · 需 3 个探测样本",
    baselineOf: "{current}ms / 基准 {baseline}ms · {profile}",
    cacheToday: "今日 · {count} 个请求 · 0 点重置",
    todayResets: "今日 · 0 点重置",
    clients: "客户端",
    worldLines: "世界线",
    experimental: "（实验性）",
    unbound: "未接入",
    noProfileBound: "尚未分配方案",
    clientNotDetected: "未检测到客户端",
    profileRemoved: "方案已删除",
    externalEdit: "检测到外部修改",
    current: "当前",
    noCompatibleProfile: "没有适配此客户端的方案",
    editToEnable: "编辑方案，勾选 {client}",
    clientDefault: "沿用客户端",
    engage: "接管",
    release: "断开",
    restoreOfficial: "恢复官方",
    swapProfile: "选择 Key",
    engaged: "已接管",
    notEngaged: "未接管",
    portHint: "端口被占？点击换一个",
  },
  keys: {
    title: "密钥",
    subtitle: "{count} 个方案 · 拖动排序",
    testAll: "检测全部",
    create: "新建",
    active: "使用中",
    tokens: "累计",
    cache: "缓存率",
    breakdown: "Token 拆解",
    awaitingSamples: "尚无样本",
    statLine: "1 小时 {availability}% · 平均 {latency}",
    switchTo: "将「{name}」分配给全部适用客户端",
    assign: "分配",
    inUseHint: "已在使用中，点击重新分配全部适用客户端",
    testEndpoints: "检测端点延迟（不影响其他操作）",
    expand: "{name} 详情",
    key: "密钥",
    authHeader: "认证头",
    targets: "适用客户端",
    autoSwitch: "自动择优",
    autoSwitchOn: "每 2 分钟按 1 小时线路可达率择优",
    autoSwitchOff: "关闭",
    lastApplied: "上次切换",
    never: "从未",
    discoverModels: "识别模型",
    edit: "编辑",
    duplicate: "复制",
    delete: "删除",
    copyKey: "复制密钥",
    models: "个模型",
    loading: "正在读取本地配置",
    loadError: "无法读取本地数据",
    retry: "重试",
    emptyTitle: "还没有连接方案",
    emptyHint: "录入第一个 API 端点和密钥",
    limited: "受限",
    down: "异常",
    untested: "未测试",
    createGroup: "新建分组",
    renameGroup: "重命名分组",
    deleteGroup: "删除分组",
    groupName: "分组名称",
    groupMembers: "分组密钥",
    groupNoKeys: "当前没有可加入的密钥",
    ungrouped: "未分组",
    moveGroup: "拖动分组排序",
    groupCount: "{count} 个密钥",
    expandGroup: "展开分组「{name}」",
    collapseGroup: "收起分组「{name}」",
    deleteGroupTitle: "删除分组「{name}」？",
    deleteGroupMessage: "分组内的密钥会移到“未分组”，密钥本身不会删除。",
  },
  wallet: {
    title: "钱包",
    count: "{count} 个站点",
    checkAll: "检测全部",
    check: "检测余额",
    name: "名称",
    namePlaceholder: "例如：主力余额",
    siteUrl: "站点 URL",
    apiKey: "API Key",
    keyKeepHint: "留空保留 {hint}",
    accountLogin: "账户登录",
    notSignedIn: "未登录",
    loginExpired: "登录已过期",
    login: "登录站点",
    relogin: "重新登录",
    saveAndLogin: "保存并登录",
    loginSuccess: "已登录「{name}」",
    importKeys: "导入密钥",
    importConflictTitle: "已有同名分组",
    importConflictMessage: "已存在名为「{name}」的分组。将密钥加入该分组，还是另建一个分组？",
    importCreateGroup: "另建分组",
    importExistingGroup: "加入已有分组",
    importSuccess: "已导入至「{group}」：新增 {imported}，已有 {reused}，跳过 {skipped}",
    template: "模板",
    balance: "余额",
    threshold: "低额阈值",
    thresholdInvalid: "低额阈值必须是大于或等于 0 的数字",
    actions: "操作",
    createTitle: "新建钱包",
    editTitle: "编辑 · {name}",
    ok: "正常",
    low: "余额偏低",
    empty: "已用完",
    unlimited: "无限额",
    error: "检测失败",
    unchecked: "未检测",
    scopeKey: "Key 额度",
    scopeAccount: "账户额度",
    scopeSite: "站点额度",
    dailyUsage: "今日 {used} / {limit}",
    dailyUnlimited: "今日 {used} / 不限额",
    resetsAt: "{time} 重置",
    daysRemaining: "剩 {days} 天",
    moreSubscriptions: "+{count}",
    loading: "正在读取钱包",
    loadError: "无法读取钱包",
    emptyTitle: "还没有钱包",
    emptyHint: "添加第一个余额查询站点",
    deleteTitle: "删除「{name}」？",
    deleteMessage: "只会删除这条钱包记录，不会修改密钥方案或网关配置。",
    saved: "已保存「{name}」",
    deleted: "已删除「{name}」",
    checkFailed: "余额检测失败：{message}",
  },
  stream: {
    title: "动态",
    streaming: "{count} 个请求进行中",
    idle: "当前空闲",
    retained: "完整保留最近 3 天",
    capped: "仅显示最近 {shown} 条 · 另有 {hidden} 条保留中",
    all: "全部",
    live: "活跃",
    done: "完成",
    fail: "异常",
    cache: "缓存率",
    tipIn: "全部提示 Token（含缓存读写）",
    tipOut: "输出 Token",
    tipCache: "命中的提示 Token（便宜）",
    tipWrite: "写入的缓存（按 1.25× 计费，最贵）",
    tipReason: "推理 Token（已含在输出里）",
    empty: "还没有请求记录 · 网关收到请求后会在这里即时显示",
    noMatch: "没有符合筛选条件的请求",
    resolving: "正在解析上游",
    states: {
      connect: "连接中",
      wait: "等待首个输出",
      stream: "传输中",
      done: "已完成",
      fail: "失败",
      abort: "已中止",
      cancel: "已取消",
    },
  },
  sessions: {
    title: "会话",
    loading: "正在读取",
    noMessages: "这个会话没有可显示的发言",
    pickOne: "从左边选一个会话",
    loadAll: "读取全部发言",
    showingMessages: "以上 {count} 条",
    you: "我",
    agent: "AGENT",
    search: "搜索标题、工作区或会话 ID",
    capped: "当前显示 {shown} 个 · 另有 {hidden} 个，可展开或搜索",
    refresh: "重新扫描",
    scanning: "正在扫描本机会话",
    empty: "没有找到任何会话",
    emptyHint: "Claude Code / Codex / OpenCode 都还没在这台机器上留下会话",
    noMatch: "没有符合筛选条件的会话",
    all: "全部",
    subagents: "子代理",
    mainTask: "主任务",
    subagent: "子代理",
    subagentCount: "{count} 个子代理",
    sessionId: "会话 ID",
    project: "项目",
    parentSessionId: "父会话 ID",
    workspace: "工作区",
    unknownWorkspace: "工作区未知",
    messages: "{count} 条消息",
    msgUnit: "条",
    selected: "已选 {count} 个",
    selectAll: "全选",
    clear: "取消选择",
    remove: "删除",
    removing: "正在删除",
    confirmTitle: "删除 {count} 个会话？",
    confirmBody: "会连同它们在数据库里的记录一起清掉。",
    confirmIrreversible: "没有回收站，删了就没了。",
    willDelete: "将删除",
    willKeep: "保留不动",
    keptHint: "这些是跨会话共享的，按会话删会毁掉别的会话的数据。",
    removed: "已删除 {count} 个会话",
    removeFailed: "{count} 个会话删除失败",
    dbLocked: "文件被占用 · 关掉对应的 agent 再试",
  },
  config: {
    title: "设置",
    launchAtLogin: "开机自启（静默）",
    closeToTray: "关闭时驻留托盘",
    startGateway: "启动时恢复网关",
    updateCurrent: "当前版本 {version}",
    updateAvailable: "发现新版本 {version}",
    updateDownloading: "正在下载 {percent}%",
    updateReady: "新版本 {version} 已就绪，重启即可安装",
    updateLatest: "已是最新版本",
    updateFailed: "检查更新失败",
    checkUpdate: "检查更新",
    download: "下载更新",
    goDownload: "前往下载",
    installRestart: "重启并安装",
    attractorField: "世界线",
    system: "跟随系统",
    language: "语言",
    security: "真实 Key 由 Windows DPAPI 加密，只在本机交给网关；客户端不会保存上游 Key。方案中的 URL 与 Key 永不写入客户端配置文件。",
  },
  editor: {
    createTitle: "新建连接方案",
    editTitle: "编辑 · {name}",
    name: "方案名称",
    namePlaceholder: "例如：主力中转",
    protocol: "API 协议",
    apiUrl: "API URL",
    activeUrlHint: "圆点标记活动 URL",
    addUrl: "添加 URL",
    autoSwitch: "自动择优",
    autoSwitchHint: "自动选择一小时线路可达率最高的 URL",
    apiKey: "API Key",
    keyKeepHint: "留空保留 {hint}",
    keyPlaceholder: "保留现有密钥",
    keyPlaceholderNew: "sk-...",
    model: "模型 ID",
    modelsAvailable: "{count} 个可用",
    discoverModels: "识别模型",
    modelEmpty: "还没有识别到模型，点击上方「识别模型」",
    modelNoMatch: "没有匹配的模型，点右侧箭头查看全部",
    authMode: "认证方式",
    targets: "适用客户端",
    viaGateway: "可由网关转发",
    incompatible: "协议不兼容",
    toolSearch: "Claude Tool Search",
    toolSearchDesc: "为非官方域名写入 ENABLE_TOOL_SEARCH",
    cancel: "取消",
    save: "保存",
    saving: "正在保存",
    saveAndUse: "保存并分配",
    setActive: "设为活动 URL",
    removeUrl: "删除 URL",
    showKey: "显示密钥",
    hideKey: "隐藏密钥",
    notDetected: "未检测",
    unavailable: "不可用",
    close: "关闭",
  },
  confirm: {
    deleteTitle: "删除「{name}」？",
    deleteMessage: "指向它的路由也会一并移除。此操作不修改已写入客户端的配置。",
    deleteConfirm: "删除",
    discardTitle: "放弃尚未保存的修改？",
    discardMessage: "表单中的改动不会写入方案。",
    discardConfirm: "放弃修改",
    cancel: "取消",
  },
  toast: {
    saved: "已保存「{name}」",
    duplicated: "已复制为「{name}」",
    deleted: "已删除「{name}」",
    keyCopied: "「{name}」的密钥已复制",
    reordered: "排序已保存",
    orderFailed: "当前版本不支持方案排序",
    gatewayStarted: "本地网关已启动，并接管已分配的客户端",
    gatewayStopped: "本地网关已停止",
    codexGatewayConflict: "Codex 仍指向另一个本地网关地址，无法安全自动覆盖。可恢复官方连接，登录状态不会清除",
    codexOfficialRestored: "Codex 已恢复官方登录，当前登录状态保持不变",
    portReassigned: "端口已换到 {port}",
    gatewaySkipped: "本地网关已停止；已跳过用户修改的 {targets}",
    settingsSaved: "设置已保存",
    modelsFound: "已识别 {count} 个可用模型",
    noModels: "请求已完成，但没有识别到模型",
    healthDone: "端点检测完成：{reachable} / {total} 可达",
    healthAllDone: "全部检测完成：{reachable} / {total} 个方案可达",
    autoSwitched: "已自动切换到 {url}",
    autoSwitchFailed: "自动检测失败",
    failoverSwitched: "{client} 已自动切换到「{name}」",
    failoverFailed: "故障切换失败",
    refreshFailed: "{message}，但界面刷新失败：{error}",
    upToDate: "已是最新版本 {version}",
    updateCheckFailed: "检查更新失败",
    unsupported: "当前版本不支持此功能",
    assignedRunning: "「{name}」已成为 {targets} 的当前网关方案",
    assignedStopped: "「{name}」已设为 {targets} 的下次启动方案",
    close: "关闭",
    undo: "撤销",
  },
  errors: {
    profileNotFound: "方案不存在",
    nameRequired: "请输入方案名称",
    urlInvalid: "请输入有效的 HTTP(S) API URL",
    urlCredentials: "API URL 不能包含凭据或片段",
    urlDuplicate: "API URL 不能重复",
    urlActiveRequired: "请选择一个活动 URL",
    keyRequired: "请输入 API Key",
    targetRequired: "至少选择一个适用客户端",
    urlAtLeastOne: "至少保留一个 API URL",
  },
  window: { minimize: "最小化", maximize: "最大化 / 还原", close: "关闭" },
  footer: {
    sealed: "DPAPI 本机加密",
    profiles: "方案",
    clients: "客户端",
    preview: "界面预览",
  },
};

const zhTW: Messages = {
  nav: { overview: "總覽", keys: "API Key", status: "狀態", wallet: "錢包", stream: "動態", config: "設定" },
  status: {
    title: "Channel Status",
    auto: "自動檢測",
    pause: "暫停",
    resume: "繼續",
    refresh: "立即檢測",
    interval: "檢測間隔",
    every2m: "2 分鐘",
    every5m: "5 分鐘",
    every10m: "10 分鐘",
    enabled: "啟用",
    disabled: "已關閉",
    monitor: "監測",
    channel: "渠道",
    model: "模型",
    state: "狀態",
    history: "近期紀錄",
    defaultModel: "預設 · {model}",
    probeModelLabel: "「{name}」檢測模型",
    enableProbe: "啟用「{name}」監測",
    disableProbe: "關閉「{name}」監測",
    healthy: "正常",
    smooth: "流暢",
    limited: "延遲",
    unhealthy: "故障",
    unknown: "未檢測",
    availability: "可用率",
    response: "總耗時",
    firstByte: "首包",
    lastCheck: "最近檢測",
    checking: "檢測中",
    countdown: "{seconds} 秒",
    action: "切換",
    noSamples: "等待第一輪實測",
    unsupported: "目前版本不支援 Key 實測",
    failover: "故障切換",
    failoverTitle: "故障切換設定",
    failoverCandidates: "允許切換的 API Key",
    failoverCurrent: "目前",
    failoverSelected: "已選 {count}",
    failoverNoProfiles: "沒有適用於這個 Client 的 API Key",
    enableFailover: "啟用 {client} 故障切換",
    disableFailover: "關閉 {client} 故障切換",
  },
  gateway: {
    online: "Gateway 運行中",
    offline: "Gateway 已關閉",
    syncing: "同步中",
    fault: "需要處理",
    toggleOn: "啟動本機 Gateway",
    toggleOff: "關閉本機 Gateway",
    recover: "還原設定並關閉本機 Gateway",
    hint: "Client 固定連本機位址；換 Profile 不動 Client 設定",
  },
  overview: {
    heroOnline: "Gateway 運行中",
    heroOffline: "Gateway 已關閉",
    heroStarting: "Gateway 啟動中",
    heroStopping: "Gateway 停止中",
    heroFault: "Gateway 需要處理",
    routesBound: "{routes} 條路由生效 · {profiles} 個 Profile 待命",
    directToUpstream: "Client 直連上游 · 點卡片接管",
    streaming: "{count} 個請求進行中",
    idle: "閒置中",
    faultHint: "設定被外部改過，請還原後關閉 Gateway",
    divergence: "分歧率",
    cacheHit: "Cache 命中",
    tokens: "用量",
    awaitingBaseline: "等待基準 · 需 3 次探測",
    baselineOf: "{current}ms / 基準 {baseline}ms · {profile}",
    cacheToday: "今日 · {count} 個請求 · 00:00 重設",
    todayResets: "今日 · 0 點歸零",
    clients: "CLIENT",
    worldLines: "世界線",
    experimental: "（實驗性）",
    unbound: "未接入",
    noProfileBound: "尚未指定 Profile",
    clientNotDetected: "找不到這個 Client",
    profileRemoved: "Profile 已刪除",
    externalEdit: "設定被外部改過",
    current: "目前",
    noCompatibleProfile: "沒有適用這個 Client 的 Profile",
    editToEnable: "編輯 Profile，勾選 {client}",
    clientDefault: "沿用 Client 設定",
    engage: "接管",
    release: "斷開",
    restoreOfficial: "恢復官方",
    swapProfile: "選 Key",
    engaged: "已接管",
    notEngaged: "未接管",
    portHint: "Port 被佔用？點一下換一個",
  },
  keys: {
    title: "API Key",
    subtitle: "{count} 個 Profile · 可拖曳排序",
    testAll: "全部檢測",
    create: "新增",
    active: "使用中",
    tokens: "累計",
    cache: "Cache 率",
    breakdown: "Token 拆解",
    awaitingSamples: "尚無樣本",
    statLine: "1 小時 {availability}% · 平均 {latency}",
    switchTo: "將「{name}」分配給所有適用 Client",
    assign: "分配",
    inUseHint: "使用中。點一下重新套用到所有適用的 Client",
    testEndpoints: "檢測 Endpoint 延遲（不影響其他操作）",
    expand: "{name} 的細節",
    key: "API Key",
    authHeader: "Auth Header",
    targets: "適用 Client",
    autoSwitch: "自動選最佳",
    autoSwitchOn: "每 2 分鐘依 1 小時線路可達率挑最佳",
    autoSwitchOff: "關閉",
    lastApplied: "上次切換",
    never: "從未",
    discoverModels: "偵測 Model",
    edit: "編輯",
    duplicate: "複製",
    delete: "刪除",
    copyKey: "複製 Key",
    models: "個 Model",
    loading: "讀取本機設定中",
    loadError: "讀不到本機資料",
    retry: "重試",
    emptyTitle: "還沒有任何 Profile",
    emptyHint: "先加一個 API Endpoint 和 Key",
    limited: "受限",
    down: "異常",
    untested: "未測",
    createGroup: "新增分組",
    renameGroup: "重新命名分組",
    deleteGroup: "刪除分組",
    groupName: "分組名稱",
    groupMembers: "分組 Key",
    groupNoKeys: "目前沒有可加入的 Key",
    ungrouped: "未分組",
    moveGroup: "拖曳分組排序",
    groupCount: "{count} 個 Key",
    expandGroup: "展開分組「{name}」",
    collapseGroup: "收起分組「{name}」",
    deleteGroupTitle: "刪除分組「{name}」？",
    deleteGroupMessage: "分組內的 Key 會移到「未分組」，Key 本身不會刪除。",
  },
  wallet: {
    title: "錢包",
    count: "{count} 個站點",
    checkAll: "全部檢測",
    check: "檢測餘額",
    name: "名稱",
    namePlaceholder: "例如：主力餘額",
    siteUrl: "站點 URL",
    apiKey: "API Key",
    keyKeepHint: "留白保留 {hint}",
    accountLogin: "帳號登入",
    notSignedIn: "未登入",
    loginExpired: "登入已過期",
    login: "登入站點",
    relogin: "重新登入",
    saveAndLogin: "儲存並登入",
    loginSuccess: "已登入「{name}」",
    importKeys: "匯入 Key",
    importConflictTitle: "已有同名分組",
    importConflictMessage: "已存在名為「{name}」的分組。要加入該分組，還是另建一個分組？",
    importCreateGroup: "另建分組",
    importExistingGroup: "加入現有分組",
    importSuccess: "已匯入至「{group}」：新增 {imported}、已有 {reused}、略過 {skipped}",
    template: "模板",
    balance: "餘額",
    threshold: "低額門檻",
    thresholdInvalid: "低額門檻必須是大於或等於 0 的數字",
    actions: "操作",
    createTitle: "新增錢包",
    editTitle: "編輯 · {name}",
    ok: "正常",
    low: "餘額偏低",
    empty: "已用完",
    unlimited: "無上限",
    error: "檢測失敗",
    unchecked: "未檢測",
    scopeKey: "Key 額度",
    scopeAccount: "帳號額度",
    scopeSite: "站點額度",
    dailyUsage: "今日 {used} / {limit}",
    dailyUnlimited: "今日 {used} / 無上限",
    resetsAt: "{time} 重置",
    daysRemaining: "剩 {days} 天",
    moreSubscriptions: "+{count}",
    loading: "讀取錢包中",
    loadError: "無法讀取錢包",
    emptyTitle: "還沒有錢包",
    emptyHint: "加入第一個餘額查詢站點",
    deleteTitle: "刪除「{name}」？",
    deleteMessage: "只會刪除這筆錢包紀錄，不會修改 API Key Profile 或 Gateway 設定。",
    saved: "已儲存「{name}」",
    deleted: "已刪除「{name}」",
    checkFailed: "餘額檢測失敗：{message}",
  },
  stream: {
    title: "動態",
    streaming: "{count} 個請求進行中",
    idle: "閒置中",
    retained: "完整保留近 3 天",
    capped: "只顯示最近 {shown} 筆 · 另有 {hidden} 筆保留中",
    all: "全部",
    live: "進行中",
    done: "完成",
    fail: "異常",
    cache: "Cache 率",
    tipIn: "全部提示 Token（含快取讀寫）",
    tipOut: "輸出 Token",
    tipCache: "命中的提示 Token（便宜）",
    tipWrite: "寫入的快取（1.25× 計費，最貴）",
    tipReason: "推理 Token（已算在輸出裡）",
    empty: "還沒有請求 · Gateway 收到請求後會即時顯示在這裡",
    noMatch: "沒有符合篩選條件的請求",
    resolving: "解析上游中",
    states: {
      connect: "連線中",
      wait: "等待首個輸出",
      stream: "傳輸中",
      done: "完成",
      fail: "失敗",
      abort: "中止",
      cancel: "取消",
    },
  },
  sessions: {
    title: "Session",
    loading: "讀取中",
    noMessages: "這個 session 沒有可顯示的發言",
    pickOne: "從左邊選一個 session",
    loadAll: "讀取全部發言",
    showingMessages: "以上 {count} 則",
    you: "我",
    agent: "AGENT",
    search: "搜尋標題、工作目錄或 Session ID",
    capped: "目前顯示 {shown} 個 · 另有 {hidden} 個，可展開或搜尋",
    refresh: "重新掃描",
    scanning: "正在掃描本機 session",
    empty: "找不到任何 session",
    emptyHint: "Claude Code / Codex / OpenCode 都還沒在這台機器上留下 session",
    noMatch: "沒有符合篩選條件的 session",
    all: "全部",
    subagents: "子代理",
    mainTask: "主任務",
    subagent: "子代理",
    subagentCount: "{count} 個子代理",
    sessionId: "Session ID",
    project: "專案",
    parentSessionId: "父 Session ID",
    workspace: "工作目錄",
    unknownWorkspace: "工作目錄不明",
    messages: "{count} 則訊息",
    msgUnit: "則",
    selected: "已選 {count} 個",
    selectAll: "全選",
    clear: "取消選取",
    remove: "刪除",
    removing: "正在刪除",
    confirmTitle: "刪除 {count} 個 session？",
    confirmBody: "連同它們在資料庫裡的紀錄一起清掉。",
    confirmIrreversible: "沒有資源回收筒，刪了就沒了。",
    willDelete: "將刪除",
    willKeep: "保留不動",
    keptHint: "這些是跨 session 共用的，按 session 刪會毀掉別的 session 的資料。",
    removed: "已刪除 {count} 個 session",
    removeFailed: "{count} 個 session 刪除失敗",
    dbLocked: "檔案被占用 · 關掉對應的 agent 再試",
  },
  config: {
    title: "設定",
    launchAtLogin: "開機自動啟動（靜默）",
    closeToTray: "關閉時常駐系統匣",
    startGateway: "啟動時還原 Gateway",
    updateCurrent: "目前版本 {version}",
    updateAvailable: "有新版本 {version}",
    updateDownloading: "下載中 {percent}%",
    updateReady: "{version} 已就緒，重開即可安裝",
    updateLatest: "已是最新版",
    updateFailed: "檢查更新失敗",
    checkUpdate: "檢查更新",
    download: "下載",
    goDownload: "前往下載",
    installRestart: "重開並安裝",
    attractorField: "世界線",
    system: "跟隨系統",
    language: "語言",
    security: "真正的 Key 由 Windows DPAPI 加密，只在本機交給 Gateway；Client 不會存到上游的 Key。Profile 裡的 URL 和 Key 永遠不會寫進 Client 的設定檔。",
  },
  editor: {
    createTitle: "新增 Profile",
    editTitle: "編輯 · {name}",
    name: "Profile 名稱",
    namePlaceholder: "例如：主力中轉",
    protocol: "API 協定",
    apiUrl: "API URL",
    activeUrlHint: "圓點標示使用中的 URL",
    addUrl: "加一個 URL",
    autoSwitch: "自動選最佳",
    autoSwitchHint: "自動挑 1 小時內線路可達率最高的 URL",
    apiKey: "API Key",
    keyKeepHint: "留空則沿用 {hint}",
    keyPlaceholder: "沿用現有的 Key",
    keyPlaceholderNew: "sk-...",
    model: "Model ID",
    modelsAvailable: "{count} 個可用",
    discoverModels: "偵測 Model",
    modelEmpty: "還沒偵測到 Model，點上面的「偵測 Model」",
    modelNoMatch: "沒有相符的 Model，點右邊箭頭看全部",
    authMode: "驗證方式",
    targets: "適用 Client",
    viaGateway: "可經 Gateway 轉發",
    incompatible: "協定不相容",
    toolSearch: "Claude Tool Search",
    toolSearchDesc: "為非官方網域寫入 ENABLE_TOOL_SEARCH",
    cancel: "取消",
    save: "儲存",
    saving: "儲存中",
    saveAndUse: "儲存並分配",
    setActive: "設為使用中的 URL",
    removeUrl: "移除 URL",
    showKey: "顯示 Key",
    hideKey: "隱藏 Key",
    notDetected: "未偵測",
    unavailable: "不可用",
    close: "關閉",
  },
  confirm: {
    deleteTitle: "刪除「{name}」？",
    deleteMessage: "指向它的路由會一起移除。已經寫進 Client 的設定不會被動到。",
    deleteConfirm: "刪除",
    discardTitle: "捨棄還沒存的變更？",
    discardMessage: "表單裡的變更不會寫進 Profile。",
    discardConfirm: "捨棄",
    cancel: "取消",
  },
  toast: {
    saved: "已儲存「{name}」",
    duplicated: "已複製成「{name}」",
    deleted: "已刪除「{name}」",
    keyCopied: "已複製「{name}」的 Key",
    reordered: "排序已儲存",
    orderFailed: "這個版本還不支援 Profile 排序",
    gatewayStarted: "本機 Gateway 已啟動，並接管指定的 Client",
    gatewayStopped: "本機 Gateway 已停止",
    codexGatewayConflict: "Codex 仍指向另一個本機 Gateway 位址，無法安全自動覆蓋。可恢復官方連線，登入狀態不會清除",
    codexOfficialRestored: "Codex 已恢復官方登入，目前登入狀態保持不變",
    portReassigned: "Port 已換成 {port}",
    gatewaySkipped: "本機 Gateway 已停止；{targets} 被你改過，跳過不動",
    settingsSaved: "設定已儲存",
    modelsFound: "偵測到 {count} 個可用 Model",
    noModels: "請求完成了，但沒偵測到任何 Model",
    healthDone: "Endpoint 檢測完成：{reachable} / {total} 可達",
    healthAllDone: "全部檢測完成：{reachable} / {total} 個 Profile 可達",
    autoSwitched: "已自動切到 {url}",
    autoSwitchFailed: "自動檢測失敗",
    failoverSwitched: "{client} 已自動切到「{name}」",
    failoverFailed: "故障切換失敗",
    refreshFailed: "{message}，但畫面沒刷新成功：{error}",
    upToDate: "已是最新版 {version}",
    updateCheckFailed: "檢查更新失敗",
    unsupported: "這個版本還不支援這個功能",
    assignedRunning: "{targets} 現在走「{name}」",
    assignedStopped: "{targets} 下次啟動時會走「{name}」",
    close: "關閉",
    undo: "復原",
  },
  errors: {
    profileNotFound: "找不到這個 Profile",
    nameRequired: "請填 Profile 名稱",
    urlInvalid: "請填有效的 HTTP(S) API URL",
    urlCredentials: "API URL 不能帶帳密或 fragment",
    urlDuplicate: "API URL 不能重複",
    urlActiveRequired: "請選一個使用中的 URL",
    keyRequired: "請填 API Key",
    targetRequired: "至少選一個適用的 Client",
    urlAtLeastOne: "至少要留一個 API URL",
  },
  window: { minimize: "最小化", maximize: "最大化 / 還原", close: "關閉" },
  footer: {
    sealed: "DPAPI 本機加密",
    profiles: "PROFILE",
    clients: "CLIENT",
    preview: "介面預覽",
  },
};

const ja: Messages = {
  nav: { overview: "概要", keys: "API キー", status: "状態", wallet: "ウォレット", stream: "ストリーム", config: "設定" },
  status: {
    title: "チャネル状態",
    auto: "自動チェック",
    pause: "一時停止",
    resume: "再開",
    refresh: "今すぐチェック",
    interval: "間隔",
    every2m: "2 分",
    every5m: "5 分",
    every10m: "10 分",
    enabled: "有効",
    disabled: "停止中",
    monitor: "監視",
    channel: "チャネル",
    model: "モデル",
    state: "状態",
    history: "直近の履歴",
    defaultModel: "既定 · {model}",
    probeModelLabel: "「{name}」のチェック用モデル",
    enableProbe: "「{name}」の監視を有効化",
    disableProbe: "「{name}」の監視を停止",
    healthy: "正常",
    smooth: "快適",
    limited: "遅延",
    unhealthy: "障害",
    unknown: "未計測",
    availability: "可用率",
    response: "合計",
    firstByte: "初バイト",
    lastCheck: "最終チェック",
    checking: "チェック中",
    countdown: "{seconds} 秒",
    action: "切替",
    noSamples: "初回チェック待ち",
    unsupported: "このバージョンでは Key 実測に未対応",
    failover: "障害時切替",
    failoverTitle: "障害時切替の設定",
    failoverCandidates: "切替を許可するキー",
    failoverCurrent: "使用中",
    failoverSelected: "{count} 件選択",
    failoverNoProfiles: "このクライアントで使えるキーがありません",
    enableFailover: "{client} の障害時切替を有効化",
    disableFailover: "{client} の障害時切替を無効化",
  },
  gateway: {
    online: "ゲートウェイ稼働中",
    offline: "ゲートウェイ停止中",
    syncing: "同期中",
    fault: "要対応",
    toggleOn: "ローカルゲートウェイを起動",
    toggleOff: "ローカルゲートウェイを停止",
    recover: "設定を戻してゲートウェイを停止",
    hint: "クライアントはローカルアドレスに固定。プロファイルを変えても設定はそのまま",
  },
  overview: {
    heroOnline: "ゲートウェイ稼働中",
    heroOffline: "ゲートウェイ停止中",
    heroStarting: "ゲートウェイ起動中",
    heroStopping: "ゲートウェイ停止処理中",
    heroFault: "ゲートウェイ異常",
    routesBound: "ルート {routes} 件が有効 · プロファイル {profiles} 件が待機",
    directToUpstream: "クライアントは上流に直結中 · カードをクリックで引き受け",
    streaming: "{count} 件のリクエストが進行中",
    idle: "アイドル",
    faultHint: "設定が外部から書き換えられています。復元してから停止してください",
    divergence: "ダイバージェンス",
    cacheHit: "キャッシュヒット",
    tokens: "使用量",
    awaitingBaseline: "基準値待ち · 計測 3 回必要",
    baselineOf: "{current}ms / 基準 {baseline}ms · {profile}",
    cacheToday: "今日 · {count} 件 · 0 時リセット",
    todayResets: "本日 · 0 時にリセット",
    clients: "CLIENT",
    worldLines: "世界線",
    experimental: "（実験的）",
    unbound: "未接続",
    noProfileBound: "プロファイル未設定",
    clientNotDetected: "クライアントが見つかりません",
    profileRemoved: "プロファイルは削除済み",
    externalEdit: "外部から書き換えられています",
    current: "使用中",
    noCompatibleProfile: "このクライアントに使えるプロファイルがありません",
    editToEnable: "プロファイルを編集して {client} を選択",
    clientDefault: "クライアント設定のまま",
    engage: "引き受け",
    release: "解除",
    restoreOfficial: "公式接続に戻す",
    swapProfile: "キーを選ぶ",
    engaged: "引き受け中",
    notEngaged: "待機中",
    portHint: "ポートが使用中？クリックで変更",
  },
  keys: {
    title: "API キー",
    subtitle: "プロファイル {count} 件 · ドラッグで並べ替え",
    testAll: "一括チェック",
    create: "追加",
    active: "使用中",
    tokens: "累計",
    cache: "キャッシュ率",
    breakdown: "トークン内訳",
    awaitingSamples: "サンプルなし",
    statLine: "1時間 {availability}% · 平均 {latency}",
    switchTo: "「{name}」を対応クライアントすべてに割り当て",
    assign: "割り当て",
    inUseHint: "使用中。クリックで対象クライアントすべてに再適用",
    testEndpoints: "エンドポイントの遅延を計測（他の操作は止まりません）",
    expand: "{name} の詳細",
    key: "API キー",
    authHeader: "認証ヘッダ",
    targets: "対象クライアント",
    autoSwitch: "自動で最適を選ぶ",
    autoSwitchOn: "2 分ごとに直近 1 時間の回線到達率で最適を選択",
    autoSwitchOff: "無効",
    lastApplied: "前回の切り替え",
    never: "未実行",
    discoverModels: "モデルを取得",
    edit: "編集",
    duplicate: "複製",
    delete: "削除",
    copyKey: "キーをコピー",
    models: "モデル",
    loading: "ローカル設定を読み込み中",
    loadError: "ローカルデータを読み込めません",
    retry: "再試行",
    emptyTitle: "プロファイルがまだありません",
    emptyHint: "最初の API エンドポイントとキーを登録",
    limited: "制限あり",
    down: "異常",
    untested: "未計測",
    createGroup: "グループを追加",
    renameGroup: "グループ名を変更",
    deleteGroup: "グループを削除",
    groupName: "グループ名",
    groupMembers: "グループのキー",
    groupNoKeys: "追加できるキーがありません",
    ungrouped: "未分類",
    moveGroup: "ドラッグしてグループを並べ替え",
    groupCount: "キー {count} 件",
    expandGroup: "グループ「{name}」を展開",
    collapseGroup: "グループ「{name}」を折りたたむ",
    deleteGroupTitle: "グループ「{name}」を削除しますか？",
    deleteGroupMessage: "グループ内のキーは「未分類」に移動し、キー自体は削除されません。",
  },
  wallet: {
    title: "ウォレット",
    count: "{count} サイト",
    checkAll: "一括確認",
    check: "残高を確認",
    name: "名前",
    namePlaceholder: "例：メイン残高",
    siteUrl: "サイト URL",
    apiKey: "API キー",
    keyKeepHint: "空欄で {hint} を維持",
    accountLogin: "アカウントログイン",
    notSignedIn: "未ログイン",
    loginExpired: "ログイン期限切れ",
    login: "サイトにログイン",
    relogin: "再ログイン",
    saveAndLogin: "保存してログイン",
    loginSuccess: "「{name}」にログインしました",
    importKeys: "キーを取り込む",
    importConflictTitle: "同名グループがあります",
    importConflictMessage: "「{name}」グループは既にあります。そこへ追加するか、別グループを作成してください。",
    importCreateGroup: "別グループを作成",
    importExistingGroup: "既存グループへ追加",
    importSuccess: "「{group}」へ取込完了：新規 {imported}、既存 {reused}、スキップ {skipped}",
    template: "テンプレート",
    balance: "残高",
    threshold: "残高警告値",
    thresholdInvalid: "残高警告値には 0 以上の数値を入力してください",
    actions: "操作",
    createTitle: "ウォレットを追加",
    editTitle: "編集 · {name}",
    ok: "正常",
    low: "残高低下",
    empty: "残高なし",
    unlimited: "無制限",
    error: "確認失敗",
    unchecked: "未確認",
    scopeKey: "キー残高",
    scopeAccount: "アカウント残高",
    scopeSite: "サイト残高",
    dailyUsage: "本日 {used} / {limit}",
    dailyUnlimited: "本日 {used} / 無制限",
    resetsAt: "{time} にリセット",
    daysRemaining: "残り {days} 日",
    moreSubscriptions: "+{count}",
    loading: "ウォレットを読込中",
    loadError: "ウォレットを読み込めません",
    emptyTitle: "ウォレットなし",
    emptyHint: "残高を確認するサイトを追加してください",
    deleteTitle: "「{name}」を削除しますか？",
    deleteMessage: "このウォレットだけを削除します。プロファイルやゲートウェイ設定は変更しません。",
    saved: "「{name}」を保存しました",
    deleted: "「{name}」を削除しました",
    checkFailed: "残高確認に失敗：{message}",
  },
  stream: {
    title: "ストリーム",
    streaming: "{count} 件のリクエストが進行中",
    idle: "アイドル",
    retained: "直近 3 日分をすべて保持",
    capped: "最新 {shown} 件を表示 · 他 {hidden} 件を保持中",
    all: "すべて",
    live: "進行中",
    done: "完了",
    fail: "異常",
    cache: "キャッシュ率",
    tipIn: "入力トークン合計（キャッシュ読み書き込み）",
    tipOut: "出力トークン",
    tipCache: "ヒットした入力トークン（安い）",
    tipWrite: "キャッシュ書き込み（1.25 倍課金、最も高い）",
    tipReason: "推論トークン（出力に含まれる）",
    empty: "リクエストはまだありません · ゲートウェイが受けた時点でここに出ます",
    noMatch: "条件に一致するリクエストがありません",
    resolving: "上流を解決中",
    states: {
      connect: "接続中",
      wait: "初回出力待ち",
      stream: "転送中",
      done: "完了",
      fail: "失敗",
      abort: "中断",
      cancel: "キャンセル",
    },
  },
  sessions: {
    title: "セッション",
    loading: "読み込み中",
    noMessages: "表示できる発言なし",
    pickOne: "左からセッションを選択",
    loadAll: "すべて読み込む",
    showingMessages: "以上 {count} 件",
    you: "自分",
    agent: "AGENT",
    search: "タイトル・作業ディレクトリ・セッション ID を検索",
    capped: "{shown} 件を表示 · 他 {hidden} 件は展開または検索で",
    refresh: "再スキャン",
    scanning: "ローカルセッションをスキャン中",
    empty: "セッションなし",
    emptyHint: "Claude Code / Codex / OpenCode いずれもこの端末にセッションを残していない",
    noMatch: "条件に合うセッションなし",
    all: "すべて",
    subagents: "サブエージェント",
    mainTask: "メインタスク",
    subagent: "サブエージェント",
    subagentCount: "サブエージェント {count} 件",
    sessionId: "セッション ID",
    project: "プロジェクト",
    parentSessionId: "親セッション ID",
    workspace: "作業ディレクトリ",
    unknownWorkspace: "作業ディレクトリ不明",
    messages: "{count} メッセージ",
    msgUnit: "件",
    selected: "{count} 件選択中",
    selectAll: "全選択",
    clear: "選択解除",
    remove: "削除",
    removing: "削除中",
    confirmTitle: "{count} 件のセッションを削除？",
    confirmBody: "DB 上のレコードごと消えます。",
    confirmIrreversible: "ゴミ箱なし。戻せません。",
    willDelete: "削除対象",
    willKeep: "手を付けない",
    keptHint: "セッション間で共有されている。セッション単位で消すと他のセッションのデータを壊す。",
    removed: "{count} 件のセッションを削除",
    removeFailed: "{count} 件の削除に失敗",
    dbLocked: "ファイルが使用中 · 対象の agent を終了してから再試行",
  },
  config: {
    title: "設定",
    launchAtLogin: "自動起動（サイレント）",
    closeToTray: "閉じてもトレイに常駐",
    startGateway: "起動時にゲートウェイを復元",
    updateCurrent: "現在のバージョン {version}",
    updateAvailable: "新しいバージョン {version} があります",
    updateDownloading: "ダウンロード中 {percent}%",
    updateReady: "{version} の準備完了。再起動でインストール",
    updateLatest: "最新版です",
    updateFailed: "更新の確認に失敗",
    checkUpdate: "更新を確認",
    download: "ダウンロード",
    goDownload: "配布ページへ",
    installRestart: "再起動してインストール",
    attractorField: "世界線",
    system: "システムに従う",
    language: "言語",
    security: "本物のキーは Windows DPAPI で暗号化し、ローカルのゲートウェイにのみ渡します。クライアントが上流のキーを保存することはありません。プロファイルの URL とキーがクライアントの設定ファイルに書き込まれることもありません。",
  },
  editor: {
    createTitle: "プロファイルを追加",
    editTitle: "編集 · {name}",
    name: "プロファイル名",
    namePlaceholder: "例：メインのリレー",
    protocol: "API プロトコル",
    apiUrl: "API URL",
    activeUrlHint: "使用中の URL はドットで表示",
    addUrl: "URL を追加",
    autoSwitch: "自動で最適を選ぶ",
    autoSwitchHint: "直近 1 時間の回線到達率が最も高い URL を自動選択",
    apiKey: "API キー",
    keyKeepHint: "空欄なら {hint} のまま",
    keyPlaceholder: "現在のキーを維持",
    keyPlaceholderNew: "sk-...",
    model: "モデル ID",
    modelsAvailable: "{count} 件が利用可能",
    discoverModels: "モデルを取得",
    modelEmpty: "モデルがまだありません。上の「モデルを取得」から",
    modelNoMatch: "一致するモデルなし。右の矢印で全件表示",
    authMode: "認証方式",
    targets: "対象クライアント",
    viaGateway: "ゲートウェイ経由で転送可",
    incompatible: "プロトコル非対応",
    toolSearch: "Claude Tool Search",
    toolSearchDesc: "非公式ドメインに ENABLE_TOOL_SEARCH を書き込む",
    cancel: "キャンセル",
    save: "保存",
    saving: "保存中",
    saveAndUse: "保存して割り当て",
    setActive: "この URL を使う",
    removeUrl: "URL を削除",
    showKey: "キーを表示",
    hideKey: "キーを隠す",
    notDetected: "未計測",
    unavailable: "利用不可",
    close: "閉じる",
  },
  confirm: {
    deleteTitle: "「{name}」を削除しますか？",
    deleteMessage: "これを指すルートも一緒に消えます。クライアントに書き込み済みの設定はそのままです。",
    deleteConfirm: "削除",
    discardTitle: "保存していない変更を破棄しますか？",
    discardMessage: "フォームの変更はプロファイルに反映されません。",
    discardConfirm: "破棄",
    cancel: "キャンセル",
  },
  toast: {
    saved: "「{name}」を保存しました",
    duplicated: "「{name}」として複製しました",
    deleted: "「{name}」を削除しました",
    keyCopied: "「{name}」のキーをコピーしました",
    reordered: "並び順を保存しました",
    orderFailed: "このバージョンは並べ替えに未対応です",
    gatewayStarted: "ローカルゲートウェイを起動し、対象のクライアントを引き受けました",
    gatewayStopped: "ローカルゲートウェイを停止しました",
    codexGatewayConflict: "Codex は別のローカルゲートウェイを参照しているため、安全に上書きできません。公式接続に戻してもログイン状態は維持されます",
    codexOfficialRestored: "Codex を公式ログインに戻しました。ログイン状態は維持されています",
    portReassigned: "ポートを {port} に変更しました",
    gatewaySkipped: "ローカルゲートウェイを停止しました。{targets} は手動で変更されているため触れていません",
    settingsSaved: "設定を保存しました",
    modelsFound: "{count} 件のモデルを取得しました",
    noModels: "リクエストは成功しましたが、モデルは見つかりませんでした",
    healthDone: "エンドポイントのチェック完了：{reachable} / {total} 到達可",
    healthAllDone: "一括チェック完了：{reachable} / {total} 件のプロファイルが到達可",
    autoSwitched: "{url} に自動で切り替えました",
    autoSwitchFailed: "自動チェックに失敗",
    failoverSwitched: "{client} を「{name}」へ自動で切り替えました",
    failoverFailed: "障害時の切替に失敗",
    refreshFailed: "{message}。ただし画面の更新に失敗しました：{error}",
    upToDate: "最新版です {version}",
    updateCheckFailed: "更新の確認に失敗",
    unsupported: "このバージョンでは使えません",
    assignedRunning: "{targets} は現在「{name}」を使います",
    assignedStopped: "{targets} は次回起動時に「{name}」を使います",
    close: "閉じる",
    undo: "元に戻す",
  },
  errors: {
    profileNotFound: "プロファイルが見つかりません",
    nameRequired: "プロファイル名を入力してください",
    urlInvalid: "有効な HTTP(S) の API URL を入力してください",
    urlCredentials: "API URL に認証情報やフラグメントは含められません",
    urlDuplicate: "API URL が重複しています",
    urlActiveRequired: "使用する URL を 1 つ選んでください",
    keyRequired: "API キーを入力してください",
    targetRequired: "対象クライアントを 1 つ以上選んでください",
    urlAtLeastOne: "API URL は 1 つ以上必要です",
  },
  window: { minimize: "最小化", maximize: "最大化 / 元に戻す", close: "閉じる" },
  footer: {
    sealed: "DPAPI 暗号化",
    profiles: "PROFILE",
    clients: "CLIENT",
    preview: "プレビュー",
  },
};

const en: Messages = {
  nav: { overview: "OVERVIEW", keys: "KEYS", status: "STATUS", wallet: "WALLET", stream: "STREAM", config: "CONFIG" },
  status: {
    title: "CHANNEL STATUS",
    auto: "AUTO PROBE",
    pause: "PAUSE",
    resume: "RESUME",
    refresh: "PROBE NOW",
    interval: "INTERVAL",
    every2m: "2 MIN",
    every5m: "5 MIN",
    every10m: "10 MIN",
    enabled: "ENABLED",
    disabled: "DISABLED",
    monitor: "MONITOR",
    channel: "CHANNEL",
    model: "MODEL",
    state: "STATE",
    history: "RECENT HISTORY",
    defaultModel: "DEFAULT · {model}",
    probeModelLabel: "Probe model for {name}",
    enableProbe: "Enable monitoring for {name}",
    disableProbe: "Disable monitoring for {name}",
    healthy: "HEALTHY",
    smooth: "SMOOTH",
    limited: "HIGH LATENCY",
    unhealthy: "DOWN",
    unknown: "UNTESTED",
    availability: "AVAILABILITY",
    response: "TOTAL",
    firstByte: "TTFB",
    lastCheck: "LAST PROBE",
    checking: "PROBING",
    countdown: "{seconds}s",
    action: "SWITCH",
    noSamples: "AWAITING FIRST PROBE",
    unsupported: "Key probing is not available in this build",
    failover: "FAILOVER",
    failoverTitle: "Failover settings",
    failoverCandidates: "Allowed keys",
    failoverCurrent: "CURRENT",
    failoverSelected: "{count} SELECTED",
    failoverNoProfiles: "No keys support this client",
    enableFailover: "Enable failover for {client}",
    disableFailover: "Disable failover for {client}",
  },
  gateway: {
    online: "GATEWAY ONLINE",
    offline: "GATEWAY OFFLINE",
    syncing: "SYNCING",
    fault: "FAULT",
    toggleOn: "Start local gateway",
    toggleOff: "Stop local gateway",
    recover: "Restore config and stop gateway",
    hint: "Clients bind to a fixed local address; switching profiles never rewrites client config",
  },
  overview: {
    heroOnline: "Gateway Online",
    heroOffline: "Gateway Offline",
    heroStarting: "Gateway Starting",
    heroStopping: "Gateway Stopping",
    heroFault: "Gateway Fault",
    routesBound: "{routes} ROUTES BOUND · {profiles} PROFILES READY",
    directToUpstream: "CLIENTS DIRECT TO UPSTREAM · TOGGLE GATEWAY TO BIND",
    streaming: "{count} STREAMING",
    idle: "IDLE",
    faultHint: "Config was edited externally. Restore and stop from the top bar.",
    divergence: "DIVERGENCE",
    cacheHit: "CACHE HIT",
    tokens: "TOKENS",
    awaitingBaseline: "AWAITING BASELINE · 3 SAMPLES NEEDED",
    baselineOf: "{current}ms / {baseline}ms BASELINE · {profile}",
    cacheToday: "TODAY · {count} REQUESTS · RESET 00:00",
    todayResets: "TODAY · RESETS AT 00:00",
    clients: "CLIENTS",
    worldLines: "World Lines",
    experimental: "(EXPERIMENTAL)",
    unbound: "UNBOUND",
    noProfileBound: "NO PROFILE BOUND",
    clientNotDetected: "CLIENT NOT DETECTED",
    profileRemoved: "PROFILE REMOVED",
    externalEdit: "EXTERNAL EDIT DETECTED",
    current: "CURRENT",
    noCompatibleProfile: "No compatible profile",
    editToEnable: "Edit a profile and enable {client}",
    clientDefault: "CLIENT DEFAULT",
    engage: "ENGAGE",
    release: "RELEASE",
    restoreOfficial: "RESTORE OFFICIAL",
    swapProfile: "SELECT KEY",
    engaged: "ENGAGED",
    notEngaged: "STANDBY",
    portHint: "Port taken? Click to move",
  },
  keys: {
    title: "Attractor Fields",
    subtitle: "{count} PROFILES · DRAG TO REORDER",
    testAll: "TEST ALL",
    create: "NEW",
    active: "ACTIVE",
    tokens: "TOKENS",
    cache: "CACHE",
    breakdown: "TOKEN BREAKDOWN",
    awaitingSamples: "AWAITING SAMPLES",
    statLine: "1H {availability}% · AVG {latency}",
    switchTo: "Assign {name} to all compatible clients",
    assign: "ASSIGN",
    inUseHint: "Already active — click to re-bind all compatible clients",
    testEndpoints: "Probe endpoint latency (non-blocking)",
    expand: "{name} details",
    key: "KEY",
    authHeader: "AUTH",
    targets: "CLIENTS",
    autoSwitch: "AUTO",
    autoSwitchOn: "Every 2 min by 1h route reachability",
    autoSwitchOff: "OFF",
    lastApplied: "LAST JUMP",
    never: "NEVER",
    discoverModels: "MODELS",
    edit: "EDIT",
    duplicate: "COPY",
    delete: "DELETE",
    copyKey: "Copy key",
    models: "models",
    loading: "Reading local config",
    loadError: "Cannot read local data",
    retry: "RETRY",
    emptyTitle: "No profiles yet",
    emptyHint: "Add your first API endpoint and key",
    limited: "LIMITED",
    down: "DOWN",
    untested: "———",
    createGroup: "NEW GROUP",
    renameGroup: "RENAME GROUP",
    deleteGroup: "DELETE GROUP",
    groupName: "GROUP NAME",
    groupMembers: "GROUP KEYS",
    groupNoKeys: "No keys available",
    ungrouped: "UNGROUPED",
    moveGroup: "Drag to reorder group",
    groupCount: "{count} keys",
    expandGroup: "Expand group {name}",
    collapseGroup: "Collapse group {name}",
    deleteGroupTitle: "Delete group “{name}”?",
    deleteGroupMessage: "Keys in this group move to Ungrouped. The keys themselves are not deleted.",
  },
  wallet: {
    title: "Wallet",
    count: "{count} sites",
    checkAll: "Check all",
    check: "Check balance",
    name: "Name",
    namePlaceholder: "e.g. Primary balance",
    siteUrl: "Site URL",
    apiKey: "API key",
    keyKeepHint: "Leave blank to keep {hint}",
    accountLogin: "Account login",
    notSignedIn: "Not signed in",
    loginExpired: "Login expired",
    login: "Sign in",
    relogin: "Sign in again",
    saveAndLogin: "Save and sign in",
    loginSuccess: "Signed in to “{name}”",
    importKeys: "Import keys",
    importConflictTitle: "Group already exists",
    importConflictMessage: "A group named “{name}” already exists. Add the keys there or create a separate group?",
    importCreateGroup: "Create separate group",
    importExistingGroup: "Add to existing group",
    importSuccess: "Imported into “{group}”: {imported} new, {reused} existing, {skipped} skipped",
    template: "Template",
    balance: "Balance",
    threshold: "Low threshold",
    thresholdInvalid: "Low threshold must be a number greater than or equal to 0",
    actions: "Actions",
    createTitle: "Add wallet",
    editTitle: "Edit · {name}",
    ok: "Available",
    low: "Low balance",
    empty: "Depleted",
    unlimited: "Unlimited",
    error: "Check failed",
    unchecked: "Unchecked",
    scopeKey: "Key balance",
    scopeAccount: "Account balance",
    scopeSite: "Site balance",
    dailyUsage: "Today {used} / {limit}",
    dailyUnlimited: "Today {used} / unlimited",
    resetsAt: "Resets {time}",
    daysRemaining: "{days}d left",
    moreSubscriptions: "+{count}",
    loading: "Loading wallets",
    loadError: "Could not load wallets",
    emptyTitle: "No wallets yet",
    emptyHint: "Add a site to start checking its balance",
    deleteTitle: "Delete “{name}”?",
    deleteMessage: "This only removes the wallet entry. Profiles and gateway settings stay unchanged.",
    saved: "Saved “{name}”",
    deleted: "Deleted “{name}”",
    checkFailed: "Balance check failed: {message}",
  },
  stream: {
    title: "Stream",
    streaming: "{count} STREAMING",
    idle: "IDLE",
    retained: "ALL REQUESTS FROM THE LAST 3 DAYS",
    capped: "SHOWING LATEST {shown} · {hidden} MORE RETAINED",
    all: "ALL",
    live: "LIVE",
    done: "DONE",
    fail: "FAIL",
    cache: "CACHE",
    tipIn: "All prompt tokens incl. cache",
    tipOut: "Output tokens",
    tipCache: "Cached prompt tokens (cheap)",
    tipWrite: "Cache write (billed 1.25x, priciest)",
    tipReason: "Reasoning tokens (already inside output)",
    empty: "NO REQUESTS YET · gateway traffic appears here in real time",
    noMatch: "NO MATCHING REQUESTS",
    resolving: "RESOLVING",
    states: {
      connect: "CONNECT",
      wait: "WAIT",
      stream: "STREAM",
      done: "DONE",
      fail: "FAIL",
      abort: "ABORT",
      cancel: "CANCEL",
    },
  },
  sessions: {
    title: "Sessions",
    loading: "Loading",
    noMessages: "No messages to show",
    pickOne: "Pick a session on the left",
    loadAll: "Load all messages",
    showingMessages: "{count} shown",
    you: "You",
    agent: "AGENT",
    search: "Search title, workspace, or session ID",
    capped: "Showing {shown} · {hidden} more, available by expanding or searching",
    refresh: "Rescan",
    scanning: "Scanning local sessions",
    empty: "No sessions found",
    emptyHint: "Claude Code / Codex / OpenCode have not left any sessions on this machine",
    noMatch: "No sessions match this filter",
    all: "All",
    subagents: "Subagents",
    mainTask: "Main task",
    subagent: "Subagent",
    subagentCount: "{count} subagents",
    sessionId: "Session ID",
    project: "Project",
    parentSessionId: "Parent session ID",
    workspace: "Workspace",
    unknownWorkspace: "Workspace unknown",
    messages: "{count} messages",
    msgUnit: "msg",
    selected: "{count} selected",
    selectAll: "Select all",
    clear: "Clear",
    remove: "Delete",
    removing: "Deleting",
    confirmTitle: "Delete {count} sessions?",
    confirmBody: "Their database rows go with them.",
    confirmIrreversible: "There is no trash. This cannot be undone.",
    willDelete: "Will delete",
    willKeep: "Left alone",
    keptHint: "These are shared across sessions — deleting them per-session would destroy other sessions' data.",
    removed: "Deleted {count} sessions",
    removeFailed: "{count} sessions failed to delete",
    dbLocked: "File is in use · close that agent and retry",
  },
  config: {
    title: "Config",
    launchAtLogin: "Launch at login (silent)",
    closeToTray: "Close to tray",
    startGateway: "Restore gateway on launch",
    updateCurrent: "Current version {version}",
    updateAvailable: "Version {version} available",
    updateDownloading: "Downloading {percent}%",
    updateReady: "Version {version} ready — restart to install",
    updateLatest: "Up to date",
    updateFailed: "Update check failed",
    checkUpdate: "CHECK",
    download: "DOWNLOAD",
    goDownload: "OPEN PAGE",
    installRestart: "RESTART & INSTALL",
    attractorField: "Attractor Field",
    system: "SYSTEM",
    language: "Language",
    security: "Real keys are encrypted with Windows DPAPI and handed only to the local gateway. Clients never store upstream keys, and profile URLs and keys are never written to client config files.",
  },
  editor: {
    createTitle: "New connection profile",
    editTitle: "Edit · {name}",
    name: "Profile name",
    namePlaceholder: "e.g. Primary relay",
    protocol: "API protocol",
    apiUrl: "API URL",
    activeUrlHint: "Dot marks the active URL",
    addUrl: "ADD URL",
    autoSwitch: "AUTO",
    autoSwitchHint: "Select the URL with the best 1h route reachability",
    apiKey: "API Key",
    keyKeepHint: "Blank keeps {hint}",
    keyPlaceholder: "Keep existing key",
    keyPlaceholderNew: "sk-...",
    model: "Model ID",
    modelsAvailable: "{count} available",
    discoverModels: "MODELS",
    modelEmpty: "No models yet — click MODELS above",
    modelNoMatch: "No match — use the arrow to see all",
    authMode: "Auth mode",
    targets: "Target clients",
    viaGateway: "Via gateway",
    incompatible: "Protocol mismatch",
    toolSearch: "Claude Tool Search",
    toolSearchDesc: "Writes ENABLE_TOOL_SEARCH for non-official domains",
    cancel: "CANCEL",
    save: "SAVE",
    saving: "SAVING",
    saveAndUse: "SAVE & ASSIGN",
    setActive: "Set as active URL",
    removeUrl: "Remove URL",
    showKey: "Show key",
    hideKey: "Hide key",
    notDetected: "———",
    unavailable: "DOWN",
    close: "Close",
  },
  confirm: {
    deleteTitle: "Delete {name}?",
    deleteMessage: "Routes pointing to it are removed too. Client configs already written are not modified.",
    deleteConfirm: "DELETE",
    discardTitle: "Discard unsaved changes?",
    discardMessage: "Form edits will not be written to the profile.",
    discardConfirm: "DISCARD",
    cancel: "CANCEL",
  },
  toast: {
    saved: "Saved {name}",
    duplicated: "Duplicated as {name}",
    deleted: "Deleted {name}",
    keyCopied: "Key for {name} copied",
    reordered: "Order saved",
    orderFailed: "This build does not support reordering",
    gatewayStarted: "Local gateway started and bound to assigned clients",
    gatewayStopped: "Local gateway stopped",
    codexGatewayConflict: "Codex points to another local gateway, so it cannot be overwritten safely. Restore the official connection without clearing the current login",
    codexOfficialRestored: "Codex restored to official login; the current session was preserved",
    portReassigned: "Port moved to {port}",
    gatewaySkipped: "Gateway stopped; skipped user-edited {targets}",
    settingsSaved: "Settings saved",
    modelsFound: "Found {count} models",
    noModels: "Completed, but no models were recognized",
    healthDone: "Probe complete: {reachable} / {total} reachable",
    healthAllDone: "All probes complete: {reachable} / {total} profiles reachable",
    autoSwitched: "Auto-switched to {url}",
    autoSwitchFailed: "Auto probe failed",
    failoverSwitched: "{client} automatically switched to {name}",
    failoverFailed: "Failover could not switch keys",
    refreshFailed: "{message}, but the view failed to refresh: {error}",
    upToDate: "Up to date {version}",
    updateCheckFailed: "Update check failed",
    unsupported: "Not supported in this build",
    assignedRunning: "{name} is now the gateway profile for {targets}",
    assignedStopped: "{name} set as the next-launch profile for {targets}",
    close: "Close",
    undo: "Undo",
  },
  errors: {
    profileNotFound: "Profile not found",
    nameRequired: "Enter a profile name",
    urlInvalid: "Enter a valid HTTP(S) API URL",
    urlCredentials: "API URL cannot contain credentials or fragments",
    urlDuplicate: "API URLs must be unique",
    urlActiveRequired: "Select an active URL",
    keyRequired: "Enter an API key",
    targetRequired: "Select at least one client",
    urlAtLeastOne: "Keep at least one API URL",
  },
  window: { minimize: "Minimize", maximize: "Maximize / Restore", close: "Close" },
  footer: {
    sealed: "DPAPI SEALED",
    profiles: "PROFILES",
    clients: "CLIENTS",
    preview: "PREVIEW",
  },
};

export const MESSAGES: Record<Locale, Messages> = { zh, "zh-TW": zhTW, ja, en };

export const LOCALE_LABELS: Record<Locale, string> = {
  zh: "简体中文",
  "zh-TW": "繁體中文",
  ja: "日本語",
  en: "English",
};

/** 台湾 / 香港 / 澳门，以及显式声明 Hant 字集的标签，都走繁体。 */
const TRADITIONAL = /^zh-(tw|hk|mo)\b|hant/;

/** 从系统语言推断界面语言，无法匹配时回退简体中文。 */
export function detectLocale(): Locale {
  const languages = typeof navigator === "undefined" ? [] : navigator.languages ?? [navigator.language];
  for (const language of languages) {
    const tag = language.toLowerCase();
    if (tag.startsWith("zh")) return TRADITIONAL.test(tag) ? "zh-TW" : "zh";
    if (tag.startsWith("ja")) return "ja";
    if (tag.startsWith("en")) return "en";
  }
  return "zh";
}
