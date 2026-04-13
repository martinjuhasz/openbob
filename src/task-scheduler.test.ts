import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  computeNextRun,
  _resetSchedulerLoopForTests,
  _runTaskForTests,
  SchedulerDeps,
} from './task-scheduler.js';
import { ScheduledTask } from './types.js';

vi.mock('./db.js', () => ({
  getActiveTasks: vi.fn(() => []),
  upsertTask: vi.fn(),
  deleteTask: vi.fn(),
}));

vi.mock('./container-runner.js', () => ({
  runAgentSession: vi.fn(),
}));

vi.mock('./router.js', () => ({
  formatOutbound: vi.fn((text: string) => text),
}));

vi.mock('./env.js', () => ({
  getEnv: vi.fn(() => ({ MODEL: 'test-model' })),
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    jid: 'tg:abc',
    group_folder: 'test-group',
    prompt: 'do something',
    schedule_type: 'interval',
    schedule_value: '60000',
    context_mode: 'isolated',
    status: 'active',
    next_run: Date.now(),
    created_at: Date.now(),
    created_by: 'test',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<SchedulerDeps> = {}): SchedulerDeps {
  return {
    registeredGroups: () => ({
      'tg:abc': {
        jid: 'tg:abc',
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@bot',
        channel: 'telegram',
        isMain: false,
        alwaysRespond: false,
        createdAt: Date.now(),
      },
    }),
    queue: {} as SchedulerDeps['queue'],
    sendMessage: vi.fn(),
    getSession: vi.fn(() => null),
    setSession: vi.fn(),
    ...overrides,
  };
}

describe('computeNextRun', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetSchedulerLoopForTests();
  });

  it('returns null for once tasks', () => {
    const task = makeTask({
      schedule_type: 'once',
      schedule_value: '2026-01-01T13:00:00.000Z',
    });
    expect(computeNextRun(task)).toBeNull();
  });

  it('computes next interval anchored to next_run', () => {
    const now = Date.now(); // 2026-01-01T12:00:00.000Z
    const task = makeTask({
      schedule_type: 'interval',
      schedule_value: '60000', // 1 minute
      next_run: now - 30000, // was 30s ago (overdue)
    });
    const next = computeNextRun(task);
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(now);
    expect(next!).toBeLessThanOrEqual(now + 60000);
  });

  it('skips multiple missed intervals', () => {
    const now = Date.now();
    const task = makeTask({
      schedule_type: 'interval',
      schedule_value: '60000',
      next_run: now - 300000, // 5 minutes overdue
    });
    const next = computeNextRun(task);
    expect(next!).toBeGreaterThan(now);
  });

  it('computes next cron run', () => {
    const now = Date.now();
    // Every minute
    const task = makeTask({
      schedule_type: 'cron',
      schedule_value: '* * * * *',
    });
    const next = computeNextRun(task);
    expect(next!).toBeGreaterThan(now);
    expect(next!).toBeLessThanOrEqual(now + 60000 + 1000); // within 1 minute + buffer
  });

  it('handles invalid interval with fallback', () => {
    const now = Date.now();
    const task = makeTask({
      schedule_type: 'interval',
      schedule_value: 'notanumber',
    });
    const next = computeNextRun(task);
    expect(next!).toBeGreaterThan(now);
  });

  it('handles invalid cron with fallback', () => {
    const now = Date.now();
    const task = makeTask({
      schedule_type: 'cron',
      schedule_value: 'not-valid-cron',
    });
    const next = computeNextRun(task);
    expect(next!).toBeGreaterThan(now);
  });
});

describe('runTask — once-task failure handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetSchedulerLoopForTests();
  });

  it('deletes a once-task on success', async () => {
    const { runAgentSession } = await import('./container-runner.js');
    const { deleteTask, upsertTask } = await import('./db.js');
    const mocked = vi.mocked(runAgentSession);
    mocked.mockResolvedValue({
      status: 'success',
      result: 'done',
    });

    const task = makeTask({
      schedule_type: 'once',
      schedule_value: '2026-01-01T12:00:00.000Z',
    });

    await _runTaskForTests(task, makeDeps());

    expect(deleteTask).toHaveBeenCalledWith('task-1');
    expect(upsertTask).not.toHaveBeenCalled();
  });

  it('pauses a once-task when agent returns error status', async () => {
    const { runAgentSession } = await import('./container-runner.js');
    const { deleteTask, upsertTask } = await import('./db.js');
    const mocked = vi.mocked(runAgentSession);
    mocked.mockResolvedValue({
      status: 'error',
      result: null,
      error: 'something broke',
    });

    const task = makeTask({
      schedule_type: 'once',
      schedule_value: '2026-01-01T12:00:00.000Z',
    });

    await _runTaskForTests(task, makeDeps());

    expect(deleteTask).not.toHaveBeenCalled();
    expect(upsertTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-1', status: 'paused' }),
    );
  });

  it('pauses a once-task when runAgentSession throws', async () => {
    const { runAgentSession } = await import('./container-runner.js');
    const { deleteTask, upsertTask } = await import('./db.js');
    const mocked = vi.mocked(runAgentSession);
    mocked.mockRejectedValue(new Error('container crash'));

    const task = makeTask({
      schedule_type: 'once',
      schedule_value: '2026-01-01T12:00:00.000Z',
    });

    await _runTaskForTests(task, makeDeps());

    expect(deleteTask).not.toHaveBeenCalled();
    expect(upsertTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-1', status: 'paused' }),
    );
  });

  it('still reschedules recurring tasks on failure', async () => {
    const { runAgentSession } = await import('./container-runner.js');
    const { deleteTask, upsertTask } = await import('./db.js');
    const mocked = vi.mocked(runAgentSession);
    mocked.mockResolvedValue({
      status: 'error',
      result: null,
      error: 'fail',
    });

    const task = makeTask({
      schedule_type: 'interval',
      schedule_value: '60000',
    });

    await _runTaskForTests(task, makeDeps());

    expect(deleteTask).not.toHaveBeenCalled();
    expect(upsertTask).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'task-1',
        status: 'active', // recurring tasks stay active
      }),
    );
  });
});
