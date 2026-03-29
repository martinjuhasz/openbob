// IPC watcher — polls DATA_DIR/ipc/<group>/{messages,tasks}/ for JSON files
// dropped there by agent containers to send messages or manage scheduled tasks

import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, POLL_INTERVAL } from './config.js';
import {
  deleteTask,
  getActiveTasks,
  getTaskById,
  setRegisteredGroup,
  upsertTask,
} from './db.js';
import { logger } from './logger.js';
import { GroupConfig, ScheduledTask } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, GroupConfig>;
  onTasksChanged: () => void;
  onGroupRegistered: (config: GroupConfig) => void;
  onGroupUpdated: (config: GroupConfig) => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
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
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process message files
      try {
        if (fs.existsSync(messagesDir)) {
          const files = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of files) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
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
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              moveToErrors(ipcBaseDir, filePath, sourceGroup, file);
            }
          }
        }
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
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              await processTaskIpc(
                data,
                sourceGroup,
                isMain,
                folderToJid,
                deps,
              );
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              moveToErrors(ipcBaseDir, filePath, sourceGroup, file);
            }
          }
        }
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
  ipcBaseDir: string,
  filePath: string,
  sourceGroup: string,
  file: string,
): void {
  try {
    const errorDir = path.join(ipcBaseDir, 'errors');
    fs.mkdirSync(errorDir, { recursive: true });
    fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
  } catch {
    // ignore rename errors
  }
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    scheduleType?: string;
    scheduleValue?: string;
    contextMode?: string;
    targetJid?: string;
    // register_group / update_group fields
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    isMain?: boolean;
    alwaysRespond?: boolean;
    model?: string;
  },
  sourceGroup: string,
  isMain: boolean,
  _folderToJid: Map<string, string>,
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task': {
      if (
        !data.prompt ||
        !data.scheduleType ||
        !data.scheduleValue ||
        !data.targetJid
      ) {
        logger.warn(
          { data, sourceGroup },
          'schedule_task missing required fields',
        );
        break;
      }

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

      const scheduleType = data.scheduleType as 'cron' | 'interval' | 'once';
      let nextRun: number;

      if (scheduleType === 'cron') {
        try {
          const interval = CronExpressionParser.parse(data.scheduleValue);
          nextRun = interval.next().getTime();
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
      if (!data.taskId) break;
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
      if (!data.taskId) break;
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
      if (!data.taskId) break;
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

    case 'register_group': {
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'register_group: only main group is allowed',
        );
        break;
      }
      if (!data.jid || !data.name || !data.folder || !data.trigger) {
        logger.warn(
          { data, sourceGroup },
          'register_group: missing required fields (jid, name, folder, trigger)',
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
        channel: data.jid.split(':')[0] ?? 'mattermost',
        isMain: data.isMain === true,
        alwaysRespond: data.alwaysRespond === true || data.isMain === true,
        createdAt: Date.now(),
        ...(data.model !== undefined && { model: data.model }),
      };
      setRegisteredGroup(config);
      deps.onGroupRegistered(config);
      logger.info(
        { jid: data.jid, name: data.name, folder: data.folder },
        'Group registered via IPC',
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
      if (!data.jid) {
        logger.warn({ sourceGroup }, 'update_group: missing jid');
        break;
      }
      const existing = deps.registeredGroups();
      const group = existing[data.jid];
      if (!group) {
        logger.warn({ jid: data.jid }, 'update_group: group not found');
        break;
      }
      const updated: GroupConfig = {
        ...group,
        ...(data.name !== undefined && { name: data.name }),
        ...(data.trigger !== undefined && { trigger: data.trigger }),
        ...(data.alwaysRespond !== undefined && {
          alwaysRespond: data.alwaysRespond,
        }),
        ...(data.isMain !== undefined && { isMain: data.isMain }),
        ...(data.model !== undefined && { model: data.model }),
      };
      setRegisteredGroup(updated);
      deps.onGroupUpdated(updated);
      logger.info(
        {
          jid: data.jid,
          changes: {
            name: data.name,
            trigger: data.trigger,
            alwaysRespond: data.alwaysRespond,
            model: data.model,
          },
        },
        'Group updated via IPC',
      );
      break;
    }

    default:
      logger.warn({ type: data.type, sourceGroup }, 'Unknown IPC task type');
  }
}
