// Test fixture: a wrapper that leaks a grandchild holding the stdout pipe.
//
// The wrapper spawns a copy of itself with stdout *inherited* — so the
// grandchild writes down the same pipe the supervisor is reading — and then
// exits on its own. The supervisor sees the wrapper exit and schedules a
// crash-restart, but the pipe stays open because the grandchild still holds
// it, and that grandchild keeps emitting well-formed lines into the next
// generation's lifetime. This is the shape that lets a stale reply be framed
// as a response to a process that never sent it.
//
//   ORPHAN_PREFIX=<s>            prefix for emitted lines (default "orphan-")
//   ORPHAN_PARENT_EXIT_MS=<n>    when the wrapper exits (default 150)
//   ORPHAN_CHILD_LIFETIME_MS=<n> how long the grandchild keeps writing (default 4000)
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const prefix = process.env.ORPHAN_PREFIX ?? 'orphan-'

if (process.env.ORPHAN_ROLE === 'child') {
  const interval = setInterval(() => process.stdout.write(`${prefix}tick\n`), 40)
  setTimeout(() => { clearInterval(interval); process.exit(0) }, Number(process.env.ORPHAN_CHILD_LIFETIME_MS ?? 4000))
} else {
  spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, ORPHAN_ROLE: 'child' },
    stdio: ['ignore', 'inherit', 'ignore'],
  })
  setTimeout(() => process.exit(1), Number(process.env.ORPHAN_PARENT_EXIT_MS ?? 150))
}
