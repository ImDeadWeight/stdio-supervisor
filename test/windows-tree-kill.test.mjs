// Verifies the actual claim behind killChild()'s Windows branch: that
// stop()/shutdown() kill the *real* grandchild process when the child was
// spawned through cmd.exe (shell:true — the default on win32, required for
// npx/npm .cmd shims), not just the cmd.exe wrapper.
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
const HEARTBEAT = path.join(__dirname, 'fixtures', 'heartbeat.mjs')

test(
  'stop() kills the real grandchild process, not just the cmd.exe shell wrapper',
  { skip: process.platform !== 'win32' ? 'Windows-only: exercises the taskkill /T tree-kill path' : false },
  async () => {
    const outFile = path.join(os.tmpdir(), `stdio-supervisor-heartbeat-${process.pid}-${Date.now()}.txt`)
    fs.writeFileSync(outFile, '')

    const supervisor = createStdioSupervisor()
    try {
      // No shell:false here — this is the default win32 path (spawn via
      // cmd.exe), same as any npx/npm-shimmed MCP server.
      const res = supervisor.start('hb', { command: process.execPath, args: [HEARTBEAT, outFile] })
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
