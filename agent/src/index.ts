// yetaclaw Agent Container — starts OpenCode as a server
// Host process connects via HTTP at port 4096

import { createOpencodeServer } from '@opencode-ai/sdk'

const PORT = parseInt(process.env['OPENCODE_PORT'] ?? '4096', 10)

let server: { url: string; close(): void }
try {
  server = await createOpencodeServer({
    hostname: '0.0.0.0',
    port: PORT,
    timeout: 60_000,
  })
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  process.stderr.write(`createOpencodeServer failed: ${msg}\n`)
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
