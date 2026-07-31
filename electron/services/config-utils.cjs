const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const TOML = require('@iarna/toml')
const {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
} = require('jsonc-parser')
const writeFileAtomic = require('write-file-atomic')
const { PROTOCOL } = require('./schemas.cjs')

const MANAGED_CODEX_PROVIDER_ID = 'agentgate'
const MANAGED_CODEX_PROVIDER_IDS = Object.freeze([
  MANAGED_CODEX_PROVIDER_ID,
  'agentgate_gateway',
  'keydeck',
  'keydeck_gateway',
])
const PRIVATE_FILE_MODE = 0o600

/**
 * @param {string} value UTF-8 文本。
 * @returns {string} SHA-256 十六进制摘要。
 */
function hashText(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * 读取文本文件及其哈希；文件不存在时返回可参与事务的空快照。
 *
 * @param {string} filePath 文件路径。
 * @returns {Promise<object>} 包含原文、存在状态和 SHA-256 的快照。
 * @throws 除文件不存在以外的读取错误。
 */
async function readTextSnapshot(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8')
    return { path: filePath, existed: true, content, hash: hashText(content) }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { path: filePath, existed: false, content: '', hash: hashText('') }
    }
    throw error
  }
}

/**
 * 将 UTF-8 文本原子写入目标文件并请求 fsync。
 *
 * @param {string} filePath 目标路径。
 * @param {string} content 待写入文本。
 * @returns {Promise<void>} 写入完成后的 Promise。
 * @throws 目录创建或原子替换失败时抛出错误。
 */
async function atomicWriteText(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await writeFileAtomic(filePath, content, {
    encoding: 'utf8',
    fsync: true,
    mode: PRIVATE_FILE_MODE,
  })
}

/**
 * 将文件恢复到事务前快照；原文件不存在时删除本次新建文件。
 *
 * @param {object} snapshot 由 `readTextSnapshot` 产生的快照。
 * @returns {Promise<void>} 恢复完成后的 Promise。
 */
async function restoreSnapshot(snapshot) {
  if (snapshot.existed) {
    await atomicWriteText(snapshot.path, snapshot.content)
    return
  }
  try {
    await fs.unlink(snapshot.path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

function jsonFormatting(source) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const indentedLine = source.match(/^[ \t]+(?=")/m)?.[0] || '  '
  return {
    insertSpaces: !indentedLine.includes('\t'),
    tabSize: indentedLine.includes('\t') ? 1 : indentedLine.length,
    eol,
  }
}

/**
 * 严格解析允许注释和尾逗号的 JSONC。
 *
 * @param {string} source JSONC 原文。
 * @param {string} label 错误信息中的配置名称。
 * @returns {unknown} 解析结果。
 * @throws 出现任何语法错误时抛出带偏移位置的错误。
 */
function parseJsoncValue(source, label = 'JSON configuration') {
  const errors = []
  const value = parse(source, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0) {
    const first = errors[0]
    throw new Error(
      `${label} is invalid (${printParseErrorCode(first.error)} at offset ${first.offset})`,
    )
  }
  return value
}

/**
 * 校验 JSONC 文本但不返回解析值。
 *
 * @param {string} source JSONC 原文。
 * @param {string} label 配置名称。
 * @returns {void} 校验通过时无返回值。
 * @throws 语法无效时抛出错误。
 */
function assertValidJsonc(source, label = 'JSON configuration') {
  parseJsoncValue(source, label)
}

/**
 * 使用 JSONC AST 编辑指定路径，保留注释、缩进和未知字段。
 *
 * @param {string} source 原始 JSONC。
 * @param {Array<{path: string[], value: unknown}>} operations 定点修改列表；值为 undefined 时删除字段。
 * @param {string} label 配置名称。
 * @returns {string} 重新校验后的 JSONC 文本。
 * @throws 原文或生成结果无法解析时抛出错误。
 */
function patchJsonc(source, operations, label) {
  let result = source.trim() ? source : '{}\n'
  assertValidJsonc(result, label)
  const formattingOptions = jsonFormatting(result)

  for (const operation of operations) {
    if (operation.value === undefined) {
      let current = parseJsoncValue(result, label)
      const exists = operation.path.every((segment) => {
        if (!current || typeof current !== 'object'
          || !Object.prototype.hasOwnProperty.call(current, segment)) return false
        current = current[segment]
        return true
      })
      if (!exists) continue
    }
    const edits = modify(result, operation.path, operation.value, { formattingOptions })
    result = applyEdits(result, edits)
  }

  assertValidJsonc(result, label)
  if (!result.endsWith('\n')) result += formattingOptions.eol
  return result
}

/**
 * 解析 TOML；空文本按空对象处理。
 *
 * @param {string} source TOML 原文。
 * @param {string} label 配置名称。
 * @returns {object} TOML 解析结果。
 * @throws TOML 无效时抛出脱敏错误。
 */
function parseTomlValue(source, label = 'TOML configuration') {
  if (!source.trim()) return {}
  try {
    return TOML.parse(source)
  } catch {
    throw new Error(`${label} is invalid TOML`)
  }
}

/**
 * 校验 TOML 文本但不返回解析值。
 *
 * @param {string} source TOML 原文。
 * @param {string} label 配置名称。
 * @returns {void} 校验通过时无返回值。
 * @throws TOML 无效时抛出错误。
 */
function assertValidToml(source, label = 'TOML configuration') {
  parseTomlValue(source, label)
}

function tomlScalar(value) {
  const output = TOML.stringify({ value }).trim()
  return output.slice(output.indexOf('=') + 1).trim()
}

/** 配置里有没有选定的 model_provider。首次使用 Codex 的人这里是空的。 */
function codexHasActiveProvider(source) {
  const data = parseTomlValue(source, 'Codex config.toml')
  return typeof data.model_provider === 'string' && data.model_provider.trim() !== ''
}

/**
 * 首次接管前的快照：配置里还没有活跃 provider（甚至没有 config.toml）。
 *
 * 接管的常规姿势是「只改现有 provider 的 base_url」，但第一次用 Codex 的人
 * 没有任何东西可改——这时要整段建一个指向网关的 provider，断开时再整段拆掉。
 * 快照记下顶层 model 原本的样子（在不在、是什么），拆的时候按原样放回去；
 * 形状与 restoreCodexManagedState 期望的 present/value 语义一致。
 */
function captureCodexFreshState(source) {
  const data = parseTomlValue(source, 'Codex config.toml')
  const modelPresent = Object.prototype.hasOwnProperty.call(data, 'model')
  return {
    fresh: true,
    modelProvider: { present: false, value: null },
    model: { present: modelPresent, value: modelPresent ? data.model : null },
    provider: { present: false, value: null },
  }
}

function codexProviderState(source, providerId) {
  const data = parseTomlValue(source, 'Codex config.toml')
  const resolvedProviderId = providerId || data.model_provider
  if (typeof resolvedProviderId !== 'string' || !resolvedProviderId.trim()) {
    throw new Error('Codex config.toml must define an active model_provider for gateway takeover')
  }
  const provider = data.model_providers?.[resolvedProviderId]
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    throw new Error(`Codex active provider is missing: ${resolvedProviderId}`)
  }
  const baseUrlPresent = Object.prototype.hasOwnProperty.call(provider, 'base_url')
  if (baseUrlPresent && typeof provider.base_url !== 'string') {
    throw new Error(`Codex provider ${resolvedProviderId} has a non-string base_url`)
  }
  if (typeof provider.wire_api !== 'string' || !provider.wire_api.trim()) {
    throw new Error(`Codex provider ${resolvedProviderId} must define wire_api for gateway takeover`)
  }
  return {
    providerId: resolvedProviderId,
    wireApi: provider.wire_api,
    baseUrl: {
      present: baseUrlPresent,
      value: baseUrlPresent ? provider.base_url : null,
    },
  }
}

function isCodexProviderHeader(line, providerId) {
  if (!/^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(line)) return false
  try {
    const marker = '__agentgate_provider_marker__'
    const parsed = TOML.parse(`${line}\n${marker} = true\n`)
    return parsed.model_providers?.[providerId]?.[marker] === true
  } catch {
    return false
  }
}

function codexProviderSection(lines, providerId) {
  const start = lines.findIndex((line) => isCodexProviderHeader(line, providerId))
  if (start < 0) throw new Error(`Codex provider table is missing: ${providerId}`)
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) {
      end = index
      break
    }
  }
  return { start, end }
}

function patchCodexProviderBaseUrl(source, providerId, fieldState) {
  assertValidToml(source, 'Codex config.toml')
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const trailingEol = source.endsWith('\n')
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  if (trailingEol) lines.pop()
  const { start, end } = codexProviderSection(lines, providerId)
  const relativeIndex = lines
    .slice(start + 1, end)
    .findIndex((line) => /^\s*base_url\s*=/.test(line))
  const assignmentIndex = relativeIndex < 0 ? -1 : start + 1 + relativeIndex

  if (!fieldState.present) {
    if (assignmentIndex >= 0) lines.splice(assignmentIndex, 1)
  } else if (assignmentIndex >= 0) {
    const line = lines[assignmentIndex]
    const match = /^(\s*base_url\s*=\s*)(?:"(?:\\.|[^"\\])*"|'[^']*')(\s*(?:#.*)?)$/.exec(line)
    if (!match) {
      throw new Error(`Codex provider ${providerId} base_url cannot be edited safely`)
    }
    lines[assignmentIndex] = `${match[1]}${tomlScalar(fieldState.value)}${match[2]}`
  } else {
    lines.splice(end, 0, `base_url = ${tomlScalar(fieldState.value)}`)
  }

  const result = `${lines.join(eol)}${trailingEol ? eol : ''}`
  assertValidToml(result, 'Generated Codex config.toml')
  return result
}

/**
 * 仅把当前活跃 Codex provider 的 base_url 指向本地网关。
 *
 * 不创建 provider，不修改 model_provider、model、wire_api 或认证字段。
 */
function patchCodexGatewayBaseUrl(source, baseUrl) {
  const state = codexProviderState(source)
  return patchCodexProviderBaseUrl(source, state.providerId, {
    present: true,
    value: baseUrl,
  })
}

/**
 * 恢复首次接管时记录的 provider base_url；当前活跃 provider 可已被用户切换。
 */
function restoreCodexGatewayBaseUrl(source, state) {
  if (!state || typeof state.providerId !== 'string' || !state.baseUrl) {
    throw new Error('Codex gateway recovery baseline is invalid')
  }
  codexProviderState(source, state.providerId)
  return patchCodexProviderBaseUrl(source, state.providerId, state.baseUrl)
}

/**
 * 恢复 Codex 官方登录模式，保留模型、MCP、项目设置和用户自建 provider。
 *
 * 官方登录由 auth.json 维护；这里仅删除 config.toml 的 provider 选择和
 * Agent;Gate 历史版本创建的 provider 表。
 */
function restoreCodexOfficialConfig(source) {
  assertValidToml(source, 'Codex config.toml')
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const trailingEol = source.endsWith('\n')
  const lines = source ? source.replace(/\r\n/g, '\n').split('\n') : []
  if (trailingEol) lines.pop()

  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line))
  const topLevelEnd = firstTable === -1 ? lines.length : firstTable
  const providerSelection = lines
    .slice(0, topLevelEnd)
    .findIndex((line) => /^\s*model_provider\s*=/.test(line))
  if (providerSelection >= 0) lines.splice(providerSelection, 1)

  for (const providerId of MANAGED_CODEX_PROVIDER_IDS) {
    const escapedProviderId = providerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const sectionPattern = new RegExp(
      `^\\s*\\[model_providers(?:\\.${escapedProviderId}|\\."${escapedProviderId}")\\]\\s*(?:#.*)?$`,
    )
    const managedSectionPrefix = new RegExp(
      `^\\s*\\[model_providers(?:\\.${escapedProviderId}|\\."${escapedProviderId}")(?:\\.|\\])`,
    )
    const sectionStart = lines.findIndex((line) => sectionPattern.test(line))
    if (sectionStart < 0) continue

    let sectionEnd = lines.length
    for (let index = sectionStart + 1; index < lines.length; index += 1) {
      if (/^\s*\[/.test(lines[index]) && !managedSectionPrefix.test(lines[index])) {
        sectionEnd = index
        break
      }
    }
    while (sectionEnd > sectionStart + 1 && !lines[sectionEnd - 1].trim()) sectionEnd -= 1
    lines.splice(sectionStart, sectionEnd - sectionStart)
  }

  const result = `${lines.join(eol)}${trailingEol && lines.length ? eol : ''}`
  assertValidToml(result, 'Restored official Codex config.toml')
  return result
}

/**
 * 仅更新 Codex 顶层选择项和 Agent;Gate 自有 provider 表。
 *
 * 其他 provider、MCP、插件、注释和顺序保持不变；旧的 Agent;Gate 子表会一起删除，
 * 避免残留请求头继续生效。
 *
 * @param {string} source 原始 TOML。
 * @param {object} profile 已校验的方案。
 * @param {string} apiKey 当前方案明文 Key，仅写入 Codex 原生配置。
 * @param {{providerId?: string, providerName?: string}} options 受管 provider 标识与显示名称。
 * @returns {string} 重新解析校验后的 TOML。
 * @throws 原文或生成结果不是有效 TOML 时抛出错误。
 */
function patchCodexToml(source, profile, apiKey, options = {}) {
  assertValidToml(source, 'Codex config.toml')
  const providerId = options.providerId || MANAGED_CODEX_PROVIDER_ID
  const providerName = options.providerName || `Agent;Gate - ${profile.name}`
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  let lines = source ? source.replace(/\r\n/g, '\n').split('\n') : []
  if (lines.at(-1) === '') lines.pop()

  const firstTableIndex = () => {
    const index = lines.findIndex((line) => /^\s*\[/.test(line))
    return index === -1 ? lines.length : index
  }

  const upsertTopLevel = (key, value) => {
    const end = firstTableIndex()
    const pattern = new RegExp(`^\\s*${key}\\s*=`)
    const index = lines.slice(0, end).findIndex((line) => pattern.test(line))
    const replacement = `${key} = ${tomlScalar(value)}`
    if (index >= 0) lines[index] = replacement
    else lines.splice(end, 0, replacement)
  }

  upsertTopLevel('model_provider', providerId)
  if (profile.model) upsertTopLevel('model', profile.model)

  const escapedProviderId = providerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const sectionPattern = new RegExp(
    `^\\s*\\[model_providers(?:\\.${escapedProviderId}|\\."${escapedProviderId}")\\]\\s*(?:#.*)?$`,
  )
  const managedSectionPrefix = new RegExp(
    `^\\s*\\[model_providers(?:\\.${escapedProviderId}|\\."${escapedProviderId}")(?:\\.|\\])`,
  )
  const sectionStart = lines.findIndex((line) => sectionPattern.test(line))
  const sectionLines = [
    `[model_providers.${providerId}]`,
    `name = ${tomlScalar(providerName)}`,
    `base_url = ${tomlScalar(profile.baseUrl)}`,
    `wire_api = ${tomlScalar(profile.protocol === PROTOCOL.OPENAI_CHAT ? 'chat' : 'responses')}`,
    'requires_openai_auth = false',
    `experimental_bearer_token = ${tomlScalar(apiKey)}`,
  ]

  if (sectionStart >= 0) {
    let sectionEnd = lines.length
    for (let index = sectionStart + 1; index < lines.length; index += 1) {
      if (/^\s*\[/.test(lines[index]) && !managedSectionPrefix.test(lines[index])) {
        sectionEnd = index
        break
      }
    }
    while (sectionEnd > sectionStart + 1 && !lines[sectionEnd - 1].trim()) {
      sectionEnd -= 1
    }
    lines.splice(sectionStart, sectionEnd - sectionStart, ...sectionLines)
  } else {
    if (lines.length && lines.at(-1).trim()) lines.push('')
    lines.push(...sectionLines)
  }

  const result = `${lines.join(eol)}${eol}`
  assertValidToml(result, 'Generated Codex config.toml')
  return result
}

/**
 * 恢复 Codex 中由本地网关接管的字段，同时保留运行期间产生的其他配置。
 *
 * @param {string} source 当前 TOML 原文。
 * @param {object} state 接管前捕获的受管字段状态。
 * @param {string} providerId 受管 provider 标识。
 * @returns {string} 恢复后的 TOML。
 */
function restoreCodexManagedState(source, state, providerId = 'agentgate_gateway') {
  assertValidToml(source, 'Codex config.toml')
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  let lines = source ? source.replace(/\r\n/g, '\n').split('\n') : []
  if (lines.at(-1) === '') lines.pop()

  const firstTableIndex = () => {
    const index = lines.findIndex((line) => /^\s*\[/.test(line))
    return index === -1 ? lines.length : index
  }

  const restoreTopLevel = (key, fieldState) => {
    const end = firstTableIndex()
    const pattern = new RegExp(`^\\s*${key}\\s*=`)
    const index = lines.slice(0, end).findIndex((line) => pattern.test(line))
    if (!fieldState.present) {
      if (index >= 0) lines.splice(index, 1)
      return
    }
    const replacement = `${key} = ${tomlScalar(fieldState.value)}`
    if (index >= 0) lines[index] = replacement
    else lines.splice(end, 0, replacement)
  }

  restoreTopLevel('model_provider', state.modelProvider)
  restoreTopLevel('model', state.model)

  const escapedProviderId = providerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const sectionPattern = new RegExp(
    `^\\s*\\[model_providers(?:\\.${escapedProviderId}|\\."${escapedProviderId}")\\]\\s*(?:#.*)?$`,
  )
  const managedSectionPrefix = new RegExp(
    `^\\s*\\[model_providers(?:\\.${escapedProviderId}|\\."${escapedProviderId}")(?:\\.|\\])`,
  )
  const sectionStart = lines.findIndex((line) => sectionPattern.test(line))
  let sectionEnd = sectionStart
  if (sectionStart >= 0) {
    sectionEnd = lines.length
    for (let index = sectionStart + 1; index < lines.length; index += 1) {
      if (/^\s*\[/.test(lines[index]) && !managedSectionPrefix.test(lines[index])) {
        sectionEnd = index
        break
      }
    }
    while (sectionEnd > sectionStart + 1 && !lines[sectionEnd - 1].trim()) sectionEnd -= 1
  }

  let restoredSection = []
  if (state.provider.present) {
    const serialized = TOML.stringify({
      model_providers: { [providerId]: state.provider.value },
    }).trim()
    restoredSection = serialized.split('\n')
  }

  if (sectionStart >= 0) {
    lines.splice(sectionStart, sectionEnd - sectionStart, ...restoredSection)
  } else if (restoredSection.length) {
    if (lines.length && lines.at(-1).trim()) lines.push('')
    lines.push(...restoredSection)
  }

  const result = lines.length ? `${lines.join(eol)}${eol}` : ''
  assertValidToml(result, 'Restored Codex config.toml')
  return result
}

function quoteEnv(value) {
  return JSON.stringify(value)
}

/**
 * 定点替换 dotenv 键，保留注释、未知字段和原换行风格。
 *
 * 同一受管键出现多次时保留一个最终定义，避免 Gemini 读取到旧值。
 *
 * @param {string} source 原始 dotenv 文本。
 * @param {Record<string, string | undefined>} values 需要写入的键值；undefined 表示删除。
 * @returns {string} 更新后的 dotenv 文本。
 */
function patchEnv(source, values) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source ? source.replace(/\r\n/g, '\n').split('\n') : []
  if (lines.at(-1) === '') lines.pop()

  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`)
    const indexes = []
    lines.forEach((line, index) => {
      if (pattern.test(line)) indexes.push(index)
    })
    if (value === undefined) {
      for (let i = indexes.length - 1; i >= 0; i -= 1) lines.splice(indexes[i], 1)
      continue
    }
    const replacement = `${key}=${quoteEnv(value)}`
    if (indexes.length) {
      lines[indexes[0]] = replacement
      for (let i = indexes.length - 1; i > 0; i -= 1) lines.splice(indexes[i], 1)
    } else {
      lines.push(replacement)
    }
  }

  return `${lines.join(eol)}${eol}`
}

module.exports = {
  hashText,
  readTextSnapshot,
  atomicWriteText,
  restoreSnapshot,
  parseJsoncValue,
  assertValidJsonc,
  patchJsonc,
  parseTomlValue,
  assertValidToml,
  patchCodexToml,
  restoreCodexManagedState,
  captureCodexFreshState,
  codexHasActiveProvider,
  codexProviderState,
  patchCodexGatewayBaseUrl,
  restoreCodexGatewayBaseUrl,
  restoreCodexOfficialConfig,
  patchEnv,
}
