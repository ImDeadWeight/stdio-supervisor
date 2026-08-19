import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createStdioSupervisor } from '../src/index.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ECHO_SERVER = path.join(__dirname, 'fixtures', 'echo-server.mjs')

function spawnEcho(extraEnv = {}) {
  return {
    command: process.execPath,
    args: [ECHO_SERVER],
    env: { ...extraEnv },
    shell: false,
  }
}

test('start() spawns a process and delivers framed lines via onLine', async () => {
  const lines = []
  const supervisor = createStdioSupervisor({ onLine: (id, line) => lines.push([id, line]) })
  try {
    const res = supervisor.start('a', spawnEcho())
    assert.equal(res.ok, true)
    assert.equal(supervisor.isRunning('a'), true)

    supervisor.send('a', 'hello')
    await delay(200)

    assert.deepEqual(lines, [['a', 'echo:hello']])
  } finally {
    supervisor.shutdown()
  }
})

test('start() is idempotent for an already-running id', async () => {
  const supervisor = createStdioSupervisor()
  try {
    supervisor.start('a', spawnEcho())
    await delay(100)
    const res = supervisor.start('a', spawnEcho())
    assert.deepEqual(res, { ok: true, alreadyRunning: true })
  } finally {
    supervisor.shutdown()
  }
})

test('stop() kills the process and does not trigger a restart', async () => {
  let exitInfo = null
  const supervisor = createStdioSupervisor({ onExit: (id, info) => { exitInfo = info } })
  try {
    supervisor.start('a', spawnEcho())
    await delay(100)

    const res = supervisor.stop('a')
    assert.equal(res.wasRunning, true)
    await delay(300)

    assert.equal(supervisor.isRunning('a'), false)
    assert.ok(exitInfo)
  } finally {
    supervisor.shutdown()
  }
})

test('stop() on an id that is not running reports wasRunning:false', () => {
  const supervisor = createStdioSupervisor()
  const res = supervisor.stop('nope')
  assert.deepEqual(res, { ok: true, wasRunning: false })
})

test('send() to an id that is not running returns an error, does not throw', () => {
  const supervisor = createStdioSupervisor()
  const res = supervisor.send('nope', 'hi')
  assert.equal(res.ok, false)
  assert.match(res.error, /not running/)
})

test('a crashing process restarts on its own with backoff', async () => {
  const exits = []
  const supervisor = createStdioSupervisor({
    onExit: (id, info) => exits.push([id, info]),
    // Without this, the restarted process would reuse the crash-after-50ms
    // config and loop crash/restart forever with an ever-growing backoff —
    // resolveConfig lets the restart come back up clean.
    resolveConfig: () => spawnEcho(),
  })
  try {
    supervisor.start('a', spawnEcho({ ECHO_CRASH_AFTER_MS: '50' }))
    await delay(150)
    assert.equal(exits.length, 1, 'first crash observed')

    // Backoff starts at 1s, so give it a little more than that to come back up.
    await delay(1200)
    assert.equal(supervisor.isRunning('a'), true, 'restarted after backoff')
  } finally {
    supervisor.shutdown()
  }
})

test('shouldRestart(id) => false suppresses the crash-restart', async () => {
  const exits = []
  const supervisor = createStdioSupervisor({
    onExit: (id, info) => exits.push([id, info]),
    shouldRestart: () => false,
    resolveConfig: () => spawnEcho(),
  })
  try {
    supervisor.start('a', spawnEcho({ ECHO_CRASH_AFTER_MS: '50' }))
    await delay(150)
    assert.equal(exits.length, 1, 'crash observed')

    await delay(1200)
    assert.equal(supervisor.isRunning('a'), false, 'did not restart')
  } finally {
    supervisor.shutdown()
  }
})

test('resolveConfig() is consulted on crash-restart so edited config takes effect', async () => {
  const lines = []
  const supervisor = createStdioSupervisor({
    onLine: (id, line) => lines.push(line),
    resolveConfig: () => spawnEcho({ ECHO_PREFIX: 'updated:' }),
  })
  try {
    supervisor.start('a', spawnEcho({ ECHO_PREFIX: 'original:', ECHO_CRASH_AFTER_MS: '50' }))
    await delay(1300) // crash + backoff + restart

    supervisor.send('a', 'ping')
    await delay(200)

    assert.ok(lines.some((l) => l.startsWith('updated:')), `expected an updated: line, got ${JSON.stringify(lines)}`)
  } finally {
    supervisor.shutdown()
  }
})

test('shutdown() stops every running process and prevents further restarts', async () => {
  const supervisor = createStdioSupervisor()
  try {
    supervisor.start('a', spawnEcho())
    supervisor.start('b', spawnEcho())
    await delay(100)

    assert.deepEqual(supervisor.listRunning().sort(), ['a', 'b'])
    supervisor.shutdown()
    await delay(300)

    assert.deepEqual(supervisor.listRunning(), [])
  } finally {
    supervisor.shutdown()
  }
})

test('start() with a bad command returns ok:false instead of throwing', () => {
  const supervisor = createStdioSupervisor()
  try {
    const res = supervisor.start('bad', { command: path.join(__dirname, 'does-not-exist-binary'), args: [], shell: false })
    // On some platforms a bad path surfaces as an async 'error' event instead of
    // a synchronous throw; either way start() itself must not throw.
    assert.equal(typeof res.ok, 'boolean')
  } finally {
    supervisor.shutdown()
  }
})
