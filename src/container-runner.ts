// Docker container runner — spawns openbob-agent containers
// Each group gets one agent container running the OpenCode server
// Host connects via HTTP using the OpenCode SDK client

import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createOpencodeClient } from '@opencode-ai/sdk';
import { promisify } from 'util';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { setSession, getSession, getOvUserKey, setOvUserKey } from './db.js';
import { getEnv } from './env.js';
import { logger } from './logger.js';
import { ContainerInput, ContainerOutput } from './types.js';

const execFileAsync = promisify(execFile);

const DOCKER = 'docker';
const AGENT_IMAGE = process.env['AGENT_IMAGE'] ?? 'openbob-agent:latest';

/**
 * Summarize session messages for debug logging.
 * Returns a compact array of { role, textPreview, toolCalls } for the last N messages.
 */
function summarizeMessages(
  messages: Array<{
    info?: { role?: string; error?: unknown };
    parts?: Array<{
      type: string;
      text?: string;
      tool?: string;
      state?: { status?: string; input?: unknown; error?: string };
    }>;
  }>,
  limit = 10,
): Array<Record<string, unknown>> {
  return messages.slice(-limit).map((m) => {
    const role = m.info?.role ?? 'unknown';
    const parts = m.parts ?? [];
    const textParts = parts
      .filter((p) => p.type === 'text' && p.text)
      .map((p) =>
        p.text!.length > 200 ? p.text!.slice(0, 200) + '…' : p.text,
      );
    const toolParts = parts
      .filter((p) => p.type === 'tool')
      .map((p) => ({
        tool: p.tool,
        status: p.state?.status,
        ...(p.state?.error ? { error: p.state.error } : {}),
      }));
    const reasoningParts = parts
      .filter((p) => p.type === 'reasoning' && p.text)
      .map((p) =>
        p.text!.length > 100 ? p.text!.slice(0, 100) + '…' : p.text,
      );
    return {
      role,
      ...(m.info?.error ? { error: m.info.error } : {}),
      ...(textParts.length > 0 ? { text: textParts } : {}),
      ...(toolParts.length > 0 ? { tools: toolParts } : {}),
      ...(reasoningParts.length > 0 ? { reasoning: reasoningParts } : {}),
      partTypes: parts.map((p) => p.type),
    };
  });
}
const DOCKER_NETWORK = process.env['DOCKER_NETWORK'] ?? 'openbob';
// DATA_PATH: absolute path on the Docker host (same value used in compose bind mount)
const DATA_PATH_HOST = process.env['DATA_PATH'] ?? DATA_DIR;

// OpenViking memory integration
const OV_ACCOUNT = 'openbob';
const OV_USER = 'default';

/** Lazy accessor for OpenViking URL — reads from validated env (not process.env). */
function getOvUrl(): string | undefined {
  return getEnv().OPENVIKING_URL;
}

// Cache the global user key after first successful read.
// null results are NOT cached so the key is retried on subsequent calls
// (handles race condition when OV container starts after the host).
let _ovGlobalUserKey: string | undefined = undefined;
function readOvGlobalUserKey(): string | null {
  if (!getOvUrl()) return null;
  if (_ovGlobalUserKey !== undefined) return _ovGlobalUserKey;
  try {
    const key = fs
      .readFileSync(path.join(DATA_DIR, 'openviking', 'ov_user.key'), 'utf-8')
      .trim();
    if (key) {
      _ovGlobalUserKey = key;
      return key;
    }
  } catch (err) {
    if (
      err instanceof Error &&
      'code' in err &&
      (err as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      // File not found — don't cache, retry on next call
    } else {
      throw err;
    }
  }
  logger.debug(
    'OpenViking user key not found yet — will retry on next request',
  );
  return null;
}

// Log OpenViking status once on first access
let _ovStatusLogged = false;
function logOvStatus(): void {
  if (_ovStatusLogged) return;
  _ovStatusLogged = true;
  const url = getOvUrl();
  if (url) {
    logger.info({ url }, 'OpenViking memory integration enabled');
  } else {
    logger.info('OpenViking not configured — memory disabled');
  }
}

/**
 * Make a request to the OpenViking API.
 * When using per-group user keys, the key alone is sufficient — the server
 * derives account_id and user_id from the key. We still send account/user
 * headers for the global (default) user for backwards compatibility.
 */
async function ovRequest(
  userKey: string,
  endpoint: string,
  method: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<unknown> {
  const res = await fetch(`${getOvUrl()}/api/v1${endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': userKey,
      ...headers,
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

/**
 * Provision a per-group OpenViking user via the Admin API.
 * Returns the new user key, or null if provisioning fails.
 */
async function ovProvisionGroupUser(
  groupFolder: string,
): Promise<string | null> {
  const apiKey = getEnv().OPENVIKING_API_KEY;
  if (!apiKey) {
    logger.warn('OPENVIKING_API_KEY not set — cannot provision per-group user');
    return null;
  }
  const userId = `group-${groupFolder}`;
  try {
    const result = (await ovRequest(
      apiKey,
      `/admin/accounts/${OV_ACCOUNT}/users`,
      'POST',
      { user_id: userId },
    )) as { user_key?: string } | null;
    const userKey = result?.user_key;
    if (!userKey) {
      logger.warn(
        { groupFolder, result },
        'OpenViking: user provisioning returned no user_key',
      );
      return null;
    }
    setOvUserKey(groupFolder, userKey);
    logger.info(
      { groupFolder, userId },
      'OpenViking: provisioned per-group user',
    );
    return userKey;
  } catch (err) {
    logger.warn(
      { groupFolder, err },
      'OpenViking: failed to provision per-group user',
    );
    return null;
  }
}

interface OvCredentials {
  userKey: string;
  userId: string;
  /** Extra headers to include in ovRequest (e.g. account/user for global mode). */
  headers: Record<string, string>;
}

/**
 * Get OpenViking credentials for a group based on OPENVIKING_SCOPE.
 * - `global`: uses the shared default user (with account/user headers)
 * - `group`: uses a per-group user key (self-sufficient, lazy-provisioned)
 */
async function getOvCredentials(
  groupFolder: string,
): Promise<OvCredentials | null> {
  logOvStatus();
  if (!getOvUrl()) return null;
  const scope = getEnv().OPENVIKING_SCOPE;

  if (scope === 'group') {
    // Check DB for existing per-group key
    let userKey = getOvUserKey(groupFolder);
    if (!userKey) {
      // Provision on first interaction
      userKey = await ovProvisionGroupUser(groupFolder);
    }
    if (!userKey) return null;
    return {
      userKey,
      userId: `group-${groupFolder}`,
      headers: {},
    };
  }

  // Global scope (default): use shared user key + account/user headers
  const userKey = readOvGlobalUserKey();
  if (!userKey) return null;
  return {
    userKey,
    userId: OV_USER,
    headers: {
      'X-OpenViking-Account': OV_ACCOUNT,
      'X-OpenViking-User': OV_USER,
    },
  };
}

/**
 * Transform the XML prompt into a sender-prefixed format for OpenViking.
 * Input:  `<messages>\n<message sender="Alice" time="...">Hello</message>\n</messages>`
 * Output: `[Alice]: Hello`
 *
 * Falls back to the raw prompt if no XML message tags are found.
 */
export function formatPromptForOv(prompt: string): string {
  const messageRegex =
    /<message\s+sender="([^"]*)"\s+time="[^"]*">([^<]*)<\/message>/g;
  const lines: string[] = [];
  let match;
  while ((match = messageRegex.exec(prompt)) !== null) {
    const sender = match[1]!
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"');
    const content = match[2]!
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"');
    lines.push(`[${sender}]: ${content}`);
  }
  if (lines.length === 0) return prompt;
  return lines.join('\n');
}

// WORKSPACE_PATH: actual host path for /workspace inside this container.
// Resolved by inspecting our own container's mount table at startup.
// Falls back to env var WORKSPACE_PATH if set, or empty string (mounts skipped).
let WORKSPACE_PATH_HOST = process.env['WORKSPACE_PATH'] ?? '';
let SKILLS_PATH_HOST = process.env['SKILLS_PATH'] ?? '';

async function resolveHostPaths(): Promise<void> {
  if (WORKSPACE_PATH_HOST && SKILLS_PATH_HOST) return;
  try {
    const selfName = process.env['HOSTNAME'] ?? 'openbob-host';
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
  return `openbob-agent-${groupFolder}`;
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
 * Write the base opencode.json for a group from the workspace template.
 *
 * Reads /workspace/opencode.json as the base template (share, permission, mcp, etc.),
 * overlays the group's model, and writes the result to the group directory.
 * Mounted read-only at /workspace/opencode.json inside the agent container.
 * OpenCode's findUp from CWD (/workspace/data/project) discovers this as the parent config.
 * Agents can create their own /workspace/data/project/opencode.json to override settings.
 *
 * The base config is written fresh each time (no merging with existing per-group config).
 */
const BASE_CONFIG_TEMPLATE = '/workspace/opencode.json';

function writeOpencodeConfig(groupFolder: string, model: string): void {
  const groupDir = path.join(GROUPS_DIR, groupFolder);
  const configPath = path.join(groupDir, 'opencode.json');

  // Read the workspace template, fall back to empty object if not found
  let template: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(BASE_CONFIG_TEMPLATE, 'utf-8');
    template = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      logger.warn('Base opencode.json template not found, using defaults');
    } else {
      throw err;
    }
  }

  // Model is always set dynamically per group
  const config = { ...template, model };

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

  // Create subdirectories for agent's runtime data (all under one group dir)
  const projectDir = path.join(groupDir, 'project');
  const ipcDir = path.join(groupDir, 'ipc');
  const ipcTasksDir = path.join(ipcDir, 'tasks');
  const ipcInputDir = path.join(ipcDir, 'input');
  const opencodeDir = path.join(groupDir, 'opencode');
  const telegramDir = path.join(groupDir, 'telegram');
  for (const dir of [
    projectDir,
    ipcTasksDir,
    ipcInputDir,
    opencodeDir,
    telegramDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o777);
  }

  // Write base opencode.json (mounted ro at /workspace/opencode.json)
  writeOpencodeConfig(groupFolder, model);

  // Copy shared auth.json into group's opencode dir (OpenCode discovers it natively)
  writeAuthConfig(groupFolder);

  // Pre-create context.json so the file bind mount works at container start
  // It will be updated with real values in runAgentSession before each prompt
  const contextFile = path.join(groupDir, 'context.json');
  if (!fs.existsSync(contextFile)) {
    fs.writeFileSync(
      contextFile,
      JSON.stringify({ chatJid: '', groupFolder, isMain: false }, null, 2),
    );
  }

  // Compute host-side path for the group directory mount
  // DATA_PATH_HOST = actual host path for DATA_DIR (for docker run bind mounts)
  const groupDirHost = `${DATA_PATH_HOST}/groups/${groupFolder}`;
  const baseConfigHost = `${groupDirHost}/opencode.json`;
  const contextJsonHost = `${groupDirHost}/context.json`;
  const agentsMdHost = WORKSPACE_PATH_HOST
    ? path.join(WORKSPACE_PATH_HOST, 'AGENTS.md')
    : null;

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
    // Enable built-in websearch tool (Exa AI — no API key required)
    '-e',
    'OPENCODE_ENABLE_EXA=1',
    ...(process.env['OPENCODE_LOG_LEVEL']
      ? ['-e', `OPENCODE_LOG_LEVEL=${process.env['OPENCODE_LOG_LEVEL']}`]
      : []),
    // Forward user-configured env vars to agent container
    ...getForwardEnvArgs(),
    // Agent container layout: everything under /workspace
    // Group data dir — rw (project, ipc, opencode, telegram all inside)
    '-v',
    `${groupDirHost}:/workspace/data`,
    // Base opencode.json — ro (host-controlled model + defaults)
    '-v',
    `${baseConfigHost}:/workspace/opencode.json:ro`,
    // Base AGENTS.md — ro (host-controlled instructions)
    ...(agentsMdHost && fs.existsSync('/workspace/AGENTS.md')
      ? ['-v', `${agentsMdHost}:/workspace/AGENTS.md:ro`]
      : []),
    // Context file — ro (host writes chatJid, groupFolder, isMain before each session)
    '-v',
    `${contextJsonHost}:/workspace/context.json:ro`,
    // Skills — read-only, shared across all agent containers
    ...(SKILLS_PATH_HOST
      ? ['-v', `${SKILLS_PATH_HOST}:/workspace/skills:ro`]
      : []),
    // Labels for cleanup
    '--label',
    `openbob.group=${groupFolder}`,
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

/** Path to the shared auth.json that users place in the data directory. */
const AUTH_JSON_PATH = path.join(DATA_DIR, 'opencode', 'auth.json');

/**
 * Validate that the shared auth.json file exists.
 * Called at host startup — exits with a clear error if missing.
 */
export function validateAuthConfig(): void {
  if (!fs.existsSync(AUTH_JSON_PATH)) {
    console.error(
      `\n❌  Missing auth configuration: ${AUTH_JSON_PATH}\n` +
        `    Copy your OpenCode credentials into the data directory:\n` +
        `      mkdir -p ${path.dirname(AUTH_JSON_PATH)}\n` +
        `      cp ~/.local/share/opencode/auth.json ${AUTH_JSON_PATH}\n`,
    );
    process.exit(1);
  }
  logger.info({ path: AUTH_JSON_PATH }, 'Auth config validated');
}

/**
 * Copy the shared auth.json into a group's opencode directory.
 * The agent container's entrypoint symlinks ~/.local/share/opencode →
 * /workspace/data/opencode, so OpenCode discovers the auth natively.
 */
function writeAuthConfig(groupFolder: string): void {
  const groupDir = path.join(GROUPS_DIR, groupFolder);
  const destPath = path.join(groupDir, 'opencode', 'auth.json');
  const content = fs.readFileSync(AUTH_JSON_PATH, 'utf-8');
  fs.writeFileSync(destPath, content);
  logger.debug({ groupFolder, destPath }, 'Copied auth.json to group');
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
 * Kill and remove all openbob agent containers (cleanup on host shutdown).
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

  // Write context.json to group dir (mounted ro at /workspace/context.json)
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

    // If the session is still busy from a previous interrupted run, abort it
    // so we can reuse the same session (preserving conversation history).
    {
      const preStatus = await client.session.status().catch(() => null);
      if (preStatus?.data?.[sessionId]?.type === 'busy') {
        logger.warn(
          { groupFolder, sessionId },
          'Session still busy before prompt — aborting',
        );
        await client.session
          .abort({ path: { id: sessionId } })
          .catch((err: unknown) =>
            logger.warn(
              { groupFolder, sessionId, err },
              'session.abort failed before prompt',
            ),
          );
        // Wait for the session to become idle after abort
        const abortDeadline = Date.now() + 10_000;
        while (Date.now() < abortDeadline) {
          await new Promise((r) => setTimeout(r, 1_000));
          const s = await client.session.status().catch(() => null);
          if (s?.data?.[sessionId]?.type !== 'busy') break;
        }
        const stillBusy =
          (await client.session.status().catch(() => null))?.data?.[sessionId]
            ?.type === 'busy';
        if (stillBusy) {
          // Fallback: abort didn't work — create new session to avoid being stuck
          logger.warn(
            { groupFolder, sessionId },
            'Session still busy after abort — creating new session as fallback',
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
            'New session created after failed abort',
          );
        }
      }
    }

    // OpenViking: recall relevant memories and inject into system prompt
    let ovSystem: string | undefined;
    const ovCreds = await getOvCredentials(groupFolder);
    const ovPrompt = formatPromptForOv(prompt);
    if (ovCreds) {
      try {
        const sid = encodeURIComponent(sessionId);
        const [, , recalled] = (await Promise.all([
          ovRequest(
            ovCreds.userKey,
            `/sessions/${sid}?auto_create=true`,
            'GET',
            undefined,
            ovCreds.headers,
          ),
          ovRequest(
            ovCreds.userKey,
            `/sessions/${sid}/messages`,
            'POST',
            {
              role: 'user',
              content: ovPrompt,
            },
            ovCreds.headers,
          ),
          ovRequest(
            ovCreds.userKey,
            '/search/find',
            'POST',
            {
              query: ovPrompt,
              target_uri: `viking://user/${ovCreds.userId}/memories`,
              limit: 5,
              score_threshold: 0.1,
            },
            ovCreds.headers,
          ),
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
        // Session not in status map — either not started yet or already finished.
        // OpenCode removes sessions from the status map shortly after completion,
        // so "missing" after a few polls is the normal completion path when we
        // miss the brief "idle" window.
        missingFromStatusCount++;
        if (missingFromStatusCount >= 3) {
          pollExitReason = 'missing';
          break;
        }
      } else {
        missingFromStatusCount = 0;
      }
    }
    logger.info({ groupFolder, sessionId, pollExitReason }, 'Poll loop exited');

    // On timeout, abort the session so the agent stops and the session
    // remains reusable (preserving conversation history).
    if (pollExitReason === 'timeout') {
      logger.warn(
        { groupFolder, sessionId },
        'Session poll timed out — aborting session',
      );
      await client.session
        .abort({ path: { id: sessionId } })
        .catch((err: unknown) =>
          logger.warn({ groupFolder, sessionId, err }, 'session.abort failed'),
        );
      // Wait briefly for the session to settle after abort
      const abortDeadline = Date.now() + 5_000;
      while (Date.now() < abortDeadline) {
        await new Promise((r) => setTimeout(r, RESPONSE_POLL_INTERVAL));
        const s = await client.session.status().catch(() => null);
        if (s?.data?.[sessionId]?.type !== 'busy') break;
      }
    }

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
          messages: summarizeMessages(messages),
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
        {
          groupFolder,
          sessionId,
          parts: assistantMsg.parts,
          messageSummary: summarizeMessages([assistantMsg]),
        },
        'Empty text from OpenCode',
      );
      return {
        status: 'error',
        result: null,
        error: 'Empty response from OpenCode',
      };
    }

    logger.debug(
      {
        groupFolder,
        sessionId,
        chars: text.length,
        text,
        messageSummary: summarizeMessages(messages.slice(-3)),
      },
      'OpenCode response received',
    );

    // OpenViking: store assistant response and commit for memory extraction
    if (ovCreds) {
      try {
        const sid = encodeURIComponent(sessionId);
        await ovRequest(
          ovCreds.userKey,
          `/sessions/${sid}/messages`,
          'POST',
          {
            role: 'assistant',
            content: text,
          },
          ovCreds.headers,
        );
        await ovRequest(
          ovCreds.userKey,
          `/sessions/${sid}/commit`,
          'POST',
          {},
          ovCreds.headers,
        );
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
 * Remove all exited openbob agent containers (orphans from previous runs or crashes).
 */
export async function cleanupStoppedContainers(): Promise<void> {
  try {
    const { stdout } = await execFileAsync(DOCKER, [
      'ps',
      '-aq',
      '--filter',
      'label=openbob.group',
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
      'label=openbob.group',
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
