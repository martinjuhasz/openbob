// Docker container runner — spawns yetaclaw-agent containers
// Each group gets one agent container running the OpenCode server
// Host connects via HTTP using the OpenCode SDK client

import { exec, execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { createOpencodeClient } from '@opencode-ai/sdk'
import { promisify } from 'util'

import { DATA_DIR, GROUPS_DIR, IDLE_TIMEOUT } from './config.js'
import { setSession, getSession } from './db.js'
import { logger } from './logger.js'
import { ContainerInput, ContainerOutput } from './types.js'

const execAsync = promisify(exec)

const DOCKER = 'docker'
const AGENT_IMAGE = process.env['AGENT_IMAGE'] ?? 'yetaclaw-agent:latest'
const DOCKER_NETWORK = process.env['DOCKER_NETWORK'] ?? 'yetaclaw'
// DATA_PATH: absolute path on the Docker host (same value used in compose bind mount)
const DATA_PATH_HOST = process.env['DATA_PATH'] ?? DATA_DIR
const OPENCODE_PORT = 4096
const SERVER_READY_TIMEOUT = 30_000 // 30s
const SERVER_POLL_INTERVAL = 500 // 0.5s
// API keys to configure on agent containers after startup
// Key: providerID (e.g. 'anthropic', 'openrouter'), Value: API key
const PROVIDER_API_KEYS: Record<string, string> = {}
if (process.env['ANTHROPIC_API_KEY']) PROVIDER_API_KEYS['anthropic'] = process.env['ANTHROPIC_API_KEY']
if (process.env['OPENROUTER_API_KEY']) PROVIDER_API_KEYS['openrouter'] = process.env['OPENROUTER_API_KEY']

// Track running containers per group: folder → name
const activeContainers = new Map<string, string>()
// Deduplicate concurrent spawn calls for the same group
const spawnInProgress = new Map<string, Promise<string>>()

function containerName(groupFolder: string): string {
  return `yetaclaw-agent-${groupFolder}`
}

/**
 * Spawn the agent container for a group.
 * Returns the container name (reachable via Docker network).
 */
async function spawnContainer(groupFolder: string): Promise<string> {
  const name = containerName(groupFolder)

  // Clean up any previous stopped container with same name
  await execAsync(`${DOCKER} rm -f ${name}`).catch(() => {})

  const groupDir = path.join(GROUPS_DIR, groupFolder)
  fs.mkdirSync(groupDir, { recursive: true })
  fs.chmodSync(groupDir, 0o777)

  const ipcDir = path.join(DATA_DIR, 'ipc', groupFolder)
  fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true })
  fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true })
  fs.chmodSync(ipcDir, 0o777)

  // Pre-create /data/opencode so the node user can access it in the agent container
  const opencodeDir = path.join(DATA_DIR, 'opencode')
  fs.mkdirSync(opencodeDir, { recursive: true })
  fs.chmodSync(opencodeDir, 0o777)

  const globalDir = path.join(GROUPS_DIR, 'global')

  // No port publish needed — host connects via Docker network using container name
  // Note: no --rm so we can fetch logs on crash; containers are cleaned up in spawnContainer
  const cmd = [
    DOCKER, 'run', '-d',
    '--name', name,
    '--network', DOCKER_NETWORK,
    // Environment
    '-e', `OPENCODE_PORT=${OPENCODE_PORT}`,
    // Data dir — bind mount, same absolute host path as in compose
    '-v', `${DATA_PATH_HOST}:/data`,
    // Workspace mounts
    '-v', `${groupDir}:/workspace/group`,
    ...(fs.existsSync(globalDir) ? [
      '-v', `${globalDir}:/workspace/global:ro`,
      // Mount AGENTS.md one level up so OpenCode finds it when traversing from /workspace/group
      ...(fs.existsSync(path.join(globalDir, 'AGENTS.md'))
        ? ['-v', `${path.join(globalDir, 'AGENTS.md')}:/workspace/AGENTS.md:ro`]
        : []),
    ] : []),
    '-v', `${ipcDir}:/workspace/ipc`,
    // Labels for cleanup
    '--label', `yetaclaw.group=${groupFolder}`,
    AGENT_IMAGE,
  ]

  logger.info({ groupFolder, name }, 'Spawning agent container')
  await execAsync(cmd.join(' '))

  activeContainers.set(groupFolder, name)
  logger.info({ groupFolder, name }, 'Agent container started')
  return name
}

/**
 * Wait for OpenCode server health check to pass (via Docker network hostname).
 */
async function waitForServer(containerName: string): Promise<void> {
  const baseUrl = `http://${containerName}:${OPENCODE_PORT}`
  const deadline = Date.now() + SERVER_READY_TIMEOUT
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/session`)
      if (res.ok) return
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, SERVER_POLL_INTERVAL))
  }
  // Collect container logs for diagnostics before failing
  const { stdout: containerLogs } = await execAsync(
    `${DOCKER} logs --tail 50 ${containerName} 2>&1`,
  ).catch(() => ({ stdout: '(could not fetch logs)' }))
  logger.error({ containerName, containerLogs }, 'Agent container logs on timeout')
  throw new Error(`OpenCode server at ${baseUrl} did not become ready in time`)
}

/**
 * Configure provider API keys on a freshly started agent container.
 */
async function configureAuth(containerName: string): Promise<void> {
  if (Object.keys(PROVIDER_API_KEYS).length === 0) return
  const client = createOpencodeClient({ baseUrl: `http://${containerName}:${OPENCODE_PORT}` })
  for (const [providerID, key] of Object.entries(PROVIDER_API_KEYS)) {
    const res = await client.auth.set({
      path: { id: providerID },
      body: { type: 'api', key },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((res as any).error) {
      logger.warn({ containerName, providerID, error: (res as any).error }, 'Failed to configure provider auth')
    } else {
      logger.info({ containerName, providerID }, 'Provider API key configured on agent container')
    }
  }
}

/**
 * Get or reuse an existing agent container for a group.
 * Returns the container name for direct Docker network access.
 * Deduplicates concurrent spawn calls for the same group.
 */
async function getAgentContainer(groupFolder: string): Promise<string> {
  const existing = activeContainers.get(groupFolder)
  if (existing) {
    // Verify container still running
    try {
      execSync(`${DOCKER} inspect ${existing}`, { stdio: 'pipe' })
      return existing
    } catch {
      activeContainers.delete(groupFolder)
    }
  }

  // Deduplicate concurrent spawns for the same group
  const inFlight = spawnInProgress.get(groupFolder)
  if (inFlight) return inFlight

  const p = (async () => {
    const name = await spawnContainer(groupFolder)
    await waitForServer(name)
    await configureAuth(name)
    return name
  })().finally(() => spawnInProgress.delete(groupFolder))

  spawnInProgress.set(groupFolder, p)
  return p
}

/**
 * Stop and remove a group's agent container.
 */
export async function stopGroupContainer(groupFolder: string): Promise<void> {
  const name = activeContainers.get(groupFolder)
  if (!name) return
  await execAsync(`${DOCKER} rm -f ${name}`).catch(() => {})
  activeContainers.delete(groupFolder)
  logger.info({ groupFolder }, 'Agent container stopped and removed')
}

/**
 * Kill and remove all yetaclaw agent containers (cleanup on host shutdown).
 */
export async function stopAllContainers(): Promise<void> {
  const names = [...activeContainers.values()]
  if (names.length === 0) return
  await execAsync(`${DOCKER} rm -f ${names.join(' ')}`).catch(() => {})
  activeContainers.clear()
  logger.info({ count: names.length }, 'All agent containers stopped and removed')
}

/**
 * Run an agent session for a group: spawn container (or reuse), send prompt, return response.
 */
export async function runAgentSession(input: ContainerInput): Promise<ContainerOutput> {
  const { groupFolder, prompt, chatJid, isMain, providerID, modelID } = input

  let agentName: string
  try {
    agentName = await getAgentContainer(groupFolder)
  } catch (err) {
    logger.error({ groupFolder, err }, 'Failed to get agent container')
    return { status: 'error', result: null, error: String(err) }
  }

  const client = createOpencodeClient({ baseUrl: `http://${agentName}:${OPENCODE_PORT}` })

  // Write context.json so the agent knows its own chatJid for IPC
  const contextFile = path.join(GROUPS_DIR, groupFolder, 'context.json')
  fs.writeFileSync(contextFile, JSON.stringify({ chatJid, groupFolder }, null, 2))

  // Resume existing session or create new one
  let sessionId = input.sessionId ?? getSession(groupFolder) ?? undefined

  try {
    if (sessionId) {
      // Verify session still exists (SDK doesn't throw by default — check .data)
      const getRes = await client.session.get({ path: { id: sessionId } })
      if (!getRes.data) {
        logger.info({ groupFolder, sessionId }, 'Session not found, creating new one')
        sessionId = undefined
      }
    }

    if (!sessionId) {
      const session = await client.session.create({
        body: { title: `${groupFolder}/${chatJid}` },
      })
      sessionId = session.data!.id as string
      setSession(groupFolder, sessionId)
      logger.info({ groupFolder, sessionId }, 'New OpenCode session created')
    }

    // Fire prompt async (returns 204, not the assistant message)
    const asyncRes = await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        model: { providerID, modelID },
        parts: [{ type: 'text', text: prompt }],
      },
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((asyncRes as any).error) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const e = (asyncRes as any).error
      const errMsg = e?.data?.message ?? JSON.stringify(e)
      logger.error({ groupFolder, sessionId, error: e }, 'promptAsync error')
      return { status: 'error', result: null, error: errMsg }
    }

    // Poll session status until idle
    const POLL_TIMEOUT = 120_000 // 2 min
    const POLL_INTERVAL = 1_000
    const deadline = Date.now() + POLL_TIMEOUT
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL))
      const statusRes = await client.session.status()
      const sessionStatus = statusRes.data?.[sessionId]
      const statusType = sessionStatus?.type
      logger.info({ groupFolder, sessionId, statusType, allStatuses: statusRes.data }, 'Session status poll')
      if (statusType === 'idle') break
    }

    // Fetch messages and find last assistant message
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messagesRes = await client.session.messages({ path: { id: sessionId } }) as any
    const messages: Array<{ info: { role: string; error?: unknown }; parts: Array<{ type: string; text?: string }> }> =
      messagesRes.data ?? []

    // Find last assistant message (in reverse)
    const assistantMsg = [...messages].reverse().find((m) => m.info?.role === 'assistant')

    if (!assistantMsg) {
      logger.warn({ groupFolder, sessionId, messageCount: messages.length, roles: messages.map((m) => m.info?.role) }, 'No assistant message found after prompt')
      return { status: 'error', result: null, error: 'No assistant message from OpenCode' }
    }

    // Check for model/auth error
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msgError = (assistantMsg.info as any)?.error
    if (msgError) {
      const errMsg =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (msgError as any)?.data?.message ?? JSON.stringify(msgError)
      logger.error({ groupFolder, sessionId, msgError }, 'OpenCode model/auth error')
      return { status: 'error', result: null, error: errMsg }
    }

    const text = (assistantMsg.parts ?? [])
      .filter((p) => p.type === 'text' && p.text)
      .map((p) => p.text)
      .join('')

    if (!text) {
      logger.warn({ groupFolder, sessionId, parts: assistantMsg.parts }, 'Empty text from OpenCode')
      return { status: 'error', result: null, error: 'Empty response from OpenCode' }
    }

    return { status: 'success', result: text, newSessionId: sessionId }
  } catch (err) {
    logger.error({ groupFolder, sessionId, err }, 'OpenCode session error')
    return { status: 'error', result: null, error: String(err) }
  }
}

/**
 * Pre-warm agent containers for all registered groups so they're ready on first message.
 */
export async function warmUpContainers(groupFolders: string[]): Promise<void> {
  if (groupFolders.length === 0) return
  await cleanupStoppedContainers()
  logger.info({ count: groupFolders.length }, 'Pre-warming agent containers')
  await Promise.allSettled(
    groupFolders.map(async (folder) => {
      try {
        await getAgentContainer(folder)
        logger.info({ folder }, 'Agent container pre-warmed')
      } catch (err) {
        logger.warn({ folder, err }, 'Pre-warm failed — will retry on first message')
      }
    }),
  )
}

/**
 * Remove all exited yetaclaw agent containers (orphans from previous runs or crashes).
 */
export async function cleanupStoppedContainers(): Promise<void> {
  try {
    const { stdout } = await execAsync(
      `${DOCKER} ps -aq --filter label=yetaclaw.group --filter status=exited --filter status=dead`,
    )
    const ids = stdout.trim().split('\n').filter(Boolean)
    if (ids.length === 0) return
    await execAsync(`${DOCKER} rm ${ids.join(' ')}`).catch(() => {})
    logger.info({ count: ids.length }, 'Removed stopped agent containers')
  } catch {
    // Docker not available or no containers — ignore
  }
}
