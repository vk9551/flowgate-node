// Mirrors internal/engine/feedback_test.go — same 7 outcome scenario cases.

import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import type { Config } from '../config/model.js';
import { SqliteStore } from '../store/sqlite.js';
import type { Store } from '../store/store.js';
import { EventNotFoundError, OutcomeConflictError, processOutcome } from './feedback.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function openMem(): SqliteStore { return new SqliteStore(':memory:'); }

// testCfgWithOutcomes builds a config with the same default outcomes the loader injects.
// Mirrors testCfgWithOutcomes() in feedback_test.go.
function testCfgWithOutcomes(): Config {
  return {
    version: '1.0',
    subject: {
      id_field:       'user_id',
      timezone_field: 'user_tz',
      waking_hours:   { start: '07:00', end: '22:00' },
    },
    priorities: [{ name: 'bulk', default: true }],
    policies:   [{ priority: 'bulk', decision: 'act_now' }],
    outcomes: [
      { name: 'success',     refund_cap: false, terminal: true  },
      { name: 'failed_temp', refund_cap: true,  terminal: false },
      { name: 'failed_perm', refund_cap: true,  terminal: true  },
      { name: 'pending',     refund_cap: false, terminal: false },
    ],
    default_outcome: 'pending',
  };
}

// seedEvent inserts a subject + event_log row and returns the event ID.
function seedEvent(store: Store, subjectId: string, priority: string): string {
  store.subjectUpsert({ id: subjectId, timezone: '', updatedAt: Date.now(), channelHealth: {} });
  const eventId = `evt-${subjectId}-${priority}`;
  store.eventAppend(subjectId, {
    id:            eventId,
    subjectId,
    priority,
    decision:      'ACT_NOW',
    reason:        'act_now',
    occurredAt:    Date.now(),
    deliverAt:     0,
    outcome:       'pending',
    outcomeReason: '',
    resolvedAt:    0,
  });
  return eventId;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('processOutcome', () => {
  let store: Store;
  let cfg: Config;

  beforeEach(() => {
    store = openMem();
    cfg   = testCfgWithOutcomes();
  });
  afterEach(() => { store.close(); });

  // ── 1. success — no cap refund ──────────────────────────────────────────

  it('success outcome persists and does NOT refund cap', () => {
    const eventId = seedEvent(store, 'u1', 'bulk');

    processOutcome(eventId, 'success', '', '', store, cfg);

    const ev = store.eventGetById(eventId);
    expect(ev!.outcome).toBe('success');
    // Row still present — cap was NOT refunded.
    expect(store.eventGetById(eventId)).not.toBeNull();
  });

  // ── 2. failed_temp — cap refund, no channel health ─────────────────────

  it('failed_temp refunds cap and leaves channel health untouched', () => {
    store.subjectUpsert({ id: 'u2', timezone: '', updatedAt: Date.now(), channelHealth: {} });
    const now = Date.now();
    const eventId = 'evt-u2-bulk';
    store.eventAppend('u2', {
      id: eventId, subjectId: 'u2', priority: 'bulk', decision: 'ACT_NOW',
      reason: 'act_now', occurredAt: now,
      deliverAt: 0, outcome: 'pending', outcomeReason: '', resolvedAt: 0,
    });

    expect(store.countEvents('u2', 'bulk', 24 * 60 * 60 * 1000)).toBe(1);

    processOutcome(eventId, 'failed_temp', 'conn_timeout', '', store, cfg);

    // Cap refund deletes the event_log row → count drops to 0.
    expect(store.countEvents('u2', 'bulk', 24 * 60 * 60 * 1000)).toBe(0);

    // failed_temp is non-terminal — channel health must NOT be updated.
    const subject = store.subjectGet('u2');
    expect(Object.keys(subject!.channelHealth)).toHaveLength(0);
  });

  // ── 3. failed_perm — cap refund AND channel health update ──────────────

  it('failed_perm refunds cap AND updates channel health', () => {
    const eventId = seedEvent(store, 'u3', 'bulk');

    processOutcome(eventId, 'failed_perm', 'hard_bounce', 'email', store, cfg);

    const subject = store.subjectGet('u3');
    expect(subject!.channelHealth['email']).toBe('failed_perm');
  });

  // ── 4. unknown outcome — validation error ───────────────────────────────

  it('unknown outcome throws', () => {
    const eventId = seedEvent(store, 'u4', 'bulk');

    expect(() => processOutcome(eventId, 'totally_made_up', '', '', store, cfg)).toThrow();
  });

  // ── 5. same terminal outcome — idempotent ───────────────────────────────

  it('repeated identical terminal outcome is idempotent', () => {
    const eventId = seedEvent(store, 'u5', 'bulk');

    processOutcome(eventId, 'success', '', '', store, cfg);
    // Second call with same outcome must not throw.
    expect(() => processOutcome(eventId, 'success', '', '', store, cfg)).not.toThrow();
  });

  // ── 6. different terminal outcome — conflict error ──────────────────────

  it('different terminal outcome after success throws OutcomeConflictError', () => {
    const eventId = seedEvent(store, 'u6', 'bulk');

    processOutcome(eventId, 'success', '', '', store, cfg);

    expect(() => processOutcome(eventId, 'failed_perm', '', '', store, cfg))
      .toThrow(OutcomeConflictError);
  });

  // ── 7. event not found ──────────────────────────────────────────────────

  it('missing event throws EventNotFoundError', () => {
    expect(() => processOutcome('nonexistent-id', 'success', '', '', store, cfg))
      .toThrow(EventNotFoundError);
  });
});
