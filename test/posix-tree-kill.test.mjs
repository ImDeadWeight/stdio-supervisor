// Verifies the POSIX counterpart of windows-tree-kill.test.mjs: that
// stop()/shutdown() kill a grandchild the target process forked on its own
// (the npx-wrapper-orphans-the-real-server pattern), not just the direct
// child's PID.
//
// child.kill('SIGTERM') on just the direct PID would leave the grandchild
// running, reparented to init — the exact leak reported against Codex CLI's
// npx-spawned MCP servers. This test proves process-group signaling (the
// detached:true + kill(-pid) path in killChild) actually reaps both.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { createStdioSupervisor } from '../src/index.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WRAPPER = path.join(__dirname, '..', 'test-fixtures', 'wrapper-spawns-heartbeat.mjs')

test(
  'stop() kills a grandchild the process forked on its own, not just the direct child',
  { skip: process.platform === 'win32' ? 'POSIX-only: exercises the process-group kill(-pid) path' : false },
  async () => {
    const outFile = path.join(os.tmpdir(), `stdio-supervisor-posix-heartbeat-${process.pid}-${Date.now()}.txt`)
    fs.writeFileSync(outFile, '')

    const supervisor = createStdioSupervisor()
    try {
      const res = supervisor.start('wrapped', { command: process.execPath, args: [WRAPPER, outFile] })
      assert.equal(res.ok, true)

      await delay(500)
      const before = fs.readFileSync(outFile, 'utf8').trim().split('\n').filter(Boolean).length
      assert.ok(before >= 2, `expected the heartbeat file to be growing before stop(), got ${before} lines`)

      supervisor.stop('wrapped')

      await delay(700)
      const afterStop = fs.readFileSync(outFile, 'utf8').trim().split('\n').filter(Boolean).length
      await delay(700)
      const afterSettle = fs.readFileSync(outFile, 'utf8').trim().split('\n').filter(Boolean).length

      assert.equal(
        afterSettle,
        afterStop,
        `heartbeat file kept growing after stop() (grandchild orphaned, still alive): ${afterStop} -> ${afterSettle} lines`
      )
    } finally {
      supervisor.shutdown()
      fs.rmSync(outFile, { force: true })
    }
  }
)
