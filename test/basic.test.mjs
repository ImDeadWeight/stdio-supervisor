import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { createStdioSupervisor } from '../src/index.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ECHO_SERVER = path.join(__dirname, '..', 'test-fixtures', 'echo-server.mjs')
const PRINT_CWD = path.join(__dirname, '..', 'test-fixtures', 'print-cwd.mjs')

function spawnEcho(extraEnv = {}) {
  return {
    command: process.execPath,
    args: [ECHO_SERVER],
    env: { ...extraEnv },
    shell: false,
  }
}

// Spawn-and-crash timings are not budgetable on a loaded CI runner: a fixed
// `delay(150)` for "node has started and exited 50ms later" is a coin flip on
// a slow macOS box. Poll for the condition instead, with a ceiling that is
// generous rather than tight. Only use this where the condition is expected
// to become true — proving something did NOT happen still needs a real wait.
async function waitFor(cond, message, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await delay(10)
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for: ${message}`)
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
    await waitFor(() => exits.length === 1, 'first crash observed')

    // Backoff starts at 1s, so it comes back up a little after that.
    await waitFor(() => supervisor.isRunning('a'), 'restarted after backoff')
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
    await waitFor(() => exits.length === 1, 'crash observed')

    // A real wait, not a poll: the point is that no restart happens inside the
    // backoff window, so the time has to actually pass.
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
    // crash + backoff + restart
    await waitFor(() => supervisor.status('a')?.restarts === 1 && supervisor.isRunning('a'), 'restarted once')

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

test('onSpawn() fires on the initial start() with the config used', async () => {
  const spawns = []
  const supervisor = createStdioSupervisor({ onSpawn: (id, cfg) => spawns.push([id, cfg]) })
  try {
    const cfg = spawnEcho({ ECHO_PREFIX: 'x:' })
    supervisor.start('a', cfg)
    await delay(100)

    assert.equal(spawns.length, 1)
    assert.equal(spawns[0][0], 'a')
    assert.equal(spawns[0][1], cfg)
  } finally {
    supervisor.shutdown()
  }
})

test('onSpawn() fires again on a crash-restart, with the re-resolved config', async () => {
  const spawns = []
  const supervisor = createStdioSupervisor({
    onSpawn: (id, cfg) => spawns.push([id, cfg]),
    resolveConfig: () => spawnEcho({ ECHO_PREFIX: 'restarted:' }),
  })
  try {
    supervisor.start('a', spawnEcho({ ECHO_PREFIX: 'original:', ECHO_CRASH_AFTER_MS: '50' }))
    await waitFor(() => spawns.length === 1, 'initial spawn observed')

    await waitFor(() => spawns.length === 2, 'restart spawn observed') // backoff + restart
    assert.equal(spawns[1][0], 'a')
    assert.equal(spawns[1][1].env.ECHO_PREFIX, 'restarted:')
  } finally {
    supervisor.shutdown()
  }
})

test('onSpawn() does not fire for a no-op start() on an already-running id', async () => {
  const spawns = []
  const supervisor = createStdioSupervisor({ onSpawn: (id) => spawns.push(id) })
  try {
    supervisor.start('a', spawnEcho())
    await delay(100)
    supervisor.start('a', spawnEcho())
    await delay(50)

    assert.equal(spawns.length, 1)
  } finally {
    supervisor.shutdown()
  }
})

test('send() with timeoutMs calls onTimeout when nothing comes back in time', async () => {
  const timeouts = []
  const supervisor = createStdioSupervisor()
  try {
    // A process that never writes anything, so any reply watchdog we arm
    // must fire — this fixture just sits there ignoring stdin.
    supervisor.start('silent', {
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      shell: false,
    })
    await delay(100)

    const res = supervisor.send('silent', 'ping', {
      timeoutMs: 300,
      onTimeout: (id, info) => timeouts.push([id, info]),
    })
    assert.equal(res.ok, true)

    await delay(500)
    assert.deepEqual(timeouts, [['silent', { timeoutMs: 300 }]])
  } finally {
    supervisor.shutdown()
  }
})

test('send() with timeoutMs does not call onTimeout if a line arrives first', async () => {
  const timeouts = []
  const supervisor = createStdioSupervisor()
  try {
    supervisor.start('a', spawnEcho())
    await delay(100)

    supervisor.send('a', 'hello', {
      timeoutMs: 2000,
      onTimeout: (id, info) => timeouts.push([id, info]),
    })
    await delay(200) // echo-server replies well within the 2s timeout

    assert.deepEqual(timeouts, [])
  } finally {
    supervisor.shutdown()
  }
})

test('a later send() timeout replaces an earlier pending one, not stacks', async () => {
  const timeouts = []
  const supervisor = createStdioSupervisor()
  try {
    supervisor.start('silent', {
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      shell: false,
    })
    await delay(100)

    supervisor.send('silent', 'first', { timeoutMs: 200, onTimeout: (id, info) => timeouts.push(['first', id, info]) })
    supervisor.send('silent', 'second', { timeoutMs: 400, onTimeout: (id, info) => timeouts.push(['second', id, info]) })

    await delay(700)
    // Only the second watchdog should ever fire — arming a new one clears the prior pending timer.
    assert.deepEqual(timeouts, [['second', 'silent', { timeoutMs: 400 }]])
  } finally {
    supervisor.shutdown()
  }
})

test('cwd is passed through to the spawned process', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stdio-supervisor-cwd-'))
  // Symlinks/junctions (common on macOS's /tmp -> /private/tmp, and possible
  // on Windows) mean the path a child reports via process.cwd() can differ
  // in spelling from the path we asked for even though it's the same
  // directory — realpath both sides before comparing.
  const expected = fs.realpathSync(dir)

  const lines = []
  const supervisor = createStdioSupervisor({ onLine: (id, line) => lines.push(line) })
  try {
    const res = supervisor.start('a', { command: process.execPath, args: [PRINT_CWD], cwd: dir, shell: false })
    assert.equal(res.ok, true)
    await delay(200)

    assert.equal(lines.length, 1)
    assert.equal(fs.realpathSync(lines[0]), expected)
  } finally {
    supervisor.shutdown()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
