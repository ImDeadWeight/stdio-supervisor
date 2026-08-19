import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createStdioSupervisor } from '../src/index.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ECHO_SERVER = path.join(__dirname, '..', 'test-fixtures', 'echo-server.mjs')
const ORPHAN_WRITER = path.join(__dirname, '..', 'test-fixtures', 'orphan-writer.mjs')
const LONG_MULTIBYTE = path.join(__dirname, '..', 'test-fixtures', 'long-multibyte-line.mjs')

function spawnEcho(extraEnv = {}) {
  return {
    command: process.execPath,
    args: [ECHO_SERVER],
    env: { ...extraEnv },
    shell: false,
  }
}

// See the note on the same helper in basic.test.mjs: spawn/crash timings are
// not budgetable on a loaded CI runner, so poll for conditions that should
// become true instead of sleeping a fixed guess.
async function waitFor(cond, message, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await delay(10)
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for: ${message}`)
}

test('onLine carries a generation that increments across restarts', async () => {
  const seen = []
  const supervisor = createStdioSupervisor({ onLine: (id, line, meta) => seen.push(meta.generation) })
  try {
    supervisor.start('a', spawnEcho())
    await delay(150)
    supervisor.send('a', 'one')
    await delay(200)

    supervisor.stop('a')
    await delay(400)
    supervisor.start('a', spawnEcho())
    await delay(150)
    supervisor.send('a', 'two')
    await delay(200)

    assert.deepEqual(seen, [1, 2])
  } finally {
    supervisor.shutdown()
  }
})

// Characterization test, not a regression test: it passes with the stale-line
// guard removed. It pins the platform behavior the guard is insurance against
// — a grandchild that outlives its parent and still holds the stdout pipe does
// NOT go on delivering lines into the next generation, because Node closes the
// child's stdout at exit. If a Node upgrade ever changes that, this fails and
// the guard in src/index.mjs starts earning its keep.
test('a leaked pipe-holder stops being read once its parent exits', async () => {
  const seen = []
  const supervisor = createStdioSupervisor({
    onLine: (id, line, meta) => seen.push({ line, generation: meta.generation }),
    // Restart clean, so anything prefixed "orphan-" after the restart is
    // unambiguously from the leaked writer rather than the new generation.
    resolveConfig: () => spawnEcho({ ECHO_CHATTER_MS: '40', ECHO_PREFIX: 'gen2-' }),
  })
  try {
    supervisor.start('a', {
      command: process.execPath,
      args: [ORPHAN_WRITER],
      env: { ORPHAN_PREFIX: 'orphan-', ORPHAN_PARENT_EXIT_MS: '150' },
      shell: false,
    })

    // Wrapper exits ~150ms, restart lands ~1s later; then watch the window
    // where the leaked writer and the new generation are both producing.
    await waitFor(() => supervisor.isRunning('a') && supervisor.status('a').restarts === 1, 'restarted')
    const mark = seen.length
    await delay(800)

    const after = seen.slice(mark)
    assert.ok(after.some(r => r.line.startsWith('gen2-')), 'new generation produced output')
    assert.equal(
      after.filter(r => r.line.startsWith('orphan-')).length,
      0,
      'the leaked writer contributes nothing once the replacement is live',
    )
    // The leak itself is real — it just stops being *readable* at exit.
    assert.ok(
      seen.slice(0, mark).some(r => r.line.startsWith('orphan-')),
      'the grandchild really was writing down the inherited pipe beforehand',
    )
    assert.ok(after.every(r => r.generation === 2), 'everything delivered is tagged gen 2')
  } finally {
    supervisor.shutdown()
  }
})

test('status() reports restart count and last exit code', async () => {
  const supervisor = createStdioSupervisor({ resolveConfig: () => spawnEcho() })
  try {
    assert.equal(supervisor.status('never-started'), null)

    supervisor.start('a', spawnEcho({ ECHO_CRASH_AFTER_MS: '50', ECHO_EXIT_CODE: '3' }))
    await waitFor(() => supervisor.status('a').lastExit !== null, 'crash recorded')

    const down = supervisor.status('a')
    assert.equal(down.running, false)
    assert.equal(down.restarts, 0)
    assert.equal(down.lastExit.code, 3, 'exit code is visible to a health check')
    assert.equal(down.generation, 1)

    await waitFor(() => supervisor.status('a').restarts === 1, 'restart recorded')
    const up = supervisor.status('a')
    assert.equal(up.running, true)
    assert.equal(up.restarts, 1)
    assert.equal(up.consecutiveRestarts, 1)
    assert.equal(up.generation, 2)
    assert.ok(up.pid > 0)
    assert.ok(up.uptimeMs >= 0)
  } finally {
    supervisor.shutdown()
  }
})

test('shouldRestart receives counters, so a caller can cap retries', async () => {
  const calls = []
  const supervisor = createStdioSupervisor({
    resolveConfig: () => spawnEcho({ ECHO_CRASH_AFTER_MS: '50' }),
    shouldRestart: (id, info) => {
      calls.push(info)
      // The give-up policy the library deliberately does not hardcode.
      return info.consecutiveRestarts < 2
    },
  })
  try {
    supervisor.start('a', spawnEcho({ ECHO_CRASH_AFTER_MS: '50' }))
    // Crash, +1s backoff, crash, +2s backoff, crash -> refused.
    await waitFor(() => calls.length >= 3, 'three restart decisions', 12000)

    assert.ok(calls.length >= 3, `expected at least 3 restart decisions, got ${calls.length}`)
    assert.equal(calls[0].consecutiveRestarts, 0)
    assert.equal(calls[0].generation, 1)
    assert.ok(Number.isFinite(calls[0].uptimeMs))
    assert.equal(calls[0].lastExit.code, 1)

    const refused = calls.find(c => c.consecutiveRestarts >= 2)
    assert.ok(refused, 'reached the cap')
    await delay(1500)
    assert.equal(supervisor.isRunning('a'), false, 'stayed down once the cap was hit')
  } finally {
    supervisor.shutdown()
  }
})

test('stop() clears flap state so a manual start begins at the floor delay', async () => {
  const supervisor = createStdioSupervisor({ resolveConfig: () => spawnEcho() })
  try {
    supervisor.start('a', spawnEcho({ ECHO_CRASH_AFTER_MS: '50' }))
    await waitFor(() => supervisor.status('a').consecutiveRestarts === 1, 'one crash-restart')

    supervisor.stop('a')
    await delay(300)
    assert.equal(supervisor.status('a').consecutiveRestarts, 0, 'deliberate stop is not a crash')
  } finally {
    supervisor.shutdown()
  }
})

test('a long multibyte line survives chunk boundaries intact', async () => {
  // chunk.toString('utf8') corrupts every codepoint split across a ~64KB stdout
  // chunk boundary — the line still arrives, silently mangled, which for a JSON
  // payload surfaces as a parse error far from the cause.
  const expected = '日本語テキスト'.repeat(20000)
  const lines = []
  const supervisor = createStdioSupervisor({
    onLine: (id, line) => lines.push(line),
    shouldRestart: () => false,
  })
  try {
    supervisor.start('a', { command: process.execPath, args: [LONG_MULTIBYTE], shell: false })
    await delay(2000)

    assert.equal(lines.length, 1, 'exactly one framed line')
    assert.equal((lines[0].match(/\uFFFD/g) || []).length, 0, 'no replacement characters')
    assert.equal(lines[0].length, expected.length)
    assert.equal(lines[0], expected)
  } finally {
    supervisor.shutdown()
  }
})
