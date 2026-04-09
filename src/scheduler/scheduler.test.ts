// Scheduler tests — covers MinHeap ordering, firing, stop(), and persistence.

import { describe, it, expect } from 'vitest';
import { FlowgateScheduler, MinHeap } from './scheduler.js';
import { SqliteStore } from '../store/sqlite.js';
import type { ScheduledEvent } from '../store/store.js';

function makeEvent(id: string, deliverAt: number): ScheduledEvent {
  return {
    id,
    subjectId:   'user1',
    priority:    'bulk',
    deliverAt,
    callbackUrl: '',
    payload:     '{}',
  };
}

// ── MinHeap unit tests ────────────────────────────────────────────────────────

describe('MinHeap', () => {
  it('pops items in ascending deliverAt order', () => {
    const heap = new MinHeap<ScheduledEvent>();
    heap.push(makeEvent('c', 3000));
    heap.push(makeEvent('a', 1000));
    heap.push(makeEvent('b', 2000));

    expect(heap.pop()?.id).toBe('a');
    expect(heap.pop()?.id).toBe('b');
    expect(heap.pop()?.id).toBe('c');
    expect(heap.pop()).toBeUndefined();
  });

  it('peek does not remove item', () => {
    const heap = new MinHeap<ScheduledEvent>();
    heap.push(makeEvent('x', 500));
    expect(heap.peek()?.id).toBe('x');
    expect(heap.size()).toBe(1);
  });

  it('size tracks item count', () => {
    const heap = new MinHeap<ScheduledEvent>();
    expect(heap.size()).toBe(0);
    heap.push(makeEvent('a', 1));
    expect(heap.size()).toBe(1);
    heap.pop();
    expect(heap.size()).toBe(0);
  });
});

// ── FlowgateScheduler integration tests ──────────────────────────────────────

describe('FlowgateScheduler', () => {
  it('fires a past-due event after the first tick', async () => {
    const store  = new SqliteStore(':memory:');
    const fired: ScheduledEvent[] = [];
    const sched  = new FlowgateScheduler(store, (e) => fired.push(e), 20 /* tickMs */);

    // start() first (production order), then schedule().
    sched.start();
    sched.schedule(makeEvent('evt1', Date.now() - 1000));

    await new Promise((resolve) => setTimeout(resolve, 100));
    sched.stop();

    expect(fired).toHaveLength(1);
    expect(fired[0].id).toBe('evt1');
    store.close();
  });

  it('fires earlier events before later events (heap ordering)', async () => {
    const store = new SqliteStore(':memory:');
    const fired: ScheduledEvent[] = [];
    const sched = new FlowgateScheduler(store, (e) => fired.push(e), 20);

    sched.start();
    const now = Date.now();
    sched.schedule(makeEvent('late',  now - 100));
    sched.schedule(makeEvent('early', now - 2000));

    await new Promise((resolve) => setTimeout(resolve, 120));
    sched.stop();

    // setImmediate guarantees ordering within a single tick drain.
    expect(fired).toHaveLength(2);
    expect(fired[0].id).toBe('early');
    expect(fired[1].id).toBe('late');
    store.close();
  });

  it('stop() prevents further ticks from firing', async () => {
    const store = new SqliteStore(':memory:');
    const fired: ScheduledEvent[] = [];
    const sched = new FlowgateScheduler(store, (e) => fired.push(e), 20);

    sched.start();
    sched.stop();
    // Schedule AFTER stop — timer is already cleared.
    sched.schedule(makeEvent('evt1', Date.now() - 100));

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(fired).toHaveLength(0);
    store.close();
  });

  it('loads persisted events from store on restart', async () => {
    const store = new SqliteStore(':memory:');
    const fired: ScheduledEvent[] = [];

    // Simulate a past run: insert directly into the store without a running scheduler.
    store.scheduledInsert(makeEvent('persisted', Date.now() - 1000));

    // New scheduler should pick it up via scheduledListAll() in start().
    const sched = new FlowgateScheduler(store, (e) => fired.push(e), 20);
    sched.start();

    await new Promise((resolve) => setTimeout(resolve, 120));
    sched.stop();

    expect(fired.some((e) => e.id === 'persisted')).toBe(true);
    store.close();
  });
});
