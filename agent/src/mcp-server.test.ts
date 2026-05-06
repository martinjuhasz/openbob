import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import fs from 'fs';
import path from 'path';

// ── Types for captured tool registrations ─────────────────────────────

interface ToolEntry {
  schema: unknown;
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }>;
}

let registeredTools: Map<string, ToolEntry>;

// ── Mock MCP SDK ──────────────────────────────────────────────────────

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  registeredTools = new Map();
  class MockMcpServer {
    tool(
      name: string,
      _desc: string,
      schemaOrHandler: unknown,
      maybeHandler?: ToolEntry['handler'],
    ) {
      if (typeof schemaOrHandler === 'function') {
        registeredTools.set(name, {
          schema: {},
          handler: schemaOrHandler as ToolEntry['handler'],
        });
      } else {
        registeredTools.set(name, {
          schema: schemaOrHandler,
          handler: maybeHandler!,
        });
      }
    }
    async connect() {
      // no-op
    }
  }
  return { McpServer: MockMcpServer };
});

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(),
}));

// ── Mock transcription ────────────────────────────────────────────────

const mockTranscribeMedia = vi.fn();
vi.mock('./transcription.js', () => ({
  transcribeMedia: mockTranscribeMedia,
}));

// ── Mock vnc-browser-session ──────────────────────────────────────────

const mockStartVncBrowserSession = vi.fn();
const mockStopVncBrowserSession = vi.fn();
const mockGetActiveVncSessionName = vi.fn();
const mockListBrowserProfiles = vi.fn();
vi.mock('./vnc-browser-session.js', () => ({
  startVncBrowserSession: mockStartVncBrowserSession,
  stopVncBrowserSession: mockStopVncBrowserSession,
  getActiveVncSessionName: mockGetActiveVncSessionName,
  listBrowserProfiles: mockListBrowserProfiles,
}));

// ── Mock cron-parser ──────────────────────────────────────────────────

const mockCronParse = vi.fn();
vi.mock('cron-parser', () => ({
  CronExpressionParser: { parse: mockCronParse },
}));

// ── Mock fs ───────────────────────────────────────────────────────────

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
      mkdirSync: vi.fn(),
      unlinkSync: vi.fn(),
    },
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

// ── Helpers ───────────────────────────────────────────────────────────

const IPC_DIR = '/workspace/data/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const _TASKS_DIR = path.join(IPC_DIR, 'tasks');

function setContext(ctx: {
  chatJid?: string;
  groupFolder?: string;
  isMain?: boolean;
}) {
  (fs.readFileSync as Mock).mockImplementation((filePath: string) => {
    if (filePath === '/workspace/context.json') {
      return JSON.stringify({
        chatJid: ctx.chatJid ?? 'test-jid',
        groupFolder: ctx.groupFolder ?? 'test-group',
        isMain: ctx.isMain ?? false,
      });
    }
    throw new Error('ENOENT');
  });
}

function setMainContext() {
  setContext({ isMain: true });
}

function setNonMainContext() {
  setContext({ isMain: false });
}

function getWrittenIpcData(): object | undefined {
  const calls = (fs.writeFileSync as Mock).mock.calls;
  if (calls.length === 0) return undefined;
  const lastCall = calls[calls.length - 1];
  return JSON.parse(lastCall[1] as string) as object;
}

function getWrittenIpcPath(): string | undefined {
  const calls = (fs.writeFileSync as Mock).mock.calls;
  if (calls.length === 0) return undefined;
  return calls[calls.length - 1][0] as string;
}

function getTool(name: string): ToolEntry {
  const tool = registeredTools.get(name);
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  return tool;
}

// ── Import module (triggers registrations) ────────────────────────────

beforeEach(() => {
  vi.restoreAllMocks();
  // Re-setup fs mocks after restoreAllMocks
  (fs.readFileSync as Mock).mockImplementation(() => {
    throw new Error('ENOENT');
  });
  (fs.writeFileSync as Mock).mockImplementation(() => undefined);
  (fs.renameSync as Mock).mockImplementation(() => undefined);
  (fs.mkdirSync as Mock).mockImplementation(() => undefined);
  (fs.unlinkSync as Mock).mockImplementation(() => undefined);
  mockTranscribeMedia.mockReset();
  mockCronParse.mockReset();
});

// Dynamic import to trigger top-level await after mocks are set up
await import('./mcp-server.js');

// ── Tests ─────────────────────────────────────────────────────────────

describe('tool registration', () => {
  it('registers all expected tools', () => {
    const expected = [
      'send_message',
      'send_photo',
      'send_document',
      'schedule_task',
      'cancel_task',
      'pause_task',
      'resume_task',
      'list_tasks',
      'list_groups',
      'update_task',
      'register_group',
      'update_group',
      'delete_group',
      'reset_session',
      'list_sessions',
      'switch_session',
      'compose_up',
      'compose_down',
      'compose_build',
      'compose_logs',
      'compose_ps',
      'compose_restart',
      'transcribe_media',
    ];
    for (const name of expected) {
      expect(registeredTools.has(name), `missing tool: ${name}`).toBe(true);
    }
  });
});

describe('readContext (via tools)', () => {
  it('returns default context when file is missing', async () => {
    (fs.readFileSync as Mock).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const result = await getTool('send_message').handler({ text: 'hi' });
    expect(result.content[0].text).toBe('Message sent.');
    const data = getWrittenIpcData() as Record<string, unknown>;
    expect(data.chatJid).toBe('');
    expect(data.groupFolder).toBe('');
  });

  it('returns default context when file has invalid JSON', async () => {
    (fs.readFileSync as Mock).mockImplementation((p: string) => {
      if (p === '/workspace/context.json') return 'not-json';
      throw new Error('ENOENT');
    });
    const result = await getTool('send_message').handler({ text: 'hi' });
    expect(result.content[0].text).toBe('Message sent.');
    const data = getWrittenIpcData() as Record<string, unknown>;
    expect(data.chatJid).toBe('');
  });

  it('reads context correctly', async () => {
    setContext({ chatJid: 'my-jid', groupFolder: 'my-group', isMain: true });
    await getTool('send_message').handler({ text: 'hi' });
    const data = getWrittenIpcData() as Record<string, unknown>;
    expect(data.chatJid).toBe('my-jid');
    expect(data.groupFolder).toBe('my-group');
  });
});

describe('writeIpcFile (via tools)', () => {
  it('creates directory recursively', async () => {
    setContext({});
    await getTool('send_message').handler({ text: 'test' });
    expect(fs.mkdirSync).toHaveBeenCalledWith(MESSAGES_DIR, {
      recursive: true,
    });
  });

  it('writes to temp file then renames atomically', async () => {
    setContext({});
    await getTool('send_message').handler({ text: 'test' });
    const writePath = getWrittenIpcPath();
    expect(writePath).toBeDefined();
    expect(writePath!.endsWith('.tmp')).toBe(true);
    expect(fs.renameSync).toHaveBeenCalled();
    const renameCalls = (fs.renameSync as Mock).mock.calls;
    const renameArgs = renameCalls[renameCalls.length - 1];
    expect(renameArgs[0]).toBe(writePath);
    expect(renameArgs[1]).toBe(writePath!.replace('.tmp', ''));
  });
});

describe('send_message', () => {
  it('writes message IPC file with correct data', async () => {
    setContext({ chatJid: 'jid-1', groupFolder: 'grp-1' });
    const result = await getTool('send_message').handler({ text: 'hello' });
    expect(result.content[0].text).toBe('Message sent.');
    const data = getWrittenIpcData() as Record<string, unknown>;
    expect(data.type).toBe('message');
    expect(data.chatJid).toBe('jid-1');
    expect(data.text).toBe('hello');
    expect(data.groupFolder).toBe('grp-1');
    expect(data.timestamp).toBeDefined();
  });

  it('includes sender when provided', async () => {
    setContext({});
    await getTool('send_message').handler({ text: 'hi', sender: 'Bob' });
    const data = getWrittenIpcData() as Record<string, unknown>;
    expect(data.sender).toBe('Bob');
  });

  it('omits sender when not provided', async () => {
    setContext({});
    await getTool('send_message').handler({ text: 'hi' });
    const data = getWrittenIpcData() as Record<string, unknown>;
    expect(data).not.toHaveProperty('sender');
  });
});

describe('send_photo', () => {
  it('writes photo IPC file', async () => {
    setContext({ chatJid: 'jid-1' });
    const result = await getTool('send_photo').handler({
      source: '/workspace/img.png',
    });
    expect(result.content[0].text).toBe('Photo sent.');
    const data = getWrittenIpcData() as Record<string, unknown>;
    expect(data.type).toBe('send_photo');
    expect(data.source).toBe('/workspace/img.png');
  });

  it('includes caption when provided', async () => {
    setContext({});
    await getTool('send_photo').handler({
      source: '/img.png',
      caption: 'Look!',
    });
    const data = getWrittenIpcData() as Record<string, unknown>;
    expect(data.caption).toBe('Look!');
  });
});

describe('send_document', () => {
  it('writes document IPC file', async () => {
    setContext({ chatJid: 'jid-1' });
    const result = await getTool('send_document').handler({
      source: '/workspace/report.pdf',
    });
    expect(result.content[0].text).toBe('Document sent.');
    const data = getWrittenIpcData() as Record<string, unknown>;
    expect(data.type).toBe('send_document');
    expect(data.source).toBe('/workspace/report.pdf');
  });
});

describe('schedule_task', () => {
  it('schedules a valid cron task', async () => {
    setContext({ chatJid: 'jid-1', groupFolder: 'grp-1' });
    mockCronParse.mockReturnValue({});
    const result = await getTool('schedule_task').handler({
      prompt: 'do stuff',
      schedule_type: 'cron',
      schedule_value: '*/5 * * * *',
    });
    expect(result.content[0].text).toMatch(/^Task task-.*scheduled\.$/);
    expect(result.isError).toBeUndefined();
    const data = getWrittenIpcData() as Record<string, unknown>;
    expect(data.type).toBe('schedule_task');
    expect(data.scheduleType).toBe('cron');
    expect(data.targetJid).toBe('jid-1');
  });

  it('rejects invalid cron expression', async () => {
    setContext({});
    mockCronParse.mockImplementation(() => {
      throw new Error('bad cron');
    });
    const result = await getTool('schedule_task').handler({
      prompt: 'do stuff',
      schedule_type: 'cron',
      schedule_value: 'bad',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid cron');
  });

  it('schedules a valid interval task', async () => {
    setContext({});
    const result = await getTool('schedule_task').handler({
      prompt: 'do stuff',
      schedule_type: 'interval',
      schedule_value: '300000',
    });
    expect(result.isError).toBeUndefined();
    const data = getWrittenIpcData() as Record<string, unknown>;
    expect(data.scheduleType).toBe('interval');
  });

  it('rejects invalid interval', async () => {
    setContext({});
    const result = await getTool('schedule_task').handler({
      prompt: 'do stuff',
      schedule_type: 'interval',
      schedule_value: 'abc',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid interval');
  });

  it('rejects zero interval', async () => {
    setContext({});
    const result = await getTool('schedule_task').handler({
      prompt: 'do stuff',
      schedule_type: 'interval',
      schedule_value: '0',
    });
    expect(result.isError).toBe(true);
  });

  it('schedules a valid once task', async () => {
    setContext({});
    const result = await getTool('schedule_task').handler({
      prompt: 'do stuff',
      schedule_type: 'once',
      schedule_value: '2026-03-25T15:00:00',
    });
    expect(result.isError).toBeUndefined();
  });

  it('rejects once with Z suffix', async () => {
    setContext({});
    const result = await getTool('schedule_task').handler({
      prompt: 'do stuff',
      schedule_type: 'once',
      schedule_value: '2026-03-25T15:00:00Z',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('local time');
  });

  it('rejects once with timezone offset', async () => {
    setContext({});
    const result = await getTool('schedule_task').handler({
      prompt: 'do stuff',
      schedule_type: 'once',
      schedule_value: '2026-03-25T15:00:00+02:00',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('local time');
  });

  it('rejects once with invalid timestamp', async () => {
    setContext({});
    const result = await getTool('schedule_task').handler({
      prompt: 'do stuff',
      schedule_type: 'once',
      schedule_value: 'not-a-date',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid timestamp');
  });

  it('uses target_group_jid when main group', async () => {
    setContext({ chatJid: 'main-jid', isMain: true });
    mockCronParse.mockReturnValue({});
    await getTool('schedule_task').handler({
      prompt: 'do stuff',
      schedule_type: 'cron',
      schedule_value: '* * * * *',
      target_group_jid: 'other-jid',
    });
    const data = getWrittenIpcData() as Record<string, unknown>;
    expect(data.targetJid).toBe('other-jid');
  });

  it('ignores target_group_jid when not main group', async () => {
    setContext({ chatJid: 'my-jid', isMain: false });
    mockCronParse.mockReturnValue({});
    await getTool('schedule_task').handler({
      prompt: 'do stuff',
      schedule_type: 'cron',
      schedule_value: '* * * * *',
      target_group_jid: 'other-jid',
    });
    const data = getWrittenIpcData() as Record<string, unknown>;
    expect(data.targetJid).toBe('my-jid');
  });

  it('defaults context_mode to group', async () => {
    setContext({});
    mockCronParse.mockReturnValue({});
    await getTool('schedule_task').handler({
      prompt: 'do stuff',
      schedule_type: 'cron',
      schedule_value: '* * * * *',
    });
    const data = getWrittenIpcData() as Record<string, unknown>;
    expect(data.contextMode).toBe('group');
  });
});

describe('cancel_task', () => {
  it('writes cancel IPC file', async () => {
    setContext({ groupFolder: 'grp-1' });
    const result = await getTool('cancel_task').handler({ task_id: 'task-1' });
    expect(result.content[0].text).toContain('task-1');
    const data = getWrittenIpcData() as Record<string, unknown>;
    expect(data.type).toBe('cancel_task');
    expect(data.taskId).toBe('task-1');
    expect(data.groupFolder).toBe('grp-1');
  });
});

describe('pause_task', () => {
  it('writes pause IPC file', async () => {
    setContext({});
    const result = await getTool('pause_task').handler({ task_id: 'task-1' });
    expect(result.content[0].text).toContain('paused');
    const data = getWrittenIpcData() as Record<string, unknown>;
    expect(data.type).toBe('pause_task');
  });
});

describe('resume_task', () => {
  it('writes resume IPC file', async () => {
    setContext({});
    const result = await getTool('resume_task').handler({ task_id: 'task-1' });
    expect(result.content[0].text).toContain('resumed');
    const data = getWrittenIpcData() as Record<string, unknown>;
    expect(data.type).toBe('resume_task');
  });
});

describe('list_tasks', () => {
  it('returns tasks on success', async () => {
    setContext({ groupFolder: 'grp-1' });
    (fs.readFileSync as Mock).mockImplementation((p: string) => {
      if (p === '/workspace/context.json') {
        return JSON.stringify({
          chatJid: 'jid',
          groupFolder: 'grp-1',
          isMain: false,
        });
      }
      // Capture requestId from the IPC response path
      if (typeof p === 'string' && p.startsWith(path.join(IPC_DIR, 'input'))) {
        return JSON.stringify({
          tasks: [
            {
              id: 'task-1',
              group_folder: 'grp-1',
              prompt: 'do something',
              schedule_type: 'cron',
              schedule_value: '* * * * *',
              context_mode: 'group',
              status: 'active',
              next_run: Date.now() + 60000,
            },
          ],
        });
      }
      throw new Error('ENOENT');
    });

    const result = await getTool('list_tasks').handler({});
    expect(result.content[0].text).toContain('1 task(s)');
    expect(result.content[0].text).toContain('task-1');
  });

  it('returns timeout error when no response', async () => {
    setContext({ groupFolder: 'grp-1' });
    const result = await getTool('list_tasks').handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Timeout');
  }, 15_000);

  it('returns empty message when no tasks', async () => {
    setContext({});
    (fs.readFileSync as Mock).mockImplementation((p: string) => {
      if (p === '/workspace/context.json') {
        return JSON.stringify({
          chatJid: 'jid',
          groupFolder: 'grp',
          isMain: false,
        });
      }
      if (typeof p === 'string' && p.includes('/input/')) {
        return JSON.stringify({ tasks: [] });
      }
      throw new Error('ENOENT');
    });
    const result = await getTool('list_tasks').handler({});
    expect(result.content[0].text).toBe('No scheduled tasks.');
  });
});

describe('list_groups', () => {
  it('returns groups on success', async () => {
    (fs.readFileSync as Mock).mockImplementation((p: string) => {
      if (p === '/workspace/context.json') {
        return JSON.stringify({
          chatJid: 'jid',
          groupFolder: 'grp',
          isMain: false,
        });
      }
      if (typeof p === 'string' && p.includes('/input/')) {
        return JSON.stringify({
          groups: [
            {
              jid: 'jid-1',
              name: 'Test Group',
              folder: 'test',
              trigger: 'Bob',
              channel: 'telegram',
              is_main: true,
              always_respond: false,
              model: null,
            },
          ],
        });
      }
      throw new Error('ENOENT');
    });
    const result = await getTool('list_groups').handler({});
    expect(result.content[0].text).toContain('1 group(s)');
    expect(result.content[0].text).toContain('Test Group');
    expect(result.content[0].text).toContain('main');
  });

  it('returns timeout error when no response', async () => {
    setContext({});
    const result = await getTool('list_groups').handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Timeout');
  }, 15_000);
});

describe('update_task', () => {
  it('writes update IPC file with partial fields', async () => {
    setContext({ groupFolder: 'grp-1' });
    const result = await getTool('update_task').handler({
      task_id: 'task-1',
      prompt: 'new prompt',
    });
    expect(result.content[0].text).toContain('task-1');
    expect(result.content[0].text).toContain('update submitted');
    const data = getWrittenIpcData() as Record<string, unknown>;
    expect(data.type).toBe('update_task');
    expect(data.taskId).toBe('task-1');
    expect(data.prompt).toBe('new prompt');
    expect(data).not.toHaveProperty('scheduleType');
  });

  it('rejects invalid cron on update', async () => {
    setContext({});
    mockCronParse.mockImplementation(() => {
      throw new Error('bad');
    });
    const result = await getTool('update_task').handler({
      task_id: 'task-1',
      schedule_type: 'cron',
      schedule_value: 'bad',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid cron');
  });

  it('rejects invalid interval on update', async () => {
    setContext({});
    const result = await getTool('update_task').handler({
      task_id: 'task-1',
      schedule_type: 'interval',
      schedule_value: 'abc',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid interval');
  });
});

describe('register_group', () => {
  it('registers group when main', async () => {
    setMainContext();
    const result = await getTool('register_group').handler({
      jid: 'tg:-100123',
      name: 'New Group',
      folder: 'newgrp',
      trigger: 'Bot',
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('registration submitted');
    const data = getWrittenIpcData() as Record<string, unknown>;
    expect(data.type).toBe('register_group');
    expect(data.jid).toBe('tg:-100123');
    expect(data.alwaysRespond).toBe(false);
  });

  it('rejects when not main', async () => {
    setNonMainContext();
    const result = await getTool('register_group').handler({
      jid: 'tg:-100123',
      name: 'New Group',
      folder: 'newgrp',
      trigger: 'Bot',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Only the main group');
  });

  it('includes model and extra_mounts when provided', async () => {
    setMainContext();
    await getTool('register_group').handler({
      jid: 'tg:-100',
      name: 'G',
      folder: 'g',
      trigger: 'B',
      model: 'anthropic/claude-sonnet-4-6',
      extra_mounts: [
        {
          host_path: '/data',
          container_path: '/mnt/data',
          read_only: true,
        },
      ],
    });
    const data = getWrittenIpcData() as Record<string, unknown>;
    expect(data.model).toBe('anthropic/claude-sonnet-4-6');
    const mounts = data.extraMounts as Array<Record<string, unknown>>;
    expect(mounts[0].hostPath).toBe('/data');
    expect(mounts[0].readOnly).toBe(true);
  });
});

describe('update_group', () => {
  it('updates group when main', async () => {
    setMainContext();
    const result = await getTool('update_group').handler({
      folder: 'grp-1',
      name: 'Updated Name',
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('update submitted');
    const data = getWrittenIpcData() as Record<string, unknown>;
    expect(data.type).toBe('update_group');
    expect(data.folder).toBe('grp-1');
    expect(data.name).toBe('Updated Name');
  });

  it('rejects when not main', async () => {
    setNonMainContext();
    const result = await getTool('update_group').handler({
      folder: 'grp-1',
      name: 'Updated',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Only the main group');
  });

  it('clears model with empty string', async () => {
    setMainContext();
    await getTool('update_group').handler({
      folder: 'grp-1',
      model: '',
    });
    const data = getWrittenIpcData() as Record<string, unknown>;
    expect(data.model).toBeNull();
  });
});

describe('delete_group', () => {
  it('deletes group when main', async () => {
    setMainContext();
    const result = await getTool('delete_group').handler({ folder: 'grp-1' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('deletion submitted');
    const data = getWrittenIpcData() as Record<string, unknown>;
    expect(data.type).toBe('delete_group');
    expect(data.folder).toBe('grp-1');
  });

  it('rejects when not main', async () => {
    setNonMainContext();
    const result = await getTool('delete_group').handler({ folder: 'grp-1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Only the main group');
  });
});

describe('reset_session', () => {
  it('returns success on confirmation', async () => {
    (fs.readFileSync as Mock).mockImplementation((p: string) => {
      if (p === '/workspace/context.json') {
        return JSON.stringify({
          chatJid: 'jid',
          groupFolder: 'grp',
          isMain: false,
        });
      }
      if (typeof p === 'string' && p.includes('/input/')) {
        return JSON.stringify({ success: true });
      }
      throw new Error('ENOENT');
    });
    const result = await getTool('reset_session').handler({});
    expect(result.content[0].text).toContain('Session reset');
  });

  it('returns error on failure', async () => {
    (fs.readFileSync as Mock).mockImplementation((p: string) => {
      if (p === '/workspace/context.json') {
        return JSON.stringify({
          chatJid: 'jid',
          groupFolder: 'grp',
          isMain: false,
        });
      }
      if (typeof p === 'string' && p.includes('/input/')) {
        return JSON.stringify({ success: false });
      }
      throw new Error('ENOENT');
    });
    const result = await getTool('reset_session').handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to reset');
  });

  it('returns timeout error', async () => {
    setContext({});
    const result = await getTool('reset_session').handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Timeout');
  }, 15_000);
});

describe('list_sessions', () => {
  it('returns sessions on success', async () => {
    (fs.readFileSync as Mock).mockImplementation((p: string) => {
      if (p === '/workspace/context.json') {
        return JSON.stringify({
          chatJid: 'jid',
          groupFolder: 'grp',
          isMain: false,
        });
      }
      if (typeof p === 'string' && p.includes('/input/')) {
        return JSON.stringify({
          sessions: [
            {
              id: 'sess-1',
              title: 'Chat 1',
              created: 1700000000000,
              active: true,
            },
            {
              id: 'sess-2',
              title: undefined,
              created: undefined,
              active: false,
            },
          ],
        });
      }
      throw new Error('ENOENT');
    });
    const result = await getTool('list_sessions').handler({});
    expect(result.content[0].text).toContain('2 session(s)');
    expect(result.content[0].text).toContain('sess-1');
    expect(result.content[0].text).toContain('← active');
    expect(result.content[0].text).toContain('(untitled)');
  });

  it('returns empty when no sessions', async () => {
    (fs.readFileSync as Mock).mockImplementation((p: string) => {
      if (p === '/workspace/context.json') {
        return JSON.stringify({
          chatJid: 'jid',
          groupFolder: 'grp',
          isMain: false,
        });
      }
      if (typeof p === 'string' && p.includes('/input/')) {
        return JSON.stringify({ sessions: [] });
      }
      throw new Error('ENOENT');
    });
    const result = await getTool('list_sessions').handler({});
    expect(result.content[0].text).toBe('No sessions found.');
  });
});

describe('switch_session', () => {
  it('returns success on confirmation', async () => {
    (fs.readFileSync as Mock).mockImplementation((p: string) => {
      if (p === '/workspace/context.json') {
        return JSON.stringify({
          chatJid: 'jid',
          groupFolder: 'grp',
          isMain: false,
        });
      }
      if (typeof p === 'string' && p.includes('/input/')) {
        return JSON.stringify({ success: true, sessionId: 'sess-2' });
      }
      throw new Error('ENOENT');
    });
    const result = await getTool('switch_session').handler({
      session_id: 'sess-2',
    });
    expect(result.content[0].text).toContain('Switched to session sess-2');
  });

  it('returns error on failure', async () => {
    (fs.readFileSync as Mock).mockImplementation((p: string) => {
      if (p === '/workspace/context.json') {
        return JSON.stringify({
          chatJid: 'jid',
          groupFolder: 'grp',
          isMain: false,
        });
      }
      if (typeof p === 'string' && p.includes('/input/')) {
        return JSON.stringify({
          success: false,
          error: 'Session not found',
        });
      }
      throw new Error('ENOENT');
    });
    const result = await getTool('switch_session').handler({
      session_id: 'bad-id',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Session not found');
  });
});

describe('compose tools', () => {
  function setupComposeResponse(response: {
    success: boolean;
    output?: string;
    error?: string;
  }) {
    (fs.readFileSync as Mock).mockImplementation((p: string) => {
      if (p === '/workspace/context.json') {
        return JSON.stringify({
          chatJid: 'jid',
          groupFolder: 'grp',
          isMain: false,
        });
      }
      if (typeof p === 'string' && p.includes('/input/')) {
        return JSON.stringify(response);
      }
      throw new Error('ENOENT');
    });
  }

  it('compose_up writes correct IPC and returns success', async () => {
    setupComposeResponse({ success: true, output: 'Services started' });
    const result = await getTool('compose_up').handler({
      services: ['web', 'db'],
    });
    expect(result.content[0].text).toBe('Services started');
    const data = getWrittenIpcData() as Record<string, unknown>;
    expect(data.type).toBe('compose');
    expect(data.action).toBe('up');
    expect(data.services).toEqual(['web', 'db']);
  });

  it('compose_up without services omits field', async () => {
    setupComposeResponse({ success: true });
    await getTool('compose_up').handler({});
    const data = getWrittenIpcData() as Record<string, unknown>;
    expect(data).not.toHaveProperty('services');
  });

  it('compose_down with remove_volumes', async () => {
    setupComposeResponse({ success: true });
    await getTool('compose_down').handler({ remove_volumes: true });
    const data = getWrittenIpcData() as Record<string, unknown>;
    expect(data.action).toBe('down');
    expect(data.removeVolumes).toBe(true);
  });

  it('compose_build writes correct action', async () => {
    setupComposeResponse({ success: true });
    await getTool('compose_build').handler({ services: ['app'] });
    const data = getWrittenIpcData() as Record<string, unknown>;
    expect(data.action).toBe('build');
    expect(data.services).toEqual(['app']);
  });

  it('compose_logs passes service and lines', async () => {
    setupComposeResponse({ success: true, output: 'log output' });
    await getTool('compose_logs').handler({ service: 'web', lines: 50 });
    const data = getWrittenIpcData() as Record<string, unknown>;
    expect(data.action).toBe('logs');
    expect(data.services).toEqual(['web']);
    expect(data.lines).toBe(50);
  });

  it('compose_ps writes correct action', async () => {
    setupComposeResponse({ success: true, output: 'ps output' });
    const result = await getTool('compose_ps').handler({});
    expect(result.content[0].text).toBe('ps output');
    const data = getWrittenIpcData() as Record<string, unknown>;
    expect(data.action).toBe('ps');
  });

  it('compose_restart writes correct action', async () => {
    setupComposeResponse({ success: true });
    await getTool('compose_restart').handler({ services: ['api'] });
    const data = getWrittenIpcData() as Record<string, unknown>;
    expect(data.action).toBe('restart');
    expect(data.services).toEqual(['api']);
  });

  it('compose tool returns error on failure', async () => {
    setupComposeResponse({ success: false, error: 'service not found' });
    const result = await getTool('compose_up').handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('service not found');
  });

  it('compose tool returns timeout error', async () => {
    setContext({});
    const result = await getTool('compose_ps').handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Timeout');
  }, 35_000);
});

describe('transcribe_media', () => {
  it('returns timestamped transcript', async () => {
    setContext({});
    mockTranscribeMedia.mockResolvedValue({
      method: 'captions',
      language: 'en',
      text: 'Hello world',
      segments: [
        { text: 'Hello', offset: 0 },
        { text: 'world', offset: 65 },
      ],
    });
    const result = await getTool('transcribe_media').handler({
      source: 'https://youtube.com/watch?v=abc',
    });
    expect(result.content[0].text).toContain('2 segments');
    expect(result.content[0].text).toContain('[0:00] Hello');
    expect(result.content[0].text).toContain('[1:05] world');
    expect(result.content[0].text).toContain('method: captions');
    expect(result.content[0].text).toContain('language: en');
  });

  it('formats hours correctly', async () => {
    setContext({});
    mockTranscribeMedia.mockResolvedValue({
      method: 'stt',
      text: 'long video',
      segments: [{ text: 'late segment', offset: 3661 }],
    });
    const result = await getTool('transcribe_media').handler({
      source: '/file.mp4',
    });
    expect(result.content[0].text).toContain('[1:01:01]');
  });

  it('returns plain text when no segments', async () => {
    setContext({});
    mockTranscribeMedia.mockResolvedValue({
      method: 'stt',
      text: 'plain transcription',
      segments: [],
    });
    const result = await getTool('transcribe_media').handler({
      source: '/file.mp3',
    });
    expect(result.content[0].text).toContain('plain transcription');
    expect(result.content[0].text).toContain('method: stt');
  });

  it('returns error on transcription failure', async () => {
    setContext({});
    mockTranscribeMedia.mockRejectedValue(new Error('STT unavailable'));
    const result = await getTool('transcribe_media').handler({
      source: '/file.mp3',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('STT unavailable');
  });

  it('handles non-Error throws', async () => {
    setContext({});
    mockTranscribeMedia.mockRejectedValue('string error');
    const result = await getTool('transcribe_media').handler({
      source: '/file.mp3',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown error');
  });
});

describe('pollIpcResponse (via tools)', () => {
  it('polls multiple times before finding response', async () => {
    let callCount = 0;
    (fs.readFileSync as Mock).mockImplementation((p: string) => {
      if (p === '/workspace/context.json') {
        return JSON.stringify({
          chatJid: 'jid',
          groupFolder: 'grp',
          isMain: false,
        });
      }
      if (typeof p === 'string' && p.includes('/input/')) {
        callCount++;
        if (callCount < 3) {
          throw new Error('ENOENT');
        }
        return JSON.stringify({ tasks: [] });
      }
      throw new Error('ENOENT');
    });

    const result = await getTool('list_tasks').handler({});
    expect(result.content[0].text).toBe('No scheduled tasks.');
    expect(callCount).toBeGreaterThanOrEqual(3);
  });
});

describe('generateRequestId (via tools)', () => {
  it('generates unique request IDs across calls', async () => {
    const requestIds: string[] = [];
    (fs.writeFileSync as Mock).mockImplementation(
      (_p: string, content: string) => {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        if (parsed.requestId) {
          requestIds.push(parsed.requestId as string);
        }
      },
    );
    (fs.readFileSync as Mock).mockImplementation((p: string) => {
      if (p === '/workspace/context.json') {
        return JSON.stringify({
          chatJid: 'jid',
          groupFolder: 'grp',
          isMain: false,
        });
      }
      if (typeof p === 'string' && p.includes('/input/')) {
        return JSON.stringify({ tasks: [] });
      }
      throw new Error('ENOENT');
    });

    await getTool('list_tasks').handler({});
    await getTool('list_tasks').handler({});

    expect(requestIds.length).toBe(2);
    expect(requestIds[0]).not.toBe(requestIds[1]);
    expect(requestIds[0]).toMatch(/^req-\d+-[a-z0-9]+$/);
  });
});

// ── VNC Browser Session tools ─────────────────────────────────────────

describe('vnc_browser_session_start', () => {
  beforeEach(() => {
    setContext({});
    mockStartVncBrowserSession.mockReset();
  });

  it('starts a VNC session and returns the URL', async () => {
    mockStartVncBrowserSession.mockResolvedValue({
      port: 6080,
      url: 'http://192.168.1.100:7000/vnc.html',
    });

    const result = await getTool('vnc_browser_session_start').handler({
      name: 'kleinanzeigen',
      url: 'https://kleinanzeigen.de',
    });

    expect(mockStartVncBrowserSession).toHaveBeenCalledWith(
      'kleinanzeigen',
      'https://kleinanzeigen.de',
    );
    expect(result.content[0].text).toContain('VNC browser session');
    expect(result.content[0].text).toContain(
      'http://192.168.1.100:7000/vnc.html',
    );
    expect(result.isError).toBeUndefined();
  });

  it('returns error when a session is already active', async () => {
    mockStartVncBrowserSession.mockRejectedValue(
      new Error(
        'A VNC browser session is already active: "amazon". Stop it first with vnc_browser_session_stop.',
      ),
    );

    const result = await getTool('vnc_browser_session_start').handler({
      name: 'kleinanzeigen',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already active');
  });
});

describe('vnc_browser_session_stop', () => {
  beforeEach(() => {
    setContext({});
    mockStopVncBrowserSession.mockReset();
  });

  it('stops a VNC session and confirms profile saved', async () => {
    mockStopVncBrowserSession.mockResolvedValue(undefined);

    const result = await getTool('vnc_browser_session_stop').handler({
      name: 'kleinanzeigen',
    });

    expect(mockStopVncBrowserSession).toHaveBeenCalledWith('kleinanzeigen');
    expect(result.content[0].text).toContain('stopped');
    expect(result.content[0].text).toContain('Profile saved');
    expect(result.isError).toBeUndefined();
  });

  it('returns error when no session is active', async () => {
    mockStopVncBrowserSession.mockRejectedValue(
      new Error('No active VNC browser session.'),
    );

    const result = await getTool('vnc_browser_session_stop').handler({
      name: 'kleinanzeigen',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No active VNC browser session');
  });
});

describe('vnc_browser_session_status', () => {
  beforeEach(() => {
    mockGetActiveVncSessionName.mockReset();
    mockListBrowserProfiles.mockReset();
  });

  it('shows no active session and no profiles', async () => {
    mockGetActiveVncSessionName.mockReturnValue(null);
    mockListBrowserProfiles.mockReturnValue([]);

    const result = await getTool('vnc_browser_session_status').handler({});

    expect(result.content[0].text).toContain('No active VNC session');
    expect(result.content[0].text).toContain('No saved browser profiles');
  });

  it('shows active session and saved profiles', async () => {
    mockGetActiveVncSessionName.mockReturnValue('kleinanzeigen');
    mockListBrowserProfiles.mockReturnValue(['kleinanzeigen', 'amazon']);

    const result = await getTool('vnc_browser_session_status').handler({});

    expect(result.content[0].text).toContain(
      'Active VNC session: kleinanzeigen',
    );
    expect(result.content[0].text).toContain('kleinanzeigen, amazon');
  });
});
