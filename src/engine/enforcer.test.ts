// Mirrors internal/engine/enforcer_test.go — same 11 test cases.
// Note: TestCheckAndRecord_DeliverAtSet checks DeliverAt UTC hour = 11,
// which assumes New York is in EDT (UTC-4). Valid for dates in DST (Mar–Nov).

import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import type { Policy, Priority, SubjectCfg } from '../config/model.js';
import { SqliteStore } from '../store/sqlite.js';
import type { Store, Subject } from '../store/store.js';
import {
  checkAndRecord,
  OUTCOME_SEND_NOW,
  OUTCOME_DELAY,
  OUTCOME_SUPPRESS,
  REASON_SEND_NOW,
  REASON_BYPASS_ALL,
  REASON_QUIET_HOURS,
  REASON_CAP_BREACHED,
} from './enforcer.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

function openMem(): SqliteStore { return new SqliteStore(':memory:'); }

// defaultSubjectCfg mirrors the Go fixture.
const defaultSubjectCfg: SubjectCfg = {
  id_field:       'user_id',
  timezone_field: 'user_tz',
  waking_hours:   { start: '07:00', end: '22:00' },
};

// localToUTC: thin helper used only by wakingTime/quietTime.
// Converts local calendar date + time in tz to a UTC Date.
function getLocalParts(date: Date, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false,
  }).formatToParts(date);
  const m: Record<string, string> = {};
  for (const p of parts) if (p.type !== 'literal') m[p.type] = p.value;
  return {
    year: parseInt(m.year), month: parseInt(m.month), day: parseInt(m.day),
    hour: parseInt(m.hour) % 24, minute: parseInt(m.minute), second: parseInt(m.second),
  };
}

function localToUTC(year: number, month: number, day: number, h: number, min: number, tz: string): Date {
  const rough = new Date(Date.UTC(year, month - 1, day, h, min, 0));
  const offset = (d: Date) => {
    const loc = getLocalParts(d, tz);
    return Date.UTC(loc.year, loc.month - 1, loc.day, loc.hour, loc.minute, loc.second) - d.getTime();
  };
  const guess = new Date(rough.getTime() - offset(rough));
  return new Date(rough.getTime() - offset(guess));
}

// wakingTime returns today's 10:00 AM New York time as a UTC Date.
function wakingTime(): Date {
  const tz = 'America/New_York';
  const { year, month, day } = getLocalParts(new Date(), tz);
  return localToUTC(year, month, day, 10, 0, tz);
}

// quietTime returns today's 02:00 AM New York time as a UTC Date.
function quietTime(): Date {
  const tz = 'America/New_York';
  const { year, month, day } = getLocalParts(new Date(), tz);
  return localToUTC(year, month, day, 2, 0, tz);
}

function nySubject(): Subject {
  return { id: 'u1', timezone: 'America/New_York', updatedAt: Date.now(), channelHealth: {} };
}

function bulkPriority(): Priority {
  return { name: 'bulk', default: true };
}

function criticalPriority(): Priority {
  return { name: 'critical', bypass_all: true };
}

function criticalPolicy(): Policy {
  return { priority: 'critical', decision: 'act_now' };
}

function bulkPolicy(limit: number): Policy {
  return {
    priority: 'bulk',
    caps: [{ scope: 'subject', period: '1d', period_ms: 24 * 60 * 60 * 1000, limit }],
    window: { respect_waking_hours: true, max_delay: '48h', max_delay_ms: 48 * 60 * 60 * 1000 },
    decision_on_cap_breach: 'suppress',
  };
}

function appendEvents(store: Store, subjectId: string, priority: string, n: number, at: Date): void {
  for (let i = 0; i < n; i++) {
    store.eventAppend(subjectId, {
      id:            `seed-${i}`,
      subjectId,
      priority,
      decision:      OUTCOME_SEND_NOW,
      reason:        'seed',
      occurredAt:    at.getTime(),
      deliverAt:     0,
      outcome:       'pending',
      outcomeReason: '',
      resolvedAt:    0,
    });
  }
}

// ── Table-driven tests ────────────────────────────────────────────────────────

interface TestCase {
  name: string;
  setup: (store: Store) => void;
  subject: Subject;
  priority: Priority;
  policy: Policy;
  subjectCfg: SubjectCfg;
  now: Date;
  wantOutcome: string;
  wantReason: string;
}

const tests: TestCase[] = [
  {
    name:        'under cap during waking hours → SEND_NOW',
    setup:       () => {},
    subject:     nySubject(),
    priority:    bulkPriority(),
    policy:      bulkPolicy(3),
    subjectCfg:  defaultSubjectCfg,
    now:         wakingTime(),
    wantOutcome: OUTCOME_SEND_NOW,
    wantReason:  REASON_SEND_NOW,
  },
  {
    name: 'at cap limit (exactly limit events already recorded) → SUPPRESS',
    setup: (st) => appendEvents(st, 'u1', 'bulk', 3, new Date(Date.now() - 60 * 60 * 1000)),
    subject:     nySubject(),
    priority:    bulkPriority(),
    policy:      bulkPolicy(3),
    subjectCfg:  defaultSubjectCfg,
    now:         wakingTime(),
    wantOutcome: OUTCOME_SUPPRESS,
    wantReason:  REASON_CAP_BREACHED,
  },
  {
    name: 'over cap → SUPPRESS',
    setup: (st) => appendEvents(st, 'u1', 'bulk', 5, new Date(Date.now() - 30 * 60 * 1000)),
    subject:     nySubject(),
    priority:    bulkPriority(),
    policy:      bulkPolicy(3),
    subjectCfg:  defaultSubjectCfg,
    now:         wakingTime(),
    wantOutcome: OUTCOME_SUPPRESS,
    wantReason:  REASON_CAP_BREACHED,
  },
  {
    name:        'bypass_all ignores caps and quiet hours → SEND_NOW',
    setup:       () => {},
    subject:     nySubject(),
    priority:    criticalPriority(),
    policy:      criticalPolicy(),
    subjectCfg:  defaultSubjectCfg,
    now:         quietTime(), // middle of the night
    wantOutcome: OUTCOME_SEND_NOW,
    wantReason:  REASON_BYPASS_ALL,
  },
  {
    name:        'quiet hours → DELAY',
    setup:       () => {},
    subject:     nySubject(),
    priority:    bulkPriority(),
    policy:      bulkPolicy(10),
    subjectCfg:  defaultSubjectCfg,
    now:         quietTime(),
    wantOutcome: OUTCOME_DELAY,
    wantReason:  REASON_QUIET_HOURS,
  },
  {
    name:    'bypass_all overrides even when over cap',
    setup:   (st) => appendEvents(st, 'u1', 'critical', 99, new Date(Date.now() - 60 * 60 * 1000)),
    subject:     nySubject(),
    priority:    criticalPriority(),
    policy:      criticalPolicy(),
    subjectCfg:  defaultSubjectCfg,
    now:         wakingTime(),
    wantOutcome: OUTCOME_SEND_NOW,
    wantReason:  REASON_BYPASS_ALL,
  },
  {
    name: 'old events outside rolling window don\'t count toward cap',
    setup: (st) => appendEvents(st, 'u1', 'bulk', 5, new Date(Date.now() - 26 * 60 * 60 * 1000)),
    subject:     nySubject(),
    priority:    bulkPriority(),
    policy:      bulkPolicy(3),
    subjectCfg:  defaultSubjectCfg,
    now:         wakingTime(),
    wantOutcome: OUTCOME_SEND_NOW,
    wantReason:  REASON_SEND_NOW,
  },
  {
    name:    'no waking hours check when respect_waking_hours=false',
    setup:   () => {},
    subject:     nySubject(),
    priority:    bulkPriority(),
    policy: {
      priority:            'bulk',
      window:              { respect_waking_hours: false },
      caps:                [{ scope: 'subject', period: '1d', period_ms: 24 * 60 * 60 * 1000, limit: 10 }],
      decision_on_cap_breach: 'suppress',
    },
    subjectCfg:  defaultSubjectCfg,
    now:         quietTime(),
    wantOutcome: OUTCOME_SEND_NOW,
    wantReason:  REASON_SEND_NOW,
  },
  {
    name:    'UTC subject during quiet hours → DELAY',
    setup:   () => {},
    subject: { id: 'u1', timezone: 'UTC', updatedAt: Date.now(), channelHealth: {} },
    priority:    bulkPriority(),
    policy:      bulkPolicy(10),
    subjectCfg:  defaultSubjectCfg,
    // 03:00 UTC is outside the 07:00–22:00 UTC waking window.
    now:         new Date(Date.UTC(2026, 3, 6, 3, 0, 0)),
    wantOutcome: OUTCOME_DELAY,
    wantReason:  REASON_QUIET_HOURS,
  },
];

describe('checkAndRecord — table-driven', () => {
  let store: Store;
  beforeEach(() => { store = openMem(); });
  afterEach(()  => { store.close(); });

  it.each(tests)('$name', ({ setup, subject, priority, policy, subjectCfg, now, wantOutcome, wantReason }) => {
    store.subjectUpsert(subject);
    setup(store);

    const d = checkAndRecord(subject, priority, policy, subjectCfg, store, 'evt-test', now);

    expect(d.outcome).toBe(wantOutcome);
    expect(d.reason).toBe(wantReason);
    expect(d.priority).toBe(priority.name);
  });
});

// ── TestCheckAndRecord_EventRecorded ────────────────────────────────────────

describe('checkAndRecord — event recorded', () => {
  let store: Store;
  beforeEach(() => { store = openMem(); });
  afterEach(()  => { store.close(); });

  it('writes one event to the event log', () => {
    const sub = nySubject();
    store.subjectUpsert(sub);

    checkAndRecord(sub, bulkPriority(), bulkPolicy(10), defaultSubjectCfg, store, 'evt-abc', new Date());

    const count = store.countEvents('u1', 'bulk', 24 * 60 * 60 * 1000);
    expect(count).toBe(1);
  });
});

// ── TestCheckAndRecord_DeliverAtSet ─────────────────────────────────────────
// DST-sensitive: assumes EDT (UTC-4), so 07:00 NY = 11:00 UTC.
// Valid for test runs in EDT window (second Sunday March – first Sunday November).

describe('checkAndRecord — DeliverAt', () => {
  let store: Store;
  beforeEach(() => { store = openMem(); });
  afterEach(()  => { store.close(); });

  it('DELAY decision sets deliverAt to next window open (07:00 NY = 11:00 UTC in EDT)', () => {
    const sub = nySubject();
    store.subjectUpsert(sub);

    const d = checkAndRecord(sub, bulkPriority(), bulkPolicy(10), defaultSubjectCfg, store, 'evt-delay', quietTime());

    expect(d.outcome).toBe(OUTCOME_DELAY);
    expect(d.deliverAt).toBeGreaterThan(0);
    expect(new Date(d.deliverAt).getUTCHours()).toBe(11);
  });
});
