import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const TOML = require('@iarna/toml')

const cdpOrigin = process.env.KEYDECK_CDP_URL
const smokeRoot = process.env.KEYDECK_SMOKE_ROOT
const upstreamOrigin = process.env.KEYDECK_SMOKE_BASE_URL?.replace(/\/+$/, '')
const codexHome = process.env.CODEX_HOME
if (!cdpOrigin || !smokeRoot || !upstreamOrigin || !codexHome) {
  throw new Error('Packaged smoke environment is incomplete')
}

class CdpClient {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (!message.id || !this.pending.has(message.id)) return
      const { resolve, reject } = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result)
    })
  }

  static async connect(origin) {
    const pages = await fetch(`${origin}/json/list`).then((response) => response.json())
    const page = pages.find((item) => item.type === 'page')
    if (!page?.webSocketDebuggerUrl) throw new Error('Packaged Keydeck page was not found')
    const socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    return new CdpClient(socket)
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || 'Renderer evaluation failed')
    }
    return result.result.value
  }

  close() {
    this.socket.close()
  }
}

async function availablePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  await new Promise((resolve) => server.close(resolve))
  return address.port
}

async function gatewayRequest(baseUrl) {
  const response = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer incoming-client-auth-is-ignored',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: 'client-owned-model', input: 'ping' }),
  })
  if (!response.ok) throw new Error(`Gateway smoke request failed: HTTP ${response.status}`)
  return response.json()
}

const codexConfig = path.join(codexHome, 'config.toml')
const secretA = 'sk-packaged-smoke-secret-a'
const secretB = 'sk-packaged-smoke-secret-b'
const original = `# 用户运行配置必须完整保留
model_provider = "custom"
model = "user-model"
approval_policy = "never"

[features]
web_search_request = true

[model_providers.custom]
name = "Custom"
base_url = "https://user-original.example/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "user-owned-auth"

[mcp_servers.demo]
command = "node"
`
await fs.mkdir(codexHome, { recursive: true })
await fs.writeFile(codexConfig, original, 'utf8')

const gatewayPort = await availablePort()
const client = await CdpClient.connect(cdpOrigin)
try {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await client.evaluate("Boolean(document.querySelector('.brand-mark'))")) break
    await new Promise((resolve) => setTimeout(resolve, 100))
    if (attempt === 39) throw new Error('Packaged Keydeck UI did not become ready')
  }
  const statusIntervals = await client.evaluate(`new Promise((resolve) => {
    document.querySelectorAll('.top-nav button')[2]?.click()
    setTimeout(() => {
      const select = document.querySelector('.status-interval select')
      resolve({
        values: [...(select?.options || [])].map((option) => Number(option.value)),
        selected: Number(select?.value),
      })
    }, 50)
  })`)
  if (JSON.stringify(statusIntervals) !== JSON.stringify({
    values: [120000, 300000, 600000],
    selected: 120000,
  })) {
    throw new Error('Packaged status probe intervals are incorrect')
  }
  await client.evaluate("window.agentgate.updateSettings({ theme: 'dark', experimentalToolBridge: false })")

  const common = {
    protocol: 'openai-responses',
    model: 'discovery-only-model',
    authMode: 'bearer',
    targets: ['codex'],
    enableToolSearch: false,
    autoSwitch: { enabled: false, intervalMinutes: 2 },
  }
  const urlA = `${upstreamOrigin}/a/v1`
  const urlB = `${upstreamOrigin}/b/v1`
  const inputA = { ...common, name: '打包方案 A', baseUrl: urlA, endpoints: [{ url: urlA }], apiKey: secretA }
  const inputB = { ...common, name: '打包方案 B', baseUrl: urlB, endpoints: [{ url: urlB }], apiKey: secretB }
  const created = await client.evaluate(`(async () => {
    const profileA = await window.agentgate.saveProfile(${JSON.stringify(inputA)});
    const profileB = await window.agentgate.saveProfile(${JSON.stringify(inputB)});
    const assigned = await window.agentgate.applyProfile(profileA.id, ['codex']);
    return { profileA, profileB, assigned };
  })()`)
  const publicResult = JSON.stringify(created)
  if (publicResult.includes(secretA) || publicResult.includes(secretB)) {
    throw new Error('Renderer IPC exposed an upstream key')
  }
  if (created.assigned.gateway.status !== 'stopped') throw new Error('Route staging started the gateway')
  if (await fs.readFile(codexConfig, 'utf8') !== original) throw new Error('Staging changed Codex config')

  await client.evaluate(`window.agentgate.startGateway({ port: ${gatewayPort} })`)
  const takenOver = await fs.readFile(codexConfig, 'utf8')
  const parsed = TOML.parse(takenOver)
  const provider = parsed.model_providers.custom
  const localBaseUrl = provider.base_url
  if (!new RegExp(`^http://127\\.0\\.0\\.1:${gatewayPort}/codex/[A-Za-z0-9_-]{40,}$`).test(localBaseUrl)) {
    throw new Error('Codex did not receive the tokenized local gateway URL')
  }
  if (parsed.model_provider !== 'custom' || parsed.model !== 'user-model') {
    throw new Error('Codex model selection changed during takeover')
  }
  if (provider.wire_api !== 'responses'
    || provider.experimental_bearer_token !== 'user-owned-auth'
    || parsed.model_providers.keydeck_gateway) {
    throw new Error('Codex provider fields changed during URL-only takeover')
  }
  if (takenOver.includes(secretA) || takenOver.includes(secretB)) {
    throw new Error('Codex config contains an upstream key')
  }
  if ((await gatewayRequest(localBaseUrl)).route !== 'a') throw new Error('Initial gateway route failed')

  const runtimeEdit = takenOver.replace('[features]', 'runtime_added = true\n\n[features]')
  await fs.writeFile(codexConfig, runtimeEdit, 'utf8')
  const beforeHotSwitch = await fs.readFile(codexConfig)
  await client.evaluate(`window.agentgate.applyProfile(${JSON.stringify(created.profileB.id)}, ['codex'])`)
  const afterHotSwitch = await fs.readFile(codexConfig)
  if (!beforeHotSwitch.equals(afterHotSwitch)) throw new Error('Hot switch rewrote Codex config')
  if ((await gatewayRequest(localBaseUrl)).route !== 'b') throw new Error('Hot gateway route failed')

  const recoveryStore = path.join(smokeRoot, 'user-data', 'data', 'gateway-recovery.json')
  const recoverySource = await fs.readFile(recoveryStore, 'utf8')
  if (recoverySource.includes('https://user-original.example')
    || recoverySource.includes('user-owned-auth')) {
    throw new Error('Recovery store contains plaintext Codex config')
  }

  const stopped = await client.evaluate('window.agentgate.stopGateway()')
  if (stopped.gateway.status !== 'stopped') throw new Error('Gateway did not stop')
  const restored = TOML.parse(await fs.readFile(codexConfig, 'utf8'))
  if (restored.model_provider !== 'custom'
    || restored.model !== 'user-model'
    || restored.runtime_added !== true
    || restored.model_providers.custom.base_url !== 'https://user-original.example/v1'
    || restored.model_providers.custom.wire_api !== 'responses'
    || restored.model_providers.custom.experimental_bearer_token !== 'user-owned-auth'
    || restored.mcp_servers.demo.command !== 'node') {
    throw new Error('Field-level Codex restore changed user settings')
  }
  const recovery = JSON.parse(await fs.readFile(recoveryStore, 'utf8'))
  if (Object.keys(recovery.baselines).length !== 0) throw new Error('Verified recovery baseline was not destroyed')

  for (const filename of ['profiles.json', 'gateway.json', 'gateway-recovery.json', 'settings.json']) {
    const source = await fs.readFile(path.join(smokeRoot, 'user-data', 'data', filename), 'utf8')
    if (source.includes(secretA) || source.includes(secretB) || source.includes('user-owned-auth')) {
      throw new Error(`${filename} contains plaintext secret material`)
    }
  }
  process.stdout.write(`PACKAGED_SMOKE_OK port=${gatewayPort}\n`)
} finally {
  client.close()
}
