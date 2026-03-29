/**
 * Stdio MCP Server for yetaclaw
 * Runs as child process inside agent container, provides IPC tools.
 * Context is read from /workspace/group/context.json (written by host on first message).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const CONTEXT_FILE = '/workspace/group/context.json';

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

const server = new McpServer({ name: 'yetaclaw', version: '1.0.0' });

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
  'register_group',
  `Register a new chat/group so the bot can respond to messages there. Main group only.

The bot user must already be a member of the target Mattermost channel.
Get the channel JID from the user — format: "mm:<channel-id>"`,
  {
    jid: z
      .string()
      .describe('Channel JID, e.g. "mm:bsn8i7mwgbgej8cq3ppda7r98w"'),
    name: z.string().describe('Display name for the group'),
    folder: z
      .string()
      .describe('Short slug for workspace dir, no spaces, e.g. "homebase"'),
    trigger: z
      .string()
      .describe('Word users type to address the bot, e.g. "winston"'),
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
      ...(args.model !== undefined && { model: args.model }),
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
  'Update settings for an existing group. Main group only.',
  {
    jid: z.string().describe('JID of the group to update'),
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
    jid: string;
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
      jid: args.jid,
      timestamp: new Date().toISOString(),
    };
    if (args.name !== undefined) data.name = args.name;
    if (args.trigger !== undefined) data.trigger = args.trigger;
    if (args.always_respond !== undefined)
      data.alwaysRespond = args.always_respond;
    if (args.model !== undefined) data.model = args.model || undefined; // empty string → clear override
    writeIpcFile(TASKS_DIR, data);
    return {
      content: [{ type: 'text' as const, text: `Group update submitted.` }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
