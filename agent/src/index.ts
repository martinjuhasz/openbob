// openbob Agent Container — starts OpenCode as a server
// Host process connects via HTTP at port 4096

import { createOpencodeServer, createOpencodeClient } from '@opencode-ai/sdk';
import type { GlobalEvent } from '@opencode-ai/sdk';
import { fileURLToPath } from 'url';
import path from 'path';

const PORT = parseInt(process.env['OPENCODE_PORT'] ?? '4096', 10);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mcpServerPath = path.join(__dirname, 'mcp-server.js');

process.stdout.write(
  `[agent] group=${process.env['GROUP_FOLDER'] ?? '?'} starting\n`,
);

const sdkConfig = {
  ...(process.env['OPENCODE_LOG_LEVEL']
    ? {
        logLevel: process.env['OPENCODE_LOG_LEVEL'] as
          | 'DEBUG'
          | 'INFO'
          | 'WARN'
          | 'ERROR',
      }
    : {}),
  mcp: {
    openbob: {
      type: 'local' as const,
      command: ['node', mcpServerPath],
    },
  },
};

let server: { url: string; close(): void };
try {
  server = await createOpencodeServer({
    hostname: '0.0.0.0',
    port: PORT,
    timeout: 60_000,
    config: sdkConfig,
  });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`createOpencodeServer failed: ${msg}\n`);
  process.exit(1);
}

process.stdout.write(JSON.stringify({ ready: true, url: server.url }) + '\n');

process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});

// Debug event logger — streams all session events to stdout
if (process.env['OPENCODE_LOG_LEVEL'] === 'DEBUG') {
  const log = (msg: string) => process.stdout.write(`[agent:debug] ${msg}\n`);

  const startEventLogger = async () => {
    const client = createOpencodeClient({
      baseUrl: `http://localhost:${PORT}`,
    });
    const messageRoles = new Map<string, 'user' | 'assistant'>();

    while (true) {
      try {
        const { stream } = await client.global.event();
        for await (const globalEvent of stream) {
          const event = (globalEvent as unknown as GlobalEvent).payload;
          if (!event || !('type' in event)) continue;

          if (event.type === 'message.updated') {
            const info = event.properties.info;
            messageRoles.set(info.id, info.role);

            if (info.role === 'user') {
              log('── user message ──────────────────');
              if (info.system) {
                log(`system:\n${info.system}`);
              }
            }

            if (info.role === 'assistant' && 'tokens' in info) {
              const t = info.tokens;
              log('── complete ──────────────────────');
              log(
                `model=${info.modelID} | in=${t.input} out=${t.output} reasoning=${t.reasoning} cache_r=${t.cache.read} cache_w=${t.cache.write} | cost=$${info.cost.toFixed(4)}`,
              );
            }
          }

          if (event.type === 'message.part.updated') {
            const { part } = event.properties;
            const role = messageRoles.get(part.messageID);

            if (part.type === 'text') {
              if (role === 'user') {
                log(`prompt:\n${part.text}`);
              } else if (role === 'assistant') {
                log(`response:\n${part.text}`);
              }
            }

            if (part.type === 'reasoning') {
              log(`thinking:\n${part.text}`);
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`event stream error: ${msg}, reconnecting...`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  };

  startEventLogger().catch(() => {});
}

// Keep alive
await new Promise<never>(() => {});
