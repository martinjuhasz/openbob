// Per-group concurrency queue — max concurrent agents, exponential backoff on failure

import { logger } from './logger.js'

const MAX_RETRIES = 5
const BASE_RETRY_MS = 5_000

interface QueuedTask {
  id: string
  groupJid: string
  fn: () => Promise<void>
}

interface GroupState {
  active: boolean
  pendingMessages: boolean
  pendingTasks: QueuedTask[]
  runningTaskId: string | null
  isTaskRun: boolean
  retryCount: number
}

export class GroupQueue {
  private groups = new Map<string, GroupState>()
  private activeCount = 0
  private waitingGroups: string[] = []
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null = null
  private shuttingDown = false
  private maxConcurrent: number

  constructor(maxConcurrent?: number) {
    this.maxConcurrent = maxConcurrent ?? parseInt(process.env['MAX_CONCURRENT_AGENTS'] ?? '5', 10)
  }

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid)
    if (!state) {
      state = {
        active: false,
        pendingMessages: false,
        pendingTasks: [],
        runningTaskId: null,
        isTaskRun: false,
        retryCount: 0,
      }
      this.groups.set(groupJid, state)
    }
    return state
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) return
    const state = this.getGroup(groupJid)

    if (state.active) {
      state.pendingMessages = true
      logger.debug({ groupJid }, 'Agent active, message queued')
      return
    }

    if (this.activeCount >= this.maxConcurrent) {
      state.pendingMessages = true
      if (!this.waitingGroups.includes(groupJid)) this.waitingGroups.push(groupJid)
      logger.debug({ groupJid, activeCount: this.activeCount }, 'At concurrency limit, message queued')
      return
    }

    this.runForGroup(groupJid, 'messages').catch((err) =>
      logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
    )
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return
    const state = this.getGroup(groupJid)

    if (state.runningTaskId === taskId || state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued or running, skipping')
      return
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn })
      logger.debug({ groupJid, taskId }, 'Agent active, task queued')
      return
    }

    if (this.activeCount >= this.maxConcurrent) {
      state.pendingTasks.push({ id: taskId, groupJid, fn })
      if (!this.waitingGroups.includes(groupJid)) this.waitingGroups.push(groupJid)
      logger.debug({ groupJid, taskId, activeCount: this.activeCount }, 'At concurrency limit, task queued')
      return
    }

    this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) =>
      logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
    )
  }

  private async runForGroup(groupJid: string, reason: 'messages' | 'drain'): Promise<void> {
    const state = this.getGroup(groupJid)
    state.active = true
    state.pendingMessages = false
    state.isTaskRun = false
    this.activeCount++

    logger.debug({ groupJid, reason, activeCount: this.activeCount }, 'Starting agent for group')

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid)
        if (success) {
          state.retryCount = 0
        } else {
          this.scheduleRetry(groupJid, state)
        }
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages')
      this.scheduleRetry(groupJid, state)
    } finally {
      state.active = false
      this.activeCount--
      this.drainGroup(groupJid)
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid)
    state.active = true
    state.isTaskRun = true
    state.runningTaskId = task.id
    this.activeCount++

    logger.debug({ groupJid, taskId: task.id, activeCount: this.activeCount }, 'Running task')

    try {
      await task.fn()
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task')
    } finally {
      state.active = false
      state.isTaskRun = false
      state.runningTaskId = null
      this.activeCount--
      this.drainGroup(groupJid)
    }
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    state.retryCount++
    if (state.retryCount > MAX_RETRIES) {
      logger.error({ groupJid, retryCount: state.retryCount }, 'Max retries exceeded, resetting')
      state.retryCount = 0
      return
    }
    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1)
    logger.info({ groupJid, retryCount: state.retryCount, delayMs }, 'Scheduling retry')
    setTimeout(() => {
      if (!this.shuttingDown) this.enqueueMessageCheck(groupJid)
    }, delayMs)
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return
    const state = this.getGroup(groupJid)

    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!
      this.runTask(groupJid, task).catch((err) =>
        logger.error({ groupJid, taskId: task.id, err }, 'Unhandled error in runTask (drain)'),
      )
      return
    }

    if (state.pendingMessages) {
      this.runForGroup(groupJid, 'drain').catch((err) =>
        logger.error({ groupJid, err }, 'Unhandled error in runForGroup (drain)'),
      )
      return
    }

    this.drainWaiting()
  }

  private drainWaiting(): void {
    while (this.waitingGroups.length > 0 && this.activeCount < this.maxConcurrent) {
      const nextJid = this.waitingGroups.shift()!
      const state = this.getGroup(nextJid)

      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!
        this.runTask(nextJid, task).catch((err) =>
          logger.error({ groupJid: nextJid, taskId: task.id, err }, 'Unhandled error (waiting)'),
        )
      } else if (state.pendingMessages) {
        this.runForGroup(nextJid, 'drain').catch((err) =>
          logger.error({ groupJid: nextJid, err }, 'Unhandled error (waiting)'),
        )
      }
    }
  }

  get active(): number {
    return this.activeCount
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    logger.info({ activeCount: this.activeCount }, 'GroupQueue shutting down')
  }
}
