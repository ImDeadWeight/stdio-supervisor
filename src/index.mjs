'use strict'

// =============================================================================
// stdio-supervisor
// =============================================================================
// Spawns long-lived child processes that talk newline-delimited text over
// stdio, frames stdout into whole lines, restarts a crashed process with
// capped exponential backoff, and force-kills it — including any child a
// wrapper process (npx, a shell) forked on its own, on Windows via
// `taskkill /T` and on POSIX via signaling the whole process group — on
// stop/shutdown.
//
// No protocol opinion — callers own how lines/exits are delivered (an RPC
// client, a log relay, a test harness, whatever) via the onLine/onExit
// callbacks, and own whether a dead process should come back via
// shouldRestart.
// =============================================================================

import { execFile } from 'node:child_process'
import crossSpawn from 'cross-spawn'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Restart-on-crash backoff: start at 1s, double per consecutive crash, cap at
// 30s. A process that stays up for RESTART_STABLE_MS resets its counter.
const RESTART_INITIAL_MS = 1_000
const RESTART_MAX_MS = 30_000
const RESTART_STABLE_MS = 30_000
// How long a process gets to exit after a polite kill before it is force-killed.
const KILL_GRACE_MS = 3_000

// Windows quirk: `npx`/`npm` are .cmd shims, and a bare Node spawn() only
// runs real executables unless shell:true. We used to hand-build one quoted
// command line and shell:true it through cmd.exe ourselves. That's a corner
// most people (including an earlier version of this file) get subtly wrong:
// quoting an argument stops cmd.exe from splitting on it, but doesn't stop
// cmd.exe's *own* %VAR% expansion from firing even inside the quotes — a
// caret-escape pass over the metacharacters, not just quoting, is needed
// too. cross-spawn has absorbed years of bug reports on exactly this
// (it's what Node's own security advisory for CVE-2024-27980 points people
// at), so this delegates the whole "does this command need cmd.exe, and how
// do I escape it if so" decision to it instead of re-deriving it here.

/**
 * @typedef {object} ProcessConfig
 * @property {string} command
 * @property {string[]} [args]
 * @property {Record<string, string>} [env]
 * @property {string} [cwd] Working directory for the child. Defaults to this process's cwd.
 * @property {boolean} [inheritEnv] Set false to spawn with a minimal baseline
 *   environment plus `env`, instead of the parent's full environment. Useful
 *   for untrusted or third-party children that must not receive the parent
 *   process's own environment (secrets, tokens, etc). Default: true (inherit).
 * @property {boolean} [shell] Passed through to the underlying spawn call. Leave unset
 *   (recommended) to let cross-spawn decide per-command whether cmd.exe is needed on
 *   Windows (e.g. for .cmd shims like npx/npm) — it also owns the escaping in that case.
 *   Set true to force full shell interpretation instead; this bypasses cross-spawn's
 *   escaping entirely and is rarely what you want for untrusted input.
 */

/**
 * @param {object} opts
 * @param {string} [opts.logDir] Directory for per-process stderr logs. Omit to disable file logging.
 * @param {(id: string, cfg: ProcessConfig) => void} [opts.onSpawn] Called once a process has actually been
 *   spawned — on the initial start() and on every successful crash-restart. This is the signal that a
 *   *new* process instance is live, for callers layering a per-connection protocol (an init handshake,
 *   session setup) on top: whatever you do once after start(), do again here.
 * @param {(id: string, line: string) => void} [opts.onLine] Called with one framed line of stdout at a time.
 * @param {(id: string, info: {code?: number|null, signal?: string|null, error?: string}) => void} [opts.onExit]
 * @param {(id: string) => boolean} [opts.shouldRestart] Consulted before a crash-restart; defaults to always true.
 * @param {(id: string) => ProcessConfig | undefined} [opts.resolveConfig] Re-resolves a process's config
 *   before a crash-restart, so config edits made while a process was up take effect on its next
 *   restart. Falls back to the config captured at spawn when absent/undefined.
 */
// The minimum a child needs to start at all. Trimming below this does not make
// a child safer, it makes it fail to spawn: on win32 with shell:true the child
// is cmd.exe, which needs COMSPEC/SystemRoot/PATH before it can run anything.
// Everything outside this list is withheld when inheritEnv is false.
const BASELINE_ENV_KEYS = process.platform === 'win32'
  ? ['SystemRoot', 'SystemDrive', 'windir', 'COMSPEC', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']
  : ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL']

function buildChildEnv(cfg) {
  if (cfg.inheritEnv !== false) return { ...process.env, ...(cfg.env ?? {}) }
  const base = {}
  for (const key of BASELINE_ENV_KEYS) {
    if (process.env[key] !== undefined) base[key] = process.env[key]
  }
  return { ...base, ...(cfg.env ?? {}) }
}

export function createStdioSupervisor({ logDir, onSpawn, onLine, onExit, shouldRestart, resolveConfig } = {}) {
  /**
   * @typedef {object} ManagedProcess
   * @property {import('node:child_process').ChildProcess} child
   * @property {ProcessConfig} cfg
   * @property {string} stdoutBuf   partial-line buffer for stdout framing
   * @property {number} restartDelay current crash-restart backoff
   * @property {ReturnType<typeof setTimeout> | null} stableTimer
   * @property {boolean} stopping   true while a deliberate stop is in progress
   * @property {ReturnType<typeof setTimeout> | null} replyTimer pending send()-timeout watchdog, if any
   */
  /** @type {Map<string, ManagedProcess>} */
  const running = new Map()
  /** Pending crash-restart timers by id — cancelled by stop()/shutdown() so a
   * deliberate stop can't be undone by a restart queued before it. */
  const restartTimers = new Map()
  let quitting = false

  function logStream(id) {
    if (!logDir) return null
    try {
      fs.mkdirSync(logDir, { recursive: true })
      return fs.createWriteStream(path.join(logDir, `${id.replace(/[^a-zA-Z0-9._-]/g, '_')}.log`), { flags: 'a' })
    } catch {
      return null
    }
  }

  /** @param {string} id @param {ProcessConfig} cfg */
  function start(id, cfg) {
    if (running.has(id)) return { ok: true, alreadyRunning: true }

    // A deliberate start supersedes any crash-restart queued for this id.
    clearTimeout(restartTimers.get(id))
    restartTimers.delete(id)

    const args = cfg.args ?? []
    const childEnv = buildChildEnv(cfg)

    let child
    try {
      child = crossSpawn(cfg.command, args, {
        env: childEnv,
        cwd: cfg.cwd,
        windowsHide: true,
        shell: cfg.shell,
        // POSIX only: make this child the leader of its own process group
        // (child.pid becomes the pgid too), so killChild() can signal the
        // whole group instead of just this one process. A wrapper like npx
        // forks the real server as its own child — signaling only the
        // wrapper's PID kills the wrapper and orphans the server underneath
        // it. Left off on win32: process groups work differently there, and
        // taskkill /T is used instead (see killChild).
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      return { ok: false, error: `Failed to spawn "${cfg.command}": ${err.message}` }
    }

    const prev = running.get(id)
    const entry = {
      child,
      cfg,
      stdoutBuf: '',
      restartDelay: prev?.restartDelay ?? RESTART_INITIAL_MS,
      stableTimer: null,
      stopping: false,
      replyTimer: null,
    }
    running.set(id, entry)

    // A process that survives the stability window earns a backoff reset.
    entry.stableTimer = setTimeout(() => { entry.restartDelay = RESTART_INITIAL_MS }, RESTART_STABLE_MS)

    const errLog = logStream(id)
    errLog?.write(`\n--- ${new Date().toISOString()} started: ${cfg.command} ${args.join(' ')} ---\n`)

    // Frame stdout by newline. stdout may deliver partial lines or several
    // messages per chunk — buffer the tail so the caller only ever receives
    // whole lines.
    child.stdout.on('data', (chunk) => {
      entry.stdoutBuf += chunk.toString('utf8')
      let nl
      while ((nl = entry.stdoutBuf.indexOf('\n')) !== -1) {
        const line = entry.stdoutBuf.slice(0, nl).replace(/\r$/, '')
        entry.stdoutBuf = entry.stdoutBuf.slice(nl + 1)
        if (line.trim()) {
          // Any output is treated as "the process is responsive" — there's no
          // protocol awareness here to correlate a specific reply to a
          // specific send(), so a pending reply watchdog clears on the next
          // line, whichever one it is.
          if (entry.replyTimer) {
            clearTimeout(entry.replyTimer)
            entry.replyTimer = null
          }
          onLine?.(id, line)
        }
      }
    })

    // stderr is process logging, never protocol/output traffic — file only.
    child.stderr.on('data', (chunk) => errLog?.write(chunk))

    // A write can race the child dying (send() checked the map, then the
    // process exited before the write landed). Without a listener that EPIPE
    // becomes an uncaught 'error' event and takes down the host process.
    child.stdin.on('error', (err) => errLog?.write(`stdin error: ${err.message}\n`))

    // 'error' (spawn failure) and 'exit' can both fire for the same child;
    // settle exactly once so the entry can't leak in `running` (a leaked entry
    // makes send() write into a dead stdin forever after).
    let settled = false

    child.on('error', (err) => {
      if (settled) return
      settled = true
      errLog?.write(`spawn error: ${err.message}\n`)
      errLog?.end()
      clearTimeout(entry.stableTimer)
      clearTimeout(entry.replyTimer)
      if (running.get(id) === entry) running.delete(id)
      // No crash-restart here: a spawn error means the command itself is bad
      // (missing binary, bad path) — retrying would loop against the same
      // failure. The caller decides via its onExit handler.
      onExit?.(id, { error: err.message })
    })

    child.on('exit', (code, signal) => {
      if (settled) return
      settled = true
      errLog?.write(`--- exited code=${code} signal=${signal} ---\n`)
      errLog?.end()
      clearTimeout(entry.stableTimer)
      clearTimeout(entry.replyTimer)
      const wasStopping = entry.stopping
      if (running.get(id) === entry) running.delete(id)
      onExit?.(id, { code, signal })

      // Crash restart with capped backoff — but never for deliberate stops or
      // while quitting, and only if the caller still wants this id running.
      const wantsRestart = shouldRestart ? shouldRestart(id) : true
      if (!wasStopping && !quitting && wantsRestart) {
        const delay = entry.restartDelay
        const nextDelay = Math.min(entry.restartDelay * 2, RESTART_MAX_MS)
        const timer = setTimeout(() => {
          restartTimers.delete(id)
          if (!quitting && !running.has(id)) {
            // Re-resolve config so edits made while the process was up take
            // effect on the restart, not just on a manual stop/start.
            const freshCfg = resolveConfig?.(id) ?? cfg
            const res = start(id, freshCfg)
            if (res.ok) {
              const restarted = running.get(id)
              if (restarted) restarted.restartDelay = nextDelay
            }
          }
        }, delay)
        timer.unref?.()
        restartTimers.set(id, timer)
      }
    })

    // Fired for both the initial start() and every successful crash-restart —
    // callers with a per-connection handshake to redo (MCP's `initialize`,
    // or any other protocol setup) key off this rather than guessing from
    // onLine/onExit timing.
    onSpawn?.(id, cfg)

    return { ok: true }
  }

  function killChild(child) {
    if (child.exitCode !== null || child.signalCode !== null) return
    if (process.platform === 'win32') {
      // With shell:true the real process is a grandchild of cmd.exe; child.kill()
      // would orphan it. taskkill /T takes down the whole tree.
      try { execFile('taskkill', ['/pid', String(child.pid), '/T', '/F']) } catch { /* already gone */ }
    } else {
      // Spawned with detached:true, so child.pid doubles as its process
      // group id — signaling -pid hits the whole group (the direct child
      // plus anything it forked), not just the direct child. A plain
      // child.kill() here would repeat the npx-wrapper orphan bug on POSIX.
      try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
      const force = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
      }, KILL_GRACE_MS)
      force.unref?.()
    }
  }

  /** @param {string} id */
  function stop(id) {
    // Cancel any queued crash-restart first — otherwise a stop issued between
    // a crash and its restart timer would be silently undone seconds later.
    clearTimeout(restartTimers.get(id))
    restartTimers.delete(id)
    const entry = running.get(id)
    if (!entry) return { ok: true, wasRunning: false }
    entry.stopping = true
    clearTimeout(entry.stableTimer)
    clearTimeout(entry.replyTimer)
    try { entry.child.stdin.end() } catch { /* stream may be gone */ }
    killChild(entry.child)
    return { ok: true, wasRunning: true }
  }

  /**
   * @param {string} id @param {string} line One line of input, newline-free.
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs] If given, arms a watchdog: if no line of output arrives from this
   *   process within timeoutMs, onTimeout is called. There's no request/reply correlation — any output
   *   at all disarms it, so this is a "the process has gone quiet" signal, not a per-message reply
   *   guarantee. A later send() with its own timeoutMs replaces the previously armed watchdog.
   * @param {(id: string, info: {timeoutMs: number}) => void} [opts.onTimeout]
   */
  function send(id, line, { timeoutMs, onTimeout } = {}) {
    const entry = running.get(id)
    if (!entry) return { ok: false, error: `Process "${id}" is not running` }
    // One line per write by contract; strip embedded newlines so a malformed
    // payload can't smuggle extra frames into the child.
    try {
      entry.child.stdin.write(String(line).replace(/\r?\n/g, ' ') + '\n')
    } catch (err) {
      return { ok: false, error: `Process "${id}" stdin write failed: ${err.message}` }
    }
    if (Number.isFinite(timeoutMs)) {
      clearTimeout(entry.replyTimer)
      entry.replyTimer = setTimeout(() => {
        entry.replyTimer = null
        onTimeout?.(id, { timeoutMs })
      }, timeoutMs)
      entry.replyTimer.unref?.()
    }
    return { ok: true }
  }

  /** @param {string} id */
  function isRunning(id) {
    return running.has(id)
  }

  function listRunning() {
    return Array.from(running.keys())
  }

  /** Kill every child; call on quit so no orphans survive in Task Manager. */
  function shutdown() {
    quitting = true
    for (const timer of restartTimers.values()) clearTimeout(timer)
    restartTimers.clear()
    for (const id of Array.from(running.keys())) stop(id)
  }

  return { start, stop, send, isRunning, listRunning, shutdown }
}
