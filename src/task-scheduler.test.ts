import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  computeNextRun,
  _resetSchedulerLoopForTests,
} from './task-scheduler.js';
import { ScheduledTask } from './types.js';

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    jid: 'mm:abc',
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
