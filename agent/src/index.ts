// yetaclaw Agent Container — starts OpenCode as a server
// Host process connects via HTTP at port 4096

import { createOpencode } from '@opencode-ai/sdk'

const PORT = parseInt(process.env['OPENCODE_PORT'] ?? '4096', 10)

const { server } = await createOpencode({
  hostname: '0.0.0.0',
  port: PORT,
})

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
