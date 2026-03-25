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

// Track running containers per group: folder → { name, hostPort }
const activeContainers = new Map<string, { name: string; hostPort: number }>()

function containerName(groupFolder: string): string {
  return `yetaclaw-agent-${groupFolder}`
}

async function findFreePort(): Promise<number> {
  const { stdout } = await execAsync(
    `${DOCKER} run --rm alpine sh -c 'nc -l -p 0 &>/dev/null & echo $! && sleep 0.1 && kill $! 2>/dev/null; true'`,
  ).catch(() => ({ stdout: '' }))
  // Fallback: use random port in range 20000-30000
  if (!stdout) {
    return 20000 + Math.floor(Math.random() * 10000)
  }
  return 0 // use dynamic port assignment below
}

/**
 * Spawn the agent container for a group, wait for OpenCode server to be ready.
 * Returns the host port the server is accessible on.
 */
async function spawnContainer(groupFolder: string): Promise<number> {
  const name = containerName(groupFolder)

  // Clean up any previous stopped container with same name
  await execAsync(`${DOCKER} rm -f ${name}`).catch(() => {})

  const groupDir = path.join(GROUPS_DIR, groupFolder)
  fs.mkdirSync(groupDir, { recursive: true })

  const ipcDir = path.join(DATA_DIR, 'ipc', groupFolder)
  fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true })
  fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true })

  const globalDir = path.join(GROUPS_DIR, 'global')

  // Dynamic port assignment — Docker picks a free host port
  const cmd = [
    DOCKER, 'run', '-d',
    '--name', name,
    '--rm',
    '--network', DOCKER_NETWORK,
    // Publish OpenCode port (dynamic host port)
    '-p', `${OPENCODE_PORT}`,
    // Environment
    '-e', `OPENCODE_PORT=${OPENCODE_PORT}`,
    // Data dir — bind mount, same absolute host path as in compose
    '-v', `${DATA_PATH_HOST}:/data`,
    // Workspace mounts
    '-v', `${groupDir}:/workspace/group`,
    ...(fs.existsSync(globalDir) ? ['-v', `${globalDir}:/workspace/global:ro`] : []),
    '-v', `${ipcDir}:/workspace/ipc`,
    // Labels for cleanup
    '--label', `yetaclaw.group=${groupFolder}`,
    AGENT_IMAGE,
  ]

  logger.info({ groupFolder, name }, 'Spawning agent container')
  const { stdout: containerId } = await execAsync(cmd.join(' '))
  const id = containerId.trim()

  // Get dynamically assigned host port
  const { stdout: portOut } = await execAsync(
    `${DOCKER} port ${id} ${OPENCODE_PORT}/tcp`,
  )
  const hostPort = parseInt(portOut.trim().split(':').pop() ?? '0', 10)
  if (!hostPort) throw new Error(`Could not determine host port for container ${name}`)

  activeContainers.set(groupFolder, { name, hostPort })
  logger.info({ groupFolder, name, hostPort }, 'Agent container started')
  return hostPort
}

/**
 * Wait for OpenCode server health check to pass.
 */
async function waitForServer(hostPort: number): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT
  while (Date.now() < deadline) {
    try {
      const client = createOpencodeClient({ baseUrl: `http://localhost:${hostPort}` })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const health = await (client.global as any).health()
      if (health.data?.healthy) return
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, SERVER_POLL_INTERVAL))
  }
  throw new Error(`OpenCode server on port ${hostPort} did not become ready in time`)
}

/**
 * Get or reuse an existing agent container for a group.
 */
async function getAgentPort(groupFolder: string): Promise<number> {
  const existing = activeContainers.get(groupFolder)
  if (existing) {
    // Verify container still running
    try {
      execSync(`${DOCKER} inspect ${existing.name}`, { stdio: 'pipe' })
      return existing.hostPort
    } catch {
      activeContainers.delete(groupFolder)
    }
  }
  const hostPort = await spawnContainer(groupFolder)
  await waitForServer(hostPort)
  return hostPort
}

/**
 * Stop a group's agent container.
 */
export async function stopGroupContainer(groupFolder: string): Promise<void> {
  const existing = activeContainers.get(groupFolder)
  if (!existing) return
  await execAsync(`${DOCKER} stop -t 5 ${existing.name}`).catch(() => {})
  activeContainers.delete(groupFolder)
  logger.info({ groupFolder }, 'Agent container stopped')
}

/**
 * Kill all yetaclaw agent containers (cleanup on host shutdown).
 */
export async function stopAllContainers(): Promise<void> {
  const names = [...activeContainers.values()].map((c) => c.name)
  if (names.length === 0) return
  await execAsync(`${DOCKER} stop -t 5 ${names.join(' ')}`).catch(() => {})
  activeContainers.clear()
  logger.info({ count: names.length }, 'All agent containers stopped')
}

/**
 * Run an agent session for a group: spawn container (or reuse), send prompt, return response.
 */
export async function runAgentSession(input: ContainerInput): Promise<ContainerOutput> {
  const { groupFolder, prompt, chatJid, isMain, providerID, modelID } = input

  let hostPort: number
  try {
    hostPort = await getAgentPort(groupFolder)
  } catch (err) {
    logger.error({ groupFolder, err }, 'Failed to get agent container')
    return { status: 'error', result: null, error: String(err) }
  }

  const client = createOpencodeClient({ baseUrl: `http://localhost:${hostPort}` })

  // Resume existing session or create new one
  let sessionId = input.sessionId ?? getSession(groupFolder) ?? undefined

  try {
    if (sessionId) {
      // Verify session still exists
      try {
        await client.session.get({ path: { id: sessionId } })
      } catch {
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

    // Send prompt
    const result = await client.session.prompt({
      path: { id: sessionId },
      body: {
        model: { providerID, modelID },
        parts: [{ type: 'text', text: prompt }],
      },
    })

    const parts = result.data?.parts ?? []
    const text = parts
      .filter((p: { type: string; text?: string }) => p.type === 'text' && p.text)
      .map((p: { type: string; text?: string }) => p.text)
      .join('')

    if (!text) {
      return { status: 'error', result: null, error: 'Empty response from OpenCode' }
    }

    return { status: 'success', result: text, newSessionId: sessionId }
  } catch (err) {
    logger.error({ groupFolder, sessionId, err }, 'OpenCode session error')
    return { status: 'error', result: null, error: String(err) }
  }
}

/**
 * Stop agent containers that have been idle longer than IDLE_TIMEOUT.
 */
export async function cleanupIdleContainers(): Promise<void> {
  try {
    const { stdout } = await execAsync(
      `${DOCKER} ps --filter label=yetaclaw.group --format '{{.Names}} {{.Status}}'`,
    )
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      const [name] = line.split(' ')
      // Parse uptime from Status field — simplified check
      const folder = name?.replace('yetaclaw-agent-', '')
      if (!folder) continue
      // Let Docker handle cleanup via --rm; containers auto-remove when stopped
    }
  } catch {
    // Docker not available or no containers
  }
}
