// openbob Agent Container — starts OpenCode as a server
// Host process connects via HTTP at port 4096

import { createOpencodeServer } from '@opencode-ai/sdk';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const PORT = parseInt(process.env['OPENCODE_PORT'] ?? '4096', 10);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mcpServerPath = path.join(__dirname, 'mcp-server.js');

process.stdout.write(
  `[agent] group=${process.env['GROUP_FOLDER'] ?? '?'} starting\n`,
);

// Debug: log config file state before OpenCode starts
const configDebug: Record<string, unknown> = {
  cwd: process.cwd(),
};

// Check opencode.json files that findUp would discover
const configPaths = [
  '/workspace/data/project/opencode.json',
  '/workspace/data/opencode.json',
  '/workspace/opencode.json',
  '/opencode.json',
];
for (const p of configPaths) {
  try {
    const content = fs.readFileSync(p, 'utf-8');
    configDebug[p] = JSON.parse(content);
  } catch {
    configDebug[p] = 'not found';
  }
}

process.stderr.write(
  `[agent-debug] config files: ${JSON.stringify(configDebug)}\n`,
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

process.stderr.write(
  `[agent-debug] OPENCODE_CONFIG_CONTENT will be: ${JSON.stringify(sdkConfig)}\n`,
);

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

// Debug: query OpenCode's resolved config after startup
try {
  const configRes = await fetch(`${server.url}/config`);
  if (configRes.ok) {
    const resolved = await configRes.json();
    const summary = {
      model: (resolved as Record<string, unknown>).model,
      mcp: Object.keys(
        ((resolved as Record<string, unknown>).mcp as Record<
          string,
          unknown
        >) ?? {},
      ),
    };
    process.stderr.write(
      `[agent-debug] resolved config from server: ${JSON.stringify(summary)}\n`,
    );
  } else {
    process.stderr.write(
      `[agent-debug] /config returned ${configRes.status}\n`,
    );
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[agent-debug] failed to fetch /config: ${msg}\n`);
}

process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});

// Keep alive
await new Promise<never>(() => {});
