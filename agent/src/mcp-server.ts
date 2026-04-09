/**
 * Stdio MCP Server for openbob
 * Runs as child process inside agent container, provides IPC tools.
 * Context is read from /workspace/context.json (written by host, mounted ro).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/data/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const CONTEXT_FILE = '/workspace/context.json';

interface GroupContext {
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
}

function readContext(): GroupContext {
  try {
    const raw = fs.readFileSync(CONTEXT_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      chatJid: parsed.chatJid ?? '',
      groupFolder: parsed.groupFolder ?? '',
      isMain: parsed.isMain === true,
    };
  } catch {
    return { chatJid: '', groupFolder: '', isMain: false };
  }
}

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

const server = new McpServer({ name: 'openbob', version: '1.0.0' });

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z
      .string()
      .optional()
      .describe('Your role/identity name shown above the message.'),
  },
  async (args: { text: string; sender?: string }) => {
    const ctx = readContext();
    writeIpcFile(MESSAGES_DIR, {
      type: 'message',
      chatJid: ctx.chatJid,
      text: args.text,
      ...(args.sender && { sender: args.sender }),
      groupFolder: ctx.groupFolder,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'send_photo',
  'Send a photo/image to the user or group. The file must exist on the local filesystem (e.g. a screenshot taken with agent-browser). You can also pass an HTTP(S) URL.',
  {
    source: z
      .string()
      .describe(
        'Absolute file path (e.g. /workspace/data/screenshot.png) or HTTP(S) URL',
      ),
    caption: z.string().optional().describe('Optional caption for the photo'),
  },
  async (args: { source: string; caption?: string }) => {
    const ctx = readContext();
    writeIpcFile(MESSAGES_DIR, {
      type: 'send_photo',
      chatJid: ctx.chatJid,
      source: args.source,
      ...(args.caption && { caption: args.caption }),
      groupFolder: ctx.groupFolder,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'Photo sent.' }] };
  },
);

server.tool(
  'send_document',
  'Send a document/file to the user or group. The file must exist on the local filesystem. You can also pass an HTTP(S) URL.',
  {
    source: z
      .string()
      .describe(
        'Absolute file path (e.g. /workspace/data/report.pdf) or HTTP(S) URL',
      ),
    caption: z
      .string()
      .optional()
      .describe('Optional caption for the document'),
  },
  async (args: { source: string; caption?: string }) => {
    const ctx = readContext();
    writeIpcFile(MESSAGES_DIR, {
      type: 'send_document',
      chatJid: ctx.chatJid,
      source: args.source,
      ...(args.caption && { caption: args.caption }),
      groupFolder: ctx.groupFolder,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'Document sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE:
• "group": runs with chat history. Use for tasks needing conversation context.
• "isolated": fresh session. Include all context in the prompt.

SCHEDULE VALUE FORMAT (local timezone):
• cron: "*/5 * * * *" (every 5 min), "0 9 * * *" (daily 9am)
• interval: milliseconds, e.g. "300000" for 5 min
• once: local timestamp without Z suffix, e.g. "2026-03-25T15:00:00"`,
  {
    prompt: z
      .string()
      .describe(
        'What the agent should do. For isolated mode, include all context here.',
      ),
    schedule_type: z.enum(['cron', 'interval', 'once']),
    schedule_value: z.string(),
    context_mode: z.enum(['group', 'isolated']).default('group'),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) Target group JID. Defaults to current group.',
      ),
  },
  async (args: {
    prompt: string;
    schedule_type: 'cron' | 'interval' | 'once';
    schedule_value: string;
    context_mode?: 'group' | 'isolated';
    target_group_jid?: string;
  }) => {
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}"`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0)
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}". Use milliseconds.`,
            },
          ],
          isError: true,
        };
    } else if (args.schedule_type === 'once') {
      if (
        /[Zz]$/.test(args.schedule_value) ||
        /[+-]\d{2}:\d{2}$/.test(args.schedule_value)
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Timestamp must be local time without timezone suffix.`,
            },
          ],
          isError: true,
        };
      }
      if (isNaN(new Date(args.schedule_value).getTime())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid timestamp: "${args.schedule_value}"`,
            },
          ],
          isError: true,
        };
      }
    }

    const ctx = readContext();
    const targetJid =
      ctx.isMain && args.target_group_jid ? args.target_group_jid : ctx.chatJid;
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    writeIpcFile(TASKS_DIR, {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      scheduleType: args.schedule_type,
      scheduleValue: args.schedule_value,
      contextMode: args.context_mode ?? 'group',
      targetJid,
      createdBy: ctx.groupFolder,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled.` }],
    };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string() },
  async (args: { task_id: string }) => {
    const ctx = readContext();
    writeIpcFile(TASKS_DIR, {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder: ctx.groupFolder,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} cancellation requested.`,
        },
      ],
    };
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task.',
  { task_id: z.string() },
  async (args: { task_id: string }) => {
    const ctx = readContext();
    writeIpcFile(TASKS_DIR, {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder: ctx.groupFolder,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [
        { type: 'text' as const, text: `Task ${args.task_id} paused.` },
      ],
    };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string() },
  async (args: { task_id: string }) => {
    const ctx = readContext();
    writeIpcFile(TASKS_DIR, {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder: ctx.groupFolder,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [
        { type: 'text' as const, text: `Task ${args.task_id} resumed.` },
      ],
    };
  },
);

server.tool(
  'list_tasks',
  `List all scheduled tasks. Returns task ID, prompt, schedule, status, and next run time.
Main group sees all tasks across groups; other groups see only their own.`,
  {},
  async () => {
    const ctx = readContext();
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    writeIpcFile(TASKS_DIR, {
      type: 'list_tasks',
      requestId,
      groupFolder: ctx.groupFolder,
      timestamp: new Date().toISOString(),
    });

    // Poll for response from host
    const responsePath = path.join(IPC_DIR, 'input', `${requestId}.json`);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const raw = fs.readFileSync(responsePath, 'utf-8');
        fs.unlinkSync(responsePath);
        const data = JSON.parse(raw) as {
          tasks: Array<{
            id: string;
            jid: string;
            group_folder: string;
            prompt: string;
            schedule_type: string;
            schedule_value: string;
            context_mode: string;
            status: string;
            next_run: number;
            created_at: number;
            created_by: string;
          }>;
        };
        if (data.tasks.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No scheduled tasks.' }],
          };
        }
        const lines = data.tasks.map((t) => {
          const next = t.next_run ? new Date(t.next_run).toISOString() : 'n/a';
          return [
            `ID: ${t.id}`,
            `  Group: ${t.group_folder}`,
            `  Status: ${t.status}`,
            `  Schedule: ${t.schedule_type} — ${t.schedule_value}`,
            `  Context: ${t.context_mode}`,
            `  Next run: ${next}`,
            `  Prompt: ${t.prompt.length > 120 ? t.prompt.slice(0, 120) + '…' : t.prompt}`,
          ].join('\n');
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `${data.tasks.length} task(s):\n\n${lines.join('\n\n')}`,
            },
          ],
        };
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Timeout waiting for task list from host.',
        },
      ],
      isError: true,
    };
  },
);

server.tool(
  'list_groups',
  `List all registered groups/chats. Returns JID, name, folder, trigger, channel, and settings for each group.
Main group sees all groups; other groups see only their own.`,
  {},
  async () => {
    const ctx = readContext();
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    writeIpcFile(TASKS_DIR, {
      type: 'list_groups',
      requestId,
      groupFolder: ctx.groupFolder,
      timestamp: new Date().toISOString(),
    });

    // Poll for response from host
    const responsePath = path.join(IPC_DIR, 'input', `${requestId}.json`);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const raw = fs.readFileSync(responsePath, 'utf-8');
        fs.unlinkSync(responsePath);
        const data = JSON.parse(raw) as {
          groups: Array<{
            jid: string;
            name: string;
            folder: string;
            trigger: string;
            channel: string;
            is_main: boolean;
            always_respond: boolean;
            model: string | null;
          }>;
        };
        if (data.groups.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No registered groups.' }],
          };
        }
        const lines = data.groups.map((g) => {
          const flags = [
            g.is_main ? 'main' : null,
            g.always_respond ? 'always-respond' : null,
          ]
            .filter(Boolean)
            .join(', ');
          return [
            `Name: ${g.name}`,
            `  JID: ${g.jid}`,
            `  Folder: ${g.folder}`,
            `  Trigger: ${g.trigger}`,
            `  Channel: ${g.channel}`,
            ...(g.model ? [`  Model: ${g.model}`] : []),
            ...(flags ? [`  Flags: ${flags}`] : []),
          ].join('\n');
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `${data.groups.length} group(s):\n\n${lines.join('\n\n')}`,
            },
          ],
        };
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Timeout waiting for group list from host.',
        },
      ],
      isError: true,
    };
  },
);

server.tool(
  'update_task',
  `Update an existing scheduled task. Only provide the fields you want to change.
If you change schedule_type, you must also provide a matching schedule_value.`,
  {
    task_id: z.string().describe('ID of the task to update'),
    prompt: z
      .string()
      .optional()
      .describe('New prompt/instructions for the task'),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .optional()
      .describe('New schedule type'),
    schedule_value: z
      .string()
      .optional()
      .describe(
        'New schedule value (cron expression, ms interval, or local timestamp)',
      ),
    context_mode: z
      .enum(['group', 'isolated'])
      .optional()
      .describe('New context mode'),
  },
  async (args: {
    task_id: string;
    prompt?: string;
    schedule_type?: 'cron' | 'interval' | 'once';
    schedule_value?: string;
    context_mode?: 'group' | 'isolated';
  }) => {
    // Validate schedule_value if schedule_type is provided
    if (args.schedule_type === 'cron' && args.schedule_value) {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}"`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}". Use milliseconds.`,
            },
          ],
          isError: true,
        };
      }
    }

    const ctx = readContext();
    writeIpcFile(TASKS_DIR, {
      type: 'update_task',
      taskId: args.task_id,
      ...(args.prompt !== undefined && { prompt: args.prompt }),
      ...(args.schedule_type !== undefined && {
        scheduleType: args.schedule_type,
      }),
      ...(args.schedule_value !== undefined && {
        scheduleValue: args.schedule_value,
      }),
      ...(args.context_mode !== undefined && {
        contextMode: args.context_mode,
      }),
      groupFolder: ctx.groupFolder,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} update submitted.`,
        },
      ],
    };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the bot can respond to messages there. Main group only.

The bot user must already be a member of the target channel/group.
Get the channel JID from the user — format: "tg:<chat-id>" for Telegram or "mm:<channel-id>" for Mattermost.`,
  {
    jid: z
      .string()
      .describe(
        'Channel JID, e.g. "tg:-1001234567890" or "mm:bsn8i7mwgbgej8cq3ppda7r98w"',
      ),
    name: z.string().describe('Display name for the group'),
    folder: z
      .string()
      .describe('Short slug for workspace dir, no spaces, e.g. "homebase"'),
    trigger: z
      .string()
      .describe('Word users type to address the bot, e.g. "Bob"'),
    always_respond: z
      .boolean()
      .optional()
      .describe(
        'If true, bot responds to every message. If false (default), only when trigger word is present.',
      ),
    model: z
      .string()
      .optional()
      .describe(
        'Per-group model override, e.g. "anthropic/claude-sonnet-4-6". Omit to use the global default.',
      ),
  },
  async (args: {
    jid: string;
    name: string;
    folder: string;
    trigger: string;
    always_respond?: boolean;
    model?: string;
  }) => {
    const ctx = readContext();
    if (!ctx.isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can register new groups.',
          },
        ],
        isError: true,
      };
    }
    writeIpcFile(TASKS_DIR, {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      alwaysRespond: args.always_respond ?? false,
      ...(args.model !== undefined && { model: args.model || null }),
      timestamp: new Date().toISOString(),
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: `Group "${args.name}" registration submitted. Container will start within seconds.`,
        },
      ],
    };
  },
);

server.tool(
  'update_group',
  `Update settings for an existing group. Main group only.
Identify the group by its folder name. You can change any field including the JID (channel migration).`,
  {
    folder: z.string().describe('Folder slug of the group to update'),
    jid: z
      .string()
      .optional()
      .describe(
        'New channel JID — migrates the group to a different channel (e.g. "tg:-1001234567890")',
      ),
    name: z.string().optional(),
    trigger: z.string().optional(),
    always_respond: z.boolean().optional(),
    model: z
      .string()
      .optional()
      .describe(
        'Per-group model override. Set to empty string to clear and use global default.',
      ),
  },
  async (args: {
    folder: string;
    jid?: string;
    name?: string;
    trigger?: string;
    always_respond?: boolean;
    model?: string;
  }) => {
    const ctx = readContext();
    if (!ctx.isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can update groups.',
          },
        ],
        isError: true,
      };
    }
    const data: Record<string, unknown> = {
      type: 'update_group',
      folder: args.folder,
      timestamp: new Date().toISOString(),
    };
    if (args.jid !== undefined) data.jid = args.jid;
    if (args.name !== undefined) data.name = args.name;
    if (args.trigger !== undefined) data.trigger = args.trigger;
    if (args.always_respond !== undefined)
      data.alwaysRespond = args.always_respond;
    if (args.model !== undefined) data.model = args.model || null; // empty string → null → clear override
    writeIpcFile(TASKS_DIR, data);
    return {
      content: [{ type: 'text' as const, text: `Group update submitted.` }],
    };
  },
);

server.tool(
  'delete_group',
  'Delete a registered group and stop its agent container. Main group only. Cannot delete the main group itself.',
  {
    folder: z.string().describe('Folder slug of the group to delete'),
  },
  async (args: { folder: string }) => {
    const ctx = readContext();
    if (!ctx.isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can delete groups.',
          },
        ],
        isError: true,
      };
    }
    writeIpcFile(TASKS_DIR, {
      type: 'delete_group',
      folder: args.folder,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: `Group "${args.folder}" deletion submitted. Container will be stopped.`,
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
