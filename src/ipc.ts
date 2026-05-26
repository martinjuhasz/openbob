// IPC watcher — polls GROUPS_DIR/<group>/ipc/{messages,tasks}/ for JSON files
// dropped there by agent containers to send messages or manage scheduled tasks

import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  channelFromJid,
  GROUPS_DIR,
  isValidGroupFolder,
  POLL_INTERVAL,
  SKILLS_DIR,
} from './config.js';
import {
  deleteRegisteredGroup,
  deleteSession,
  deleteTask,
  getActiveTasks,
  getAllRegisteredGroups,
  getAllTasks,
  getSession,
  getTaskById,
  getTasksForGroup,
  migrateGroupJid,
  setRegisteredGroup,
  setSession,
  updateTask,
  upsertTask,
} from './db.js';
import { listAgentSessions, validateAgentSession } from './container-runner.js';
import { handleComposeIpc } from './compose.js';
import { logger } from './logger.js';
import {
  messageIpcSchema,
  taskIpcSchema,
  type TaskIpcMessage,
} from './ipc-schemas.js';
import { GroupConfig, ScheduledTask } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendPhoto: (jid: string, source: string, caption?: string) => Promise<void>;
  sendDocument: (
    jid: string,
    source: string,
    caption?: string,
  ) => Promise<void>;
  registeredGroups: () => Record<string, GroupConfig>;
  onTasksChanged: () => void;
  onGroupRegistered: (config: GroupConfig) => void;
  onGroupUpdated: (config: GroupConfig, oldJid?: string) => void;
  onGroupDeleted: (folder: string, jid: string) => void;
}

/**
 * Translate a container-relative file path to the host-side path.
 * Agent containers mount `groups/<folder>/` as `/workspace/data/`, so
 * `/workspace/data/screenshot.png` → `GROUPS_DIR/<folder>/screenshot.png`.
 * HTTP(S) URLs are returned unchanged.
 * Returns null for any path that escapes the group directory or is not allowed.
 */
const CONTAINER_DATA_PREFIX = '/workspace/data/';

export function resolveContainerPath(
  source: string,
  groupFolder: string,
): string | null {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    return source;
  }

  const groupDir = path.resolve(GROUPS_DIR, groupFolder);

  if (
    source.startsWith(CONTAINER_DATA_PREFIX) ||
    source === '/workspace/data'
  ) {
    const relative =
      source === '/workspace/data'
        ? ''
        : source.slice(CONTAINER_DATA_PREFIX.length);
    const resolved = path.resolve(groupDir, relative);
    // Ensure the resolved path stays within the group directory
    if (!resolved.startsWith(groupDir + path.sep) && resolved !== groupDir) {
      return null;
    }
    return resolved;
  }

  // All other paths (absolute host paths, relative paths, etc.) are rejected.
  return null;
}

/**
 * Format an outbound IPC message, optionally prefixing with sender identity.
 * Uses `[sender]: text` format compatible with OpenViking memory.
 */
export function formatIpcOutbound(text: string, sender?: string): string {
  return sender ? `[${sender}]: ${text}` : text;
}

/**
 * Write a JSON response to the IPC input directory for the agent to poll.
 * Uses atomic write (write to .tmp then rename) to prevent partial reads.
 */
export function writeIpcResponse(
  sourceGroup: string,
  requestId: string,
  data: unknown,
): void {
  const responseDir = path.join(GROUPS_DIR, sourceGroup, 'ipc', 'input');
  fs.mkdirSync(responseDir, { recursive: true });
  const responsePath = path.join(responseDir, `${requestId}.json`);
  const tempPath = `${responsePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data));
  fs.renameSync(tempPath, responsePath);
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  fs.mkdirSync(GROUPS_DIR, { recursive: true });

  const processIpcFiles = async () => {
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(GROUPS_DIR).filter((f) => {
        const stat = fs.statSync(path.join(GROUPS_DIR, f));
        return stat.isDirectory();
      });
      // eslint-disable-next-line no-catch-all/no-catch-all -- poll loop: retry on next interval
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→jid lookup and folder→isMain
    const folderToJid = new Map<string, string>();
    const folderIsMain = new Map<string, boolean>();
    for (const [jid, group] of Object.entries(registeredGroups)) {
      folderToJid.set(group.folder, jid);
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(GROUPS_DIR, sourceGroup, 'ipc', 'messages');
      const tasksDir = path.join(GROUPS_DIR, sourceGroup, 'ipc', 'tasks');

      // Process message files
      try {
        if (fs.existsSync(messagesDir)) {
          const files = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of files) {
            const filePath = path.join(messagesDir, file);
            try {
              const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              const parsed = messageIpcSchema.safeParse(raw);
              if (!parsed.success) {
                logger.warn(
                  { file, sourceGroup, errors: parsed.error.issues },
                  'IPC message validation failed',
                );
                fs.unlinkSync(filePath);
                continue;
              }
              const data = parsed.data;

              if (data.type === 'message') {
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(
                    data.chatJid,
                    formatIpcOutbound(data.text, data.sender),
                  );
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              } else if (data.type === 'send_photo') {
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  const hostSource = resolveContainerPath(
                    data.source,
                    sourceGroup,
                  );
                  if (!hostSource) {
                    logger.warn(
                      {
                        chatJid: data.chatJid,
                        source: data.source,
                        sourceGroup,
                      },
                      'IPC send_photo blocked: path traversal rejected',
                    );
                  } else {
                    await deps.sendPhoto(
                      data.chatJid,
                      hostSource,
                      data.caption,
                    );
                    logger.info(
                      {
                        chatJid: data.chatJid,
                        source: data.source,
                        hostSource,
                        sourceGroup,
                      },
                      'IPC photo sent',
                    );
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC send_photo attempt blocked',
                  );
                }
              } else if (data.type === 'send_document') {
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  const hostSource = resolveContainerPath(
                    data.source,
                    sourceGroup,
                  );
                  if (!hostSource) {
                    logger.warn(
                      {
                        chatJid: data.chatJid,
                        source: data.source,
                        sourceGroup,
                      },
                      'IPC send_document blocked: path traversal rejected',
                    );
                  } else {
                    await deps.sendDocument(
                      data.chatJid,
                      hostSource,
                      data.caption,
                    );
                    logger.info(
                      {
                        chatJid: data.chatJid,
                        source: data.source,
                        hostSource,
                        sourceGroup,
                      },
                      'IPC document sent',
                    );
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC send_document attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
              // eslint-disable-next-line no-catch-all/no-catch-all -- isolate per-message failure
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              moveToErrors(filePath, sourceGroup, file);
            }
          }
        }
        // eslint-disable-next-line no-catch-all/no-catch-all -- isolate per-group message dir failure
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process task files
      try {
        if (fs.existsSync(tasksDir)) {
          const files = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of files) {
            const filePath = path.join(tasksDir, file);
            try {
              const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              const parsed = taskIpcSchema.safeParse(raw);
              if (!parsed.success) {
                logger.warn(
                  { file, sourceGroup, errors: parsed.error.issues },
                  'IPC task validation failed',
                );
                moveToErrors(filePath, sourceGroup, file);
                continue;
              }
              await processTaskIpc(
                parsed.data,
                sourceGroup,
                isMain,
                folderToJid,
                deps,
              );
              fs.unlinkSync(filePath);
              // eslint-disable-next-line no-catch-all/no-catch-all -- isolate per-task failure
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              moveToErrors(filePath, sourceGroup, file);
            }
          }
        }
        // eslint-disable-next-line no-catch-all/no-catch-all -- isolate per-group task dir failure
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started');
}

function moveToErrors(
  filePath: string,
  sourceGroup: string,
  file: string,
): void {
  try {
    const errorDir = path.join(GROUPS_DIR, sourceGroup, 'ipc', 'errors');
    fs.mkdirSync(errorDir, { recursive: true });
    fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
    // eslint-disable-next-line no-catch-all/no-catch-all -- last-ditch: ignore rename errors
  } catch {
    // intentionally empty: rename failure is non-critical
  }
}

export async function processTaskIpc(
  data: TaskIpcMessage,
  sourceGroup: string,
  isMain: boolean,
  _folderToJid: Map<string, string>,
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task': {
      const targetGroup = registeredGroups[data.targetJid];
      if (!targetGroup) {
        logger.warn(
          { targetJid: data.targetJid },
          'schedule_task: target group not registered',
        );
        break;
      }

      // Authorization: non-main groups can only schedule for themselves
      if (!isMain && targetGroup.folder !== sourceGroup) {
        logger.warn(
          { sourceGroup, targetFolder: targetGroup.folder },
          'Unauthorized schedule_task attempt blocked',
        );
        break;
      }

      const scheduleType = data.scheduleType;
      let nextRun: number;

      if (scheduleType === 'cron') {
        try {
          const interval = CronExpressionParser.parse(data.scheduleValue);
          nextRun = interval.next().getTime();
          // eslint-disable-next-line no-catch-all/no-catch-all -- invalid cron from agent input
        } catch {
          logger.warn(
            { scheduleValue: data.scheduleValue },
            'Invalid cron expression',
          );
          break;
        }
      } else if (scheduleType === 'interval') {
        const ms = parseInt(data.scheduleValue, 10);
        if (isNaN(ms) || ms <= 0) {
          logger.warn(
            { scheduleValue: data.scheduleValue },
            'Invalid interval',
          );
          break;
        }
        nextRun = Date.now() + ms;
      } else if (scheduleType === 'once') {
        const date = new Date(data.scheduleValue);
        if (isNaN(date.getTime())) {
          logger.warn(
            { scheduleValue: data.scheduleValue },
            'Invalid timestamp',
          );
          break;
        }
        nextRun = date.getTime();
      } else {
        logger.warn({ scheduleType }, 'Unknown schedule type');
        break;
      }

      const contextMode =
        data.contextMode === 'group' || data.contextMode === 'isolated'
          ? data.contextMode
          : 'isolated';

      const taskId =
        data.taskId ??
        `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const task: ScheduledTask = {
        id: taskId,
        jid: data.targetJid,
        group_folder: targetGroup.folder,
        prompt: data.prompt,
        schedule_type: scheduleType,
        schedule_value: data.scheduleValue,
        context_mode: contextMode,
        status: 'active',
        next_run: nextRun,
        created_at: Date.now(),
        created_by: sourceGroup,
      };
      upsertTask(task);
      logger.info(
        { taskId, sourceGroup, targetFolder: targetGroup.folder },
        'Task created via IPC',
      );
      deps.onTasksChanged();
      break;
    }

    case 'cancel_task': {
      const tasks = getActiveTasks();
      const task = tasks.find((t) => t.id === data.taskId);
      if (task && (isMain || task.group_folder === sourceGroup)) {
        deleteTask(data.taskId);
        logger.info(
          { taskId: data.taskId, sourceGroup },
          'Task cancelled via IPC',
        );
        deps.onTasksChanged();
      } else {
        logger.warn(
          { taskId: data.taskId, sourceGroup },
          'Unauthorized task cancel attempt or task not found',
        );
      }
      break;
    }

    case 'pause_task': {
      const tasks = getActiveTasks();
      const task = tasks.find((t) => t.id === data.taskId);
      if (task && (isMain || task.group_folder === sourceGroup)) {
        upsertTask({ ...task, status: 'paused' });
        logger.info(
          { taskId: data.taskId, sourceGroup },
          'Task paused via IPC',
        );
        deps.onTasksChanged();
      } else {
        logger.warn(
          { taskId: data.taskId, sourceGroup },
          'Unauthorized task pause attempt or task not found',
        );
      }
      break;
    }

    case 'resume_task': {
      const task = getTaskById(data.taskId);
      if (
        task &&
        task.status === 'paused' &&
        (isMain || task.group_folder === sourceGroup)
      ) {
        const now = Date.now();
        let next_run = task.next_run;
        // Recalculate next run for recurring tasks since the paused time may have passed
        if (task.schedule_type === 'cron') {
          try {
            const interval = CronExpressionParser.parse(task.schedule_value);
            next_run = interval.next().getTime();
            // eslint-disable-next-line no-catch-all/no-catch-all -- invalid cron from DB
          } catch {
            next_run = now + 60_000;
          }
        } else if (task.schedule_type === 'interval') {
          const ms = parseInt(task.schedule_value, 10);
          next_run = now + (ms > 0 ? ms : 60_000);
        }
        // For 'once' tasks, keep the original next_run
        upsertTask({ ...task, status: 'active', next_run });
        logger.info(
          { taskId: data.taskId, sourceGroup, next_run },
          'Task resumed via IPC',
        );
        deps.onTasksChanged();
      } else {
        logger.warn(
          { taskId: data.taskId, sourceGroup },
          'Unauthorized task resume attempt or task not found/not paused',
        );
      }
      break;
    }

    case 'list_tasks': {
      const tasks = isMain ? getAllTasks() : getTasksForGroup(sourceGroup);
      writeIpcResponse(sourceGroup, data.requestId, { tasks });
      logger.debug(
        { sourceGroup, requestId: data.requestId, count: tasks.length },
        'list_tasks response written',
      );
      break;
    }

    case 'list_groups': {
      const allGroups = getAllRegisteredGroups();
      const groupList = Object.values(allGroups)
        .filter((g) => isMain || g.folder === sourceGroup)
        .map((g) => ({
          jid: g.jid,
          name: g.name,
          folder: g.folder,
          trigger: g.trigger,
          channel: g.channel,
          is_main: g.isMain,
          always_respond: g.alwaysRespond,
          model: g.model ?? null,
          extra_mounts: g.extraMounts ?? null,
          browser_enabled: g.browserEnabled,
        }));
      writeIpcResponse(sourceGroup, data.requestId, { groups: groupList });
      logger.debug(
        { sourceGroup, requestId: data.requestId, count: groupList.length },
        'list_groups response written',
      );
      break;
    }

    case 'update_task': {
      const task = getTaskById(data.taskId);
      if (!task) {
        logger.warn(
          { taskId: data.taskId, sourceGroup },
          'update_task: task not found',
        );
        break;
      }
      if (!isMain && task.group_folder !== sourceGroup) {
        logger.warn(
          { taskId: data.taskId, sourceGroup },
          'Unauthorized update_task attempt',
        );
        break;
      }

      const fields: Parameters<typeof updateTask>[1] = {};
      if (data.prompt !== undefined) fields.prompt = data.prompt;
      if (data.contextMode === 'group' || data.contextMode === 'isolated') {
        fields.context_mode = data.contextMode;
      }

      // Handle schedule changes
      const newType =
        (data.scheduleType as ScheduledTask['schedule_type']) ??
        task.schedule_type;
      const newValue = data.scheduleValue ?? task.schedule_value;
      if (data.scheduleType !== undefined) fields.schedule_type = newType;
      if (data.scheduleValue !== undefined) fields.schedule_value = newValue;

      // Recalculate next_run if schedule changed
      if (data.scheduleType !== undefined || data.scheduleValue !== undefined) {
        const now = Date.now();
        if (newType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(newValue);
            fields.next_run = interval.next().getTime();
            // eslint-disable-next-line no-catch-all/no-catch-all -- invalid cron from agent input
          } catch {
            logger.warn(
              { taskId: data.taskId, scheduleValue: newValue },
              'update_task: invalid cron expression',
            );
            break;
          }
        } else if (newType === 'interval') {
          const ms = parseInt(newValue, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { taskId: data.taskId, scheduleValue: newValue },
              'update_task: invalid interval',
            );
            break;
          }
          fields.next_run = now + ms;
        } else if (newType === 'once') {
          const date = new Date(newValue);
          if (isNaN(date.getTime())) {
            logger.warn(
              { taskId: data.taskId, scheduleValue: newValue },
              'update_task: invalid timestamp',
            );
            break;
          }
          fields.next_run = date.getTime();
        }
      }

      updateTask(data.taskId, fields);
      logger.info(
        { taskId: data.taskId, sourceGroup, fields },
        'Task updated via IPC',
      );
      deps.onTasksChanged();
      break;
    }

    case 'register_group': {
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'register_group: only main group is allowed',
        );
        break;
      }
      if (!isValidGroupFolder(data.folder)) {
        logger.warn(
          { folder: data.folder, sourceGroup },
          'register_group: invalid folder name',
        );
        break;
      }
      const existing = deps.registeredGroups();
      if (existing[data.jid]) {
        logger.warn(
          { jid: data.jid },
          'register_group: group already registered',
        );
        break;
      }
      // Check for folder collision
      const folderCollision = Object.values(existing).find(
        (g) => g.folder === data.folder,
      );
      if (folderCollision) {
        logger.warn(
          { folder: data.folder },
          'register_group: folder already in use',
        );
        break;
      }
      const config: GroupConfig = {
        jid: data.jid,
        name: data.name,
        folder: data.folder,
        trigger: data.trigger,
        channel: channelFromJid(data.jid),
        isMain: data.isMain === true,
        alwaysRespond: data.alwaysRespond === true || data.isMain === true,
        browserEnabled: false,
        createdAt: Date.now(),
        ...(data.model !== undefined && { model: data.model || null }),
        ...(data.extraMounts !== undefined && {
          extraMounts: data.extraMounts,
        }),
      };
      setRegisteredGroup(config);
      deps.onGroupRegistered(config);
      logger.info(
        { jid: data.jid, name: data.name, folder: data.folder },
        'Group registered via IPC',
      );
      break;
    }

    case 'delete_group': {
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'delete_group: only main group is allowed',
        );
        break;
      }
      const existing = deps.registeredGroups();
      const group = Object.values(existing).find(
        (g) => g.folder === data.folder,
      );
      if (!group) {
        logger.warn({ folder: data.folder }, 'delete_group: group not found');
        break;
      }
      if (group.isMain) {
        logger.warn(
          { folder: data.folder },
          'delete_group: cannot delete the main group',
        );
        break;
      }
      deleteRegisteredGroup(group.jid);
      deps.onGroupDeleted(group.folder, group.jid);
      logger.info(
        { jid: group.jid, name: group.name, folder: group.folder },
        'Group deleted via IPC',
      );
      break;
    }

    case 'update_group': {
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'update_group: only main group is allowed',
        );
        break;
      }
      const existing = deps.registeredGroups();
      const group = Object.values(existing).find(
        (g) => g.folder === data.folder,
      );
      if (!group) {
        logger.warn({ folder: data.folder }, 'update_group: group not found');
        break;
      }

      // Handle JID migration if a new jid is provided
      let oldJid: string | undefined;
      if (data.jid && data.jid !== group.jid) {
        // Check the new jid isn't already taken
        if (existing[data.jid]) {
          logger.warn(
            { newJid: data.jid },
            'update_group: new jid already in use',
          );
          break;
        }
        const migrated = migrateGroupJid(group.jid, data.jid);
        if (!migrated) {
          logger.warn(
            { oldJid: group.jid, newJid: data.jid },
            'update_group: jid migration failed',
          );
          break;
        }
        oldJid = group.jid;
        logger.info(
          { oldJid: group.jid, newJid: data.jid },
          'Group JID migrated via IPC',
        );
      }

      const updated: GroupConfig = {
        ...group,
        ...(data.jid !== undefined && {
          jid: data.jid,
          channel: channelFromJid(data.jid),
        }),
        ...(data.name !== undefined && { name: data.name }),
        ...(data.trigger !== undefined && { trigger: data.trigger }),
        ...(data.alwaysRespond !== undefined && {
          alwaysRespond: data.alwaysRespond,
        }),
        ...(data.isMain !== undefined && { isMain: data.isMain }),
        ...(data.model !== undefined && { model: data.model || null }),
        ...(data.extraMounts !== undefined && {
          extraMounts: data.extraMounts,
        }),
        ...(data.browserEnabled !== undefined && {
          browserEnabled: data.browserEnabled,
        }),
      };
      // Only call setRegisteredGroup for non-jid changes (jid was already migrated above)
      if (!oldJid) {
        setRegisteredGroup(updated);
      } else {
        // After migration the jid is already updated in DB; apply other field changes
        setRegisteredGroup(updated);
      }
      deps.onGroupUpdated(updated, oldJid);
      logger.info(
        {
          folder: data.folder,
          changes: {
            jid: data.jid,
            name: data.name,
            trigger: data.trigger,
            alwaysRespond: data.alwaysRespond,
            model: data.model,
            browserEnabled: data.browserEnabled,
          },
        },
        'Group updated via IPC',
      );
      break;
    }

    case 'reset_session': {
      deleteSession(sourceGroup);
      writeIpcResponse(sourceGroup, data.requestId, { success: true });
      logger.info({ sourceGroup }, 'Session reset via IPC');
      break;
    }

    case 'list_sessions': {
      let sessions: Array<{
        id: string;
        title?: string;
        created?: number;
      }> = [];
      try {
        sessions = await listAgentSessions(sourceGroup);
        // eslint-disable-next-line no-catch-all/no-catch-all -- return empty list on failure
      } catch (err) {
        logger.warn(
          { sourceGroup, err },
          'list_sessions: failed to query agent',
        );
      }
      const activeSessionId = getSession(sourceGroup);
      const sessionsWithActive = sessions.map((s) => ({
        ...s,
        active: s.id === activeSessionId,
      }));
      writeIpcResponse(sourceGroup, data.requestId, {
        sessions: sessionsWithActive,
      });
      logger.debug(
        { sourceGroup, requestId: data.requestId, count: sessions.length },
        'list_sessions response written',
      );
      break;
    }

    case 'switch_session': {
      if (!data.sessionId) {
        writeIpcResponse(sourceGroup, data.requestId, {
          success: false,
          error: 'missing sessionId',
        });
        break;
      }
      let valid = false;
      try {
        valid = await validateAgentSession(sourceGroup, data.sessionId);
        // eslint-disable-next-line no-catch-all/no-catch-all -- treat validation failure as invalid
      } catch (err) {
        logger.warn(
          { sourceGroup, sessionId: data.sessionId, err },
          'switch_session: validation failed',
        );
      }
      if (valid) {
        setSession(sourceGroup, data.sessionId);
        writeIpcResponse(sourceGroup, data.requestId, {
          success: true,
          sessionId: data.sessionId,
        });
        logger.info(
          { sourceGroup, sessionId: data.sessionId },
          'Session switched via IPC',
        );
      } else {
        writeIpcResponse(sourceGroup, data.requestId, {
          success: false,
          error: 'session not found',
        });
        logger.warn(
          { sourceGroup, sessionId: data.sessionId },
          'switch_session: session not found',
        );
      }
      break;
    }

    case 'compose': {
      const result = await handleComposeIpc(data, sourceGroup);
      writeIpcResponse(sourceGroup, data.requestId, result);
      logger.info(
        { sourceGroup, action: data.action, success: result.success },
        'Compose action via IPC',
      );
      break;
    }

    case 'publish_skill': {
      if (!isMain) {
        writeIpcResponse(sourceGroup, data.requestId, {
          success: false,
          error: 'Only the main group can publish global skills.',
        });
        logger.warn(
          { sourceGroup },
          'publish_skill: only main group is allowed',
        );
        break;
      }

      const skillDir = path.resolve(SKILLS_DIR, data.name);
      // Prevent path traversal
      if (!skillDir.startsWith(path.resolve(SKILLS_DIR) + path.sep)) {
        writeIpcResponse(sourceGroup, data.requestId, {
          success: false,
          error: 'Invalid skill name.',
        });
        break;
      }

      try {
        for (const file of data.files) {
          // Validate no traversal in file paths
          const filePath = path.resolve(skillDir, file.path);
          if (
            !filePath.startsWith(skillDir + path.sep) &&
            filePath !== skillDir
          ) {
            writeIpcResponse(sourceGroup, data.requestId, {
              success: false,
              error: `Invalid file path: "${file.path}"`,
            });
            logger.warn(
              { sourceGroup, filePath: file.path },
              'publish_skill: path traversal in file path',
            );
            return;
          }
          const fileDir = path.dirname(filePath);
          fs.mkdirSync(fileDir, { recursive: true });
          fs.writeFileSync(filePath, file.content, 'utf-8');
        }
        writeIpcResponse(sourceGroup, data.requestId, { success: true });
        logger.info(
          { sourceGroup, skillName: data.name, fileCount: data.files.length },
          'Skill published globally via IPC',
        );
        // eslint-disable-next-line no-catch-all/no-catch-all -- return error to agent
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : 'Unknown error writing skill files';
        writeIpcResponse(sourceGroup, data.requestId, {
          success: false,
          error: message,
        });
        logger.error(
          { sourceGroup, skillName: data.name, err },
          'publish_skill: failed to write files',
        );
      }
      break;
    }

    default:
      logger.warn({ type: data, sourceGroup }, 'Unknown IPC task type');
  }
}
