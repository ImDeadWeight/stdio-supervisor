// Verifies the actual claim behind killChild()'s Windows branch: that
// stop()/shutdown() kill the *real* grandchild process when the child is a
// .cmd shim (exactly the npx/npm case) that cross-spawn routes through
// cmd.exe, not just the cmd.exe wrapper.
//
// child.kill() alone only signals the direct child (cmd.exe); the real
// worker underneath survives as an orphan. This test proves taskkill /T
// actually reaps the whole tree by watching a heartbeat file the grandchild
// writes to every 100ms — if the grandchild is still alive, the file keeps
// growing after stop() returns.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { createStdioSupervisor } from '../src/index.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// A .cmd file (not .exe) — cross-spawn only routes through cmd.exe for
// extensions it doesn't recognize as directly executable, which is exactly
// what makes npx.cmd/npm.cmd need this path in the first place.
const HEARTBEAT_CMD = path.join(__dirname, '..', 'test-fixtures', 'heartbeat.cmd')

test(
  'stop() kills the real grandchild process, not just the cmd.exe shell wrapper',
  { skip: process.platform !== 'win32' ? 'Windows-only: exercises the taskkill /T tree-kill path' : false },
  async () => {
    const outFile = path.join(os.tmpdir(), `stdio-supervisor-heartbeat-${process.pid}-${Date.now()}.txt`)
    fs.writeFileSync(outFile, '')

    const supervisor = createStdioSupervisor()
    try {
      const res = supervisor.start('hb', { command: HEARTBEAT_CMD, args: [outFile] })
      assert.equal(res.ok, true)

      // Wait for the grandchild to actually be alive and writing.
      await delay(500)
      const before = fs.readFileSync(outFile, 'utf8').trim().split('\n').filter(Boolean).length
      assert.ok(before >= 2, `expected the heartbeat file to be growing before stop(), got ${before} lines`)

      supervisor.stop('hb')

      // Give taskkill time to run, then confirm the file has stopped growing
      // across a further window — proof the grandchild, not just cmd.exe, died.
      await delay(700)
      const afterStop = fs.readFileSync(outFile, 'utf8').trim().split('\n').filter(Boolean).length
      await delay(700)
      const afterSettle = fs.readFileSync(outFile, 'utf8').trim().split('\n').filter(Boolean).length

      assert.equal(
        afterSettle,
        afterStop,
        `heartbeat file kept growing after stop() (grandchild still alive): ${afterStop} -> ${afterSettle} lines`
      )
    } finally {
      supervisor.shutdown()
      fs.rmSync(outFile, { force: true })
    }
  }
)
