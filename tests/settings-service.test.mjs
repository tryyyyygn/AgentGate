import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  defaultSettings,
  SettingsSchema,
  SettingsService,
} = require('../electron/services/settings-service.cjs')

function memoryStore(initial = defaultSettings()) {
  let value = structuredClone(initial)
  return {
    read: vi.fn(async () => structuredClone(value)),
    write: vi.fn(async (next) => {
      value = SettingsSchema.parse(structuredClone(next))
      return structuredClone(value)
    }),
  }
}

describe('SettingsService', () => {
  it('默认关闭开机自启，保留托盘与网关恢复', async () => {
    const app = { setLoginItemSettings: vi.fn() }
    const service = new SettingsService({ store: memoryStore(), app, executablePath: 'D:\\Keydeck.exe' })

    await expect(service.initialize()).resolves.toEqual({
      version: 1,
      launchAtLogin: false,
      closeToTray: true,
      startGatewayOnLaunch: true,
      theme: 'system',
      language: 'system',
      routing: { mode: 'assignment', strategy: 'fixed' },
      failover: {
        claude: { enabled: false, profileIds: [] },
        'claude-desktop': { enabled: false, profileIds: [] },
        codex: { enabled: false, profileIds: [] },
        opencode: { enabled: false, profileIds: [] },
        gemini: { enabled: false, profileIds: [] },
      },
    })
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: false,
      path: 'D:\\Keydeck.exe',
      args: [],
    })
  })

  it('读取旧版没有 language 和故障切换字段的配置文件时补上默认值而不是报错', async () => {
    const legacy = defaultSettings()
    delete legacy.language
    delete legacy.failover
    const app = { setLoginItemSettings: vi.fn() }
    const service = new SettingsService({
      store: memoryStore(legacy),
      app,
      executablePath: 'D:\\Keydeck.exe',
    })

    await expect(service.initialize()).resolves.toMatchObject({
      language: 'system',
      failover: {
        codex: { enabled: false, profileIds: [] },
      },
    })
  })

  it('故障切换对象缺少单个客户端字段时也补上该客户端默认值', async () => {
    const legacy = defaultSettings()
    delete legacy.failover.gemini
    const service = new SettingsService({
      store: memoryStore(legacy),
      app: { setLoginItemSettings: vi.fn() },
    })

    await expect(service.initialize()).resolves.toMatchObject({
      failover: {
        gemini: { enabled: false, profileIds: [] },
      },
    })
  })

  it('SettingsSchema 直接读取缺少单个客户端字段的旧文件时也能迁移', () => {
    const legacy = defaultSettings()
    delete legacy.failover.gemini

    expect(SettingsSchema.parse(legacy).failover.gemini).toEqual({
      enabled: false,
      profileIds: [],
    })
  })

  it('按客户端保存故障切换开关和候选库', async () => {
    const app = { setLoginItemSettings: vi.fn() }
    const service = new SettingsService({ store: memoryStore(), app, executablePath: 'D:\\Keydeck.exe' })
    await service.initialize()
    const first = '00000000-0000-4000-8000-000000000101'
    const second = '00000000-0000-4000-8000-000000000102'

    const result = await service.update({
      failover: {
        ...defaultSettings().failover,
        codex: { enabled: true, profileIds: [first, second] },
      },
    })

    expect(result.failover.codex).toEqual({ enabled: true, profileIds: [first, second] })
    expect(result.failover.claude).toEqual({ enabled: false, profileIds: [] })
    await expect(service.update({
      failover: {
        ...defaultSettings().failover,
        codex: { enabled: true, profileIds: ['not-a-profile-id'] },
      },
    })).rejects.toThrow()
  })

  it('局部更新一个客户端时保留其他客户端的故障切换设置', async () => {
    const first = '00000000-0000-4000-8000-000000000101'
    const second = '00000000-0000-4000-8000-000000000102'
    const initial = defaultSettings()
    initial.failover.claude = { enabled: true, profileIds: [first] }
    initial.failover.codex = { enabled: true, profileIds: [second] }
    const service = new SettingsService({
      store: memoryStore(initial),
      app: { setLoginItemSettings: vi.fn() },
    })
    await service.initialize()

    const result = await service.update({
      failover: { codex: { enabled: false } },
    })

    expect(result.failover).toEqual({
      claude: { enabled: true, profileIds: [first] },
      'claude-desktop': { enabled: false, profileIds: [] },
      codex: { enabled: false, profileIds: [second] },
      opencode: { enabled: false, profileIds: [] },
      gemini: { enabled: false, profileIds: [] },
    })
  })

  it('初始化时过滤已经删除的方案 ID，并把清理结果持久化', async () => {
    const first = '00000000-0000-4000-8000-000000000101'
    const deleted = '00000000-0000-4000-8000-000000000102'
    const stored = defaultSettings()
    stored.failover.codex = { enabled: true, profileIds: [first, deleted] }
    const store = memoryStore(stored)
    const app = { setLoginItemSettings: vi.fn() }
    const service = new SettingsService({
      store,
      app,
      getProfileIds: vi.fn(async () => [first]),
    })

    await expect(service.initialize()).resolves.toMatchObject({
      failover: {
        codex: { enabled: true, profileIds: [first] },
      },
    })
    expect(store.write).toHaveBeenCalledWith(expect.objectContaining({
      failover: expect.objectContaining({
        codex: { enabled: true, profileIds: [first] },
      }),
    }))
  })

  it('删除方案时从所有客户端候选库移除其 ID', async () => {
    const profileId = '00000000-0000-4000-8000-000000000101'
    const stored = defaultSettings()
    for (const target of Object.keys(stored.failover)) {
      stored.failover[target] = { enabled: true, profileIds: [profileId] }
    }
    const store = memoryStore(stored)
    const app = { setLoginItemSettings: vi.fn() }
    const service = new SettingsService({ store, app })
    await service.initialize()

    const result = await service.removeProfileId(profileId)

    expect(Object.values(result.failover).every((value) => value.profileIds.length === 0)).toBe(true)
    expect(store.write).toHaveBeenLastCalledWith(expect.objectContaining({
      failover: expect.objectContaining({
        codex: { enabled: true, profileIds: [] },
      }),
    }))
  })

  it('设置文件写入失败时也立即从当前内存候选库移除方案 ID', async () => {
    const profileId = '00000000-0000-4000-8000-000000000101'
    const stored = defaultSettings()
    stored.failover.codex = { enabled: true, profileIds: [profileId] }
    const store = memoryStore(stored)
    const service = new SettingsService({
      store,
      app: { setLoginItemSettings: vi.fn() },
    })
    await service.initialize()
    store.write.mockRejectedValueOnce(new Error('settings locked'))

    await expect(service.removeProfileId(profileId)).rejects.toThrow('settings locked')
    expect(service.getPublicSettings().failover.codex).toEqual({
      enabled: true,
      profileIds: [],
    })
  })

  it('保存界面语言', async () => {
    const app = { setLoginItemSettings: vi.fn() }
    const service = new SettingsService({ store: memoryStore(), app, executablePath: 'D:\\Keydeck.exe' })
    await service.initialize()

    await expect(service.update({ language: 'ja' })).resolves.toMatchObject({ language: 'ja' })
    // 繁体带地区子标签，容易在某处被当成未知值丢掉
    await expect(service.update({ language: 'zh-TW' })).resolves.toMatchObject({ language: 'zh-TW' })
    await expect(service.update({ language: 'klingon' })).rejects.toThrow()
  })

  it('保存路由模式和权重策略而不改动旧故障切换配置', async () => {
    const initial = defaultSettings()
    initial.failover.codex = { enabled: true, profileIds: [] }
    const service = new SettingsService({
      store: memoryStore(initial),
      app: { setLoginItemSettings: vi.fn() },
    })
    await service.initialize()

    const result = await service.update({
      routing: { mode: 'weighted', strategy: 'adaptive' },
    })

    expect(result.routing).toEqual({ mode: 'weighted', strategy: 'adaptive' })
    expect(result.failover.codex).toEqual({ enabled: true, profileIds: [] })
  })

  it('原子保存局部设置并同步 Windows 登录项', async () => {
    const store = memoryStore()
    const app = { setLoginItemSettings: vi.fn() }
    const onChanged = vi.fn()
    const service = new SettingsService({
      store,
      app,
      onChanged,
      executablePath: 'D:\\Keydeck.exe',
    })
    await service.initialize()

    const result = await service.update({
      launchAtLogin: true,
      theme: 'dark',
    })

    expect(result).toMatchObject({
      launchAtLogin: true,
      closeToTray: true,
      theme: 'dark',
    })
    expect(app.setLoginItemSettings).toHaveBeenLastCalledWith({
      openAtLogin: true,
      path: 'D:\\Keydeck.exe',
      args: ['--silent'],
    })
    expect(onChanged).toHaveBeenCalledWith(result)
  })

  it('拒绝未知字段，持久化失败时恢复登录项', async () => {
    const store = memoryStore()
    const app = { setLoginItemSettings: vi.fn() }
    const service = new SettingsService({ store, app, executablePath: 'D:\\Keydeck.exe' })
    await service.initialize()

    await expect(service.update({ hiddenOption: true })).rejects.toBeDefined()
    store.write.mockRejectedValueOnce(new Error('disk full'))
    await expect(service.update({ launchAtLogin: true })).rejects.toThrow('disk full')
    expect(app.setLoginItemSettings.mock.calls.slice(-2)).toEqual([
      [{ openAtLogin: true, path: 'D:\\Keydeck.exe', args: ['--silent'] }],
      [{ openAtLogin: false, path: 'D:\\Keydeck.exe', args: [] }],
    ])
  })
})
