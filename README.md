# stdio-supervisor

A small supervisor for long-lived child processes that communicate over
stdio. It handles the fiddly, easy-to-get-wrong parts of spawning and
babysitting a process from Node:

- Restart on crash with capped exponential backoff (and a stability window
  that resets the backoff once a process has stayed up a while)
- Cross-platform termination that kills the whole process tree, not just the
  direct child — via `taskkill /T` on Windows, and process-group signaling
  (`detached` + `kill(-pid)`) on POSIX. A plain `child.kill()` only signals
  the direct PID; a wrapper like `npx` that forks the real server as its own
  child would leave that real server orphaned on either platform
- Windows `.cmd` shim handling for `npx`/`npm`-style commands via
  [`cross-spawn`](https://www.npmjs.com/package/cross-spawn) — the one
  runtime dependency this library takes, deliberately: getting cmd.exe
  quoting right (including the parts that stay dangerous even inside quotes,
  like `%VAR%` expansion) is a problem cross-spawn has had a decade of bug
  reports to shake out, and re-deriving that by hand is exactly the kind of
  thing worth not doing twice
- Line-framed stdout — partial chunks are buffered until a full line is
  available, and multibyte characters split across chunk boundaries are
  reassembled rather than mangled into `U+FFFD`
- Raw (unframed) stderr via `onStderr`, alongside the optional file logging
- An optional `maxLineBytes` cap, so a child that never emits a newline can't
  grow host memory without bound
- An optional minimal-environment mode for spawning children that shouldn't
  inherit the parent's full environment (secrets, tokens, etc.)
- Config re-resolution on crash-restart, so a config edit made while a
  process is up takes effect on its next restart rather than requiring a
  manual stop/start
- An `onSpawn` hook that fires on the initial start *and* every successful
  crash-restart, so callers with a per-connection handshake (an MCP
  `initialize`, or anything else that needs redoing against a fresh process)
  have a clean signal for "this is a new instance"
- A monotonic **generation** number on every `onSpawn`/`onLine`/`onExit`, so a
  caller can fence in-flight request ids across a restart rather than letting a
  reply from the old process resolve a call made against the new one
- `status(id)` — restart counts, last exit code, uptime, pid — because a
  supervisor that is quietly flapping otherwise looks healthy from the outside
- An optional per-`send()` reply watchdog (`timeoutMs`/`onTimeout`) for
  detecting a process that's gone quiet — no request/reply correlation, just
  "nothing came back before the deadline"

It does **not** know anything about your process's protocol — no RPC
framing, no message correlation. It gives you framed lines in and lines out;
what you put in those lines is up to you. This makes it a reasonable fit
underneath an MCP client, a JSON-RPC or LSP transport, a plain log-following
supervisor, or anything else that's "spawn N long-lived stdio processes and
keep them alive."

What it *does* assume, and what that rules out:

- **stdout is newline-delimited UTF-8 text.** Framing is mandatory and there is
  no binary mode, so this is the wrong tool for piping images, audio, or any
  other non-line-oriented stream.
- **Blank stdout lines are skipped.** They're noise in a line protocol; if
  they're content for you, read stderr through `onStderr` (which preserves
  them) or file an issue — a passthrough flag is easy, it just isn't the
  default.
- **stdin has no backpressure handling.** `send()` writes and returns without
  waiting for `drain`, which is fine for small frames and wrong for bulk data.

## Install

```sh
npm install stdio-supervisor
```

## Usage

```js
import { createStdioSupervisor } from 'stdio-supervisor'

const supervisor = createStdioSupervisor({
  logDir: './logs', // optional; omit to disable stderr file logging
  maxLineBytes: 32 * 1024 * 1024, // optional; unlimited by default
  onSpawn: (id, cfg, { generation }) => doHandshake(id, generation),
  onLine: (id, line, { generation }) => console.log(`[${id}/${generation}]`, line),
  onStderr: (id, text) => process.stderr.write(text), // raw, not line-framed
  onExit: (id, info) => console.log(`[${id}] exited`, info),
  shouldRestart: (id) => true, // consulted before every crash-restart
  resolveConfig: (id) => configs.get(id), // re-resolved before every crash-restart
})

supervisor.start('github', {
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_PERSONAL_ACCESS_TOKEN: token },
})

supervisor.send('github', JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }), {
  timeoutMs: 5000,
  onTimeout: (id) => console.warn(`[${id}] no output within 5s of that write`),
})

supervisor.isRunning('github')   // -> true
supervisor.listRunning()         // -> ['github']

supervisor.stop('github')        // deliberate stop: no crash-restart follows
await supervisor.shutdown()      // stop everything, cancel all pending restarts
```

## API

### `createStdioSupervisor(options?)`

| option | type | description |
|---|---|---|
| `logDir` | `string` | Directory for per-process stderr log files. Omit to disable file logging. |
| `onSpawn` | `(id, cfg, meta) => void` | Called once a process has actually been spawned — on the initial `start()` and on every successful crash-restart. `cfg` is the config that was actually used (the re-resolved one, on a restart). `meta` is `{ generation }`. This is the hook for redoing a per-connection handshake against the new process instance. Not called for a no-op `start()` on an already-running id. |
| `onLine` | `(id, line, meta) => void` | Called once per framed line of stdout. Blank lines are skipped. `meta` is `{ generation }`. |
| `onStderr` | `(id, text, meta) => void` | Raw decoded stderr, **not** line-framed — blank lines and newline-less progress output arrive exactly as the child wrote them. Additive: file logging via `logDir` still happens either way. |
| `maxLineBytes` | `number` | Cap on a single *unterminated* stdout line. Default `Infinity`. An over-long line is **dropped, never truncated**, and framing resumes at the next newline. Applies per line, not to cumulative output. |
| `onOverflow` | `(id, info) => void` | An over-long line was dropped. `info` is `{ bytes, maxLineBytes, generation }`. |
| `onExit` | `(id, info) => void` | Called on process exit or spawn error. `info` is `{ code, signal, generation }` or `{ error, generation }`. |
| `shouldRestart` | `(id, info) => boolean` | Consulted before a crash-restart. Defaults to always `true`. Never consulted for a deliberate `stop()`. `info` is `{ restarts, consecutiveRestarts, lastExit, uptimeMs, generation }` — see [Giving up](#giving-up). |
| `resolveConfig` | `(id) => ProcessConfig \| undefined` | Re-resolves a process's config before a crash-restart. Falls back to the config captured at the last `start()` when it returns `undefined`. |

Returns a supervisor with:

- **`start(id, config)`** — spawn a process under `id`. No-op (`{ ok: true, alreadyRunning: true }`) if `id` is already running. Returns `{ ok: false, error }` if the spawn itself throws synchronously.
- **`stop(id)`** — deliberately stop a process. Cancels any pending crash-restart for `id` first. Returns `{ ok: true, wasRunning: boolean }`.
- **`send(id, line, opts?)`** — write one line to the process's stdin. Returns `{ ok: false, error }` if `id` isn't running or the write fails. `opts.timeoutMs`, if given, arms a watchdog that calls `opts.onTimeout(id, { timeoutMs })` if no line of output arrives before the deadline. There's no request/reply correlation — any output at all disarms it, and a later `send()` with its own `timeoutMs` replaces a still-pending watchdog rather than stacking.
- **`isRunning(id)`** — `boolean`.
- **`listRunning()`** — `string[]` of currently-running ids.
- **`status(id)`** — `{ running, pid, generation, restarts, consecutiveRestarts, lastExit, uptimeMs }`, or `null` for an id that has never been started. Survives exit, so it distinguishes "up and healthy" from "up, but on its 40th restart".
- **`shutdown()`** — stop every running process and cancel every pending restart. Call this once, on your own process's exit, so nothing is left running after you quit.

### `ProcessConfig`

| field | type | description |
|---|---|---|
| `command` | `string` | required |
| `args` | `string[]` | default `[]` |
| `env` | `Record<string, string>` | merged over the base environment |
| `cwd` | `string` | working directory for the child. Defaults to this process's cwd. |
| `inheritEnv` | `boolean` | default `true`. Set `false` to spawn with a minimal baseline environment (PATH and the handful of variables a shell needs to function) plus `env`, instead of the parent's full environment. |
| `shell` | `boolean` | Passed straight through to the underlying spawn call. Leave unset (recommended) — cross-spawn decides per-command whether cmd.exe is actually needed on Windows (e.g. for `.cmd` shims) and owns the escaping when it is. Set `true` only to force full shell interpretation; this bypasses cross-spawn's escaping and is rarely what you want, especially for anything but fully-trusted input. |

## Generations

Every spawn of an id gets a monotonic generation number, reported on `onSpawn`,
`onLine`, and `onExit`. It exists for the failure a supervisor otherwise hides:
the old process dies, a new one comes up, the handshake succeeds — and the
client is still holding request ids issued to the process that died.

```js
let live = 0
const pending = new Map()

onSpawn: (id, cfg, { generation }) => {
  for (const [key, p] of pending) {
    if (key.generation !== generation) { p.reject(new Error('process restarted')); pending.delete(key) }
  }
  live = generation
  handshake(id)
},
onLine: (id, line, { generation }) => {
  if (generation !== live) return   // never resolve a call from a stale generation
  dispatch(JSON.parse(line))
},
```

The library does not correlate requests to replies itself — it has no protocol
opinion — but the generation is the piece a caller cannot reconstruct on its own.

## Giving up

There is deliberately **no built-in retry cap**. Backoff doubles to a 30s ceiling
and keeps going, which is right for a transient failure and wrong for a bad
config that will never fix itself. `shouldRestart` is where that policy lives,
and it gets the counters needed to make the call:

```js
shouldRestart: (id, { consecutiveRestarts, lastExit, uptimeMs }) => {
  if (consecutiveRestarts >= 5) return false        // give up
  if (lastExit.code === 78) return false            // config error; retrying won't help
  return true
}
```

`consecutiveRestarts` resets once a process has stayed up for the stability
window, and on any deliberate `stop()`. `restarts` is the lifetime total and
never resets.

## What this is not

This is not PM2, `forever`, or `systemd` — it doesn't daemonize, doesn't have
a CLI, doesn't do log rotation or clustering, and isn't meant to run as its
own top-level service. It's a library you embed in an app that needs to
supervise a handful of long-lived stdio children (an MCP gateway, an IDE
extension, an agent runtime, a plugin host) and wants the restart/backoff/
cross-platform-kill logic handled correctly without pulling in a full process
manager.

## License

MIT
