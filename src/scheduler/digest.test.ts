// DigestCollector tests — timer flush, max_items early flush, idempotency.

import { describe, it, expect } from 'vitest';
import { DigestCollector } from './digest.js';
import type { ScheduledEvent } from '../store/store.js';

function makeEvent(id: string, subjectId = 'user1', priority = 'bulk'): ScheduledEvent {
  return {
    id,
    subjectId,
    priority,
    deliverAt:   Date.now() + 10_000,
    callbackUrl: '',
    payload:     '{}',
  };
}

describe('DigestCollector', () => {
  it('accumulates items then flushes after wait_ms', async () => {
    const flushed: Array<{ subjectId: string; priority: string; events: ScheduledEvent[] }> = [];
    const collector = new DigestCollector(
      { wait_ms: 60, max_items: 100 },
      (subjectId, priority, events) => flushed.push({ subjectId, priority, events }),
    );

    collector.add(makeEvent('e1'));
    collector.add(makeEvent('e2'));

    // Not flushed yet.
    expect(flushed).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(flushed).toHaveLength(1);
    expect(flushed[0].subjectId).toBe('user1');
    expect(flushed[0].priority).toBe('bulk');
    expect(flushed[0].events).toHaveLength(2);
  });

  it('max_items triggers early flush before timer expires', () => {
    const flushed: ScheduledEvent[][] = [];
    const collector = new DigestCollector(
      { wait_ms: 10_000, max_items: 3 },
      (_s, _p, events) => flushed.push(events),
    );

    collector.add(makeEvent('e1'));
    collector.add(makeEvent('e2'));
    expect(flushed).toHaveLength(0); // not yet

    collector.add(makeEvent('e3')); // triggers immediate flush
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(3);
  });

  it('flush is idempotent — double timer/max_items does nothing', async () => {
    let flushCount = 0;
    const collector = new DigestCollector(
      { wait_ms: 50, max_items: 100 },
      () => { flushCount++; },
    );

    collector.add(makeEvent('e1'));

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(flushCount).toBe(1);

    // Wait another interval — no second flush should occur.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(flushCount).toBe(1);
  });

  it('different subject+priority keys flush independently', async () => {
    const flushed: string[] = [];
    const collector = new DigestCollector(
      { wait_ms: 50, max_items: 100 },
      (subjectId, priority) => flushed.push(`${subjectId}:${priority}`),
    );

    collector.add(makeEvent('e1', 'userA', 'bulk'));
    collector.add(makeEvent('e2', 'userB', 'critical'));

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(flushed).toHaveLength(2);
    expect(flushed).toContain('userA:bulk');
    expect(flushed).toContain('userB:critical');
  });
});
