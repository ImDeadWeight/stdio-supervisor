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
  available
- An optional minimal-environment mode for spawning children that shouldn't
  inherit the parent's full environment (secrets, tokens, etc.)
- Config re-resolution on crash-restart, so a config edit made while a
  process is up takes effect on its next restart rather than requiring a
  manual stop/start
- An `onSpawn` hook that fires on the initial start *and* every successful
  crash-restart, so callers with a per-connection handshake (an MCP
  `initialize`, or anything else that needs redoing against a fresh process)
  have a clean signal for "this is a new instance"
- An optional per-`send()` reply watchdog (`timeoutMs`/`onTimeout`) for
  detecting a process that's gone quiet — no request/reply correlation, just
  "nothing came back before the deadline"

It does **not** know anything about your process's protocol — no RPC
framing, no message correlation. It gives you framed lines in and lines out;
what you put in those lines is up to you. This makes it a reasonable fit
underneath an MCP client, a JSON-RPC transport, a plain log-following
supervisor, or anything else that's "spawn N long-lived stdio processes and
keep them alive."

## Install

```sh
npm install stdio-supervisor
```

## Usage

```js
import { createStdioSupervisor } from 'stdio-supervisor'

const supervisor = createStdioSupervisor({
  logDir: './logs', // optional; omit to disable stderr file logging
  onSpawn: (id, cfg) => doHandshake(id), // fires on start() and every crash-restart
  onLine: (id, line) => console.log(`[${id}]`, line),
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
| `onSpawn` | `(id, cfg) => void` | Called once a process has actually been spawned — on the initial `start()` and on every successful crash-restart. `cfg` is the config that was actually used (the re-resolved one, on a restart). This is the hook for redoing a per-connection handshake against the new process instance. Not called for a no-op `start()` on an already-running id. |
| `onLine` | `(id, line) => void` | Called once per framed line of stdout. |
| `onExit` | `(id, info) => void` | Called on process exit or spawn error. `info` is `{ code, signal }` or `{ error }`. |
| `shouldRestart` | `(id) => boolean` | Consulted before a crash-restart. Defaults to always `true`. Never consulted for a deliberate `stop()`. |
| `resolveConfig` | `(id) => ProcessConfig \| undefined` | Re-resolves a process's config before a crash-restart. Falls back to the config captured at the last `start()` when it returns `undefined`. |

Returns a supervisor with:

- **`start(id, config)`** — spawn a process under `id`. No-op (`{ ok: true, alreadyRunning: true }`) if `id` is already running. Returns `{ ok: false, error }` if the spawn itself throws synchronously.
- **`stop(id)`** — deliberately stop a process. Cancels any pending crash-restart for `id` first. Returns `{ ok: true, wasRunning: boolean }`.
- **`send(id, line, opts?)`** — write one line to the process's stdin. Returns `{ ok: false, error }` if `id` isn't running or the write fails. `opts.timeoutMs`, if given, arms a watchdog that calls `opts.onTimeout(id, { timeoutMs })` if no line of output arrives before the deadline. There's no request/reply correlation — any output at all disarms it, and a later `send()` with its own `timeoutMs` replaces a still-pending watchdog rather than stacking.
- **`isRunning(id)`** — `boolean`.
- **`listRunning()`** — `string[]` of currently-running ids.
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
