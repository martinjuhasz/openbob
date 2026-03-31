// Docker container runner — spawns yetaclaw-agent containers
// Each group gets one agent container running the OpenCode server
// Host connects via HTTP using the OpenCode SDK client

import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createOpencodeClient } from '@opencode-ai/sdk';
import { promisify } from 'util';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { setSession, getSession } from './db.js';
import { getEnv } from './env.js';
import { logger } from './logger.js';
import { ContainerInput, ContainerOutput } from './types.js';

const execFileAsync = promisify(execFile);

const DOCKER = 'docker';
const AGENT_IMAGE = process.env['AGENT_IMAGE'] ?? 'yetaclaw-agent:latest';
const DOCKER_NETWORK = process.env['DOCKER_NETWORK'] ?? 'yetaclaw';
// DATA_PATH: absolute path on the Docker host (same value used in compose bind mount)
const DATA_PATH_HOST = process.env['DATA_PATH'] ?? DATA_DIR;

// OpenViking memory integration
const OV_URL = process.env['OPENVIKING_URL'];
const OV_ACCOUNT = 'yetaclaw';
const OV_USER = 'default';

// Cache the user key after first read — it never changes at runtime
let _ovUserKey: string | null | undefined = undefined;
function readOvUserKey(): string | null {
  if (!OV_URL) return null;
  if (_ovUserKey !== undefined) return _ovUserKey;
  try {
    _ovUserKey = fs
      .readFileSync(path.join(DATA_DIR, 'openviking', 'ov_user.key'), 'utf-8')
      .trim();
  } catch (err) {
    if (
      err instanceof Error &&
      'code' in err &&
      (err as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      _ovUserKey = null;
    } else {
      throw err;
    }
  }
  if (!_ovUserKey)
    logger.warn(
      'OpenViking URL configured but user key not found — memory disabled',
    );
  return _ovUserKey;
}

// Log once at startup whether OpenViking is enabled
if (OV_URL) {
  logger.info({ url: OV_URL }, 'OpenViking memory integration enabled');
} else {
  logger.info('OpenViking not configured — memory disabled');
}

async function ovRequest(
  userKey: string,
  endpoint: string,
  method: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`${OV_URL}/api/v1${endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': userKey,
      'X-OpenViking-Account': OV_ACCOUNT,
      'X-OpenViking-User': OV_USER,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    logger.warn({ endpoint, status: res.status }, 'OpenViking request failed');
    return null;
  }
  const json = (await res.json()) as { result?: unknown; status?: string };
  return json.result ?? json;
}

// WORKSPACE_PATH: actual host path for /workspace inside this container.
// Resolved by inspecting our own container's mount table at startup.
// Falls back to env var WORKSPACE_PATH if set, or empty string (mounts skipped).
let WORKSPACE_PATH_HOST = process.env['WORKSPACE_PATH'] ?? '';
let SKILLS_PATH_HOST = process.env['SKILLS_PATH'] ?? '';

async function resolveHostPaths(): Promise<void> {
  if (WORKSPACE_PATH_HOST && SKILLS_PATH_HOST) return;
  try {
    const selfName = process.env['HOSTNAME'] ?? 'yetaclaw-host';
    const { stdout } = await execFileAsync(DOCKER, [
      'inspect',
      selfName,
      '--format',
      '{{range .Mounts}}{{.Destination}}:{{.Source}};{{end}}',
    ]);
    for (const entry of stdout.split(';')) {
      const [dest, src] = entry.trim().split(':');
      if (!dest || !src) continue;
      if (!WORKSPACE_PATH_HOST && dest === '/workspace')
        WORKSPACE_PATH_HOST = src;
      if (!SKILLS_PATH_HOST && dest === '/skills') SKILLS_PATH_HOST = src;
    }
    logger.info(
      { WORKSPACE_PATH_HOST, SKILLS_PATH_HOST },
      'Resolved host paths via docker inspect',
    );
    // eslint-disable-next-line no-catch-all/no-catch-all -- fallback: skip mounts if docker inspect fails
  } catch (err) {
    logger.warn(
      { err },
      'Could not resolve host paths via docker inspect — workspace/skills mounts will be skipped',
    );
  }
}

const OPENCODE_PORT = 4096;
const SERVER_POLL_INTERVAL = 500; // 0.5s
const RESPONSE_POLL_INTERVAL = 1_000; // 1s

// Track running containers per group: folder → name
const activeContainers = new Map<string, string>();
// Track model per container for restart-on-change: folder → model
const containerModels = new Map<string, string>();
// Deduplicate concurrent spawn calls for the same group
const spawnInProgress = new Map<string, Promise<string>>();
// Track last activity time per container for idle timeout: folder → timestamp (ms)
const lastActivity = new Map<string, number>();

/** Update the last-activity timestamp for a group's container. */
function touchContainer(groupFolder: string): void {
  lastActivity.set(groupFolder, Date.now());
}

let idleCheckerRunning = false;

/**
 * Start the idle-timeout checker loop.
 * If IDLE_TIMEOUT is set, periodically stops containers that haven't been used
 * within the timeout window. They are re-spawned automatically on next request.
 */
export function startIdleChecker(): void {
  const idleTimeout = getEnv().IDLE_TIMEOUT;
  if (!idleTimeout) {
    logger.debug('IDLE_TIMEOUT not set — containers will run forever');
    return;
  }
  if (idleCheckerRunning) return;
  idleCheckerRunning = true;

  // Check every 60s or half the timeout, whichever is smaller
  const checkInterval = Math.min(60_000, Math.floor(idleTimeout / 2));

  logger.info({ idleTimeout, checkInterval }, 'Idle timeout checker started');

  const check = async () => {
    const now = Date.now();
    for (const [folder, ts] of lastActivity) {
      if (now - ts >= idleTimeout && activeContainers.has(folder)) {
        logger.info(
          { folder, idleMs: now - ts },
          'Stopping idle agent container',
        );
        await stopGroupContainer(folder);
        lastActivity.delete(folder);
      }
    }
    setTimeout(check, checkInterval);
  };

  setTimeout(check, checkInterval);
}

function containerName(groupFolder: string): string {
  return `yetaclaw-agent-${groupFolder}`;
}

/**
 * Build `-e KEY=value` docker args for each env var listed in AGENT_FORWARD_ENV
 * that is actually set in the current process environment.
 */
function getForwardEnvArgs(): string[] {
  const envConfig = getEnv();
  const raw = envConfig.AGENT_FORWARD_ENV;
  if (!raw) return [];

  const args: string[] = [];
  for (const name of raw.split(',')) {
    const key = name.trim();
    if (!key) continue;
    const value = process.env[key];
    if (value !== undefined) {
      args.push('-e', `${key}=${value}`);
    }
  }
  return args;
}

/**
 * Write the base opencode.json for a group.
 * This file is mounted read-only at /workspace/opencode.json inside the agent container.
 * OpenCode's findUp from CWD (/workspace/project) discovers this as the parent config.
 * Agents can create their own /workspace/project/opencode.json to override settings.
 *
 * The base config is written fresh each time (no merging) — it is host-controlled.
 */
function writeOpencodeConfig(groupFolder: string, model: string): void {
  const groupDir = path.join(GROUPS_DIR, groupFolder);
  const configPath = path.join(groupDir, 'opencode.json');

  const config: Record<string, unknown> = {
    model,
    share: 'disabled',
    permission: { edit: 'allow', bash: 'allow' },
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  logger.debug({ groupFolder, model, configPath }, 'Wrote base opencode.json');
}

/**
 * Spawn the agent container for a group.
 * Returns the container name (reachable via Docker network).
 */
async function spawnContainer(
  groupFolder: string,
  model: string,
): Promise<string> {
  const name = containerName(groupFolder);

  // Clean up any previous stopped container with same name
  await execFileAsync(DOCKER, ['rm', '-f', name]).catch(() => {});

  const groupDir = path.join(GROUPS_DIR, groupFolder);
  fs.mkdirSync(groupDir, { recursive: true });
  fs.chmodSync(groupDir, 0o777);

  // Create project subdirectory for agent's CWD (rw)
  const projectDir = path.join(groupDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.chmodSync(projectDir, 0o777);

  // Write base opencode.json (mounted ro at /workspace/opencode.json)
  writeOpencodeConfig(groupFolder, model);

  // Pre-create context.json so the file bind mount works at container start
  // It will be updated with real values in runAgentSession before each prompt
  const contextFile = path.join(groupDir, 'context.json');
  if (!fs.existsSync(contextFile)) {
    fs.writeFileSync(
      contextFile,
      JSON.stringify({ chatJid: '', groupFolder, isMain: false }, null, 2),
    );
  }

  const ipcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  const ipcTasksDir = path.join(ipcDir, 'tasks');
  const ipcInputDir = path.join(ipcDir, 'input');
  fs.mkdirSync(ipcTasksDir, { recursive: true });
  fs.mkdirSync(ipcInputDir, { recursive: true });
  fs.chmodSync(ipcDir, 0o777);
  fs.chmodSync(ipcTasksDir, 0o777);
  fs.chmodSync(ipcInputDir, 0o777);

  // Pre-create opencode data dir so the node user can access it in the agent container
  const opencodeDir = path.join(DATA_DIR, 'opencode');
  fs.mkdirSync(opencodeDir, { recursive: true });
  fs.chmodSync(opencodeDir, 0o777);

  // Compute host-side paths for agent container mounts
  // WORKSPACE_PATH_HOST = actual host path for /workspace inside this (host) container
  // New agent layout: everything under /workspace in the agent container
  const groupDirHost = WORKSPACE_PATH_HOST
    ? path.join(WORKSPACE_PATH_HOST, 'groups', groupFolder)
    : null;
  const projectDirHost = groupDirHost
    ? path.join(groupDirHost, 'project')
    : null;
  const baseConfigHost = groupDirHost
    ? path.join(groupDirHost, 'opencode.json')
    : null;
  const contextJsonHost = groupDirHost
    ? path.join(groupDirHost, 'context.json')
    : null;
  const agentsMdHost = WORKSPACE_PATH_HOST
    ? path.join(WORKSPACE_PATH_HOST, 'AGENTS.md')
    : null;
  // IPC dir: lives under /data in the host container → use DATA_PATH_HOST for docker run mount
  const ipcDirHost = `${DATA_PATH_HOST}/ipc/${groupFolder}`;
  // OpenCode data dir: /data/opencode on host → /workspace/data/opencode in agent
  const opencodeDirHost = `${DATA_PATH_HOST}/opencode`;
  // Telegram files: /data/telegram on host → /workspace/data/telegram in agent (ro)
  const telegramDirHost = `${DATA_PATH_HOST}/telegram`;

  // No port publish needed — host connects via Docker network using container name
  // Note: no --rm so we can fetch logs on crash; containers are cleaned up in spawnContainer
  const cmd = [
    DOCKER,
    'run',
    '-d',
    '--name',
    name,
    '--network',
    DOCKER_NETWORK,
    // Environment
    '-e',
    `OPENCODE_PORT=${OPENCODE_PORT}`,
    '-e',
    `GROUP_FOLDER=${groupFolder}`,
    ...(process.env['OPENCODE_LOG_LEVEL']
      ? ['-e', `OPENCODE_LOG_LEVEL=${process.env['OPENCODE_LOG_LEVEL']}`]
      : []),
    // Forward user-configured env vars to agent container
    ...getForwardEnvArgs(),
    // Agent container layout: everything under /workspace
    // Project dir (CWD) — rw
    ...(projectDirHost ? ['-v', `${projectDirHost}:/workspace/project`] : []),
    // Base opencode.json — ro (host-controlled model + defaults)
    ...(baseConfigHost
      ? ['-v', `${baseConfigHost}:/workspace/opencode.json:ro`]
      : []),
    // Base AGENTS.md — ro (host-controlled instructions)
    ...(agentsMdHost && fs.existsSync('/workspace/AGENTS.md')
      ? ['-v', `${agentsMdHost}:/workspace/AGENTS.md:ro`]
      : []),
    // Context file — ro (host writes chatJid, groupFolder, isMain before each session)
    ...(contextJsonHost
      ? ['-v', `${contextJsonHost}:/workspace/context.json:ro`]
      : []),
    // IPC dir — rw (host ↔ agent communication)
    '-v',
    `${ipcDirHost}:/workspace/ipc`,
    // OpenCode data dir (sessions, auth) — rw
    '-v',
    `${opencodeDirHost}:/workspace/data/opencode`,
    // Telegram files (photos, documents) — ro for agent
    '-v',
    `${telegramDirHost}:/workspace/data/telegram:ro`,
    // Skills — read-only, shared across all agent containers
    ...(SKILLS_PATH_HOST
      ? ['-v', `${SKILLS_PATH_HOST}:/workspace/skills:ro`]
      : []),
    // Labels for cleanup
    '--label',
    `yetaclaw.group=${groupFolder}`,
    AGENT_IMAGE,
  ];

  logger.info({ groupFolder, name, model }, 'Spawning agent container');
  await execFileAsync(cmd[0]!, cmd.slice(1), { timeout: 30_000 });

  activeContainers.set(groupFolder, name);
  containerModels.set(groupFolder, model);
  touchContainer(groupFolder);
  logger.info({ groupFolder, name }, 'Agent container started');
  return name;
}

/**
 * Wait for OpenCode server health check to pass (via Docker network hostname).
 */
async function waitForServer(containerName: string): Promise<void> {
  const baseUrl = `http://${containerName}:${OPENCODE_PORT}`;
  const startupTimeout = getEnv().AGENT_STARTUP_TIMEOUT ?? 30_000;
  const deadline = Date.now() + startupTimeout;
  let attempts = 0;
  let lastError: string | undefined;
  while (Date.now() < deadline) {
    attempts++;
    try {
      const res = await fetch(`${baseUrl}/session`);
      if (res.ok) return;
      const body = await res.text().catch(() => '');
      lastError = `HTTP ${res.status} ${res.statusText}: ${body.slice(0, 500)}`;
      // eslint-disable-next-line no-catch-all/no-catch-all -- expected during container boot
    } catch (err) {
      lastError =
        err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
    if (attempts <= 3 || attempts % 10 === 0) {
      logger.debug(
        { containerName, attempts, lastError },
        'waitForServer poll attempt',
      );
    }
    await new Promise((r) => setTimeout(r, SERVER_POLL_INTERVAL));
  }
  // Collect container logs for diagnostics before failing
  const { stdout, stderr } = await execFileAsync(DOCKER, [
    'logs',
    '--tail',
    '50',
    containerName,
  ]).catch(() => ({ stdout: '(could not fetch logs)', stderr: '' }));
  const containerLogs = stdout + stderr;
  logger.error(
    { containerName, containerLogs, lastError, attempts },
    'Agent container logs on timeout',
  );
  throw new Error(
    `OpenCode server at ${baseUrl} did not become ready in time (${attempts} attempts, last: ${lastError})`,
  );
}

/**
 * Configure provider auth on a freshly started agent container.
 * Derives the provider ID from the model string (first segment before '/'),
 * looks for `<PROVIDER>_API_KEY` in the host environment, and calls auth.set().
 */
async function configureAuth(
  containerName: string,
  model: string,
): Promise<void> {
  const providerID = model.split('/')[0];
  if (!providerID) return;

  const envKey = `${providerID.toUpperCase()}_API_KEY`;
  const apiKey = process.env[envKey];
  if (!apiKey) {
    logger.debug(
      { containerName, providerID, envKey },
      'No API key found for provider — skipping auth.set()',
    );
    return;
  }

  const client = createOpencodeClient({
    baseUrl: `http://${containerName}:${OPENCODE_PORT}`,
  });

  const res = await client.auth.set({
    path: { id: providerID },
    body: { type: 'api', key: apiKey },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((res as any).error) {
    logger.warn(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { containerName, providerID, error: (res as any).error },
      'Failed to configure provider auth',
    );
  } else {
    logger.info(
      { containerName, providerID },
      'Provider API key configured on agent container',
    );
  }
}

/**
 * Get or reuse an existing agent container for a group.
 * Returns the container name for direct Docker network access.
 * Deduplicates concurrent spawn calls for the same group.
 * If the model changed since the container was spawned, restarts it.
 */
async function getAgentContainer(
  groupFolder: string,
  model: string,
): Promise<string> {
  const existing = activeContainers.get(groupFolder);
  if (existing) {
    // Check if model changed — if so, restart the container
    const currentModel = containerModels.get(groupFolder);
    if (currentModel && currentModel !== model) {
      logger.info(
        { groupFolder, oldModel: currentModel, newModel: model },
        'Model changed — restarting agent container',
      );
      await execFileAsync(DOCKER, ['rm', '-f', existing]).catch(() => {});
      activeContainers.delete(groupFolder);
      containerModels.delete(groupFolder);
    } else {
      // Verify container still running
      try {
        execFileSync(DOCKER, ['inspect', existing], { stdio: 'pipe' });
        return existing;
        // eslint-disable-next-line no-catch-all/no-catch-all -- container gone, clean up and re-spawn
      } catch {
        activeContainers.delete(groupFolder);
        containerModels.delete(groupFolder);
      }
    }
  }

  // Deduplicate concurrent spawns for the same group
  const inFlight = spawnInProgress.get(groupFolder);
  if (inFlight) return inFlight;

  const p = (async () => {
    const name = await spawnContainer(groupFolder, model);
    await waitForServer(name);
    await configureAuth(name, model);
    return name;
  })().finally(() => spawnInProgress.delete(groupFolder));

  spawnInProgress.set(groupFolder, p);
  return p;
}

/**
 * Stop and remove a group's agent container.
 */
export async function stopGroupContainer(groupFolder: string): Promise<void> {
  const name = activeContainers.get(groupFolder);
  if (!name) return;
  await execFileAsync(DOCKER, ['rm', '-f', name]).catch(() => {});
  activeContainers.delete(groupFolder);
  containerModels.delete(groupFolder);
  lastActivity.delete(groupFolder);
  logger.info({ groupFolder }, 'Agent container stopped and removed');
}

/**
 * Kill and remove all yetaclaw agent containers (cleanup on host shutdown).
 */
export async function stopAllContainers(): Promise<void> {
  const names = [...activeContainers.values()];
  if (names.length === 0) return;
  await execFileAsync(DOCKER, ['rm', '-f', ...names]).catch(() => {});
  activeContainers.clear();
  containerModels.clear();
  lastActivity.clear();
  logger.info(
    { count: names.length },
    'All agent containers stopped and removed',
  );
}

/**
 * Run an agent session for a group: spawn container (or reuse), send prompt, return response.
 */
export async function runAgentSession(
  input: ContainerInput,
): Promise<ContainerOutput> {
  const { groupFolder, prompt, chatJid, isMain, model } = input;

  let agentName: string;
  try {
    agentName = await getAgentContainer(groupFolder, model);
    // eslint-disable-next-line no-catch-all/no-catch-all -- return error status instead of crashing
  } catch (err) {
    logger.error({ groupFolder, err }, 'Failed to get agent container');
    return { status: 'error', result: null, error: String(err) };
  }

  const client = createOpencodeClient({
    baseUrl: `http://${agentName}:${OPENCODE_PORT}`,
  });

  // Write context.json to group dir (mounted ro at /workspace/context.json via base config mount)
  const contextFile = path.join(GROUPS_DIR, groupFolder, 'context.json');
  fs.writeFileSync(
    contextFile,
    JSON.stringify({ chatJid, groupFolder, isMain }, null, 2),
  );

  // Resume existing session or create new one
  let sessionId = input.sessionId ?? getSession(groupFolder) ?? undefined;

  try {
    if (sessionId) {
      // Verify session still exists (SDK doesn't throw by default — check .data)
      const getRes = await client.session.get({ path: { id: sessionId } });
      if (!getRes.data) {
        // session.get may return empty if session not yet loaded into memory — try session.list
        const listRes = await client.session.list().catch(() => null);
        const found = (listRes?.data ?? []).find(
          (s: { id: string }) => s.id === sessionId,
        );
        if (!found) {
          logger.info(
            { groupFolder, sessionId },
            'Session not found in list, creating new one',
          );
          sessionId = undefined;
        } else {
          logger.info(
            { groupFolder, sessionId },
            'Session found via list, reusing',
          );
        }
      }
    }

    if (!sessionId) {
      const session = await client.session.create({
        body: { title: `${groupFolder}/${chatJid}` },
      });
      logger.debug(
        { groupFolder, sessionCreateRes: session },
        'session.create response',
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionId = (session.data?.id ?? (session as any).id) as string;
      if (!sessionId) {
        throw new Error(
          `session.create returned no id: ${JSON.stringify(session)}`,
        );
      }
      setSession(groupFolder, sessionId);
      logger.info({ groupFolder, sessionId }, 'New OpenCode session created');
    }

    // If the session is still busy from a previous interrupted run, wait briefly then abandon
    {
      const preStatus = await client.session.status().catch(() => null);
      if (preStatus?.data?.[sessionId]?.type === 'busy') {
        logger.warn(
          { groupFolder, sessionId },
          'Session still busy before prompt — waiting up to 10s',
        );
        const busyDeadline = Date.now() + 10_000;
        while (Date.now() < busyDeadline) {
          await new Promise((r) => setTimeout(r, 1_000));
          const s = await client.session.status().catch(() => null);
          if (s?.data?.[sessionId]?.type !== 'busy') break;
        }
        const stillBusy =
          (await client.session.status().catch(() => null))?.data?.[sessionId]
            ?.type === 'busy';
        if (stillBusy) {
          logger.warn(
            { groupFolder, sessionId },
            'Session still busy after wait — creating new session',
          );
          const newRes = await client.session.create({
            body: { title: `${groupFolder}/${chatJid}` },
          });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          sessionId = (newRes.data?.id ?? (newRes as any).id) as string;
          if (!sessionId) {
            throw new Error(
              `session.create returned no id: ${JSON.stringify(newRes)}`,
            );
          }
          setSession(groupFolder, sessionId);
          logger.info(
            { groupFolder, sessionId },
            'New session created after stale busy',
          );
        }
      }
    }

    // OpenViking: recall relevant memories and inject into system prompt
    let ovSystem: string | undefined;
    const ovKey = readOvUserKey();
    if (ovKey) {
      try {
        const sid = encodeURIComponent(sessionId);
        const [, , recalled] = (await Promise.all([
          ovRequest(ovKey, `/sessions/${sid}?auto_create=true`, 'GET'),
          ovRequest(ovKey, `/sessions/${sid}/messages`, 'POST', {
            role: 'user',
            content: prompt,
          }),
          ovRequest(ovKey, '/search/find', 'POST', {
            query: prompt,
            target_uri: `viking://user/${OV_USER}/memories`,
            limit: 5,
            score_threshold: 0.1,
          }),
        ])) as [
          unknown,
          unknown,
          { memories?: Array<{ abstract?: string; score?: number }> } | null,
        ];
        const items = recalled?.memories
          ?.filter((m) => m.abstract)
          .map((m) => `- ${m.abstract}`);
        if (items && items.length > 0) {
          ovSystem = `## Relevant Memories\n${items.join('\n')}`;
          logger.info(
            { groupFolder, count: items.length },
            'OpenViking: memories injected into prompt',
          );
          logger.debug(
            { groupFolder, memories: items },
            'OpenViking: memory content',
          );
        } else {
          logger.info(
            { groupFolder },
            'OpenViking: no relevant memories found',
          );
        }
        // eslint-disable-next-line no-catch-all/no-catch-all -- OpenViking recall is optional
      } catch (err) {
        logger.warn(
          { err },
          'OpenViking recall failed — continuing without memories',
        );
      }
    }

    logger.debug(
      { groupFolder, sessionId, chars: prompt.length, prompt },
      'Sending prompt to OpenCode',
    );

    // Fire prompt async (returns 204, not the assistant message)
    // Model is already configured in opencode.json — no per-prompt override needed
    const asyncRes = await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        parts: [{ type: 'text', text: prompt }],
        ...(ovSystem ? { system: ovSystem } : {}),
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((asyncRes as any).error) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const e = (asyncRes as any).error;
      const errMsg = e?.data?.message ?? JSON.stringify(e);
      logger.error({ groupFolder, sessionId, error: e }, 'promptAsync error');
      return { status: 'error', result: null, error: errMsg };
    }

    // Poll session status until idle
    const agentTimeout = getEnv().AGENT_TIMEOUT ?? 480_000; // default 8 min
    const deadline = Date.now() + agentTimeout;
    let missingFromStatusCount = 0;
    let pollExitReason = 'timeout';
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, RESPONSE_POLL_INTERVAL));
      const statusRes = await client.session.status();
      const sessionStatus = statusRes.data?.[sessionId];
      const statusType = sessionStatus?.type;
      logger.debug(
        { groupFolder, sessionId, statusType },
        'Session status poll',
      );
      if (statusType === 'idle') {
        pollExitReason = 'idle';
        break;
      }
      if (statusType === undefined) {
        // Session not in status map — either not started yet or already finished
        missingFromStatusCount++;
        if (missingFromStatusCount >= 3) {
          // Session never appeared in status — assume it finished or was lost
          logger.warn(
            { groupFolder, sessionId },
            'Session missing from status map — assuming finished',
          );
          pollExitReason = 'missing';
          break;
        }
      } else {
        missingFromStatusCount = 0;
      }
    }
    logger.info({ groupFolder, sessionId, pollExitReason }, 'Poll loop exited');

    // Fetch messages and find last assistant message
    const messagesRes = await client.session.messages({
      path: { id: sessionId },
    });
    const messages = messagesRes.data ?? [];

    // Find last assistant message (in reverse)
    const assistantMsg = [...messages]
      .reverse()
      .find((m) => m.info?.role === 'assistant');

    if (!assistantMsg) {
      logger.warn(
        {
          groupFolder,
          sessionId,
          messageCount: messages.length,
          roles: messages.map((m) => m.info?.role),
        },
        'No assistant message found after prompt',
      );
      return {
        status: 'error',
        result: null,
        error: 'No assistant message from OpenCode',
      };
    }

    // Check for model/auth error
    const msgError =
      assistantMsg.info.role === 'assistant'
        ? assistantMsg.info.error
        : undefined;
    if (msgError) {
      const errMsg =
        'data' in msgError && msgError.data
          ? 'message' in msgError.data
            ? String(msgError.data.message)
            : JSON.stringify(msgError)
          : JSON.stringify(msgError);
      logger.error(
        { groupFolder, sessionId, msgError },
        'OpenCode model/auth error',
      );
      return { status: 'error', result: null, error: errMsg };
    }

    const text = (assistantMsg.parts ?? [])
      .filter(
        (p): p is typeof p & { type: 'text'; text: string } =>
          p.type === 'text' && 'text' in p,
      )
      .map((p) => p.text)
      .join('');

    if (!text) {
      logger.warn(
        { groupFolder, sessionId, parts: assistantMsg.parts },
        'Empty text from OpenCode',
      );
      return {
        status: 'error',
        result: null,
        error: 'Empty response from OpenCode',
      };
    }

    logger.debug(
      { groupFolder, sessionId, chars: text.length, text },
      'OpenCode response received',
    );

    // OpenViking: store assistant response and commit for memory extraction
    if (ovKey) {
      try {
        const sid = encodeURIComponent(sessionId);
        await ovRequest(ovKey, `/sessions/${sid}/messages`, 'POST', {
          role: 'assistant',
          content: text,
        });
        await ovRequest(ovKey, `/sessions/${sid}/commit`, 'POST', {});
        logger.info(
          { groupFolder },
          'OpenViking: session committed for memory extraction',
        );
        logger.debug(
          { groupFolder, sessionId, chars: text.length },
          'OpenViking: stored assistant response',
        );
        // eslint-disable-next-line no-catch-all/no-catch-all -- OpenViking commit is optional
      } catch (err) {
        logger.warn({ err }, 'OpenViking commit failed');
      }
    }

    touchContainer(groupFolder);
    return { status: 'success', result: text, newSessionId: sessionId };
    // eslint-disable-next-line no-catch-all/no-catch-all -- return error status instead of crashing
  } catch (err) {
    logger.error({ groupFolder, sessionId, err }, 'OpenCode session error');
    touchContainer(groupFolder);
    return { status: 'error', result: null, error: String(err) };
  }
}

/**
 * Pre-warm agent containers for all registered groups so they're ready on first message.
 */
export async function warmUpContainers(
  groups: Array<{ folder: string; model: string }>,
): Promise<void> {
  if (groups.length === 0) return;
  await resolveHostPaths();
  await cleanupAllAgentContainers();
  logger.info({ count: groups.length }, 'Pre-warming agent containers');
  await Promise.allSettled(
    groups.map(async ({ folder, model }) => {
      try {
        await getAgentContainer(folder, model);
        logger.info({ folder }, 'Agent container pre-warmed');
        // eslint-disable-next-line no-catch-all/no-catch-all -- pre-warm is best-effort
      } catch (err) {
        logger.warn(
          { folder, err },
          'Pre-warm failed — will retry on first message',
        );
      }
    }),
  );
}

/**
 * Remove all exited yetaclaw agent containers (orphans from previous runs or crashes).
 */
export async function cleanupStoppedContainers(): Promise<void> {
  try {
    const { stdout } = await execFileAsync(DOCKER, [
      'ps',
      '-aq',
      '--filter',
      'label=yetaclaw.group',
      '--filter',
      'status=exited',
      '--filter',
      'status=dead',
    ]);
    const ids = stdout.trim().split('\n').filter(Boolean);
    if (ids.length === 0) return;
    await execFileAsync(DOCKER, ['rm', ...ids]).catch(() => {});
    logger.info({ count: ids.length }, 'Removed stopped agent containers');
    // eslint-disable-next-line no-catch-all/no-catch-all -- Docker cleanup is best-effort
  } catch {
    // Docker not available or no containers — ignore
  }
}

/**
 * Stop and remove ALL agent containers (running + stopped).
 * Called on host startup to ensure prewarming uses the latest image.
 */
export async function cleanupAllAgentContainers(): Promise<void> {
  try {
    const { stdout } = await execFileAsync(DOCKER, [
      'ps',
      '-aq',
      '--filter',
      'label=yetaclaw.group',
    ]);
    const ids = stdout.trim().split('\n').filter(Boolean);
    if (ids.length === 0) return;
    await execFileAsync(DOCKER, ['rm', '-f', ...ids]).catch(() => {});
    logger.info(
      { count: ids.length },
      'Removed all agent containers before prewarming',
    );
    // eslint-disable-next-line no-catch-all/no-catch-all -- Docker cleanup is best-effort
  } catch {
    // Docker not available or no containers — ignore
  }
}
