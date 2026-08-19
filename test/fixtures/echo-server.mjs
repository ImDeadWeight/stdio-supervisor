// Test fixture: echoes each stdin line back on stdout, prefixed.
// Supports a few behaviors via env vars so tests can drive crash/backoff paths:
//   ECHO_CRASH_AFTER_MS=<n>   exit(1) after n ms
//   ECHO_EXIT_CODE=<n>        exit code to use for ECHO_CRASH_AFTER_MS (default 1)
//   ECHO_PREFIX=<s>           prefix for echoed lines (default "echo:")
process.stdin.setEncoding('utf8')

const prefix = process.env.ECHO_PREFIX ?? 'echo:'

process.stdin.on('data', (chunk) => {
  for (const line of chunk.split('\n')) {
    if (line.trim()) process.stdout.write(`${prefix}${line.trim()}\n`)
  }
})

const crashAfter = Number(process.env.ECHO_CRASH_AFTER_MS)
if (Number.isFinite(crashAfter)) {
  setTimeout(() => process.exit(Number(process.env.ECHO_EXIT_CODE ?? 1)), crashAfter)
}
