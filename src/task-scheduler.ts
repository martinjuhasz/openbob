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
  if (task.scheduleType === 'once') return null;

  const now = Date.now();

  if (task.scheduleType === 'cron') {
    try {
      const interval = CronExpressionParser.parse(task.scheduleValue);
      return interval.next().getTime();
    } catch {
      logger.warn(
        { taskId: task.id, value: task.scheduleValue },
        'Invalid cron expression',
      );
      return now + 60_000; // fallback: retry in 1 min
    }
  }

  if (task.scheduleType === 'interval') {
    const ms = parseInt(task.scheduleValue, 10);
    if (!ms || ms <= 0) {
      logger.warn(
        { taskId: task.id, value: task.scheduleValue },
        'Invalid interval value',
      );
      return now + 60_000;
    }
    // Anchor to scheduled time to prevent drift
    let next = task.nextRun + ms;
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
    { taskId: task.id, groupFolder: task.groupFolder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.groupFolder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.groupFolder },
      'Group not found for task',
    );
    deleteTask(task.id);
    return;
  }

  const sessionId =
    task.contextMode === 'group'
      ? (deps.getSession(task.groupFolder) ?? undefined)
      : undefined;

  try {
    const model = group.model ?? getEnv().MODEL;

    const output = await runAgentSession({
      prompt: task.prompt,
      sessionId,
      groupFolder: task.groupFolder,
      chatJid: task.jid,
      isMain: group.isMain,
      isScheduledTask: true,
      model,
    });

    if (output.newSessionId && task.contextMode === 'group') {
      deps.setSession(task.groupFolder, output.newSessionId);
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
    upsertTask({ ...task, nextRun });
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
      const dueTasks = getActiveTasks().filter((t) => t.nextRun <= now);

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
