// Zod schemas for all IPC message types between agent and host.
// Used by processTaskIpc to validate incoming JSON before processing.

import { z } from 'zod';

const extraMountSchema = z.object({
  hostPath: z.string(),
  containerPath: z.string(),
  readOnly: z.boolean(),
});

export const scheduleTaskSchema = z.object({
  type: z.literal('schedule_task'),
  prompt: z.string(),
  scheduleType: z.enum(['cron', 'interval', 'once']),
  scheduleValue: z.string(),
  targetJid: z.string(),
  contextMode: z.enum(['group', 'isolated']).optional(),
  taskId: z.string().optional(),
});

export const cancelTaskSchema = z.object({
  type: z.literal('cancel_task'),
  taskId: z.string(),
});

export const pauseTaskSchema = z.object({
  type: z.literal('pause_task'),
  taskId: z.string(),
});

export const resumeTaskSchema = z.object({
  type: z.literal('resume_task'),
  taskId: z.string(),
});

export const listTasksSchema = z.object({
  type: z.literal('list_tasks'),
  requestId: z.string(),
});

export const listGroupsSchema = z.object({
  type: z.literal('list_groups'),
  requestId: z.string(),
});

export const updateTaskSchema = z.object({
  type: z.literal('update_task'),
  taskId: z.string(),
  prompt: z.string().optional(),
  scheduleType: z.enum(['cron', 'interval', 'once']).optional(),
  scheduleValue: z.string().optional(),
  contextMode: z.enum(['group', 'isolated']).optional(),
});

export const registerGroupSchema = z.object({
  type: z.literal('register_group'),
  jid: z.string(),
  name: z.string(),
  folder: z.string(),
  trigger: z.string(),
  isMain: z.boolean().optional(),
  alwaysRespond: z.boolean().optional(),
  model: z.union([z.string(), z.null()]).optional(),
  extraMounts: z.union([z.array(extraMountSchema), z.null()]).optional(),
});

export const deleteGroupSchema = z.object({
  type: z.literal('delete_group'),
  folder: z.string(),
});

export const updateGroupSchema = z.object({
  type: z.literal('update_group'),
  folder: z.string(),
  jid: z.string().optional(),
  name: z.string().optional(),
  trigger: z.string().optional(),
  isMain: z.boolean().optional(),
  alwaysRespond: z.boolean().optional(),
  model: z.union([z.string(), z.null()]).optional(),
  extraMounts: z.union([z.array(extraMountSchema), z.null()]).optional(),
  browserEnabled: z.boolean().optional(),
});

export const resetSessionSchema = z.object({
  type: z.literal('reset_session'),
  requestId: z.string(),
});

export const listSessionsSchema = z.object({
  type: z.literal('list_sessions'),
  requestId: z.string(),
});

export const switchSessionSchema = z.object({
  type: z.literal('switch_session'),
  requestId: z.string(),
  sessionId: z.string().optional(),
});

export const publishSkillSchema = z.object({
  type: z.literal('publish_skill'),
  requestId: z.string(),
  name: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      content: z.string(),
    }),
  ),
});

export const composeSchema = z.object({
  type: z.literal('compose'),
  action: z.enum(['up', 'down', 'build', 'logs', 'ps', 'restart']),
  services: z.array(z.string()).optional(),
  lines: z.number().int().positive().optional(),
  removeVolumes: z.boolean().optional(),
  requestId: z.string(),
});

export const taskIpcSchema = z.discriminatedUnion('type', [
  scheduleTaskSchema,
  cancelTaskSchema,
  pauseTaskSchema,
  resumeTaskSchema,
  listTasksSchema,
  listGroupsSchema,
  updateTaskSchema,
  registerGroupSchema,
  deleteGroupSchema,
  updateGroupSchema,
  resetSessionSchema,
  listSessionsSchema,
  switchSessionSchema,
  publishSkillSchema,
  composeSchema,
]);

export type TaskIpcMessage = z.infer<typeof taskIpcSchema>;

export const messageIpcSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message'),
    chatJid: z.string(),
    text: z.string(),
    sender: z.string().optional(),
  }),
  z.object({
    type: z.literal('send_photo'),
    chatJid: z.string(),
    source: z.string(),
    caption: z.string().optional(),
  }),
  z.object({
    type: z.literal('send_document'),
    chatJid: z.string(),
    source: z.string(),
    caption: z.string().optional(),
  }),
]);

export type MessageIpcMessage = z.infer<typeof messageIpcSchema>;
