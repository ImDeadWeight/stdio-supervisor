'use strict'

// Supervises long-lived stdio children: line-framed stdout, crash-restart with
// capped backoff, whole-process-tree kill. No protocol opinion. See README.md.

import { execFile } from 'node:child_process'
import crossSpawn from 'cross-spawn'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

// Restart-on-crash backoff: start at 1s, double per consecutive crash, cap at
// 30s. A process that stays up for RESTART_STABLE_MS resets its counter.
const RESTART_INITIAL_MS = 1_000
const RESTART_MAX_MS = 30_000
// Must stay comfortably above RESTART_MAX_MS. If it isn't, a process that dies
// just after the window resets its backoff on every crash and flaps at the
// floor delay forever — the slow crash-loop the backoff exists to damp.
const RESTART_STABLE_MS = 120_000
// How long a process gets to exit after a polite kill before it is force-killed.
const KILL_GRACE_MS = 3_000

/**
 * @typedef {object} ProcessConfig
 * @property {string} command
 * @property {string[]} [args]
 * @property {Record<string, string>} [env]
 * @property {string} [cwd]
 * @property {boolean} [inheritEnv] Default true. False spawns with BASELINE_ENV_KEYS plus `env` only.
 * @property {boolean} [shell] Leave unset; cross-spawn decides (and escapes) per-command on Windows.
 *   Setting true bypasses that escaping entirely.
 */

/**
 * @typedef {object} RestartInfo
 * @property {number} restarts total crash-restarts for this id
 * @property {number} consecutiveRestarts since the last stable window; reset by stop()
 * @property {object|null} lastExit
 * @property {number} uptimeMs how long the generation that just died stayed up
 * @property {number} generation the generation that just died
 */

/**
 * @param {object} opts
 * @param {string} [opts.logDir]
 * @param {(id: string, cfg: ProcessConfig, meta: {generation: number}) => void} [opts.onSpawn]
 *   Fires on start() and every crash-restart.
 * @param {(id: string, line: string, meta: {generation: number}) => void} [opts.onLine]
 * @param {(id: string, text: string, meta: {generation: number}) => void} [opts.onStderr] Raw decoded
 *   stderr, NOT line-framed — blank lines and newline-less output reach you as the child wrote them.
 * @param {number} [opts.maxLineBytes] Cap on a single unterminated stdout line. Default Infinity,
 *   which means a child that never emits a newline grows host memory without bound. Set it for any
 *   child whose output you don't control.
 * @param {(id: string, info: {bytes: number, maxLineBytes: number, generation: number}) => void} [opts.onOverflow]
 *   An over-long line was dropped (never truncated). Framing resumes at the next newline.
 * @param {(id: string, info: {code?: number|null, signal?: string|null, error?: string, generation: number}) => void} [opts.onExit]
 * @param {(id: string, info: RestartInfo) => boolean} [opts.shouldRestart] Defaults to always true.
 *   This is the give-up hook: there is no built-in retry cap, so a caller that wants one returns
 *   false here off `consecutiveRestarts`.
 * @param {(id: string) => ProcessConfig | undefined} [opts.resolveConfig] Falls back to the config captured at spawn.
 */
// The minimum a child needs to start at all. Trimming below this does not make
// a child safer, it makes it fail to spawn: on win32 with shell:true the child
// is cmd.exe, which needs COMSPEC/SystemRoot/PATH before it can run anything.
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

export function createStdioSupervisor({
  logDir, onSpawn, onLine, onStderr, onExit, onOverflow, shouldRestart, resolveConfig,
  maxLineBytes = Infinity,
} = {}) {
  /**
   * @typedef {object} ManagedProcess
   * @property {import('node:child_process').ChildProcess} child
   * @property {ProcessConfig} cfg
   * @property {string} stdoutBuf   partial-line buffer for stdout framing
   * @property {number} pendingBytes bytes of the current unterminated line
   * @property {boolean} overflowing discarding an over-long line until the next newline
   * @property {number} generation  which spawn of this id this is; 1-based
   * @property {number} startedAt
   * @property {ReturnType<typeof setTimeout> | null} stableTimer
   * @property {boolean} stopping   true while a deliberate stop is in progress
   * @property {ReturnType<typeof setTimeout> | null} replyTimer pending send()-timeout watchdog
   */
  /** @type {Map<string, ManagedProcess>} */
  const running = new Map()
  /** Per-id state that has to outlive any one process: backoff, counters, last
   * exit. Keyed by caller-chosen id, so it's bounded by how many ids exist. */
  const history = new Map()
  /** Pending crash-restart timers by id — cancelled by stop()/shutdown() so a
   * deliberate stop can't be undone by a restart queued before it. */
  const restartTimers = new Map()
  let quitting = false

  function historyFor(id) {
    let hist = history.get(id)
    if (!hist) {
      hist = { generation: 0, restarts: 0, consecutiveRestarts: 0, lastExit: null, restartDelay: RESTART_INITIAL_MS }
      history.set(id, hist)
    }
    return hist
  }

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
        // POSIX: make the child its own process-group leader so killChild()
        // can signal the whole group. A wrapper like npx forks the real server
        // as its own child, so signaling the wrapper's PID alone orphans it.
        // win32 uses taskkill /T instead (see killChild).
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      return { ok: false, error: `Failed to spawn "${cfg.command}": ${err.message}` }
    }

    const hist = historyFor(id)
    hist.generation += 1

    const entry = {
      child,
      cfg,
      stdoutBuf: '',
      generation: hist.generation,
      startedAt: Date.now(),
      pendingBytes: 0,
      overflowing: false,
      stableTimer: null,
      stopping: false,
      replyTimer: null,
    }
    running.set(id, entry)

    entry.stableTimer = setTimeout(() => {
      hist.restartDelay = RESTART_INITIAL_MS
      hist.consecutiveRestarts = 0
    }, RESTART_STABLE_MS)

    // The log stream is closed once the process settles, but stderr/stdout
    // handlers can still fire after that — write through a guard so a late
    // chunk can't become a write-after-end 'error' on the stream.
    const errLog = logStream(id)
    let logOpen = true
    const writeLog = (chunk) => { if (logOpen) errLog?.write(chunk) }
    const closeLog = () => { if (logOpen) { logOpen = false; errLog?.end() } }

    writeLog(`\n--- ${new Date().toISOString()} started (gen ${entry.generation}): ${cfg.command} ${args.join(' ')} ---\n`)

    // A chunk may hold partial lines or several messages — buffer the tail so
    // the caller only ever receives whole lines.
    //
    // Decode through a StringDecoder, not chunk.toString('utf8'): a chunk
    // boundary lands mid-codepoint on any line long enough to span one (~64KB),
    // and toString() turns each split character into U+FFFD. The line still
    // arrives, just silently corrupted — which for a JSON payload means a parse
    // error nowhere near the actual cause. StringDecoder holds the partial
    // bytes back until the rest arrives.
    const capped = Number.isFinite(maxLineBytes)
    const decoder = new StringDecoder('utf8')
    child.stdout.on('data', (chunk) => {
      let text = decoder.write(chunk)
      if (capped) entry.pendingBytes += chunk.length

      // Mid-overflow: everything up to the next newline belongs to the line
      // that was already dropped, so discard it and resync on that boundary.
      if (entry.overflowing) {
        const nl = text.indexOf('\n')
        if (nl === -1) return
        text = text.slice(nl + 1)
        entry.overflowing = false
        entry.stdoutBuf = ''
        entry.pendingBytes = capped ? Buffer.byteLength(text) : 0
      }

      entry.stdoutBuf += text
      let nl
      while ((nl = entry.stdoutBuf.indexOf('\n')) !== -1) {
        const raw = entry.stdoutBuf.slice(0, nl)
        entry.stdoutBuf = entry.stdoutBuf.slice(nl + 1)
        // Charged back per completed line, so the running total stays O(1) per
        // chunk — measuring the buffer itself would be O(n) on every chunk, and
        // quadratic exactly in the overflow case this counter exists to catch.
        // Skipped entirely when uncapped, so the default path pays nothing.
        if (capped) entry.pendingBytes -= Buffer.byteLength(raw) + 1
        const line = raw.replace(/\r$/, '')
        if (!line.trim()) continue

        // Belt-and-braces: never hand the caller output from a generation that
        // has already been replaced, where it could be framed as a reply from
        // the live process. Node closes a child's stdout at exit — even when a
        // leaked grandchild still holds the write end — and a replacement can
        // only register after that exit, so this is not known to be reachable
        // on Node 24/win32 (test/generation.test.mjs pins that behavior). It's
        // kept because the cost is one map lookup and the failure it prevents
        // is a silent wrong-answer, not a crash.
        if (running.has(id) && running.get(id) !== entry) {
          writeLog(`[stale gen ${entry.generation}] ${line}\n`)
          continue
        }

        // No protocol awareness to correlate a reply to a specific send(),
        // so any output at all disarms the watchdog.
        if (entry.replyTimer) {
          clearTimeout(entry.replyTimer)
          entry.replyTimer = null
        }
        onLine?.(id, line, { generation: entry.generation })
      }

      // Overflow is checked after framing, so a chunk that completes a line and
      // starts a new one isn't judged on the completed line's bytes.
      if (entry.pendingBytes > maxLineBytes && !entry.overflowing) {
        const bytes = entry.pendingBytes
        entry.stdoutBuf = ''
        entry.pendingBytes = 0
        entry.overflowing = true
        writeLog(`--- dropped an unterminated line of ${bytes} bytes (maxLineBytes=${maxLineBytes}) ---\n`)
        // Dropped, never truncated: handing back a half line would look like a
        // complete one and fail as corrupt data somewhere downstream.
        onOverflow?.(id, { bytes, maxLineBytes, generation: entry.generation })
      }
    })

    // stderr is diagnostics, not protocol traffic, so it is never line-framed:
    // it arrives in whatever shape the child wrote it, blank lines and
    // newline-less progress output included. Decoded separately — it has the
    // same split-codepoint hazard as stdout.
    const errDecoder = onStderr ? new StringDecoder('utf8') : null
    child.stderr.on('data', (chunk) => {
      writeLog(chunk)
      if (onStderr) onStderr(id, errDecoder.write(chunk), { generation: entry.generation })
    })

    // A write can race the child dying. Without a listener that EPIPE becomes
    // an uncaught 'error' event and takes down the host process.
    child.stdin.on('error', (err) => writeLog(`stdin error: ${err.message}\n`))

    // 'error' (spawn failure) and 'exit' can both fire for the same child;
    // settle exactly once so the entry can't leak in `running` (a leaked entry
    // makes send() write into a dead stdin forever after).
    let settled = false

    child.on('error', (err) => {
      if (settled) return
      settled = true
      writeLog(`spawn error: ${err.message}\n`)
      closeLog()
      clearTimeout(entry.stableTimer)
      clearTimeout(entry.replyTimer)
      hist.lastExit = { error: err.message, generation: entry.generation, at: Date.now() }
      if (running.get(id) === entry) running.delete(id)
      // No crash-restart: a spawn error means the command itself is bad
      // (missing binary, bad path) and retrying would loop on it.
      onExit?.(id, { error: err.message, generation: entry.generation })
    })

    child.on('exit', (code, signal) => {
      if (settled) return
      settled = true
      writeLog(`--- exited code=${code} signal=${signal} ---\n`)
      closeLog()
      clearTimeout(entry.stableTimer)
      clearTimeout(entry.replyTimer)
      const wasStopping = entry.stopping
      const uptimeMs = Date.now() - entry.startedAt
      hist.lastExit = { code, signal, generation: entry.generation, at: Date.now() }
      if (running.get(id) === entry) running.delete(id)
      onExit?.(id, { code, signal, generation: entry.generation })

      const wantsRestart = shouldRestart
        ? shouldRestart(id, {
          restarts: hist.restarts,
          consecutiveRestarts: hist.consecutiveRestarts,
          lastExit: hist.lastExit,
          uptimeMs,
          generation: entry.generation,
        })
        : true
      if (!wasStopping && !quitting && wantsRestart) {
        const delay = hist.restartDelay
        const timer = setTimeout(() => {
          restartTimers.delete(id)
          if (!quitting && !running.has(id)) {
            // Re-resolve so edits made while the process was up take effect on
            // the restart, not just on a manual stop/start.
            const freshCfg = resolveConfig?.(id) ?? cfg
            hist.restartDelay = Math.min(delay * 2, RESTART_MAX_MS)
            const res = start(id, freshCfg)
            if (res.ok) {
              hist.restarts += 1
              hist.consecutiveRestarts += 1
            }
          }
        }, delay)
        timer.unref?.()
        restartTimers.set(id, timer)
      }
    })

    onSpawn?.(id, cfg, { generation: entry.generation })

    return { ok: true, generation: entry.generation }
  }

  function killChild(child) {
    if (child.exitCode !== null || child.signalCode !== null) return
    if (process.platform === 'win32') {
      // Under cmd.exe the real process is a grandchild; child.kill() would
      // orphan it. taskkill /T takes down the whole tree.
      try { execFile('taskkill', ['/pid', String(child.pid), '/T', '/F']) } catch { /* already gone */ }
    } else {
      // detached:true means child.pid doubles as the pgid, so -pid hits the
      // whole group. child.kill() would orphan anything the child forked.
      try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
      const force = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
      }, KILL_GRACE_MS)
      force.unref?.()
    }
  }

  /** @param {string} id */
  function stop(id) {
    // Cancel any queued crash-restart first — a stop issued between a crash
    // and its restart timer would otherwise be undone seconds later.
    clearTimeout(restartTimers.get(id))
    restartTimers.delete(id)
    const hist = history.get(id)
    if (hist) {
      // A deliberate stop isn't a crash: clear the flap state so the next
      // manual start() begins at the floor delay rather than inheriting
      // backoff from whatever went wrong before it.
      hist.consecutiveRestarts = 0
      hist.restartDelay = RESTART_INITIAL_MS
    }
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
   * @param {number} [opts.timeoutMs] Arms a "gone quiet" watchdog. No request/reply correlation:
   *   any output disarms it, and a later send() replaces rather than stacks the watchdog.
   * @param {(id: string, info: {timeoutMs: number}) => void} [opts.onTimeout]
   */
  function send(id, line, { timeoutMs, onTimeout } = {}) {
    const entry = running.get(id)
    if (!entry) return { ok: false, error: `Process "${id}" is not running` }
    // Strip embedded newlines so a malformed payload can't smuggle extra
    // frames into the child.
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
    return { ok: true, generation: entry.generation }
  }

  function isRunning(id) {
    return running.has(id)
  }

  function listRunning() {
    return Array.from(running.keys())
  }

  /**
   * Health for one id, or null if it has never been started. Survives exit, so
   * a caller can tell "up and healthy" from "up, but on its 40th restart".
   * @param {string} id
   */
  function status(id) {
    const hist = history.get(id)
    if (!hist) return null
    const entry = running.get(id)
    return {
      running: !!entry,
      pid: entry?.child.pid ?? null,
      generation: hist.generation,
      restarts: hist.restarts,
      consecutiveRestarts: hist.consecutiveRestarts,
      lastExit: hist.lastExit,
      uptimeMs: entry ? Date.now() - entry.startedAt : null,
    }
  }

  /** Kill every child; call on quit so no orphans survive in Task Manager. */
  function shutdown() {
    quitting = true
    for (const timer of restartTimers.values()) clearTimeout(timer)
    restartTimers.clear()
    for (const id of Array.from(running.keys())) stop(id)
  }

  return { start, stop, send, isRunning, listRunning, status, shutdown }
}
