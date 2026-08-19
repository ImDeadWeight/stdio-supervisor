// Test fixture: writes to stderr in shapes a line-framing reader would mangle —
// a blank line, and a final chunk with no trailing newline.
process.stderr.write('first\n')
process.stderr.write('\n')
process.stderr.write('progress-no-newline')
setTimeout(() => process.exit(0), 300)
