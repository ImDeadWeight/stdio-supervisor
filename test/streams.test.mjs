import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createStdioSupervisor } from '../src/index.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name) => path.join(__dirname, '..', 'test-fixtures', name)

test('onStderr delivers stderr unframed, preserving blank and unterminated lines', async () => {
  const chunks = []
  const supervisor = createStdioSupervisor({
    onStderr: (id, text, meta) => chunks.push({ text, generation: meta.generation }),
    shouldRestart: () => false,
  })
  try {
    supervisor.start('a', { command: process.execPath, args: [fixture('noisy-stderr.mjs')], shell: false })
    await delay(700)

    const all = chunks.map(c => c.text).join('')
    assert.equal(all, 'first\n\nprogress-no-newline', 'stderr arrives byte-for-byte as written')
    assert.ok(chunks.every(c => c.generation === 1))
  } finally {
    supervisor.shutdown()
  }
})

test('stderr still reaches the log file when no onStderr is given', async () => {
  // The callback is additive: it must not replace the existing file logging.
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
  const os = await import('node:os')
  const dir = mkdtempSync(path.join(os.tmpdir(), 'stdio-sup-'))
  const supervisor = createStdioSupervisor({ logDir: dir, shouldRestart: () => false })
  try {
    supervisor.start('a', { command: process.execPath, args: [fixture('noisy-stderr.mjs')], shell: false })
    await delay(700)
    assert.match(readFileSync(path.join(dir, 'a.log'), 'utf8'), /first/)
  } finally {
    supervisor.shutdown()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('maxLineBytes drops an over-long line and resyncs at the next newline', async () => {
  const lines = []
  const overflows = []
  const supervisor = createStdioSupervisor({
    maxLineBytes: 1024 * 1024,
    onLine: (id, line) => lines.push(line),
    onOverflow: (id, info) => overflows.push(info),
    shouldRestart: () => false,
  })
  try {
    supervisor.start('a', {
      command: process.execPath,
      args: [fixture('flood.mjs')],
      env: { FLOOD_BYTES: String(5 * 1024 * 1024) },
      shell: false,
    })
    await delay(2500)

    assert.equal(overflows.length, 1, 'reported exactly once for the one over-long line')
    assert.ok(overflows[0].bytes > 1024 * 1024)
    assert.equal(overflows[0].maxLineBytes, 1024 * 1024)
    assert.equal(overflows[0].generation, 1)

    // The critical property: no fragment of the flood is delivered as if it
    // were a whole line. Truncating would hand back a plausible-looking line.
    assert.ok(!lines.some(l => l.includes('x')), 'no truncated fragment delivered')
    assert.deepEqual(lines, ['recovered'], 'framing resumed after the newline')
  } finally {
    supervisor.shutdown()
  }
})

test('maxLineBytes is not applied across separate lines', async () => {
  // Many small lines must never trip a cap larger than any one of them.
  const lines = []
  const overflows = []
  const supervisor = createStdioSupervisor({
    maxLineBytes: 4096,
    onLine: (id, line) => lines.push(line),
    onOverflow: (id, info) => overflows.push(info),
    shouldRestart: () => false,
  })
  try {
    supervisor.start('a', {
      command: process.execPath,
      args: [fixture('echo-server.mjs')],
      env: { ECHO_CHATTER_MS: '10' },
      shell: false,
    })
    await delay(600)
    assert.ok(lines.length > 10, 'plenty of small lines flowed')
    assert.equal(overflows.length, 0, 'cumulative volume did not trip the per-line cap')
  } finally {
    supervisor.shutdown()
  }
})

test('default maxLineBytes is unlimited, preserving prior behavior', async () => {
  const overflows = []
  const lines = []
  const supervisor = createStdioSupervisor({
    onLine: (id, line) => lines.push(line),
    onOverflow: (id, info) => overflows.push(info),
    shouldRestart: () => false,
  })
  try {
    supervisor.start('a', {
      command: process.execPath,
      args: [fixture('flood.mjs')],
      env: { FLOOD_BYTES: String(2 * 1024 * 1024) },
      shell: false,
    })
    await delay(2500)
    assert.equal(overflows.length, 0, 'no cap by default')
    assert.ok(lines[0].length >= 2 * 1024 * 1024, 'the whole long line was delivered intact')
  } finally {
    supervisor.shutdown()
  }
})
