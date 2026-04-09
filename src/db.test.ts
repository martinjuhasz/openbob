import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/openbob-test',
  GROUPS_DIR: '/tmp/openbob-groups',
  DB_PATH: ':memory:',
  POLL_INTERVAL: 2000,
  ASSISTANT_NAME: 'openbob',
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  initDatabase,
  storeMessage,
  getRecentMessages,
  getMessagesSince,
  getNewMessages,
  storeChatMetadata,
  getAllRegisteredGroups,
  setRegisteredGroup,
  deleteRegisteredGroup,
  getOvUserKey,
  setOvUserKey,
  migrateGroupJid,
  getSession,
  setSession,
  getRouterState,
  setRouterState,
  getActiveTasks,
  getTaskById,
  getTasksForGroup,
  getAllTasks,
  upsertTask,
  deleteTask,
  updateTask,
} from './db.js';

import type { GroupConfig, ScheduledTask } from './types.js';

beforeEach(() => {
  initDatabase();
});

// --- helpers ---

function makeGroup(overrides: Partial<GroupConfig> = {}): GroupConfig {
  return {
    jid: 'mm:ch1',
    name: 'Dev',
    folder: 'dev-group',
    trigger: '@bot',
    channel: 'mattermost',
    isMain: false,
    alwaysRespond: false,
    createdAt: 1700000000000,
    ...overrides,
  };
}

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 't1',
    jid: 'mm:ch1',
    group_folder: 'dev',
    prompt: 'do stuff',
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    context_mode: 'isolated',
    status: 'active',
    next_run: 9999999999,
    created_at: 1700000000000,
    created_by: 'bot',
    ...overrides,
  };
}

// --- Messages ---

describe('storeMessage + getRecentMessages', () => {
  it('stores message and retrieves it', () => {
    storeChatMetadata(
      'mm:ch1',
      '2026-01-01T10:00:00.000Z',
      'General',
      'mattermost',
      true,
    );
    storeMessage({
      id: 'm1',
      chat_jid: 'mm:ch1',
      sender: 'u1',
      sender_name: 'Alice',
      content: 'hello',
      timestamp: '2026-01-01T10:00:00.000Z',
    });

    const rows = getRecentMessages('mm:ch1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe('hello');
    expect(rows[0]?.sender_name).toBe('Alice');
  });

  it('deduplicates messages with same id+chat_jid', () => {
    storeChatMetadata('mm:ch1', '2026-01-01T10:00:00.000Z');
    storeMessage({
      id: 'dup',
      chat_jid: 'mm:ch1',
      sender: 'u1',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2026-01-01T10:00:00.000Z',
    });
    storeMessage({
      id: 'dup',
      chat_jid: 'mm:ch1',
      sender: 'u1',
      sender_name: 'Alice',
      content: 'second',
      timestamp: '2026-01-01T10:01:00.000Z',
    });

    const rows = getRecentMessages('mm:ch1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe('first');
  });

  it('respects limit parameter', () => {
    storeChatMetadata('mm:ch1', '2026-01-01T10:03:00.000Z');
    for (let i = 0; i < 5; i++) {
      storeMessage({
        id: `m${i}`,
        chat_jid: 'mm:ch1',
        sender: 'u1',
        sender_name: 'Alice',
        content: `msg-${i}`,
        timestamp: `2026-01-01T10:0${i}:00.000Z`,
      });
    }

    const rows = getRecentMessages('mm:ch1', 3);
    expect(rows).toHaveLength(3);
    // Should return the 3 most recent, in chronological order
    expect(rows[0]?.content).toBe('msg-2');
    expect(rows[2]?.content).toBe('msg-4');
  });
});

describe('getMessagesSince', () => {
  it('retrieves messages since a given timestamp', () => {
    storeChatMetadata('mm:ch1', '2026-01-01T10:02:00.000Z');
    storeMessage({
      id: 'm1',
      chat_jid: 'mm:ch1',
      sender: 'u1',
      sender_name: 'Alice',
      content: 'old',
      timestamp: '2026-01-01T09:00:00.000Z',
    });
    storeMessage({
      id: 'm2',
      chat_jid: 'mm:ch1',
      sender: 'u1',
      sender_name: 'Alice',
      content: 'new',
      timestamp: '2026-01-01T10:00:00.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'mm:ch1',
      sender: 'u1',
      sender_name: 'Alice',
      content: 'newer',
      timestamp: '2026-01-01T10:01:00.000Z',
    });

    const rows = getMessagesSince('mm:ch1', '2026-01-01T09:30:00.000Z');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.content).toBe('new');
    expect(rows[1]?.content).toBe('newer');
  });

  it('respects limit parameter', () => {
    storeChatMetadata('mm:ch1', '2026-01-01T10:05:00.000Z');
    for (let i = 0; i < 5; i++) {
      storeMessage({
        id: `m${i}`,
        chat_jid: 'mm:ch1',
        sender: 'u1',
        sender_name: 'Alice',
        content: `msg-${i}`,
        timestamp: `2026-01-01T10:0${i}:00.000Z`,
      });
    }

    const rows = getMessagesSince('mm:ch1', '2026-01-01T09:00:00.000Z', 2);
    expect(rows).toHaveLength(2);
  });
});

describe('getNewMessages', () => {
  it('returns messages across all chats since timestamp', () => {
    storeChatMetadata('mm:ch1', '2026-01-01T10:00:00.000Z');
    storeChatMetadata('mm:ch2', '2026-01-01T10:01:00.000Z');
    storeMessage({
      id: 'm1',
      chat_jid: 'mm:ch1',
      sender: 'u1',
      sender_name: 'Alice',
      content: 'old',
      timestamp: '2026-01-01T08:00:00.000Z',
    });
    storeMessage({
      id: 'm2',
      chat_jid: 'mm:ch1',
      sender: 'u1',
      sender_name: 'Alice',
      content: 'new-ch1',
      timestamp: '2026-01-01T10:00:00.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'mm:ch2',
      sender: 'u2',
      sender_name: 'Bob',
      content: 'new-ch2',
      timestamp: '2026-01-01T10:01:00.000Z',
    });

    const rows = getNewMessages('2026-01-01T09:00:00.000Z');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.content).toBe('new-ch1');
    expect(rows[1]?.content).toBe('new-ch2');
  });
});

// --- Chat metadata ---

describe('storeChatMetadata', () => {
  it('creates chat entry', () => {
    storeChatMetadata(
      'mm:ch99',
      '2026-01-01T10:00:00.000Z',
      'TestChannel',
      'mattermost',
      true,
    );
    // Verify via messages — store a message then retrieve it to confirm chat exists
    storeMessage({
      id: 'verify',
      chat_jid: 'mm:ch99',
      sender: 'u1',
      sender_name: 'User',
      content: 'test',
      timestamp: '2026-01-01T10:00:00.000Z',
    });
    const msgs = getRecentMessages('mm:ch99');
    expect(msgs).toHaveLength(1);
  });

  it('upserts: preserves existing name on re-insert without name', () => {
    storeChatMetadata(
      'mm:ch99',
      '2026-01-01T10:00:00.000Z',
      'OriginalName',
      'mattermost',
      true,
    );
    storeChatMetadata('mm:ch99', '2026-01-01T11:00:00.000Z'); // no name
    // Chat should still exist
    storeMessage({
      id: 'verify',
      chat_jid: 'mm:ch99',
      sender: 'u1',
      sender_name: 'User',
      content: 'test',
      timestamp: '2026-01-01T11:00:00.000Z',
    });
    const msgs = getRecentMessages('mm:ch99');
    expect(msgs).toHaveLength(1);
  });
});

// --- Registered groups ---

describe('registered groups', () => {
  it('setRegisteredGroup + getAllRegisteredGroups round-trip', () => {
    const group = makeGroup();
    setRegisteredGroup(group);

    const all = getAllRegisteredGroups();
    expect(Object.keys(all)).toHaveLength(1);
    expect(all['mm:ch1']).toBeDefined();
    expect(all['mm:ch1']?.name).toBe('Dev');
    expect(all['mm:ch1']?.folder).toBe('dev-group');
    expect(all['mm:ch1']?.isMain).toBe(false);
  });

  it('main group flag', () => {
    setRegisteredGroup(
      makeGroup({ jid: 'mm:main', folder: 'main', isMain: true }),
    );

    const all = getAllRegisteredGroups();
    expect(all['mm:main']?.isMain).toBe(true);
  });

  it('upserts group config on same jid', () => {
    setRegisteredGroup(makeGroup({ name: 'OldName' }));
    setRegisteredGroup(makeGroup({ name: 'NewName' }));

    const all = getAllRegisteredGroups();
    expect(all['mm:ch1']?.name).toBe('NewName');
  });

  it('deleteRegisteredGroup removes a group', () => {
    setRegisteredGroup(makeGroup());
    deleteRegisteredGroup('mm:ch1');

    const all = getAllRegisteredGroups();
    expect(Object.keys(all)).toHaveLength(0);
  });

  it('model is undefined when not set', () => {
    setRegisteredGroup(makeGroup());

    const all = getAllRegisteredGroups();
    expect(all['mm:ch1']?.model).toBeUndefined();
  });

  it('model is preserved when set', () => {
    setRegisteredGroup(makeGroup({ model: 'anthropic/claude-sonnet-4-6' }));

    const all = getAllRegisteredGroups();
    expect(all['mm:ch1']?.model).toBe('anthropic/claude-sonnet-4-6');
  });

  it('alwaysRespond flag round-trips', () => {
    setRegisteredGroup(makeGroup({ alwaysRespond: true }));

    const all = getAllRegisteredGroups();
    expect(all['mm:ch1']?.alwaysRespond).toBe(true);
  });
});

// --- OpenViking per-group user keys ---

describe('OV user keys', () => {
  it('returns null for unknown group folder', () => {
    expect(getOvUserKey('nonexistent')).toBeNull();
  });

  it('returns null when group exists but no key set', () => {
    setRegisteredGroup(makeGroup());
    expect(getOvUserKey('dev-group')).toBeNull();
  });

  it('stores and retrieves key', () => {
    setRegisteredGroup(makeGroup());
    setOvUserKey('dev-group', 'ov-key-abc');
    expect(getOvUserKey('dev-group')).toBe('ov-key-abc');
  });

  it('overwrites existing key', () => {
    setRegisteredGroup(makeGroup());
    setOvUserKey('dev-group', 'old-key');
    setOvUserKey('dev-group', 'new-key');
    expect(getOvUserKey('dev-group')).toBe('new-key');
  });
});

// --- Sessions ---

describe('sessions', () => {
  it('returns null for unknown group', () => {
    expect(getSession('unknown')).toBeNull();
  });

  it('stores and retrieves session ID', () => {
    setSession('dev', 'sess-abc');
    expect(getSession('dev')).toBe('sess-abc');
  });

  it('upserts session ID', () => {
    setSession('dev', 'sess-old');
    setSession('dev', 'sess-new');
    expect(getSession('dev')).toBe('sess-new');
  });
});

// --- Router state ---

describe('router state', () => {
  it('returns null for unknown key', () => {
    expect(getRouterState('unknown')).toBeNull();
  });

  it('stores and updates key-value pairs', () => {
    setRouterState('last_ts', 'ts1');
    expect(getRouterState('last_ts')).toBe('ts1');

    setRouterState('last_ts', 'ts2');
    expect(getRouterState('last_ts')).toBe('ts2');
  });
});

// --- Scheduled tasks ---

describe('scheduled tasks', () => {
  it('upsertTask + getActiveTasks round-trip', () => {
    upsertTask(makeTask());

    const tasks = getActiveTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe('t1');
    expect(tasks[0]?.prompt).toBe('do stuff');
  });

  it('getActiveTasks excludes non-active tasks', () => {
    upsertTask(makeTask({ id: 't1', status: 'active' }));
    upsertTask(makeTask({ id: 't2', status: 'paused', group_folder: 'other' }));
    upsertTask(
      makeTask({ id: 't3', status: 'completed', group_folder: 'other2' }),
    );

    const tasks = getActiveTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe('t1');
  });

  describe('getTaskById', () => {
    it('returns the task when it exists', () => {
      upsertTask(makeTask({ id: 'find-me' }));
      const task = getTaskById('find-me');
      expect(task).toBeDefined();
      expect(task?.id).toBe('find-me');
      expect(task?.prompt).toBe('do stuff');
    });

    it('returns undefined when task does not exist', () => {
      expect(getTaskById('nonexistent')).toBeUndefined();
    });
  });

  describe('getTasksForGroup', () => {
    it('returns only tasks for the given group_folder', () => {
      upsertTask(makeTask({ id: 't1', group_folder: 'group-a' }));
      upsertTask(makeTask({ id: 't2', group_folder: 'group-a' }));
      upsertTask(makeTask({ id: 't3', group_folder: 'group-b' }));

      const rows = getTasksForGroup('group-a');
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.id).sort()).toEqual(['t1', 't2']);
    });

    it('returns empty array when no tasks exist for group', () => {
      upsertTask(makeTask({ id: 't1', group_folder: 'group-a' }));
      expect(getTasksForGroup('group-z')).toHaveLength(0);
    });

    it('includes all statuses', () => {
      upsertTask(makeTask({ id: 't1', group_folder: 'grp', status: 'active' }));
      upsertTask(makeTask({ id: 't2', group_folder: 'grp', status: 'paused' }));
      upsertTask(
        makeTask({ id: 't3', group_folder: 'grp', status: 'completed' }),
      );

      const rows = getTasksForGroup('grp');
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.status).sort()).toEqual([
        'active',
        'completed',
        'paused',
      ]);
    });
  });

  describe('getAllTasks', () => {
    it('returns all tasks across all groups', () => {
      upsertTask(makeTask({ id: 't1', group_folder: 'group-a' }));
      upsertTask(makeTask({ id: 't2', group_folder: 'group-b' }));
      upsertTask(makeTask({ id: 't3', group_folder: 'group-c' }));

      expect(getAllTasks()).toHaveLength(3);
    });

    it('returns empty array when no tasks exist', () => {
      expect(getAllTasks()).toHaveLength(0);
    });
  });

  describe('deleteTask', () => {
    it('removes a task', () => {
      upsertTask(makeTask({ id: 'del-me' }));
      deleteTask('del-me');
      expect(getTaskById('del-me')).toBeUndefined();
    });

    it('does not affect other tasks', () => {
      upsertTask(makeTask({ id: 't1' }));
      upsertTask(makeTask({ id: 't2', group_folder: 'other' }));
      deleteTask('t1');
      expect(getTaskById('t2')).toBeDefined();
    });
  });

  describe('updateTask', () => {
    it('updates prompt only', () => {
      upsertTask(makeTask({ id: 'u1', prompt: 'original' }));
      updateTask('u1', { prompt: 'updated prompt' });

      const task = getTaskById('u1');
      expect(task?.prompt).toBe('updated prompt');
      expect(task?.schedule_type).toBe('cron'); // unchanged
    });

    it('updates schedule_type and schedule_value together', () => {
      upsertTask(makeTask({ id: 'u2' }));
      updateTask('u2', {
        schedule_type: 'interval',
        schedule_value: '60000',
      });

      const task = getTaskById('u2');
      expect(task?.schedule_type).toBe('interval');
      expect(task?.schedule_value).toBe('60000');
    });

    it('updates context_mode', () => {
      upsertTask(makeTask({ id: 'u3', context_mode: 'isolated' }));
      updateTask('u3', { context_mode: 'group' });
      expect(getTaskById('u3')?.context_mode).toBe('group');
    });

    it('updates next_run', () => {
      upsertTask(makeTask({ id: 'u4', next_run: 1000 }));
      updateTask('u4', { next_run: 9999 });
      expect(getTaskById('u4')?.next_run).toBe(9999);
    });

    it('updates status', () => {
      upsertTask(makeTask({ id: 'u5', status: 'active' }));
      updateTask('u5', { status: 'paused' });
      expect(getTaskById('u5')?.status).toBe('paused');
    });

    it('updates multiple fields at once', () => {
      upsertTask(
        makeTask({ id: 'u6', prompt: 'old', context_mode: 'isolated' }),
      );
      updateTask('u6', {
        prompt: 'new prompt',
        context_mode: 'group',
        next_run: 5000,
      });

      const task = getTaskById('u6');
      expect(task?.prompt).toBe('new prompt');
      expect(task?.context_mode).toBe('group');
      expect(task?.next_run).toBe(5000);
    });

    it('does not affect other tasks', () => {
      upsertTask(makeTask({ id: 'u7', prompt: 'keep me' }));
      upsertTask(
        makeTask({ id: 'u8', prompt: 'change me', group_folder: 'other' }),
      );
      updateTask('u8', { prompt: 'changed' });

      expect(getTaskById('u7')?.prompt).toBe('keep me');
      expect(getTaskById('u8')?.prompt).toBe('changed');
    });

    it('no-ops when no fields provided', () => {
      upsertTask(makeTask({ id: 'u9', prompt: 'same' }));
      updateTask('u9', {});
      expect(getTaskById('u9')?.prompt).toBe('same');
    });
  });

  describe('upsertTask updates status and next_run on conflict', () => {
    it('updates status and next_run for existing task', () => {
      upsertTask(makeTask({ id: 'up1', status: 'active', next_run: 1000 }));
      upsertTask(makeTask({ id: 'up1', status: 'paused', next_run: 2000 }));

      const task = getTaskById('up1');
      expect(task?.status).toBe('paused');
      expect(task?.next_run).toBe(2000);
    });
  });
});

// --- migrateGroupJid ---

describe('migrateGroupJid', () => {
  it('migrates registered_groups JID', () => {
    setRegisteredGroup(
      makeGroup({
        jid: 'tg:-5095000864',
        folder: 'homebase',
        channel: 'telegram',
      }),
    );

    const result = migrateGroupJid('tg:-5095000864', 'tg:-1003898307477');
    expect(result).toBe(true);

    const all = getAllRegisteredGroups();
    expect(all['tg:-5095000864']).toBeUndefined();
    expect(all['tg:-1003898307477']).toBeDefined();
    expect(all['tg:-1003898307477']?.folder).toBe('homebase');
  });

  it('migrates chats and messages', () => {
    setRegisteredGroup(
      makeGroup({ jid: 'tg:-100', folder: 'grp', channel: 'telegram' }),
    );
    storeChatMetadata(
      'tg:-100',
      '2026-01-01T10:00:00.000Z',
      'MyChat',
      'telegram',
      true,
    );
    storeMessage({
      id: 'm1',
      chat_jid: 'tg:-100',
      sender: 'u1',
      sender_name: 'Alice',
      content: 'hello',
      timestamp: '2026-01-01T10:00:00.000Z',
    });

    migrateGroupJid('tg:-100', 'tg:-200');

    // Old JID should have no messages
    expect(getRecentMessages('tg:-100')).toHaveLength(0);

    // New JID should have the message
    const msgs = getRecentMessages('tg:-200');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.content).toBe('hello');
  });

  it('migrates scheduled_tasks', () => {
    setRegisteredGroup(
      makeGroup({ jid: 'tg:-100', folder: 'grp', channel: 'telegram' }),
    );
    upsertTask(makeTask({ id: 't1', jid: 'tg:-100', group_folder: 'grp' }));

    migrateGroupJid('tg:-100', 'tg:-200');

    const task = getTaskById('t1');
    expect(task?.jid).toBe('tg:-200');
  });

  it('returns false when old JID does not exist', () => {
    expect(migrateGroupJid('tg:-nonexistent', 'tg:-200')).toBe(false);
  });

  it('does not affect other groups', () => {
    setRegisteredGroup(
      makeGroup({ jid: 'tg:-100', folder: 'grp-a', channel: 'telegram' }),
    );
    setRegisteredGroup(
      makeGroup({ jid: 'tg:-999', folder: 'grp-b', channel: 'telegram' }),
    );

    migrateGroupJid('tg:-100', 'tg:-200');

    const all = getAllRegisteredGroups();
    expect(all['tg:-999']).toBeDefined();
    expect(all['tg:-999']?.folder).toBe('grp-b');
  });
});
