const { Transform } = require('node:stream')
const { StringDecoder } = require('node:string_decoder')

const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024
const MAX_RESPONSE_BODY_BYTES = 8 * 1024 * 1024
const MAX_RESPONSE_STREAM_BYTES = 32 * 1024 * 1024
const MAX_RESPONSE_FRAME_BYTES = 8 * 1024 * 1024
const MAX_ACTIVE_RESPONSE_TRANSFORMS = 16
const MAX_GLOBAL_RESPONSE_BUFFER_BYTES = 16 * 1024 * 1024
const PART_BLOCK_SIZE = 1024
let activeResponseTransforms = 0
let globalResponseBufferBytes = 0

class ResponseBudgetLease {
  constructor() {
    this.bytes = 0
    this.acquired = activeResponseTransforms < MAX_ACTIVE_RESPONSE_TRANSFORMS
    if (this.acquired) activeResponseTransforms += 1
  }

  assertAvailable() {
    if (!this.acquired) throw new Error('Too many concurrent Responses transforms')
  }

  reserve(bytes) {
    this.assertAvailable()
    if (bytes <= 0) return
    if (globalResponseBufferBytes + bytes > MAX_GLOBAL_RESPONSE_BUFFER_BYTES) {
      throw new Error('Responses transform global buffer budget exceeded')
    }
    this.bytes += bytes
    globalResponseBufferBytes += bytes
  }

  release(bytes) {
    if (!this.acquired || bytes <= 0) return
    const released = Math.min(bytes, this.bytes)
    this.bytes -= released
    globalResponseBufferBytes -= released
  }

  close() {
    if (!this.acquired) return
    globalResponseBufferBytes -= this.bytes
    this.bytes = 0
    this.acquired = false
    activeResponseTransforms -= 1
  }
}

class ResponsesSseJsonTransform extends Transform {
  constructor() {
    super()
    this.lease = new ResponseBudgetLease()
    this.decoder = new StringDecoder('utf8')
    this.lineBlocks = []
    this.lineParts = []
    this.lineBytes = 0
    this.frameLines = []
    this.frameBytes = 0
    this.totalBytes = 0
    this.response = undefined
    this.errorPayload = undefined
  }

  _construct(callback) {
    try {
      this.lease.assertAvailable()
      callback()
    } catch (error) {
      callback(error)
    }
  }

  _transform(chunk, _encoding, callback) {
    try {
      this.lease.assertAvailable()
      this.totalBytes += chunk.length
      if (this.totalBytes > MAX_RESPONSE_STREAM_BYTES) {
        throw new Error('Upstream Responses stream is too large')
      }
      this.lease.reserve(chunk.length)
      this._consume(this.decoder.write(chunk))
      callback()
    } catch (error) {
      callback(error)
    }
  }

  _flush(callback) {
    try {
      this.lease.assertAvailable()
      this._consume(this.decoder.end(), true)
      if (!this.response || typeof this.response !== 'object') {
        throw new Error(
          this.errorPayload
            ? 'Upstream Responses stream ended with an error'
            : 'Upstream Responses stream did not include response.completed',
        )
      }
      const body = Buffer.from(JSON.stringify(this.response), 'utf8')
      if (body.length > MAX_RESPONSE_BODY_BYTES) {
        throw new Error('Upstream Responses response is too large')
      }
      this.lease.reserve(body.length)
      this.push(body)
      this.lease.release(body.length)
      callback()
    } catch (error) {
      callback(error)
    }
  }

  _destroy(error, callback) {
    this.lineBlocks = []
    this.lineParts = []
    this.frameLines = []
    this.response = undefined
    this.errorPayload = undefined
    this.lease.close()
    callback(error)
  }

  _consume(text, final = false) {
    let start = 0
    for (let newline = text.indexOf('\n', start); newline >= 0; newline = text.indexOf('\n', start)) {
      this._appendLine(text.slice(start, newline))
      this._finishLine(true)
      start = newline + 1
    }
    this._appendLine(text.slice(start))
    if (final) {
      if (this.lineBytes > 0) this._finishLine(false)
      if (this.frameLines.length > 0 || this.frameBytes > 0) this._flushFrame()
    }
  }

  _appendLine(text) {
    if (!text) return
    const bytes = Buffer.byteLength(text, 'utf8')
    this.lineBytes += bytes
    if (this.lineBytes > MAX_RESPONSE_FRAME_BYTES) {
      throw new Error('Upstream Responses SSE frame is too large')
    }
    this.lineParts.push(text)
    if (this.lineParts.length >= PART_BLOCK_SIZE) {
      this.lineBlocks.push(this.lineParts.join(''))
      this.lineParts = []
    }
  }

  _finishLine(hasNewline) {
    const raw = [...this.lineBlocks, this.lineParts.join('')].join('')
    const bytes = this.lineBytes
    this.lineBlocks = []
    this.lineParts = []
    this.lineBytes = 0
    this.frameBytes += bytes + (hasNewline ? 1 : 0)
    if (this.frameBytes > MAX_RESPONSE_FRAME_BYTES) {
      throw new Error('Upstream Responses SSE frame is too large')
    }
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line === '') this._flushFrame()
    else this.frameLines.push(line)
  }

  _flushFrame() {
    const lines = this.frameLines
    const bytes = this.frameBytes
    this.frameLines = []
    this.frameBytes = 0
    this.lease.release(bytes)
    if (lines.length === 0) return
    const eventName = lines.find((line) => line.startsWith('event:'))
      ?.slice(6).trim()
    const data = lines.filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n')
      .trim()
    if (!data || data === '[DONE]') return
    let payload
    try {
      payload = JSON.parse(data)
    } catch {
      throw new Error('Upstream Responses SSE event contains invalid JSON')
    }
    const type = eventName || payload?.type
    if (type === 'response.completed'
      || type === 'response.failed'
      || type === 'response.incomplete') {
      this.response = payload.response
    } else if (type === 'error' || type === 'response.error') {
      this.errorPayload = payload
    }
  }
}

function createResponsesSseJsonTransform() {
  return new ResponsesSseJsonTransform()
}

module.exports = {
  MAX_ACTIVE_RESPONSE_TRANSFORMS,
  MAX_GLOBAL_RESPONSE_BUFFER_BYTES,
  MAX_REQUEST_BODY_BYTES,
  MAX_RESPONSE_BODY_BYTES,
  MAX_RESPONSE_STREAM_BYTES,
  MAX_RESPONSE_FRAME_BYTES,
  createResponsesSseJsonTransform,
  ResponsesSseJsonTransform,
}
