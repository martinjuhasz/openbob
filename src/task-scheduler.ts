// Task scheduler — cron/interval/once tasks from SQLite
import { CronExpressionParser } from 'cron-parser';

import { POLL_INTERVAL } from './config.js';
import { getActiveTasks, upsertTask, deleteTask } from './db.js';
import { getEnv } from './env.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { runAgentSession } from './container-runner.js';
import { formatOutbound } from './router.js';
import { GroupConfig, ScheduledTask } from './types.js';

export interface SchedulerDeps {
  registeredGroups: () => Record<string, GroupConfig>;
  queue: GroupQueue;
  sendMessage: (jid: string, text: string) => Promise<void>;
  getSession: (groupFolder: string) => string | null;
  setSession: (groupFolder: string, sessionId: string) => void;
}

/**
 * Compute next run timestamp (ms) for a recurring task.
 * Returns null for 'once' tasks (they should be deleted after running).
 */
export function computeNextRun(task: ScheduledTask): number | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    try {
      const interval = CronExpressionParser.parse(task.schedule_value);
      return interval.next().getTime();
    } catch {
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid cron expression',
      );
      return now + 60_000; // fallback: retry in 1 min
    }
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return now + 60_000;
    }
    // Anchor to scheduled time to prevent drift
    let next = task.next_run + ms;
    while (next <= now) next += ms;
    return next;
  }

  return null;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDeps,
): Promise<void> {
  logger.info(
    { taskId: task.id, group_folder: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, group_folder: task.group_folder },
      'Group not found for task',
    );
    deleteTask(task.id);
    return;
  }

  const sessionId =
    task.context_mode === 'group'
      ? (deps.getSession(task.group_folder) ?? undefined)
      : undefined;

  try {
    const model = group.model ?? getEnv().MODEL;

    const output = await runAgentSession({
      prompt: task.prompt,
      sessionId,
      groupFolder: task.group_folder,
      chatJid: task.jid,
      isMain: group.isMain,
      isScheduledTask: true,
      model,
    });

    if (output.newSessionId && task.context_mode === 'group') {
      deps.setSession(task.group_folder, output.newSessionId);
    }

    if (output.status === 'success' && output.result) {
      const text = formatOutbound(output.result);
      if (text) await deps.sendMessage(task.jid, text);
    } else if (output.status === 'error') {
      logger.error(
        { taskId: task.id, error: output.error },
        'Task agent error',
      );
    }
  } catch (err) {
    logger.error({ taskId: task.id, err }, 'Task failed');
  }

  // Advance or remove task
  const nextRun = computeNextRun(task);
  if (nextRun === null) {
    deleteTask(task.id);
    logger.info({ taskId: task.id }, 'One-time task completed and removed');
  } else {
    upsertTask({ ...task, next_run: nextRun });
    logger.info({ taskId: task.id, nextRun }, 'Task rescheduled');
  }
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDeps): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const now = Date.now();
      const dueTasks = getActiveTasks().filter((t) => t.next_run <= now);

      for (const task of dueTasks) {
        deps.queue.enqueueTask(task.jid, task.id, () => runTask(task, deps));
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
