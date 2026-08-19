// Test fixture: writes its own cwd to stdout once, then exits.
process.stdout.write(process.cwd() + '\n')
