// Test fixture: one line of multibyte text long enough (~420KB) to span many
// 64KB stdout chunks, so chunk boundaries are guaranteed to land mid-codepoint.
// Proves the stdout decoder holds partial codepoints instead of emitting U+FFFD.
const s = (process.env.MB_TEXT ?? '日本語テキスト').repeat(Number(process.env.MB_REPEAT ?? 20000))
process.stdout.write(s + '\n', () => setTimeout(() => process.exit(0), 200))
