import { describe, it, expect, vi, beforeEach } from 'vitest'
import { processTaskIpc, IpcDeps } from './ipc.js'
import { GroupConfig } from './types.js'

// Mock the db module
vi.mock('./db.js', () => ({
  getActiveTasks: vi.fn(() => []),
  upsertTask: vi.fn(),
  deleteTask: vi.fn(),
}))

import { upsertTask, deleteTask, getActiveTasks } from './db.js'

function makeGroup(overrides: Partial<GroupConfig> = {}): GroupConfig {
  return {
    jid: 'mm:abc',
    folder: 'test-group',
    name: 'Test Group',
    trigger: 'yetaclaw',
    channel: 'mattermost',
    isMain: false,
    createdAt: Date.now(),
    ...overrides,
  }
}

function makeDeps(groups: Record<string, GroupConfig> = {}): IpcDeps & { sent: string[], tasksChanged: number[] } {
  const sent: string[] = []
  const tasksChanged: number[] = []
  return {
    sent,
    tasksChanged,
    sendMessage: async (_jid, text) => { sent.push(text) },
    registeredGroups: () => groups,
    onTasksChanged: () => { tasksChanged.push(1) },
  }
}

describe('processTaskIpc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('schedules a cron task from main group', async () => {
    const groups = { 'mm:abc': makeGroup({ isMain: false, folder: 'test-group' }) }
    const deps = makeDeps(groups)
    const folderToJid = new Map([['main-group', 'mm:abc']])

    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'hello',
        scheduleType: 'cron',
        scheduleValue: '* * * * *',
        targetJid: 'mm:abc',
      },
      'main-group',
      true, // isMain
      folderToJid,
      deps,
    )

    expect(upsertTask).toHaveBeenCalledOnce()
    expect(deps.tasksChanged).toHaveLength(1)
  })

  it('blocks non-main group scheduling for another group', async () => {
    const groups = {
      'mm:abc': makeGroup({ folder: 'group-a' }),
      'mm:xyz': makeGroup({ jid: 'mm:xyz', folder: 'group-b' }),
    }
    const deps = makeDeps(groups)
    const folderToJid = new Map<string, string>([['group-a', 'mm:abc'], ['group-b', 'mm:xyz']])

    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'hello',
        scheduleType: 'interval',
        scheduleValue: '60000',
        targetJid: 'mm:xyz', // targeting a different group
      },
      'group-a', // sourceGroup
      false, // not main
      folderToJid,
      deps,
    )

    expect(upsertTask).not.toHaveBeenCalled()
  })

  it('cancels a task from authorised group', async () => {
    const task = {
      id: 'task-1',
      jid: 'mm:abc',
      groupFolder: 'test-group',
      prompt: 'x',
      scheduleType: 'once' as const,
      scheduleValue: '2026-01-01T00:00:00.000Z',
      contextMode: 'isolated' as const,
      status: 'active' as const,
      nextRun: Date.now(),
      createdAt: Date.now(),
      createdBy: 'test',
    }
    vi.mocked(getActiveTasks).mockReturnValue([task])

    const groups = { 'mm:abc': makeGroup() }
    const deps = makeDeps(groups)
    const folderToJid = new Map([['test-group', 'mm:abc']])

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-1' },
      'test-group',
      false,
      folderToJid,
      deps,
    )

    expect(deleteTask).toHaveBeenCalledWith('task-1')
    expect(deps.tasksChanged).toHaveLength(1)
  })

  it('rejects cancel from unauthorized group', async () => {
    const task = {
      id: 'task-1',
      jid: 'mm:abc',
      groupFolder: 'other-group',
      prompt: 'x',
      scheduleType: 'once' as const,
      scheduleValue: '2026-01-01T00:00:00.000Z',
      contextMode: 'isolated' as const,
      status: 'active' as const,
      nextRun: Date.now(),
      createdAt: Date.now(),
      createdBy: 'test',
    }
    vi.mocked(getActiveTasks).mockReturnValue([task])

    const groups = { 'mm:abc': makeGroup() }
    const deps = makeDeps(groups)
    const folderToJid = new Map([['test-group', 'mm:abc']])

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-1' },
      'test-group', // sourceGroup doesn't own task
      false,
      folderToJid,
      deps,
    )

    expect(deleteTask).not.toHaveBeenCalled()
  })

  it('logs warning for unknown IPC type', async () => {
    const deps = makeDeps()
    const folderToJid = new Map<string, string>()
    // Should not throw
    await processTaskIpc(
      { type: 'unknown_type' },
      'test-group',
      false,
      folderToJid,
      deps,
    )
  })
})
