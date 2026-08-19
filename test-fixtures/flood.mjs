// Test fixture: emits one enormous unterminated line, then a normal line.
// Used to prove the maxLineBytes cap drops the over-long line and resyncs on
// the next newline rather than truncating it into something that looks whole.
const chunk = 'x'.repeat(64 * 1024)
let sent = 0
const target = Number(process.env.FLOOD_BYTES ?? 5 * 1024 * 1024)
const timer = setInterval(() => {
  process.stdout.write(chunk)
  sent += chunk.length
  if (sent >= target) {
    clearInterval(timer)
    process.stdout.write('\nrecovered\n', () => setTimeout(() => process.exit(0), 200))
  }
}, 5)
