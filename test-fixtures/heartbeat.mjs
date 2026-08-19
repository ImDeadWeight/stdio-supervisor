// Test fixture: appends a timestamp line to the file at process.argv[2] every
// 100ms, forever. Used to prove a grandchild process actually died (the file
// stops growing) rather than trusting exitCode/signalCode on a process we
// never held a direct handle to (the shell:true case, where the real work is
// a grandchild of cmd.exe).
import { appendFileSync } from 'node:fs'

const outFile = process.argv[2]
setInterval(() => {
  appendFileSync(outFile, `${Date.now()}\n`)
}, 100)
