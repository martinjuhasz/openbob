import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  processTaskIpc,
  resolveContainerPath,
  formatIpcOutbound,
  IpcDeps,
} from './ipc.js';
import { GroupConfig } from './types.js';

// Mock the db module
vi.mock('./db.js', () => ({
  getActiveTasks: vi.fn(() => []),
  getTaskById: vi.fn(() => undefined),
  getTasksForGroup: vi.fn(() => []),
  getAllTasks: vi.fn(() => []),
  getAllRegisteredGroups: vi.fn(() => ({})),
  updateTask: vi.fn(),
  upsertTask: vi.fn(),
  deleteTask: vi.fn(),
  deleteRegisteredGroup: vi.fn(),
  migrateGroupJid: vi.fn(() => true),
  setRegisteredGroup: vi.fn(),
  deleteSession: vi.fn(),
  setSession: vi.fn(),
  getSession: vi.fn(() => null),
}));

// Mock the container-runner module
vi.mock('./container-runner.js', () => ({
  listAgentSessions: vi.fn(async () => []),
  validateAgentSession: vi.fn(async () => false),
}));

// Mock fs for list_tasks response file writing
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
    },
  };
});

import fs from 'fs';

import {
  upsertTask,
  deleteTask,
  getActiveTasks,
  getTaskById,
  getTasksForGroup,
  getAllTasks,
  getAllRegisteredGroups,
  updateTask,
  deleteRegisteredGroup,
  migrateGroupJid,
  setRegisteredGroup,
  deleteSession,
  setSession,
  getSession,
} from './db.js';

import { listAgentSessions, validateAgentSession } from './container-runner.js';

function makeGroup(overrides: Partial<GroupConfig> = {}): GroupConfig {
  return {
    jid: 'tg:abc',
    folder: 'test-group',
    name: 'Test Group',
    trigger: 'openbob',
    channel: 'telegram',
    isMain: false,
    alwaysRespond: false,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeDeps(groups: Record<string, GroupConfig> = {}): IpcDeps & {
  sent: string[];
  photosSent: Array<{ source: string; caption?: string }>;
  documentsSent: Array<{ source: string; caption?: string }>;
  tasksChanged: number[];
  registered: GroupConfig[];
  updated: Array<{ config: GroupConfig; oldJid?: string }>;
  deleted: Array<{ folder: string; jid: string }>;
} {
  const sent: string[] = [];
  const photosSent: Array<{ source: string; caption?: string }> = [];
  const documentsSent: Array<{ source: string; caption?: string }> = [];
  const tasksChanged: number[] = [];
  const registered: GroupConfig[] = [];
  const updated: Array<{ config: GroupConfig; oldJid?: string }> = [];
  const deleted: Array<{ folder: string; jid: string }> = [];
  return {
    sent,
    photosSent,
    documentsSent,
    tasksChanged,
    registered,
    updated,
    deleted,
    sendMessage: async (_jid, text) => {
      sent.push(text);
    },
    sendPhoto: async (_jid, source, caption) => {
      photosSent.push({ source, caption });
    },
    sendDocument: async (_jid, source, caption) => {
      documentsSent.push({ source, caption });
    },
    registeredGroups: () => groups,
    onTasksChanged: () => {
      tasksChanged.push(1);
    },
    onGroupRegistered: (config) => {
      registered.push(config);
    },
    onGroupUpdated: (config, oldJid) => {
      updated.push({ config, oldJid });
    },
    onGroupDeleted: (folder, jid) => {
      deleted.push({ folder, jid });
    },
  };
}

describe('processTaskIpc', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('schedules a cron task from main group', async () => {
    const groups = {
      'tg:abc': makeGroup({ isMain: false, folder: 'test-group' }),
    };
    const deps = makeDeps(groups);
    const folderToJid = new Map([['main-group', 'tg:abc']]);

    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'hello',
        scheduleType: 'cron',
        scheduleValue: '* * * * *',
        targetJid: 'tg:abc',
      },
      'main-group',
      true, // isMain
      folderToJid,
      deps,
    );

    expect(upsertTask).toHaveBeenCalledOnce();
    expect(deps.tasksChanged).toHaveLength(1);
  });

  it('blocks non-main group scheduling for another group', async () => {
    const groups = {
      'tg:abc': makeGroup({ folder: 'group-a' }),
      'tg:xyz': makeGroup({ jid: 'tg:xyz', folder: 'group-b' }),
    };
    const deps = makeDeps(groups);
    const folderToJid = new Map<string, string>([
      ['group-a', 'tg:abc'],
      ['group-b', 'tg:xyz'],
    ]);

    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'hello',
        scheduleType: 'interval',
        scheduleValue: '60000',
        targetJid: 'tg:xyz', // targeting a different group
      },
      'group-a', // sourceGroup
      false, // not main
      folderToJid,
      deps,
    );

    expect(upsertTask).not.toHaveBeenCalled();
  });

  it('cancels a task from authorised group', async () => {
    const task = {
      id: 'task-1',
      jid: 'tg:abc',
      group_folder: 'test-group',
      prompt: 'x',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      status: 'active' as const,
      next_run: Date.now(),
      created_at: Date.now(),
      created_by: 'test',
    };
    vi.mocked(getActiveTasks).mockReturnValue([task]);

    const groups = { 'tg:abc': makeGroup() };
    const deps = makeDeps(groups);
    const folderToJid = new Map([['test-group', 'tg:abc']]);

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-1' },
      'test-group',
      false,
      folderToJid,
      deps,
    );

    expect(deleteTask).toHaveBeenCalledWith('task-1');
    expect(deps.tasksChanged).toHaveLength(1);
  });

  it('rejects cancel from unauthorized group', async () => {
    const task = {
      id: 'task-1',
      jid: 'tg:abc',
      group_folder: 'other-group',
      prompt: 'x',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      status: 'active' as const,
      next_run: Date.now(),
      created_at: Date.now(),
      created_by: 'test',
    };
    vi.mocked(getActiveTasks).mockReturnValue([task]);

    const groups = { 'tg:abc': makeGroup() };
    const deps = makeDeps(groups);
    const folderToJid = new Map([['test-group', 'tg:abc']]);

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-1' },
      'test-group', // sourceGroup doesn't own task
      false,
      folderToJid,
      deps,
    );

    expect(deleteTask).not.toHaveBeenCalled();
  });

  it('logs warning for unknown IPC type', async () => {
    const deps = makeDeps();
    const folderToJid = new Map<string, string>();
    // Should not throw
    await processTaskIpc(
      { type: 'unknown_type' },
      'test-group',
      false,
      folderToJid,
      deps,
    );
  });

  describe('register_group', () => {
    it('registers a new group from main group', async () => {
      const deps = makeDeps({});
      await processTaskIpc(
        {
          type: 'register_group',
          jid: 'tg:new',
          name: 'New Group',
          folder: 'new-group',
          trigger: 'Bob',
        },
        'main-group',
        true,
        new Map(),
        deps,
      );
      expect(setRegisteredGroup).toHaveBeenCalledOnce();
      expect(deps.registered).toHaveLength(1);
      expect(deps.registered[0]).toMatchObject({
        jid: 'tg:new',
        name: 'New Group',
        folder: 'new-group',
        channel: 'telegram',
      });
    });

    it('derives telegram channel from tg: prefix', async () => {
      const deps = makeDeps({});
      await processTaskIpc(
        {
          type: 'register_group',
          jid: 'tg:-1001234567890',
          name: 'TG Group',
          folder: 'tg-group',
          trigger: 'bot',
        },
        'main-group',
        true,
        new Map(),
        deps,
      );
      expect(setRegisteredGroup).toHaveBeenCalledOnce();
      expect(deps.registered[0]).toMatchObject({
        jid: 'tg:-1001234567890',
        channel: 'telegram',
      });
    });

    it('blocks registration from non-main group', async () => {
      const deps = makeDeps({});
      await processTaskIpc(
        {
          type: 'register_group',
          jid: 'tg:new',
          name: 'New',
          folder: 'new',
          trigger: 'Bob',
        },
        'some-group',
        false,
        new Map(),
        deps,
      );
      expect(setRegisteredGroup).not.toHaveBeenCalled();
      expect(deps.registered).toHaveLength(0);
    });

    it('blocks registration of already-registered jid', async () => {
      const existing = {
        'tg:existing': makeGroup({ jid: 'tg:existing', folder: 'existing' }),
      };
      const deps = makeDeps(existing);
      await processTaskIpc(
        {
          type: 'register_group',
          jid: 'tg:existing',
          name: 'Dup',
          folder: 'dup',
          trigger: 'Bob',
        },
        'main-group',
        true,
        new Map(),
        deps,
      );
      expect(setRegisteredGroup).not.toHaveBeenCalled();
    });

    it('blocks registration when folder already in use', async () => {
      const existing = {
        'tg:other': makeGroup({ jid: 'tg:other', folder: 'taken' }),
      };
      const deps = makeDeps(existing);
      await processTaskIpc(
        {
          type: 'register_group',
          jid: 'tg:new',
          name: 'New',
          folder: 'taken',
          trigger: 'Bob',
        },
        'main-group',
        true,
        new Map(),
        deps,
      );
      expect(setRegisteredGroup).not.toHaveBeenCalled();
    });

    it('blocks registration with missing fields', async () => {
      const deps = makeDeps({});
      await processTaskIpc(
        { type: 'register_group', jid: 'tg:new' }, // missing name, folder, trigger
        'main-group',
        true,
        new Map(),
        deps,
      );
      expect(setRegisteredGroup).not.toHaveBeenCalled();
    });

    it('blocks registration with invalid folder name', async () => {
      const deps = makeDeps({});
      await processTaskIpc(
        {
          type: 'register_group',
          jid: 'tg:new',
          name: 'New',
          folder: '../../escape',
          trigger: 'w',
        },
        'main-group',
        true,
        new Map(),
        deps,
      );
      expect(setRegisteredGroup).not.toHaveBeenCalled();
    });

    it('sets alwaysRespond from field', async () => {
      const deps = makeDeps({});
      await processTaskIpc(
        {
          type: 'register_group',
          jid: 'tg:new',
          name: 'New',
          folder: 'new',
          trigger: 'w',
          alwaysRespond: true,
        },
        'main-group',
        true,
        new Map(),
        deps,
      );
      expect(deps.registered[0]?.alwaysRespond).toBe(true);
    });

    it('normalizes empty model string to null on register', async () => {
      const deps = makeDeps({});
      await processTaskIpc(
        {
          type: 'register_group',
          jid: 'tg:new',
          name: 'New',
          folder: 'new',
          trigger: 'w',
          model: '',
        },
        'main-group',
        true,
        new Map(),
        deps,
      );
      expect(setRegisteredGroup).toHaveBeenCalledOnce();
      const stored = vi.mocked(setRegisteredGroup).mock.calls[0]?.[0];
      expect(stored?.model).toBeNull();
    });

    it('preserves valid model string on register', async () => {
      const deps = makeDeps({});
      await processTaskIpc(
        {
          type: 'register_group',
          jid: 'tg:new',
          name: 'New',
          folder: 'new',
          trigger: 'w',
          model: 'anthropic/claude-sonnet-4-6',
        },
        'main-group',
        true,
        new Map(),
        deps,
      );
      expect(setRegisteredGroup).toHaveBeenCalledOnce();
      const stored = vi.mocked(setRegisteredGroup).mock.calls[0]?.[0];
      expect(stored?.model).toBe('anthropic/claude-sonnet-4-6');
    });
  });

  describe('list_tasks', () => {
    const task1 = {
      id: 'task-1',
      jid: 'tg:abc',
      group_folder: 'group-a',
      prompt: 'check health',
      schedule_type: 'cron' as const,
      schedule_value: '0 9 * * *',
      context_mode: 'isolated' as const,
      status: 'active' as const,
      next_run: Date.now() + 60000,
      created_at: Date.now(),
      created_by: 'group-a',
    };
    const task2 = {
      id: 'task-2',
      jid: 'tg:xyz',
      group_folder: 'group-b',
      prompt: 'daily report',
      schedule_type: 'interval' as const,
      schedule_value: '3600000',
      context_mode: 'group' as const,
      status: 'active' as const,
      next_run: Date.now() + 120000,
      created_at: Date.now(),
      created_by: 'group-b',
    };

    it('main group sees all tasks', async () => {
      vi.mocked(getAllTasks).mockReturnValue([task1, task2]);
      const deps = makeDeps({});
      await processTaskIpc(
        { type: 'list_tasks', requestId: 'req-123' },
        'main-group',
        true,
        new Map(),
        deps,
      );

      expect(getAllTasks).toHaveBeenCalledOnce();
      expect(getTasksForGroup).not.toHaveBeenCalled();
      expect(fs.mkdirSync).toHaveBeenCalled();
      // Verify atomic write: writeFileSync to .tmp then renameSync
      expect(fs.writeFileSync).toHaveBeenCalledOnce();
      const writtenPath = vi.mocked(fs.writeFileSync).mock
        .calls[0]?.[0] as string;
      expect(writtenPath).toContain('req-123.json.tmp');
      const writtenData = JSON.parse(
        vi.mocked(fs.writeFileSync).mock.calls[0]?.[1] as string,
      );
      expect(writtenData.tasks).toHaveLength(2);
      expect(fs.renameSync).toHaveBeenCalledOnce();
    });

    it('non-main group sees only own tasks', async () => {
      vi.mocked(getTasksForGroup).mockReturnValue([task1]);
      const deps = makeDeps({});
      await processTaskIpc(
        { type: 'list_tasks', requestId: 'req-456' },
        'group-a',
        false,
        new Map(),
        deps,
      );

      expect(getTasksForGroup).toHaveBeenCalledWith('group-a');
      expect(getAllTasks).not.toHaveBeenCalled();
      const writtenData = JSON.parse(
        vi.mocked(fs.writeFileSync).mock.calls[0]?.[1] as string,
      );
      expect(writtenData.tasks).toHaveLength(1);
      expect(writtenData.tasks[0].id).toBe('task-1');
    });

    it('does nothing without requestId', async () => {
      const deps = makeDeps({});
      await processTaskIpc(
        { type: 'list_tasks' },
        'main-group',
        true,
        new Map(),
        deps,
      );

      expect(getAllTasks).not.toHaveBeenCalled();
      expect(getTasksForGroup).not.toHaveBeenCalled();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe('update_task', () => {
    const existingTask = {
      id: 'task-1',
      jid: 'tg:abc',
      group_folder: 'group-a',
      prompt: 'original prompt',
      schedule_type: 'cron' as const,
      schedule_value: '0 9 * * *',
      context_mode: 'isolated' as const,
      status: 'active' as const,
      next_run: Date.now() + 60000,
      created_at: Date.now(),
      created_by: 'group-a',
    };

    it('updates prompt only', async () => {
      vi.mocked(getTaskById).mockReturnValue(existingTask);
      const deps = makeDeps({});
      await processTaskIpc(
        { type: 'update_task', taskId: 'task-1', prompt: 'new prompt' },
        'group-a',
        false,
        new Map(),
        deps,
      );

      expect(updateTask).toHaveBeenCalledWith('task-1', {
        prompt: 'new prompt',
      });
      expect(deps.tasksChanged).toHaveLength(1);
    });

    it('updates context_mode', async () => {
      vi.mocked(getTaskById).mockReturnValue(existingTask);
      const deps = makeDeps({});
      await processTaskIpc(
        { type: 'update_task', taskId: 'task-1', contextMode: 'group' },
        'group-a',
        false,
        new Map(),
        deps,
      );

      expect(updateTask).toHaveBeenCalledWith('task-1', {
        context_mode: 'group',
      });
      expect(deps.tasksChanged).toHaveLength(1);
    });

    it('recalculates next_run when schedule changes to interval', async () => {
      vi.mocked(getTaskById).mockReturnValue(existingTask);
      const deps = makeDeps({});
      const before = Date.now();
      await processTaskIpc(
        {
          type: 'update_task',
          taskId: 'task-1',
          scheduleType: 'interval',
          scheduleValue: '60000',
        },
        'group-a',
        false,
        new Map(),
        deps,
      );

      expect(updateTask).toHaveBeenCalledOnce();
      const fields = vi.mocked(updateTask).mock.calls[0]?.[1];
      expect(fields?.schedule_type).toBe('interval');
      expect(fields?.schedule_value).toBe('60000');
      expect(fields?.next_run).toBeGreaterThanOrEqual(before + 60000);
      expect(deps.tasksChanged).toHaveLength(1);
    });

    it('recalculates next_run when schedule changes to cron', async () => {
      vi.mocked(getTaskById).mockReturnValue({
        ...existingTask,
        schedule_type: 'interval',
        schedule_value: '60000',
      });
      const deps = makeDeps({});
      await processTaskIpc(
        {
          type: 'update_task',
          taskId: 'task-1',
          scheduleType: 'cron',
          scheduleValue: '*/5 * * * *',
        },
        'group-a',
        false,
        new Map(),
        deps,
      );

      expect(updateTask).toHaveBeenCalledOnce();
      const fields = vi.mocked(updateTask).mock.calls[0]?.[1];
      expect(fields?.schedule_type).toBe('cron');
      expect(fields?.schedule_value).toBe('*/5 * * * *');
      expect(fields?.next_run).toBeGreaterThan(Date.now() - 1000);
    });

    it('recalculates next_run when schedule changes to once', async () => {
      const futureDate = '2099-12-31T23:59:59.000Z';
      vi.mocked(getTaskById).mockReturnValue(existingTask);
      const deps = makeDeps({});
      await processTaskIpc(
        {
          type: 'update_task',
          taskId: 'task-1',
          scheduleType: 'once',
          scheduleValue: futureDate,
        },
        'group-a',
        false,
        new Map(),
        deps,
      );

      expect(updateTask).toHaveBeenCalledOnce();
      const fields = vi.mocked(updateTask).mock.calls[0]?.[1];
      expect(fields?.next_run).toBe(new Date(futureDate).getTime());
    });

    it('rejects update from unauthorized group', async () => {
      vi.mocked(getTaskById).mockReturnValue(existingTask);
      const deps = makeDeps({});
      await processTaskIpc(
        { type: 'update_task', taskId: 'task-1', prompt: 'hacked' },
        'group-b', // different group
        false,
        new Map(),
        deps,
      );

      expect(updateTask).not.toHaveBeenCalled();
      expect(deps.tasksChanged).toHaveLength(0);
    });

    it('main group can update any task', async () => {
      vi.mocked(getTaskById).mockReturnValue(existingTask);
      const deps = makeDeps({});
      await processTaskIpc(
        { type: 'update_task', taskId: 'task-1', prompt: 'admin override' },
        'main-group',
        true,
        new Map(),
        deps,
      );

      expect(updateTask).toHaveBeenCalledWith('task-1', {
        prompt: 'admin override',
      });
      expect(deps.tasksChanged).toHaveLength(1);
    });

    it('does nothing when task not found', async () => {
      vi.mocked(getTaskById).mockReturnValue(undefined);
      const deps = makeDeps({});
      await processTaskIpc(
        { type: 'update_task', taskId: 'nonexistent', prompt: 'nope' },
        'group-a',
        false,
        new Map(),
        deps,
      );

      expect(updateTask).not.toHaveBeenCalled();
      expect(deps.tasksChanged).toHaveLength(0);
    });

    it('does nothing without taskId', async () => {
      const deps = makeDeps({});
      await processTaskIpc(
        { type: 'update_task', prompt: 'no id' },
        'group-a',
        false,
        new Map(),
        deps,
      );

      expect(getTaskById).not.toHaveBeenCalled();
      expect(updateTask).not.toHaveBeenCalled();
    });

    it('rejects invalid cron expression', async () => {
      vi.mocked(getTaskById).mockReturnValue(existingTask);
      const deps = makeDeps({});
      await processTaskIpc(
        {
          type: 'update_task',
          taskId: 'task-1',
          scheduleType: 'cron',
          scheduleValue: 'not-a-cron',
        },
        'group-a',
        false,
        new Map(),
        deps,
      );

      expect(updateTask).not.toHaveBeenCalled();
    });

    it('rejects invalid interval value', async () => {
      vi.mocked(getTaskById).mockReturnValue(existingTask);
      const deps = makeDeps({});
      await processTaskIpc(
        {
          type: 'update_task',
          taskId: 'task-1',
          scheduleType: 'interval',
          scheduleValue: 'abc',
        },
        'group-a',
        false,
        new Map(),
        deps,
      );

      expect(updateTask).not.toHaveBeenCalled();
    });

    it('rejects invalid once timestamp', async () => {
      vi.mocked(getTaskById).mockReturnValue(existingTask);
      const deps = makeDeps({});
      await processTaskIpc(
        {
          type: 'update_task',
          taskId: 'task-1',
          scheduleType: 'once',
          scheduleValue: 'not-a-date',
        },
        'group-a',
        false,
        new Map(),
        deps,
      );

      expect(updateTask).not.toHaveBeenCalled();
    });

    it('updates only scheduleValue, inheriting existing scheduleType', async () => {
      vi.mocked(getTaskById).mockReturnValue(existingTask); // cron type
      const deps = makeDeps({});
      await processTaskIpc(
        {
          type: 'update_task',
          taskId: 'task-1',
          scheduleValue: '30 8 * * *',
        },
        'group-a',
        false,
        new Map(),
        deps,
      );

      expect(updateTask).toHaveBeenCalledOnce();
      const fields = vi.mocked(updateTask).mock.calls[0]?.[1];
      expect(fields?.schedule_value).toBe('30 8 * * *');
      // schedule_type should NOT be in fields since it wasn't changed
      expect(fields?.schedule_type).toBeUndefined();
      // next_run should be recalculated (scheduleValue changed)
      expect(fields?.next_run).toBeDefined();
    });
  });

  describe('update_group', () => {
    it('updates trigger and alwaysRespond from main group', async () => {
      const existing = {
        'tg:abc': makeGroup({ jid: 'tg:abc', folder: 'grp' }),
      };
      const deps = makeDeps(existing);
      await processTaskIpc(
        {
          type: 'update_group',
          folder: 'grp',
          trigger: 'bot',
          alwaysRespond: true,
        },
        'main-group',
        true,
        new Map(),
        deps,
      );
      expect(setRegisteredGroup).toHaveBeenCalledOnce();
      expect(deps.updated[0]?.config).toMatchObject({
        trigger: 'bot',
        alwaysRespond: true,
      });
    });

    it('blocks update from non-main group', async () => {
      const existing = { 'tg:abc': makeGroup({ folder: 'grp' }) };
      const deps = makeDeps(existing);
      await processTaskIpc(
        { type: 'update_group', folder: 'grp', alwaysRespond: true },
        'test-group',
        false,
        new Map(),
        deps,
      );
      expect(setRegisteredGroup).not.toHaveBeenCalled();
    });

    it('blocks update for unknown folder', async () => {
      const deps = makeDeps({});
      await processTaskIpc(
        { type: 'update_group', folder: 'no-such-folder', alwaysRespond: true },
        'main-group',
        true,
        new Map(),
        deps,
      );
      expect(setRegisteredGroup).not.toHaveBeenCalled();
    });

    it('migrates jid when new jid is provided', async () => {
      const existing = {
        'tg:old': makeGroup({ jid: 'tg:old', folder: 'grp' }),
      };
      const deps = makeDeps(existing);
      vi.mocked(migrateGroupJid).mockReturnValue(true);
      await processTaskIpc(
        { type: 'update_group', folder: 'grp', jid: 'tg:new' },
        'main-group',
        true,
        new Map(),
        deps,
      );
      expect(migrateGroupJid).toHaveBeenCalledWith('tg:old', 'tg:new');
      expect(setRegisteredGroup).toHaveBeenCalledOnce();
      expect(deps.updated[0]?.config.jid).toBe('tg:new');
      expect(deps.updated[0]?.config.channel).toBe('telegram');
      expect(deps.updated[0]?.oldJid).toBe('tg:old');
    });

    it('blocks jid migration when new jid already in use', async () => {
      const existing = {
        'tg:abc': makeGroup({ jid: 'tg:abc', folder: 'grp-a' }),
        'tg:def': makeGroup({ jid: 'tg:def', folder: 'grp-b' }),
      };
      const deps = makeDeps(existing);
      await processTaskIpc(
        { type: 'update_group', folder: 'grp-a', jid: 'tg:def' },
        'main-group',
        true,
        new Map(),
        deps,
      );
      expect(migrateGroupJid).not.toHaveBeenCalled();
      expect(setRegisteredGroup).not.toHaveBeenCalled();
    });

    it('blocks jid migration when migrateGroupJid fails', async () => {
      const existing = {
        'tg:old': makeGroup({ jid: 'tg:old', folder: 'grp' }),
      };
      const deps = makeDeps(existing);
      vi.mocked(migrateGroupJid).mockReturnValue(false);
      await processTaskIpc(
        { type: 'update_group', folder: 'grp', jid: 'tg:new' },
        'main-group',
        true,
        new Map(),
        deps,
      );
      expect(migrateGroupJid).toHaveBeenCalledWith('tg:old', 'tg:new');
      expect(setRegisteredGroup).not.toHaveBeenCalled();
    });

    it('clears model override when empty string is passed', async () => {
      const existing = {
        'tg:abc': makeGroup({
          jid: 'tg:abc',
          folder: 'grp',
          model: 'anthropic/claude-sonnet-4-6',
        }),
      };
      const deps = makeDeps(existing);
      await processTaskIpc(
        { type: 'update_group', folder: 'grp', model: '' },
        'main-group',
        true,
        new Map(),
        deps,
      );
      expect(setRegisteredGroup).toHaveBeenCalledOnce();
      const stored = vi.mocked(setRegisteredGroup).mock.calls[0]?.[0];
      expect(stored?.model).toBeNull();
    });

    it('clears model override when null is passed', async () => {
      const existing = {
        'tg:abc': makeGroup({
          jid: 'tg:abc',
          folder: 'grp',
          model: 'anthropic/claude-sonnet-4-6',
        }),
      };
      const deps = makeDeps(existing);
      await processTaskIpc(
        { type: 'update_group', folder: 'grp', model: null },
        'main-group',
        true,
        new Map(),
        deps,
      );
      expect(setRegisteredGroup).toHaveBeenCalledOnce();
      const stored = vi.mocked(setRegisteredGroup).mock.calls[0]?.[0];
      expect(stored?.model).toBeNull();
    });

    it('updates model override with a valid value', async () => {
      const existing = {
        'tg:abc': makeGroup({ jid: 'tg:abc', folder: 'grp' }),
      };
      const deps = makeDeps(existing);
      await processTaskIpc(
        {
          type: 'update_group',
          folder: 'grp',
          model: 'openai/gpt-4o',
        },
        'main-group',
        true,
        new Map(),
        deps,
      );
      expect(setRegisteredGroup).toHaveBeenCalledOnce();
      const stored = vi.mocked(setRegisteredGroup).mock.calls[0]?.[0];
      expect(stored?.model).toBe('openai/gpt-4o');
    });
  });

  describe('list_groups', () => {
    it('writes response with all groups for main group', async () => {
      const existing = {
        'tg:abc': makeGroup({
          jid: 'tg:abc',
          folder: 'admin',
          name: 'Admin',
          isMain: true,
        }),
        'tg:123': makeGroup({
          jid: 'tg:123',
          folder: 'home',
          name: 'Home',
          channel: 'telegram',
        }),
      };
      vi.mocked(getAllRegisteredGroups).mockReturnValue(existing);
      const deps = makeDeps(existing);
      await processTaskIpc(
        { type: 'list_groups', requestId: 'req-1' },
        'admin',
        true,
        new Map(),
        deps,
      );
      expect(fs.mkdirSync).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalledOnce();
      const written = vi.mocked(fs.writeFileSync).mock.calls[0]?.[1] as string;
      const parsed = JSON.parse(written) as {
        groups: Array<{ jid: string; name: string }>;
      };
      expect(parsed.groups).toHaveLength(2);
      expect(parsed.groups.map((g) => g.name).sort()).toEqual([
        'Admin',
        'Home',
      ]);
    });

    it('filters to own group for non-main', async () => {
      const existing = {
        'tg:abc': makeGroup({
          jid: 'tg:abc',
          folder: 'admin',
          isMain: true,
        }),
        'tg:123': makeGroup({ jid: 'tg:123', folder: 'home' }),
      };
      vi.mocked(getAllRegisteredGroups).mockReturnValue(existing);
      const deps = makeDeps(existing);
      await processTaskIpc(
        { type: 'list_groups', requestId: 'req-2' },
        'home',
        false,
        new Map(),
        deps,
      );
      const written = vi.mocked(fs.writeFileSync).mock.calls[0]?.[1] as string;
      const parsed = JSON.parse(written) as {
        groups: Array<{ folder: string }>;
      };
      expect(parsed.groups).toHaveLength(1);
      expect(parsed.groups[0]?.folder).toBe('home');
    });

    it('skips when requestId is missing', async () => {
      const deps = makeDeps({});
      await processTaskIpc(
        { type: 'list_groups' },
        'admin',
        true,
        new Map(),
        deps,
      );
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe('delete_group', () => {
    it('deletes a non-main group from main group', async () => {
      const existing = {
        'tg:main': makeGroup({
          jid: 'tg:main',
          folder: 'admin',
          isMain: true,
        }),
        'tg:123': makeGroup({
          jid: 'tg:123',
          folder: 'home',
          name: 'Home',
        }),
      };
      const deps = makeDeps(existing);
      await processTaskIpc(
        { type: 'delete_group', folder: 'home' },
        'admin',
        true,
        new Map(),
        deps,
      );
      expect(deleteRegisteredGroup).toHaveBeenCalledWith('tg:123');
      expect(deps.deleted).toHaveLength(1);
      expect(deps.deleted[0]).toEqual({ folder: 'home', jid: 'tg:123' });
    });

    it('blocks deletion from non-main group', async () => {
      const existing = {
        'tg:123': makeGroup({ jid: 'tg:123', folder: 'home' }),
      };
      const deps = makeDeps(existing);
      await processTaskIpc(
        { type: 'delete_group', folder: 'home' },
        'home',
        false,
        new Map(),
        deps,
      );
      expect(deleteRegisteredGroup).not.toHaveBeenCalled();
    });

    it('blocks deletion of the main group', async () => {
      const existing = {
        'tg:main': makeGroup({
          jid: 'tg:main',
          folder: 'admin',
          isMain: true,
        }),
      };
      const deps = makeDeps(existing);
      await processTaskIpc(
        { type: 'delete_group', folder: 'admin' },
        'admin',
        true,
        new Map(),
        deps,
      );
      expect(deleteRegisteredGroup).not.toHaveBeenCalled();
    });

    it('ignores deletion of unknown folder', async () => {
      const deps = makeDeps({});
      await processTaskIpc(
        { type: 'delete_group', folder: 'nonexistent' },
        'admin',
        true,
        new Map(),
        deps,
      );
      expect(deleteRegisteredGroup).not.toHaveBeenCalled();
    });
  });

  describe('reset_session', () => {
    it('deletes session and writes success response', async () => {
      const deps = makeDeps({});
      await processTaskIpc(
        { type: 'reset_session', requestId: 'req-rs1' },
        'test-group',
        false,
        new Map(),
        deps,
      );
      expect(deleteSession).toHaveBeenCalledWith('test-group');
      expect(fs.mkdirSync).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalledOnce();
      const writtenData = JSON.parse(
        vi.mocked(fs.writeFileSync).mock.calls[0]?.[1] as string,
      );
      expect(writtenData.success).toBe(true);
      expect(fs.renameSync).toHaveBeenCalledOnce();
    });

    it('skips when requestId is missing', async () => {
      const deps = makeDeps({});
      await processTaskIpc(
        { type: 'reset_session' },
        'test-group',
        false,
        new Map(),
        deps,
      );
      expect(deleteSession).not.toHaveBeenCalled();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe('list_sessions', () => {
    it('returns sessions from agent container with active flag', async () => {
      const mockSessions = [
        { id: 'sess-1', title: 'First', created: 1000 },
        { id: 'sess-2', title: 'Second', created: 2000 },
      ];
      vi.mocked(listAgentSessions).mockResolvedValue(mockSessions);
      vi.mocked(getSession).mockReturnValue('sess-2');
      const deps = makeDeps({});
      await processTaskIpc(
        { type: 'list_sessions', requestId: 'req-ls1' },
        'test-group',
        false,
        new Map(),
        deps,
      );
      expect(listAgentSessions).toHaveBeenCalledWith('test-group');
      expect(getSession).toHaveBeenCalledWith('test-group');
      expect(fs.writeFileSync).toHaveBeenCalledOnce();
      const writtenData = JSON.parse(
        vi.mocked(fs.writeFileSync).mock.calls[0]?.[1] as string,
      );
      expect(writtenData.sessions).toHaveLength(2);
      expect(writtenData.sessions[0]).toMatchObject({
        id: 'sess-1',
        active: false,
      });
      expect(writtenData.sessions[1]).toMatchObject({
        id: 'sess-2',
        active: true,
      });
    });

    it('returns empty array when agent query fails', async () => {
      vi.mocked(listAgentSessions).mockRejectedValue(new Error('no container'));
      const deps = makeDeps({});
      await processTaskIpc(
        { type: 'list_sessions', requestId: 'req-ls2' },
        'test-group',
        false,
        new Map(),
        deps,
      );
      expect(fs.writeFileSync).toHaveBeenCalledOnce();
      const writtenData = JSON.parse(
        vi.mocked(fs.writeFileSync).mock.calls[0]?.[1] as string,
      );
      expect(writtenData.sessions).toHaveLength(0);
    });

    it('skips when requestId is missing', async () => {
      const deps = makeDeps({});
      await processTaskIpc(
        { type: 'list_sessions' },
        'test-group',
        false,
        new Map(),
        deps,
      );
      expect(listAgentSessions).not.toHaveBeenCalled();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe('switch_session', () => {
    it('switches to a valid session', async () => {
      vi.mocked(validateAgentSession).mockResolvedValue(true);
      const deps = makeDeps({});
      await processTaskIpc(
        { type: 'switch_session', requestId: 'req-sw1', sessionId: 'sess-1' },
        'test-group',
        false,
        new Map(),
        deps,
      );
      expect(validateAgentSession).toHaveBeenCalledWith('test-group', 'sess-1');
      expect(setSession).toHaveBeenCalledWith('test-group', 'sess-1');
      expect(fs.writeFileSync).toHaveBeenCalledOnce();
      const writtenData = JSON.parse(
        vi.mocked(fs.writeFileSync).mock.calls[0]?.[1] as string,
      );
      expect(writtenData.success).toBe(true);
      expect(writtenData.sessionId).toBe('sess-1');
    });

    it('rejects switch to invalid session', async () => {
      vi.mocked(validateAgentSession).mockResolvedValue(false);
      const deps = makeDeps({});
      await processTaskIpc(
        {
          type: 'switch_session',
          requestId: 'req-sw2',
          sessionId: 'nonexistent',
        },
        'test-group',
        false,
        new Map(),
        deps,
      );
      expect(validateAgentSession).toHaveBeenCalledWith(
        'test-group',
        'nonexistent',
      );
      expect(setSession).not.toHaveBeenCalled();
      const writtenData = JSON.parse(
        vi.mocked(fs.writeFileSync).mock.calls[0]?.[1] as string,
      );
      expect(writtenData.success).toBe(false);
      expect(writtenData.error).toBe('session not found');
    });

    it('returns error when sessionId is missing', async () => {
      const deps = makeDeps({});
      await processTaskIpc(
        { type: 'switch_session', requestId: 'req-sw3' },
        'test-group',
        false,
        new Map(),
        deps,
      );
      expect(validateAgentSession).not.toHaveBeenCalled();
      expect(setSession).not.toHaveBeenCalled();
      const writtenData = JSON.parse(
        vi.mocked(fs.writeFileSync).mock.calls[0]?.[1] as string,
      );
      expect(writtenData.success).toBe(false);
      expect(writtenData.error).toBe('missing sessionId');
    });

    it('skips when requestId is missing', async () => {
      const deps = makeDeps({});
      await processTaskIpc(
        { type: 'switch_session', sessionId: 'sess-1' },
        'test-group',
        false,
        new Map(),
        deps,
      );
      expect(validateAgentSession).not.toHaveBeenCalled();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('returns error when validation throws', async () => {
      vi.mocked(validateAgentSession).mockRejectedValue(
        new Error('container down'),
      );
      const deps = makeDeps({});
      await processTaskIpc(
        { type: 'switch_session', requestId: 'req-sw4', sessionId: 'sess-1' },
        'test-group',
        false,
        new Map(),
        deps,
      );
      expect(setSession).not.toHaveBeenCalled();
      const writtenData = JSON.parse(
        vi.mocked(fs.writeFileSync).mock.calls[0]?.[1] as string,
      );
      expect(writtenData.success).toBe(false);
      expect(writtenData.error).toBe('session not found');
    });
  });
});

describe('resolveContainerPath', () => {
  it('translates /workspace/data/ prefix to host groups dir', () => {
    const result = resolveContainerPath(
      '/workspace/data/screenshot.png',
      'my-group',
    );
    expect(result).toBe('/data/groups/my-group/screenshot.png');
  });

  it('translates nested container paths', () => {
    const result = resolveContainerPath(
      '/workspace/data/telegram/files/photo_123.jpg',
      'test-folder',
    );
    expect(result).toBe(
      '/data/groups/test-folder/telegram/files/photo_123.jpg',
    );
  });

  it('returns HTTP URLs unchanged', () => {
    expect(resolveContainerPath('https://example.com/photo.jpg', 'grp')).toBe(
      'https://example.com/photo.jpg',
    );
    expect(resolveContainerPath('http://example.com/photo.jpg', 'grp')).toBe(
      'http://example.com/photo.jpg',
    );
  });

  it('handles /workspace/data without trailing slash', () => {
    expect(resolveContainerPath('/workspace/data', 'grp')).toBe(
      '/data/groups/grp',
    );
  });

  it('returns null for non-container absolute paths', () => {
    expect(resolveContainerPath('/tmp/file.png', 'grp')).toBeNull();
  });

  it('returns null for path traversal via ../', () => {
    expect(
      resolveContainerPath('/workspace/data/../../etc/passwd', 'grp'),
    ).toBeNull();
  });

  it('returns null for traversal escaping group dir', () => {
    expect(
      resolveContainerPath('/workspace/data/../other-group/secret.db', 'grp'),
    ).toBeNull();
  });

  it('returns null for relative paths', () => {
    expect(resolveContainerPath('relative/path.png', 'grp')).toBeNull();
  });

  it('allows deeply nested paths within group dir', () => {
    const result = resolveContainerPath(
      '/workspace/data/sub/dir/file.png',
      'grp',
    );
    expect(result).toBe('/data/groups/grp/sub/dir/file.png');
  });
});

describe('formatIpcOutbound', () => {
  it('prefixes text with sender in bracket format', () => {
    expect(formatIpcOutbound('Hello world', 'Assistant')).toBe(
      '[Assistant]: Hello world',
    );
  });

  it('returns text as-is when sender is undefined', () => {
    expect(formatIpcOutbound('Hello world')).toBe('Hello world');
  });

  it('returns text as-is when sender is empty string', () => {
    expect(formatIpcOutbound('Hello world', '')).toBe('Hello world');
  });
});
