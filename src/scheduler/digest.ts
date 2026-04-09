// DigestCollector — batches scheduled events by subject+priority and flushes
// them either after a timer expires or when the max_items threshold is reached.
// Mirrors the digest collector pattern from the Go scheduler package.

import type { ScheduledEvent } from '../store/store.js';

export interface DigestCfg {
  wait_ms: number;   // how long to wait before flushing an incomplete batch
  max_items: number; // flush immediately when this many items accumulate
}

export class DigestCollector {
  // buckets holds accumulated events per "subjectId:priority" key.
  private buckets = new Map<string, ScheduledEvent[]>();
  // timers holds the pending flush timer per key.
  private timers  = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly config: DigestCfg,
    private readonly onFlush: (
      subjectId: string,
      priority: string,
      events: ScheduledEvent[],
    ) => void,
  ) {}

  // add appends an event to the appropriate bucket, starting a flush timer on
  // the first item or flushing immediately when max_items is reached.
  add(e: ScheduledEvent): void {
    const key = `${e.subjectId}:${e.priority}`;

    let items = this.buckets.get(key);
    if (!items) {
      items = [];
      this.buckets.set(key, items);
      // Start timer on the first item in a new bucket.
      const timer = setTimeout(() => { this.flush(key); }, this.config.wait_ms);
      this.timers.set(key, timer);
    }
    items.push(e);

    // Early flush when max_items threshold is reached.
    if (items.length >= this.config.max_items) {
      const timer = this.timers.get(key);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.timers.delete(key);
      }
      this.flush(key);
    }
  }

  // flush emits the batch for the given key and removes it from state.
  // Idempotent: if the key was already flushed (e.g. by max_items before timer),
  // the timer callback will find no bucket and return immediately.
  private flush(key: string): void {
    const items = this.buckets.get(key);
    if (!items) return; // already flushed

    this.buckets.delete(key);
    this.timers.delete(key);

    const sep = key.indexOf(':');
    const subjectId = key.slice(0, sep);
    const priority  = key.slice(sep + 1);

    this.onFlush(subjectId, priority, items);
  }
}
