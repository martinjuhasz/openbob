import { describe, it, expect, vi, beforeEach } from 'vitest'
import { processTaskIpc, IpcDeps } from './ipc.js'
import { GroupConfig } from './types.js'

// Mock the db module
vi.mock('./db.js', () => ({
  getActiveTasks: vi.fn(() => []),
  upsertTask: vi.fn(),
  deleteTask: vi.fn(),
  setRegisteredGroup: vi.fn(),
}))

import { upsertTask, deleteTask, getActiveTasks, setRegisteredGroup } from './db.js'

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

function makeDeps(groups: Record<string, GroupConfig> = {}): IpcDeps & { sent: string[], tasksChanged: number[], registered: GroupConfig[] } {
  const sent: string[] = []
  const tasksChanged: number[] = []
  const registered: GroupConfig[] = []
  return {
    sent,
    tasksChanged,
    registered,
    sendMessage: async (_jid, text) => { sent.push(text) },
    registeredGroups: () => groups,
    onTasksChanged: () => { tasksChanged.push(1) },
    onGroupRegistered: (config) => { registered.push(config) },
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

  describe('register_group', () => {
    it('registers a new group from main group', async () => {
      const deps = makeDeps({})
      await processTaskIpc(
        { type: 'register_group', jid: 'mm:new', name: 'New Group', folder: 'new-group', trigger: 'winston' },
        'main-group',
        true,
        new Map(),
        deps,
      )
      expect(setRegisteredGroup).toHaveBeenCalledOnce()
      expect(deps.registered).toHaveLength(1)
      expect(deps.registered[0]).toMatchObject({ jid: 'mm:new', name: 'New Group', folder: 'new-group' })
    })

    it('blocks registration from non-main group', async () => {
      const deps = makeDeps({})
      await processTaskIpc(
        { type: 'register_group', jid: 'mm:new', name: 'New', folder: 'new', trigger: 'winston' },
        'some-group',
        false,
        new Map(),
        deps,
      )
      expect(setRegisteredGroup).not.toHaveBeenCalled()
      expect(deps.registered).toHaveLength(0)
    })

    it('blocks registration of already-registered jid', async () => {
      const existing = { 'mm:existing': makeGroup({ jid: 'mm:existing', folder: 'existing' }) }
      const deps = makeDeps(existing)
      await processTaskIpc(
        { type: 'register_group', jid: 'mm:existing', name: 'Dup', folder: 'dup', trigger: 'winston' },
        'main-group',
        true,
        new Map(),
        deps,
      )
      expect(setRegisteredGroup).not.toHaveBeenCalled()
    })

    it('blocks registration when folder already in use', async () => {
      const existing = { 'mm:other': makeGroup({ jid: 'mm:other', folder: 'taken' }) }
      const deps = makeDeps(existing)
      await processTaskIpc(
        { type: 'register_group', jid: 'mm:new', name: 'New', folder: 'taken', trigger: 'winston' },
        'main-group',
        true,
        new Map(),
        deps,
      )
      expect(setRegisteredGroup).not.toHaveBeenCalled()
    })

    it('blocks registration with missing fields', async () => {
      const deps = makeDeps({})
      await processTaskIpc(
        { type: 'register_group', jid: 'mm:new' }, // missing name, folder, trigger
        'main-group',
        true,
        new Map(),
        deps,
      )
      expect(setRegisteredGroup).not.toHaveBeenCalled()
    })
  })
})
