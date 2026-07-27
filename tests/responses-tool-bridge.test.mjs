import { once } from 'node:events'
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  MAX_ACTIVE_RESPONSE_TRANSFORMS,
  MAX_GLOBAL_RESPONSE_BUFFER_BYTES,
  MAX_RESPONSE_FRAME_BYTES,
  MAX_RESPONSE_STREAM_BYTES,
  createResponsesSseJsonTransform,
} = require('../electron/services/responses-tool-bridge.cjs')

async function runTransform(transform, chunks) {
  const output = []
  for await (const chunk of Readable.from(chunks).pipe(transform)) output.push(chunk)
  return Buffer.concat(output).toString('utf8')
}

describe('Responses 同步流兼容', () => {
  it('把 response.completed SSE 收拢成同步 JSON', async () => {
    const source = [
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      'event: response.completed\n',
      'data: {"type":"response.completed","response":{"id":"resp_1","output":[{"type":"message"}],"usage":{"input_tokens":2,"output_tokens":1}}}\n\n',
      'data: [DONE]\n\n',
    ].join('')
    const split = Buffer.from(source, 'utf8')
    const output = await runTransform(createResponsesSseJsonTransform(), [
      split.subarray(0, 17),
      split.subarray(17),
    ])

    expect(JSON.parse(output)).toEqual({
      id: 'resp_1',
      output: [{ type: 'message' }],
      usage: { input_tokens: 2, output_tokens: 1 },
    })
  })

  it('保留 response.failed 和 response.incomplete 的响应正文', async () => {
    for (const type of ['response.failed', 'response.incomplete']) {
      const source = `event: ${type}\ndata: ${JSON.stringify({
        type,
        response: { id: `resp_${type}`, status: type.slice(9) },
      })}\n\n`
      const output = await runTransform(
        createResponsesSseJsonTransform(),
        [Buffer.from(source, 'utf8')],
      )
      expect(JSON.parse(output)).toMatchObject({ id: `resp_${type}` })
    }
  })

  it('错误事件、缺少完成事件和损坏 JSON 都会失败', async () => {
    await expect(runTransform(createResponsesSseJsonTransform(), [
      Buffer.from('event: error\ndata: {"type":"error"}\n\n', 'utf8'),
    ])).rejects.toThrow(/ended with an error/)

    await expect(runTransform(createResponsesSseJsonTransform(), [
      Buffer.from('data: {"type":"response.output_text.delta","delta":"hi"}\n\n', 'utf8'),
    ])).rejects.toThrow(/did not include response.completed/)

    await expect(runTransform(createResponsesSseJsonTransform(), [
      Buffer.from('event: response.completed\ndata: {not-json}\n\n', 'utf8'),
    ])).rejects.toThrow(/invalid JSON/)
  })

  it('UTF-8 多字节字符跨原始字节分片时保持完整', async () => {
    const source = Buffer.from(
      'event: response.completed\ndata: {"type":"response.completed","response":{"output_text":"你好"}}\n\n',
      'utf8',
    )
    const start = source.indexOf(Buffer.from('你', 'utf8'))
    const output = await runTransform(createResponsesSseJsonTransform(), [
      source.subarray(0, start + 1),
      source.subarray(start + 1),
    ])

    expect(JSON.parse(output)).toEqual({ output_text: '你好' })
    expect(output).not.toContain('\uFFFD')
  })

  it('拒绝超过单帧和整条流上限的响应', async () => {
    await expect(runTransform(
      createResponsesSseJsonTransform(),
      [Buffer.alloc(MAX_RESPONSE_FRAME_BYTES + 1, 0x61)],
    )).rejects.toThrow(/frame is too large/i)

    await expect(runTransform(
      createResponsesSseJsonTransform(),
      [Buffer.alloc(MAX_RESPONSE_STREAM_BYTES + 1)],
    )).rejects.toThrow(/stream is too large/i)
  })

  it('并发和全局缓冲预算在销毁后释放', async () => {
    const active = Array.from(
      { length: MAX_ACTIVE_RESPONSE_TRANSFORMS },
      () => createResponsesSseJsonTransform(),
    )
    await expect(runTransform(
      createResponsesSseJsonTransform(),
      [Buffer.from('data: {}\n\n')],
    )).rejects.toThrow(/concurrent Responses transforms/i)
    const activeClosed = active.map((transform) => once(transform, 'close'))
    active.forEach((transform) => transform.destroy())
    await Promise.all(activeClosed)

    const holders = [createResponsesSseJsonTransform(), createResponsesSseJsonTransform()]
    const bytesPerHolder = MAX_GLOBAL_RESPONSE_BUFFER_BYTES / holders.length
    await Promise.all(holders.map((transform) => new Promise((resolve, reject) => {
      transform.write(Buffer.alloc(bytesPerHolder, 0x61), (error) => (error ? reject(error) : resolve()))
    })))
    await expect(runTransform(
      createResponsesSseJsonTransform(),
      [Buffer.from('x')],
    )).rejects.toThrow(/buffer budget/i)
    const holderClosed = holders.map((transform) => once(transform, 'close'))
    holders.forEach((transform) => transform.destroy())
    await Promise.all(holderClosed)

    const source = Buffer.from(
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_ok"}}\n\n',
      'utf8',
    )
    await expect(runTransform(createResponsesSseJsonTransform(), [source]))
      .resolves.toContain('resp_ok')
  })
})
