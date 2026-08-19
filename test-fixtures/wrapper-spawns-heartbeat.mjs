// Test fixture that mimics an npx-style wrapper: it forks its own child
// (the heartbeat fixture) and then just sits there — no signal forwarding,
// no cleanup on exit, default Node behavior only. If the supervisor only
// signals this wrapper's PID, this process dies and the heartbeat
// grandchild is orphaned (reparented, kept running). If the supervisor
// signals the whole process group, both die.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const heartbeat = path.join(__dirname, 'heartbeat.mjs')
const outFile = process.argv[2]

spawn(process.execPath, [heartbeat, outFile], { stdio: 'ignore' })

setInterval(() => {}, 1000)
