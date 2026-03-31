import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupQueue } from './group-queue.js';

describe('GroupQueue', () => {
  let queue: GroupQueue;

  beforeEach(() => {
    queue = new GroupQueue();
  });

  it('runs processMessagesFn when a message is enqueued', async () => {
    const fn = vi.fn().mockResolvedValue(true);
    queue.setProcessMessagesFn(fn);
    queue.enqueueMessageCheck('mm:ch1');

    // Wait for async execution
    await new Promise((r) => setTimeout(r, 10));
    expect(fn).toHaveBeenCalledWith('mm:ch1');
  });

  it('queues messages when agent is active', async () => {
    let resolve!: (v: boolean) => void;
    const fn = vi.fn().mockImplementation(
      () =>
        new Promise<boolean>((r) => {
          resolve = r;
        }),
    );
    queue.setProcessMessagesFn(fn);

    queue.enqueueMessageCheck('mm:ch1');
    await new Promise((r) => setTimeout(r, 5)); // let first run start

    // Second enqueue while active
    queue.enqueueMessageCheck('mm:ch1');
    resolve(true);
    await new Promise((r) => setTimeout(r, 20));

    // Should have been called twice — once initially, once after drain
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('respects MAX_CONCURRENT_AGENTS limit', async () => {
    queue = new GroupQueue(2);
    const started: string[] = [];
    const resolvers: Array<(v: boolean) => void> = [];

    const fn = vi.fn().mockImplementation((jid: string) => {
      started.push(jid as string);
      return new Promise<boolean>((r) => resolvers.push(r));
    });
    queue.setProcessMessagesFn(fn);

    queue.enqueueMessageCheck('mm:ch1');
    queue.enqueueMessageCheck('mm:ch2');
    queue.enqueueMessageCheck('mm:ch3'); // should be queued

    await new Promise((r) => setTimeout(r, 10));
    expect(started).toHaveLength(2); // only 2 running

    resolvers[0]!(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toHaveLength(3); // third unblocked

    resolvers[1]!(true);
    resolvers[2]!(true);
  });

  it('runs tasks via enqueueTask', async () => {
    const taskFn = vi.fn().mockResolvedValue(undefined);
    queue.enqueueTask('mm:ch1', 'task-001', taskFn);

    await new Promise((r) => setTimeout(r, 20));
    expect(taskFn).toHaveBeenCalledOnce();
  });

  it('does not double-queue the same task ID', async () => {
    let resolve!: (v: void) => void;
    const taskFn = vi.fn().mockImplementation(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );

    queue.enqueueTask('mm:ch1', 'task-001', taskFn);
    await new Promise((r) => setTimeout(r, 5)); // task starts running

    queue.enqueueTask('mm:ch1', 'task-001', taskFn); // duplicate — should be ignored
    resolve();
    await new Promise((r) => setTimeout(r, 10));

    expect(taskFn).toHaveBeenCalledOnce();
  });

  it('ignores enqueues after shutdown', async () => {
    const fn = vi.fn().mockResolvedValue(true);
    queue.setProcessMessagesFn(fn);
    await queue.shutdown();

    queue.enqueueMessageCheck('mm:ch1');
    await new Promise((r) => setTimeout(r, 10));
    expect(fn).not.toHaveBeenCalled();
  });
});
