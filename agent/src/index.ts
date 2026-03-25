// yetaclaw Agent Container — starts OpenCode as a server
// Host process connects via HTTP at port 4096

import { createOpencodeServer } from '@opencode-ai/sdk'
import fs from 'fs'

const PORT = parseInt(process.env['OPENCODE_PORT'] ?? '4096', 10)
function writeError(msg: string): void {
  // Write to /workspace/group/ — readable from the host filesystem
  for (const p of ['/workspace/group/agent-crash.txt', '/tmp/agent-crash.txt']) {
    try { fs.writeFileSync(p, msg + '\n'); break } catch { /* try next */ }
  }
  process.stderr.write(msg + '\n')
}

let server: { url: string; close(): void }
try {
  server = await createOpencodeServer({
    hostname: '0.0.0.0',
    port: PORT,
    timeout: 60_000,
  })
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  writeError(`createOpencodeServer failed: ${msg}`)
  process.exit(1)
}

process.stdout.write(JSON.stringify({ ready: true, url: server.url }) + '\n')

process.on('SIGTERM', () => {
  server.close()
  process.exit(0)
})

process.on('SIGINT', () => {
  server.close()
  process.exit(0)
})

// Keep alive
await new Promise<never>(() => {})
