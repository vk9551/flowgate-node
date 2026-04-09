// Scheduler — MinHeap-backed event queue with setInterval tick loop.
// Mirrors the scheduler pattern from Go: delete-before-fire via setImmediate
// so a crash between delete and fire leaves no ghost entries in the store.

import type { ScheduledEvent, Store } from '../store/store.js';

// Scheduler is the narrow interface used by routes.ts (avoids importing the full class).
export interface Scheduler {
  schedule(e: ScheduledEvent): void;
}

// ── MinHeap ───────────────────────────────────────────────────────────────────

// MinHeap<T> is a generic binary min-heap ordered by T.deliverAt (unix ms).
export class MinHeap<T extends { deliverAt: number }> {
  private items: T[] = [];

  push(item: T): void {
    this.items.push(item);
    this.bubbleUp(this.items.length - 1);
  }

  pop(): T | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  size(): number {
    return this.items.length;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (this.items[parent].deliverAt <= this.items[i].deliverAt) break;
      [this.items[parent], this.items[i]] = [this.items[i], this.items[parent]];
      i = parent;
    }
  }

  private sinkDown(i: number): void {
    const n = this.items.length;
    while (true) {
      let smallest = i;
      const left  = 2 * i + 1;
      const right = 2 * i + 2;
      if (left  < n && this.items[left].deliverAt  < this.items[smallest].deliverAt) smallest = left;
      if (right < n && this.items[right].deliverAt < this.items[smallest].deliverAt) smallest = right;
      if (smallest === i) break;
      [this.items[smallest], this.items[i]] = [this.items[i], this.items[smallest]];
      i = smallest;
    }
  }
}

// ── FlowgateScheduler ─────────────────────────────────────────────────────────

export class FlowgateScheduler implements Scheduler {
  private heap = new MinHeap<ScheduledEvent>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly store: Store,
    private readonly onFire: (e: ScheduledEvent) => void,
    private readonly tickMs: number = 5000,
  ) {}

  // start loads all persisted events from the store (so they survive process restart),
  // then starts the tick interval.
  start(): void {
    for (const e of this.store.scheduledListAll()) {
      this.heap.push(e);
    }
    this.stopped = false;
    this.timer = setInterval(() => { this.tick(); }, this.tickMs);
  }

  // stop clears the interval and sets the stopped flag.
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // schedule persists the event to the store and enqueues it in the heap.
  schedule(e: ScheduledEvent): void {
    this.store.scheduledInsert(e);
    this.heap.push(e);
  }

  // tick drains all events whose deliverAt <= now.
  // Deletes from store BEFORE firing (crash-safe), uses setImmediate so the
  // synchronous delete commits before the async callback runs.
  private tick(): void {
    if (this.stopped) return;
    const now = Date.now();
    while (true) {
      const top = this.heap.peek();
      if (!top || top.deliverAt > now) break;
      this.heap.pop();
      this.store.scheduledDelete(top.id);
      const event = top;
      setImmediate(() => { this.onFire(event); });
    }
  }
}
