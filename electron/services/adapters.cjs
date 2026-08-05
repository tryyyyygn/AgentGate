const fs = require('node:fs')
const path = require('node:path')
const {
  assertValidJsonc,
  assertValidToml,
  hashText,
  parseJsoncValue,
  parseTomlValue,
  patchCodexToml,
  patchCodexGatewayBaseUrl,
  patchEnv,
  patchJsonc,
  readTextSnapshot,
  captureCodexFreshState,
  codexHasActiveProvider,
  codexProviderState,
  restoreCodexGatewayBaseUrl,
  restoreCodexManagedState,
  restoreCodexOfficialConfig,
} = require('./config-utils.cjs')
const { AUTH_MODE, PROTOCOL, TARGET } = require('./schemas.cjs')

const MANAGED_PROVIDER_ID = 'agentgate'
const GATEWAY_PROVIDER_ID = 'agentgate_gateway'
const GATEWAY_PROVIDER_NAME = 'Agent;Gate Local Gateway'
const LEGACY_GATEWAY_PROVIDER_ID = 'keydeck_gateway'
const LEGACY_GATEWAY_PROVIDER_NAME = 'Keydeck Local Gateway'
const CONFIG_LIBRARY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
/** 0.8.0 及更早版本写入的 provider id，扫描时仍需识别。 */
const LEGACY_PROVIDER_IDS = Object.freeze(['keydeck', LEGACY_GATEWAY_PROVIDER_ID])
const GATEWAY_OWNERSHIP = Object.freeze({
  OWNED: 'owned',
  RELEASED: 'released',
  CONFLICT: 'conflict',
})
const OPEN_CODE_PACKAGE = Object.freeze({
  [PROTOCOL.ANTHROPIC]: '@ai-sdk/anthropic',
  [PROTOCOL.GEMINI]: '@ai-sdk/google',
  [PROTOCOL.OPENAI_RESPONSES]: '@ai-sdk/openai',
  [PROTOCOL.OPENAI_CHAT]: '@ai-sdk/openai-compatible',
})
const CLAUDE_ENV = Object.freeze({
  BASE_URL: 'ANTHROPIC_BASE_URL',
  API_KEY: 'ANTHROPIC_API_KEY',
  AUTH_TOKEN: 'ANTHROPIC_AUTH_TOKEN',
  MODEL: 'ANTHROPIC_MODEL',
  TOOL_SEARCH: 'ENABLE_TOOL_SEARCH',
})
const CLAUDE_VSCODE = Object.freeze({
  ENVIRONMENT_VARIABLES: 'claudeCode.environmentVariables',
  DISABLE_LOGIN_PROMPT: 'claudeCode.disableLoginPrompt',
})
const CLAUDE_VSCODE_STATE_KEYS = Object.freeze({
  [CLAUDE_ENV.BASE_URL]: 'vscodeBaseUrl',
  [CLAUDE_ENV.API_KEY]: 'vscodeApiKey',
  [CLAUDE_ENV.AUTH_TOKEN]: 'vscodeAuthToken',
  [CLAUDE_ENV.MODEL]: 'vscodeModel',
  [CLAUDE_ENV.TOOL_SEARCH]: 'vscodeToolSearch',
})
const CLAUDE_DESKTOP = Object.freeze({
  PROVIDER: 'inferenceProvider',
  BASE_URL: 'inferenceGatewayBaseUrl',
  CREDENTIAL_KIND: 'inferenceCredentialKind',
  API_KEY: 'inferenceGatewayApiKey',
  AUTH_SCHEME: 'inferenceGatewayAuthScheme',
  OIDC: 'inferenceGatewayOidc',
  MODEL_DISCOVERY: 'modelDiscoveryEnabled',
  MODELS: 'inferenceModels',
  DISABLE_MODE_CHOOSER: 'disableDeploymentModeChooser',
})
const CLAUDE_DESKTOP_STATE_KEYS = Object.freeze({
  [CLAUDE_DESKTOP.PROVIDER]: 'desktopProvider',
  [CLAUDE_DESKTOP.BASE_URL]: 'desktopBaseUrl',
  [CLAUDE_DESKTOP.CREDENTIAL_KIND]: 'desktopCredentialKind',
  [CLAUDE_DESKTOP.API_KEY]: 'desktopApiKey',
  [CLAUDE_DESKTOP.AUTH_SCHEME]: 'desktopAuthScheme',
  [CLAUDE_DESKTOP.OIDC]: 'desktopOidc',
  [CLAUDE_DESKTOP.MODEL_DISCOVERY]: 'desktopModelDiscovery',
  [CLAUDE_DESKTOP.MODELS]: 'desktopModels',
  [CLAUDE_DESKTOP.DISABLE_MODE_CHOOSER]: 'desktopDisableModeChooser',
})
const GEMINI_ENV = Object.freeze({
  API_KEY: 'GEMINI_API_KEY',
  BASE_URL: 'GOOGLE_GEMINI_BASE_URL',
  MODEL: 'GEMINI_MODEL',
})

async function draft(target, filePath, transform) {
  const snapshot = await readTextSnapshot(filePath)
  const content = transform(snapshot.content)
  return {
    target,
    path: filePath,
    before: snapshot,
    content,
    afterHash: hashText(content),
  }
}

async function restoreDraft(target, filePath, transform, suppliedSources) {
  if (!suppliedSources || !suppliedSources.has(filePath)) {
    return draft(target, filePath, transform)
  }
  const supplied = suppliedSources.get(filePath)
  const content = typeof supplied === 'string' ? supplied : supplied.content
  const before = typeof supplied === 'string'
    ? { path: filePath, existed: true, content, hash: hashText(content) }
    : supplied
  const restored = transform(content)
  return {
    target,
    path: filePath,
    before,
    content: restored,
    afterHash: hashText(restored),
  }
}

function assertProtocol(profile, supported, clientName) {
  if (!supported.includes(profile.protocol)) {
    throw new Error(`${clientName} does not support the ${profile.protocol} profile protocol`)
  }
}

function openCodePackage(protocol) {
  return OPEN_CODE_PACKAGE[protocol]
}

function parseEnv(source) {
  const values = {}
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value)
      } catch {
        continue
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1)
    }
    values[match[1]] = value
  }
  return values
}

async function adapterSources(filePaths, supplied) {
  if (supplied) return supplied
  const snapshots = await Promise.all(filePaths.map((filePath) => readTextSnapshot(filePath)))
  return new Map(snapshots.map((snapshot) => [snapshot.path, snapshot.content]))
}

function sourceText(sources, filePath, fallback) {
  const value = sources.get(filePath)
  const content = typeof value === 'string' ? value : value?.content
  return typeof content === 'string' && content.trim() ? content : fallback
}

function ownership(managed, matches) {
  return managed
    ? (matches ? GATEWAY_OWNERSHIP.OWNED : GATEWAY_OWNERSHIP.CONFLICT)
    : GATEWAY_OWNERSHIP.RELEASED
}

function fieldState(container, key) {
  const present = container !== null
    && typeof container === 'object'
    && Object.prototype.hasOwnProperty.call(container, key)
  return {
    present,
    value: present ? container[key] : null,
  }
}

function restoredValue(state) {
  return state.present ? state.value : undefined
}

function claudeEnvironment(profile, apiKey, modelState) {
  const environment = {
    [CLAUDE_ENV.BASE_URL]: profile.baseUrl,
    [CLAUDE_ENV.API_KEY]: profile.authMode === AUTH_MODE.API_KEY ? apiKey : undefined,
    [CLAUDE_ENV.AUTH_TOKEN]: profile.authMode === AUTH_MODE.BEARER ? apiKey : undefined,
    [CLAUDE_ENV.TOOL_SEARCH]: profile.enableToolSearch ? 'true' : undefined,
  }
  if (profile.model) environment[CLAUDE_ENV.MODEL] = profile.model
  else if (modelState) environment[CLAUDE_ENV.MODEL] = restoredValue(modelState)
  return environment
}

function claudeVsCodeEnvironment(profile, apiKey, modelState) {
  const environment = claudeEnvironment(profile, apiKey, modelState)
  return {
    ...environment,
    [CLAUDE_ENV.API_KEY]: environment[CLAUDE_ENV.API_KEY] ?? '',
    [CLAUDE_ENV.AUTH_TOKEN]: environment[CLAUDE_ENV.AUTH_TOKEN] ?? '',
    [CLAUDE_ENV.TOOL_SEARCH]: environment[CLAUDE_ENV.TOOL_SEARCH] ?? '',
  }
}

function claudeDesktopConfiguration(profile, apiKey, baseline) {
  const configuration = {
    [CLAUDE_DESKTOP.PROVIDER]: 'gateway',
    [CLAUDE_DESKTOP.BASE_URL]: profile.baseUrl,
    [CLAUDE_DESKTOP.CREDENTIAL_KIND]: 'static',
    [CLAUDE_DESKTOP.API_KEY]: apiKey,
    [CLAUDE_DESKTOP.AUTH_SCHEME]: profile.authMode === AUTH_MODE.API_KEY
      ? 'x-api-key'
      : 'bearer',
    [CLAUDE_DESKTOP.OIDC]: undefined,
    [CLAUDE_DESKTOP.DISABLE_MODE_CHOOSER]: true,
  }
  if (profile.model) {
    configuration[CLAUDE_DESKTOP.MODEL_DISCOVERY] = true
    configuration[CLAUDE_DESKTOP.MODELS] = [profile.model]
  } else if (hasClaudeDesktopBaseline(baseline)) {
    configuration[CLAUDE_DESKTOP.MODEL_DISCOVERY] = restoredValue(
      baseline.desktopModelDiscovery,
    )
    configuration[CLAUDE_DESKTOP.MODELS] = restoredValue(baseline.desktopModels)
  }
  return configuration
}

function namedEnvironmentEntries(value) {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([name, entryValue]) => ({ name, value: entryValue }))
  }
  return []
}

function namedEnvironmentState(value, name) {
  let result = { present: false, value: null }
  for (const entry of namedEnvironmentEntries(value)) {
    if (entry && typeof entry === 'object' && entry.name === name) {
      result = { present: true, value: entry.value ?? null }
    }
  }
  return result
}

function mergeNamedEnvironment(value, replacements) {
  const managed = new Set(Object.keys(replacements))
  const result = namedEnvironmentEntries(value).filter((entry) => (
    !entry || typeof entry !== 'object' || !managed.has(entry.name)
  ))
  for (const [name, entryValue] of Object.entries(replacements)) {
    if (entryValue !== undefined) result.push({ name, value: entryValue })
  }
  return result
}

function namedEnvironmentPatchOperations(setting, value, replacements) {
  if (!Array.isArray(value)) {
    return [{ path: [setting], value: mergeNamedEnvironment(value, replacements) }]
  }
  const updates = []
  const removals = []
  let nextIndex = value.length
  for (const [name, entryValue] of Object.entries(replacements)) {
    const indexes = []
    value.forEach((entry, index) => {
      if (entry && typeof entry === 'object' && entry.name === name) indexes.push(index)
    })
    if (entryValue === undefined) {
      for (const index of indexes.reverse()) removals.push({ path: [setting, index] })
    } else if (indexes.length > 0) {
      for (const index of indexes) {
        updates.push({ path: [setting, index, 'value'], value: entryValue })
      }
    } else {
      updates.push({ path: [setting, nextIndex], value: { name, value: entryValue } })
      nextIndex += 1
    }
  }
  removals.sort((left, right) => right.path[1] - left.path[1])
  return [...updates, ...removals]
}

function captureClaudeVsCodeState(data) {
  const value = data?.[CLAUDE_VSCODE.ENVIRONMENT_VARIABLES]
  const state = {
    vscodeEnvironmentVariables: {
      present: Object.prototype.hasOwnProperty.call(
        data || {},
        CLAUDE_VSCODE.ENVIRONMENT_VARIABLES,
      ),
      value: null,
    },
    vscodeDisableLoginPrompt: fieldState(data, CLAUDE_VSCODE.DISABLE_LOGIN_PROMPT),
  }
  for (const [name, stateKey] of Object.entries(CLAUDE_VSCODE_STATE_KEYS)) {
    state[stateKey] = namedEnvironmentState(value, name)
  }
  return state
}

function hasClaudeVsCodeBaseline(state) {
  return state && Object.prototype.hasOwnProperty.call(state, 'vscodeEnvironmentVariables')
}

function claudeDesktopProfileFromId(claudePaths, profileId) {
  if (!claudePaths.desktopLibrary || !CONFIG_LIBRARY_ID.test(profileId || '')) return undefined
  return {
    id: profileId,
    path: path.join(claudePaths.desktopLibrary, `${profileId}.json`),
    metaPath: path.join(claudePaths.desktopLibrary, '_meta.json'),
  }
}

function activeClaudeDesktopProfile(claudePaths, sources, strict = true) {
  if (!claudePaths.desktopLibrary) {
    return claudePaths.desktopConfig
      ? { id: null, path: claudePaths.desktopConfig, metaPath: null }
      : undefined
  }
  const metaPath = path.join(claudePaths.desktopLibrary, '_meta.json')
  try {
    const source = sources?.has(metaPath)
      ? sourceText(sources, metaPath, '{}')
      : fs.readFileSync(metaPath, 'utf8')
    const meta = parseJsoncValue(source, 'Claude Desktop config library')
    const profile = claudeDesktopProfileFromId(claudePaths, meta?.appliedId)
    if (!profile) throw new Error('Claude Desktop config library has an invalid appliedId')
    return profile
  } catch (error) {
    if (strict) throw error
    return { id: null, path: null, metaPath }
  }
}

function managedClaudeDesktopProfile(claudePaths, baseline, sources) {
  if (hasClaudeDesktopBaseline(baseline)
    && typeof baseline.desktopProfileId === 'string') {
    return claudeDesktopProfileFromId(claudePaths, baseline.desktopProfileId)
  }
  return activeClaudeDesktopProfile(claudePaths, sources, false)
}

async function claudeDesktopData(profile, sources) {
  if (!profile?.path) return undefined
  let source
  if (sources) {
    if (!sources.has(profile.path)) {
      throw new Error('Claude Desktop profile is missing from the configuration snapshot')
    }
    source = sourceText(sources, profile.path, '{}')
  } else {
    source = (await readTextSnapshot(profile.path)).content || '{}'
  }
  return parseJsoncValue(source, 'Claude Desktop profile')
}

function captureClaudeDesktopState(data, profileId) {
  const state = {
    desktopConfig: { present: true, value: null },
    desktopProfileId: profileId,
  }
  for (const [name, stateKey] of Object.entries(CLAUDE_DESKTOP_STATE_KEYS)) {
    state[stateKey] = fieldState(data, name)
  }
  return state
}

function claudeDesktopInspection(data) {
  const models = data?.[CLAUDE_DESKTOP.MODELS]
  let model
  if (Array.isArray(models)) {
    for (const value of models) {
      const normalized = normalizedDesktopModel(value)
      if (typeof normalized?.name === 'string' && normalized.name.trim()) {
        model = normalized.name.trim()
        break
      }
    }
  }
  return {
    baseUrl: data?.[CLAUDE_DESKTOP.BASE_URL],
    model,
  }
}

function hasClaudeDesktopBaseline(state) {
  return state && Object.prototype.hasOwnProperty.call(state, 'desktopConfig')
}

function normalizedDesktopModel(value) {
  if (typeof value === 'string') {
    const extended = /^(.*?)\[1m\]$/i.exec(value.trim())
    return { name: extended ? extended[1].trim() : value, supports1m: Boolean(extended) }
  }
  if (!value || typeof value !== 'object' || typeof value.name !== 'string') return value
  return { name: value.name, supports1m: Boolean(value.supports1m) }
}

function claudeDesktopValueMatches(name, current, expected) {
  if (name === CLAUDE_DESKTOP.MODELS && Array.isArray(current) && Array.isArray(expected)) {
    return JSON.stringify(current.map(normalizedDesktopModel))
      === JSON.stringify(expected.map(normalizedDesktopModel))
  }
  return current === expected || JSON.stringify(current) === JSON.stringify(expected)
}

function sameClaudeDesktopProfile(left, right) {
  if (!left?.path || !right?.path) return false
  return path.resolve(left.path).toLowerCase() === path.resolve(right.path).toLowerCase()
}

function claudeDesktopMatches(data, profile, apiKey, baseline, options = {}) {
  return Object.entries(claudeDesktopConfiguration(profile, apiKey, baseline))
    .every(([name, expected]) => (
      expected === undefined
        ? !Object.prototype.hasOwnProperty.call(data || {}, name)
        : Object.prototype.hasOwnProperty.call(data || {}, name)
          && (claudeDesktopValueMatches(name, data[name], expected)
            || (options.allowLegacyModelDiscovery
              && name === CLAUDE_DESKTOP.MODEL_DISCOVERY
              && data[name] === false
              && expected === true))
    ))
}

function claudeVsCodeMatches(data, profile, apiKey, modelState) {
  const value = data?.[CLAUDE_VSCODE.ENVIRONMENT_VARIABLES]
  const matchesEnvironment = Object.entries(claudeVsCodeEnvironment(profile, apiKey, modelState))
    .every(([name, expected]) => {
      const current = namedEnvironmentState(value, name)
      return expected === undefined
        ? !current.present
        : current.present && current.value === expected
    })
  return matchesEnvironment && data?.[CLAUDE_VSCODE.DISABLE_LOGIN_PROMPT] === true
}

/**
 * 为已解析的配置路径创建客户端适配器。
 *
 * 每个适配器只生成待写入草稿，不直接修改磁盘；事务服务会统一执行并发检查、
 * 原子替换和失败回滚。`inspect` 永远不返回 Key。
 *
 * @param {object} paths `resolveClientPaths` 返回的路径集合。
 * @returns {object} 以客户端 ID 为键的适配器注册表。
 */
function createAdapters(paths) {
  const adapters = {
    [TARGET.CLAUDE]: {
      id: TARGET.CLAUDE,
      name: 'Claude Code',
      command: 'claude',
      primaryPath: paths.claude.config,
      get paths() {
        const desktopProfile = activeClaudeDesktopProfile(paths.claude, undefined, false)
        return [...new Set([
          paths.claude.config,
          paths.claude.vscodeConfig,
          desktopProfile?.metaPath,
          desktopProfile?.path,
        ].filter(Boolean))]
      },
      pathsForBaseline(baseline) {
        const filePaths = this.paths
        if (!hasClaudeDesktopBaseline(baseline)
          || typeof baseline.desktopProfileId !== 'string') return filePaths
        const desktopProfile = claudeDesktopProfileFromId(
          paths.claude,
          baseline.desktopProfileId,
        )
        return [...new Set([...filePaths, desktopProfile?.path].filter(Boolean))]
      },
      async build(profile, apiKey, options = {}) {
        assertProtocol(profile, [PROTOCOL.ANTHROPIC], 'Claude Code')
        const environment = claudeEnvironment(profile, apiKey, options.baseline?.model)
        const operations = [
          { path: ['env', CLAUDE_ENV.BASE_URL], value: environment[CLAUDE_ENV.BASE_URL] },
          { path: ['env', CLAUDE_ENV.API_KEY], value: environment[CLAUDE_ENV.API_KEY] },
          { path: ['env', CLAUDE_ENV.AUTH_TOKEN], value: environment[CLAUDE_ENV.AUTH_TOKEN] },
          { path: ['env', CLAUDE_ENV.TOOL_SEARCH], value: environment[CLAUDE_ENV.TOOL_SEARCH] },
        ]
        if (profile.model || options.baseline?.model) {
          operations.push({ path: ['env', CLAUDE_ENV.MODEL], value: environment[CLAUDE_ENV.MODEL] })
        }
        const drafts = [await restoreDraft(TARGET.CLAUDE, paths.claude.config, (source) => (
          patchJsonc(source, operations, 'Claude settings.json')
        ), options.sources)]
        const manageVsCode = paths.claude.vscodeConfig
          && (!options.baseline || hasClaudeVsCodeBaseline(options.baseline))
        if (manageVsCode) {
          drafts.push(await restoreDraft(TARGET.CLAUDE, paths.claude.vscodeConfig, (source) => {
            const data = parseJsoncValue(source.trim() ? source : '{}', 'VS Code user settings')
            const vscodeEnvironment = claudeVsCodeEnvironment(
              profile,
              apiKey,
              options.baseline?.vscodeModel,
            )
            return patchJsonc(source, [
              ...namedEnvironmentPatchOperations(
                CLAUDE_VSCODE.ENVIRONMENT_VARIABLES,
                data?.[CLAUDE_VSCODE.ENVIRONMENT_VARIABLES],
                vscodeEnvironment,
              ),
              { path: [CLAUDE_VSCODE.DISABLE_LOGIN_PROMPT], value: true },
            ], 'VS Code user settings')
          }, options.sources))
        }
        const manageDesktop = !options.baseline || hasClaudeDesktopBaseline(options.baseline)
        if (manageDesktop) {
          const desktopProfile = managedClaudeDesktopProfile(
            paths.claude,
            options.baseline,
          )
          if (desktopProfile?.path) {
            drafts.push(await restoreDraft(TARGET.CLAUDE, desktopProfile.path, (source) => (
              patchJsonc(source, Object.entries(claudeDesktopConfiguration(
                profile,
                apiKey,
                options.baseline,
              ))
                .map(([name, value]) => ({ path: [name], value })), 'Claude Desktop profile')
            ), options.sources))
          }
        }
        return drafts
      },
      validate(source, filePath) {
        const desktopMetaPath = paths.claude.desktopLibrary
          ? path.join(paths.claude.desktopLibrary, '_meta.json')
          : undefined
        if (desktopMetaPath && filePath === desktopMetaPath) return
        if (source.trim()) assertValidJsonc(source, 'Claude settings.json')
      },
      inspect(sources) {
        const data = parseJsoncValue(
          sourceText(sources, paths.claude.config, '{}'),
          'Claude settings.json',
        )
        const native = {
          baseUrl: data?.env?.[CLAUDE_ENV.BASE_URL],
          model: data?.env?.[CLAUDE_ENV.MODEL],
        }
        if (native.baseUrl !== undefined) return native
        const desktopProfile = activeClaudeDesktopProfile(paths.claude, sources, false)
        if (!desktopProfile?.path || !sources.has(desktopProfile.path)) return native
        const desktop = parseJsoncValue(
          sourceText(sources, desktopProfile.path, '{}'),
          'Claude Desktop profile',
        )
        const inspection = claudeDesktopInspection(desktop)
        return {
          ...inspection,
          model: inspection.model ?? native.model,
        }
      },
      async captureManagedState(suppliedSources) {
        const sources = await adapterSources(this.paths, suppliedSources)
        const data = parseJsoncValue(
          sourceText(sources, paths.claude.config, '{}'),
          'Claude settings.json',
        )
        const env = data?.env
        const state = {
          baseUrl: fieldState(env, CLAUDE_ENV.BASE_URL),
          apiKey: fieldState(env, CLAUDE_ENV.API_KEY),
          authToken: fieldState(env, CLAUDE_ENV.AUTH_TOKEN),
          model: fieldState(env, CLAUDE_ENV.MODEL),
          toolSearch: fieldState(env, CLAUDE_ENV.TOOL_SEARCH),
        }
        if (paths.claude.vscodeConfig) {
          const vscode = parseJsoncValue(
            sourceText(sources, paths.claude.vscodeConfig, '{}'),
            'VS Code user settings',
          )
          Object.assign(state, captureClaudeVsCodeState(vscode))
        }
        const desktopProfile = activeClaudeDesktopProfile(paths.claude, sources, false)
        if (desktopProfile?.path) {
          const desktop = await claudeDesktopData(desktopProfile, sources)
          Object.assign(state, captureClaudeDesktopState(desktop, desktopProfile.id))
        }
        return state
      },
      async buildRestore(state, suppliedSources) {
        const drafts = [await restoreDraft(TARGET.CLAUDE, paths.claude.config, (source) => (
          patchJsonc(source, [
            { path: ['env', CLAUDE_ENV.BASE_URL], value: restoredValue(state.baseUrl) },
            { path: ['env', CLAUDE_ENV.API_KEY], value: restoredValue(state.apiKey) },
            { path: ['env', CLAUDE_ENV.AUTH_TOKEN], value: restoredValue(state.authToken) },
            { path: ['env', CLAUDE_ENV.MODEL], value: restoredValue(state.model) },
            { path: ['env', CLAUDE_ENV.TOOL_SEARCH], value: restoredValue(state.toolSearch) },
          ], 'Claude settings.json')
        ), suppliedSources)]
        if (paths.claude.vscodeConfig && hasClaudeVsCodeBaseline(state)) {
          drafts.push(await restoreDraft(
            TARGET.CLAUDE,
            paths.claude.vscodeConfig,
            (source) => {
              const data = parseJsoncValue(source.trim() ? source : '{}', 'VS Code user settings')
              const replacements = {}
              for (const [name, stateKey] of Object.entries(CLAUDE_VSCODE_STATE_KEYS)) {
                if (state[stateKey] !== undefined) {
                  replacements[name] = restoredValue(state[stateKey])
                }
              }
              const environment = mergeNamedEnvironment(
                data?.[CLAUDE_VSCODE.ENVIRONMENT_VARIABLES],
                replacements,
              )
              const restoreEnvironment = environment.length > 0
                || state.vscodeEnvironmentVariables.present
                ? namedEnvironmentPatchOperations(
                    CLAUDE_VSCODE.ENVIRONMENT_VARIABLES,
                    data?.[CLAUDE_VSCODE.ENVIRONMENT_VARIABLES],
                    replacements,
                  )
                : [{ path: [CLAUDE_VSCODE.ENVIRONMENT_VARIABLES], value: undefined }]
              return patchJsonc(source, [
                ...restoreEnvironment,
                {
                  path: [CLAUDE_VSCODE.DISABLE_LOGIN_PROMPT],
                  value: restoredValue(state.vscodeDisableLoginPrompt),
                },
              ], 'VS Code user settings')
            },
            suppliedSources,
          ))
        }
        if (hasClaudeDesktopBaseline(state)) {
          const desktopProfile = managedClaudeDesktopProfile(paths.claude, state, suppliedSources)
          if (desktopProfile?.path) {
            drafts.push(await restoreDraft(
              TARGET.CLAUDE,
              desktopProfile.path,
              (source) => patchJsonc(source, Object.entries(CLAUDE_DESKTOP_STATE_KEYS)
                .map(([name, stateKey]) => ({
                  path: [name],
                  value: restoredValue(state[stateKey]),
                })), 'Claude Desktop profile'),
              suppliedSources,
            ))
          }
        }
        return drafts
      },
      async gatewayOwnership(profile, apiKey, suppliedSources, options = {}) {
        const sourcePaths = options.baseline
          ? this.pathsForBaseline(options.baseline)
          : this.paths
        const sources = await adapterSources(sourcePaths, suppliedSources)
        const data = parseJsoncValue(
          sourceText(sources, paths.claude.config, '{}'),
          'Claude settings.json',
        )
        const env = data?.env || {}
        const nativeSelected = env[CLAUDE_ENV.BASE_URL] === profile.baseUrl
        let selected = nativeSelected
        const nativeMatches = Object.entries(claudeEnvironment(
          profile,
          apiKey,
          options.baseline?.model,
        )).every(([name, expected]) => env[name] === expected)
        let vscodeMatches = true
        if (paths.claude.vscodeConfig
          && (!options.baseline || hasClaudeVsCodeBaseline(options.baseline))) {
          const vscode = parseJsoncValue(
            sourceText(sources, paths.claude.vscodeConfig, '{}'),
            'VS Code user settings',
          )
          selected = selected || namedEnvironmentState(
            vscode?.[CLAUDE_VSCODE.ENVIRONMENT_VARIABLES],
            CLAUDE_ENV.BASE_URL,
          ).value === profile.baseUrl
          vscodeMatches = claudeVsCodeMatches(
            vscode,
            profile,
            apiKey,
            options.baseline?.vscodeModel,
          )
        }
        let desktopMatches = true
        const manageDesktop = !options.baseline || hasClaudeDesktopBaseline(options.baseline)
        if (manageDesktop) {
          const desktopProfile = managedClaudeDesktopProfile(
            paths.claude,
            options.baseline,
            sources,
          )
          const desktop = await claudeDesktopData(desktopProfile, sources)
          selected = selected || desktop?.[CLAUDE_DESKTOP.BASE_URL] === profile.baseUrl
          desktopMatches = !desktopProfile?.path
            || claudeDesktopMatches(desktop, profile, apiKey, options.baseline, options)

          const activeProfile = activeClaudeDesktopProfile(paths.claude, sources, false)
          if (activeProfile?.path && !sameClaudeDesktopProfile(activeProfile, desktopProfile)) {
            const activeDesktop = await claudeDesktopData(activeProfile, sources)
            if (activeDesktop?.[CLAUDE_DESKTOP.BASE_URL] === profile.baseUrl) {
              return GATEWAY_OWNERSHIP.CONFLICT
            }
          }
        }
        return ownership(selected,
          nativeMatches
          && vscodeMatches
          && desktopMatches)
      },
    },

    [TARGET.CODEX]: {
      id: TARGET.CODEX,
      name: 'Codex',
      command: 'codex',
      primaryPath: paths.codex.config,
      paths: [paths.codex.config],
      async build(profile, apiKey, options = {}) {
        assertProtocol(
          profile,
          [PROTOCOL.OPENAI_CHAT, PROTOCOL.OPENAI_RESPONSES],
          'Codex',
        )
        if (options.gateway) {
          return [await draft(TARGET.CODEX, paths.codex.config, (source) => {
            /*
             * 首次使用 Codex 的人配置里没有任何 provider——「只改现有 provider 的
             * base_url」在这儿无的放矢。整段建一个指向网关的 provider；基线是
             * fresh，断开时按基线整段拆掉（见 buildRestore）。基线尚未捕获时也
             * 按当前配置判定：没有活跃 provider 就走建段。
             */
            if (options.baseline?.fresh
              || (!options.baseline && !codexHasActiveProvider(source))) {
              return patchCodexToml(source, profile, apiKey, {
                providerId: options.providerId || GATEWAY_PROVIDER_ID,
                providerName: options.providerName || GATEWAY_PROVIDER_NAME,
              })
            }
            const current = codexProviderState(source)
            if (options.baseline?.providerId
              && current.providerId !== options.baseline.providerId) {
              throw new Error(
                'Codex active model_provider changed while the gateway owns its previous base_url',
              )
            }
            return patchCodexGatewayBaseUrl(source, profile.baseUrl)
          })]
        }
        return [await draft(TARGET.CODEX, paths.codex.config, (source) => (
          patchCodexToml(source, profile, apiKey, {
            providerId: MANAGED_PROVIDER_ID,
          })
        ))]
      },
      validate(source) {
        assertValidToml(source, 'Codex config.toml')
      },
      inspect(sources) {
        const data = parseTomlValue(sources.get(paths.codex.config) || '', 'Codex config.toml')
        const providerId = data.model_provider
        const provider = providerId ? data.model_providers?.[providerId] : undefined
        return {
          baseUrl: provider?.base_url,
          model: data.model,
        }
      },
      async captureManagedState(suppliedSources) {
        const sources = await adapterSources(this.paths, suppliedSources)
        const source = sourceText(sources, paths.codex.config, '')
        // 首次使用：没有活跃 provider，记一份 fresh 基线，断开时整段拆掉
        if (!codexHasActiveProvider(source)) return captureCodexFreshState(source)
        return codexProviderState(source)
      },
      async buildRestore(state, suppliedSources) {
        return [await restoreDraft(TARGET.CODEX, paths.codex.config, (source) => (
          state?.fresh
            ? restoreCodexManagedState(source, state, GATEWAY_PROVIDER_ID)
            : restoreCodexGatewayBaseUrl(source, state)
        ), suppliedSources)]
      },
      async buildOfficialRestore(state, suppliedSources) {
        return [await restoreDraft(TARGET.CODEX, paths.codex.config, (source) => {
          const direct = !state || state.fresh
            ? source
            : restoreCodexGatewayBaseUrl(source, state)
          return restoreCodexOfficialConfig(direct)
        }, suppliedSources)]
      },
      async verifyManagedState(state, suppliedSources) {
        const sources = await adapterSources(this.paths, suppliedSources)
        const source = sourceText(sources, paths.codex.config, '')
        if (state?.fresh) {
          // 拆干净的标准：我们加的三样都不在了，原有的顶层 model 按原样回位
          const data = parseTomlValue(source, 'Codex config.toml')
          const modelRestored = state.model.present
            ? data.model === state.model.value
            : data.model === undefined
          return data.model_provider === undefined
            && data.model_providers?.[GATEWAY_PROVIDER_ID] === undefined
            && modelRestored
        }
        const current = codexProviderState(source, state.providerId)
        return current.providerId === state.providerId
          && JSON.stringify(current.baseUrl) === JSON.stringify(state.baseUrl)
      },
      async gatewayOwnership(profile, _apiKey, suppliedSources, options = {}) {
        const sources = await adapterSources(this.paths, suppliedSources)
        const data = parseTomlValue(sourceText(sources, paths.codex.config, ''), 'Codex config.toml')
        const baselineProviderId = options?.baseline?.providerId
        const providerId = baselineProviderId || data.model_provider
        const provider = providerId ? data.model_providers?.[providerId] : undefined
        const currentBaseUrl = provider?.base_url
        const selected = typeof currentBaseUrl === 'string' && currentBaseUrl === profile.baseUrl
        if (selected) return GATEWAY_OWNERSHIP.OWNED
        if (typeof currentBaseUrl === 'string') {
          try {
            const url = new URL(currentBaseUrl)
            const segments = url.pathname.split('/').filter(Boolean)
            if (url.protocol === 'http:'
              && url.hostname === '127.0.0.1'
              && segments[0] === 'codex'
              && segments.length >= 2) {
              return options?.allowExternalGatewayHandoff
                ? GATEWAY_OWNERSHIP.RELEASED
                : GATEWAY_OWNERSHIP.CONFLICT
            }
          } catch {
            // A non-URL value is treated as a user release below.
          }
        }
        return GATEWAY_OWNERSHIP.RELEASED
      },
    },

    [TARGET.OPENCODE]: {
      id: TARGET.OPENCODE,
      name: 'OpenCode',
      command: 'opencode',
      primaryPath: paths.opencode.config,
      paths: [paths.opencode.config, paths.opencode.auth],
      async build(profile, apiKey, options = {}) {
        if (!profile.model) throw new Error('OpenCode profiles require a model ID')
        const providerId = options.gateway ? GATEWAY_PROVIDER_ID : MANAGED_PROVIDER_ID
        const provider = {
          npm: openCodePackage(profile.protocol),
          name: options.gateway ? GATEWAY_PROVIDER_NAME : `Agent;Gate - ${profile.name}`,
          options: { baseURL: profile.baseUrl },
          models: {
            [profile.model]: { name: profile.model },
          },
        }
        return Promise.all([
          draft(TARGET.OPENCODE, paths.opencode.config, (source) => patchJsonc(source, [
            { path: ['provider', providerId], value: provider },
            { path: ['model'], value: `${providerId}/${profile.model}` },
          ], 'OpenCode configuration')),
          draft(TARGET.OPENCODE, paths.opencode.auth, (source) => patchJsonc(source, [
            {
              path: [providerId],
              value: { type: 'api', key: apiKey },
            },
          ], 'OpenCode auth.json')),
        ])
      },
      validate(source, filePath) {
        if (source.trim()) assertValidJsonc(source, `OpenCode ${filePath}`)
      },
      inspect(sources) {
        const data = parseJsoncValue(
          sources.get(paths.opencode.config) || '{}',
          'OpenCode configuration',
        )
        // 兼容旧 provider id：升级前写入的配置仍需被正确识别为 Agent;Gate 接管。
        const selectedProviderId = [
          MANAGED_PROVIDER_ID,
          GATEWAY_PROVIDER_ID,
          ...LEGACY_PROVIDER_IDS,
        ].find(
          (providerId) => typeof data?.model === 'string' && data.model.startsWith(`${providerId}/`),
        )
        const modelPrefix = selectedProviderId ? `${selectedProviderId}/` : undefined
        const selectedModel = modelPrefix ? data.model.slice(modelPrefix.length) : undefined
        return {
          baseUrl: selectedProviderId
            ? data?.provider?.[selectedProviderId]?.options?.baseURL
            : undefined,
          model: selectedModel,
        }
      },
      async captureManagedState(suppliedSources) {
        const sources = await adapterSources(this.paths, suppliedSources)
        const data = parseJsoncValue(
          sourceText(sources, paths.opencode.config, '{}'),
          'OpenCode configuration',
        )
        const auth = parseJsoncValue(
          sourceText(sources, paths.opencode.auth, '{}'),
          'OpenCode auth.json',
        )
        const activeGatewayProviderId = [GATEWAY_PROVIDER_ID, LEGACY_GATEWAY_PROVIDER_ID]
          .find((providerId) => typeof data?.model === 'string'
            && data.model.startsWith(`${providerId}/`)) || GATEWAY_PROVIDER_ID
        return {
          providerId: activeGatewayProviderId,
          model: fieldState(data, 'model'),
          provider: fieldState(data?.provider, activeGatewayProviderId),
          auth: fieldState(auth, activeGatewayProviderId),
        }
      },
      async buildRestore(state, suppliedSources) {
        const sources = await adapterSources(this.paths, suppliedSources)
        const data = parseJsoncValue(
          sourceText(sources, paths.opencode.config, '{}'),
          'OpenCode configuration',
        )
        const baselineProviderId = [GATEWAY_PROVIDER_ID, LEGACY_GATEWAY_PROVIDER_ID]
          .find((providerId) => state?.providerId === providerId)
        const activeGatewayProviderId = baselineProviderId || [
          GATEWAY_PROVIDER_ID,
          LEGACY_GATEWAY_PROVIDER_ID,
        ].find((providerId) => typeof data?.model === 'string'
          && data.model.startsWith(`${providerId}/`)) || GATEWAY_PROVIDER_ID
        const gatewayProviderIds = [GATEWAY_PROVIDER_ID, LEGACY_GATEWAY_PROVIDER_ID]
        return Promise.all([
          restoreDraft(TARGET.OPENCODE, paths.opencode.config, (source) => patchJsonc(source, [
            { path: ['model'], value: restoredValue(state.model) },
            ...gatewayProviderIds.map((providerId) => ({
              path: ['provider', providerId],
              value: providerId === activeGatewayProviderId
                ? restoredValue(state.provider)
                : undefined,
            })),
          ], 'OpenCode configuration'), suppliedSources),
          restoreDraft(TARGET.OPENCODE, paths.opencode.auth, (source) => patchJsonc(source, [
            ...gatewayProviderIds.map((providerId) => ({
              path: [providerId],
              value: providerId === activeGatewayProviderId
                ? restoredValue(state.auth)
                : undefined,
            })),
          ], 'OpenCode auth.json'), suppliedSources),
        ])
      },
      async gatewayOwnership(profile, apiKey, suppliedSources) {
        const sources = await adapterSources(this.paths, suppliedSources)
        const data = parseJsoncValue(
          sourceText(sources, paths.opencode.config, '{}'),
          'OpenCode configuration',
        )
        const auth = parseJsoncValue(
          sourceText(sources, paths.opencode.auth, '{}'),
          'OpenCode auth.json',
        )
        const providerId = [GATEWAY_PROVIDER_ID, LEGACY_GATEWAY_PROVIDER_ID].find((candidate) => (
          typeof data?.model === 'string'
          && data.model.startsWith(`${candidate}/`)
          && data?.provider?.[candidate]?.options?.baseURL === profile.baseUrl
        ))
        const provider = providerId ? data?.provider?.[providerId] : undefined
        const providerName = providerId === LEGACY_GATEWAY_PROVIDER_ID
          ? LEGACY_GATEWAY_PROVIDER_NAME
          : GATEWAY_PROVIDER_NAME
        const selected = Boolean(providerId)
          && provider?.options?.baseURL === profile.baseUrl
        return ownership(selected,
          data.model === `${providerId}/${profile.model}`
          && provider?.npm === openCodePackage(profile.protocol)
          && provider?.name === providerName
          && provider?.models?.[profile.model]?.name === profile.model
          && auth?.[providerId]?.type === 'api'
          && auth?.[providerId]?.key === apiKey)
      },
    },

    [TARGET.GEMINI]: {
      id: TARGET.GEMINI,
      name: 'Gemini CLI',
      command: 'gemini',
      primaryPath: paths.gemini.env,
      paths: [paths.gemini.config, paths.gemini.env],
      async build(profile, apiKey, _options = {}) {
        assertProtocol(profile, [PROTOCOL.GEMINI], 'Gemini CLI')
        const envValues = {
          [GEMINI_ENV.API_KEY]: apiKey,
          [GEMINI_ENV.BASE_URL]: profile.baseUrl,
        }
        if (profile.model) envValues[GEMINI_ENV.MODEL] = profile.model
        return Promise.all([
          draft(TARGET.GEMINI, paths.gemini.env, (source) => patchEnv(source, envValues)),
          draft(TARGET.GEMINI, paths.gemini.config, (source) => patchJsonc(source, [
            { path: ['security', 'auth', 'selectedType'], value: 'gemini-api-key' },
          ], 'Gemini settings.json')),
        ])
      },
      validate(source, filePath) {
        if (filePath.endsWith('.json') && source.trim()) {
          assertValidJsonc(source, 'Gemini settings.json')
        }
      },
      inspect(sources) {
        const values = parseEnv(sources.get(paths.gemini.env) || '')
        return {
          baseUrl: values[GEMINI_ENV.BASE_URL],
          model: values[GEMINI_ENV.MODEL],
        }
      },
      async captureManagedState(suppliedSources) {
        const sources = await adapterSources(this.paths, suppliedSources)
        const values = parseEnv(sourceText(sources, paths.gemini.env, ''))
        const data = parseJsoncValue(
          sourceText(sources, paths.gemini.config, '{}'),
          'Gemini settings.json',
        )
        return {
          apiKey: fieldState(values, GEMINI_ENV.API_KEY),
          baseUrl: fieldState(values, GEMINI_ENV.BASE_URL),
          model: fieldState(values, GEMINI_ENV.MODEL),
          selectedType: fieldState(data?.security?.auth, 'selectedType'),
        }
      },
      async buildRestore(state, suppliedSources) {
        return Promise.all([
          restoreDraft(TARGET.GEMINI, paths.gemini.env, (source) => patchEnv(source, {
            [GEMINI_ENV.API_KEY]: restoredValue(state.apiKey),
            [GEMINI_ENV.BASE_URL]: restoredValue(state.baseUrl),
            [GEMINI_ENV.MODEL]: restoredValue(state.model),
          }), suppliedSources),
          restoreDraft(TARGET.GEMINI, paths.gemini.config, (source) => patchJsonc(source, [
            {
              path: ['security', 'auth', 'selectedType'],
              value: restoredValue(state.selectedType),
            },
          ], 'Gemini settings.json'), suppliedSources),
        ])
      },
      async gatewayOwnership(profile, apiKey, suppliedSources) {
        const sources = await adapterSources(this.paths, suppliedSources)
        const values = parseEnv(sourceText(sources, paths.gemini.env, ''))
        const data = parseJsoncValue(
          sourceText(sources, paths.gemini.config, '{}'),
          'Gemini settings.json',
        )
        const selected = data?.security?.auth?.selectedType === 'gemini-api-key'
          && values[GEMINI_ENV.BASE_URL] === profile.baseUrl
        return ownership(selected,
          values[GEMINI_ENV.API_KEY] === apiKey
          && (!profile.model || values[GEMINI_ENV.MODEL] === profile.model))
      },
    },
  }

  return adapters
}

module.exports = {
  GATEWAY_OWNERSHIP,
  createAdapters,
}
