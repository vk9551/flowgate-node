// Mirrors internal/store/sqlite_test.go — same 5 store-level cases.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from './sqlite.js';
import type { Store } from './store.js';

function openMem(): SqliteStore {
  return new SqliteStore(':memory:');
}

describe('SqliteStore', () => {
  let store: Store;

  beforeEach(() => { store = openMem(); });
  afterEach(() => { store.close(); });

  // ── 1. subjectUpsertAndGet ──────────────────────────────────────────────

  it('subjectUpsert and subjectGet round-trip', () => {
    const now = Date.now();

    store.subjectUpsert({ id: 'u1', timezone: 'America/New_York', updatedAt: now, channelHealth: {} });

    const got = store.subjectGet('u1');
    expect(got).not.toBeNull();
    expect(got!.timezone).toBe('America/New_York');

    // Update timezone.
    store.subjectUpsert({ id: 'u1', timezone: 'Europe/London', updatedAt: now, channelHealth: {} });
    const updated = store.subjectGet('u1');
    expect(updated!.timezone).toBe('Europe/London');
  });

  // ── 2. subjectGet not found ─────────────────────────────────────────────

  it('subjectGet returns null for unknown id', () => {
    const got = store.subjectGet('missing');
    expect(got).toBeNull();
  });

  // ── 3. eventAppend and countEvents ─────────────────────────────────────

  it('eventAppend writes rows and countEvents tallies them', () => {
    const now = Date.now();

    for (let i = 0; i < 3; i++) {
      store.eventAppend('u1', {
        id:           `e${i}`,
        subjectId:    'u1',
        priority:     'bulk',
        decision:     'ACT_NOW',
        reason:       'act_now',
        occurredAt:   now,
        deliverAt:    0,
        outcome:      'pending',
        outcomeReason: '',
        resolvedAt:   0,
      });
    }

    expect(store.countEvents('u1', 'bulk',     24 * 60 * 60 * 1000)).toBe(3);
    expect(store.countEvents('u1', 'critical', 24 * 60 * 60 * 1000)).toBe(0); // different priority
  });

  // ── 4. countEvents rolling window ──────────────────────────────────────

  it('countEvents rolling window excludes old events', () => {
    const now = Date.now();

    // Two recent events (within 1d window).
    for (let i = 0; i < 2; i++) {
      store.eventAppend('u1', {
        id: `recent${i}`, subjectId: 'u1', priority: 'bulk', decision: 'ACT_NOW',
        reason: 'act_now', occurredAt: now - 30 * 60 * 1000,
        deliverAt: 0, outcome: 'pending', outcomeReason: '', resolvedAt: 0,
      });
    }
    // One old event (25 hours ago — outside the 1d window).
    store.eventAppend('u1', {
      id: 'old', subjectId: 'u1', priority: 'bulk', decision: 'ACT_NOW',
      reason: 'act_now', occurredAt: now - 25 * 60 * 60 * 1000,
      deliverAt: 0, outcome: 'pending', outcomeReason: '', resolvedAt: 0,
    });

    expect(store.countEvents('u1', 'bulk', 24 * 60 * 60 * 1000)).toBe(2);
  });

  // ── 5. capRefund decrements countEvents ────────────────────────────────

  it('capRefund removes one matching event_log row', () => {
    const now = Date.now();
    store.eventAppend('u1', {
      id: 'e1', subjectId: 'u1', priority: 'bulk', decision: 'ACT_NOW',
      reason: 'act_now', occurredAt: now,
      deliverAt: 0, outcome: 'pending', outcomeReason: '', resolvedAt: 0,
    });

    expect(store.countEvents('u1', 'bulk', 24 * 60 * 60 * 1000)).toBe(1);

    store.capRefund('u1', 'bulk', now);

    expect(store.countEvents('u1', 'bulk', 24 * 60 * 60 * 1000)).toBe(0);
  });
});
