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
    })
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: false,
      path: 'D:\\Keydeck.exe',
      args: [],
    })
  })

  it('读取旧版没有 language 字段的配置文件时补上默认值而不是报错', async () => {
    const legacy = defaultSettings()
    delete legacy.language
    const app = { setLoginItemSettings: vi.fn() }
    const service = new SettingsService({
      store: memoryStore(legacy),
      app,
      executablePath: 'D:\\Keydeck.exe',
    })

    await expect(service.initialize()).resolves.toMatchObject({ language: 'system' })
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
