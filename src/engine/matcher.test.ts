// Mirrors internal/engine/matcher_test.go — same 20 table-driven cases.

import { describe, it, expect } from 'vitest';
import type { Priority } from '../config/model.js';
import { matchPriority } from './matcher.js';

// basePriorities mirrors the Go test fixture.
const basePriorities: Priority[] = [
  {
    name: 'critical',
    match: [{ field: 'type', in: ['otp', 'order_confirmed'] }],
    bypass_all: true,
  },
  {
    name: 'transactional',
    match: [{ field: 'type', prefix: 'txn_' }],
  },
  {
    name: 'bulk',
    match: [{ field: 'type', prefix: 'marketing_' }],
    default: true,
  },
];

interface TestCase {
  name: string;
  priorities: Priority[];
  event: Record<string, string>;
  wantName: string; // '' means null expected
}

const tests: TestCase[] = [
  // ── In matcher ──────────────────────────────────────────────────────────────
  {
    name: 'in: exact match first value',
    priorities: basePriorities,
    event: { type: 'otp' },
    wantName: 'critical',
  },
  {
    name: 'in: exact match second value',
    priorities: basePriorities,
    event: { type: 'order_confirmed' },
    wantName: 'critical',
  },
  {
    name: 'in: no match falls to default',
    priorities: basePriorities,
    event: { type: 'newsletter' },
    wantName: 'bulk',
  },

  // ── Prefix matcher ──────────────────────────────────────────────────────────
  {
    name: 'prefix: matches transactional',
    priorities: basePriorities,
    event: { type: 'txn_refund' },
    wantName: 'transactional',
  },
  {
    name: 'prefix: marketing_ matches default bulk',
    priorities: basePriorities,
    event: { type: 'marketing_weekly' },
    wantName: 'bulk',
  },
  {
    name: 'prefix: partial prefix does not match',
    priorities: basePriorities,
    event: { type: 'txn' },
    wantName: 'bulk', // falls to default
  },

  // ── Suffix matcher ──────────────────────────────────────────────────────────
  {
    name: 'suffix: matches',
    priorities: [
      { name: 'digest',   match: [{ field: 'type', suffix: '_digest' }] },
      { name: 'fallback', default: true },
    ],
    event: { type: 'weekly_digest' },
    wantName: 'digest',
  },
  {
    name: 'suffix: no match falls to default',
    priorities: [
      { name: 'digest',   match: [{ field: 'type', suffix: '_digest' }] },
      { name: 'fallback', default: true },
    ],
    event: { type: 'weekly_summary' },
    wantName: 'fallback',
  },

  // ── Equals matcher ──────────────────────────────────────────────────────────
  {
    name: 'equals: exact match',
    priorities: [
      { name: 'ping', match: [{ field: 'type', equals: 'ping' }] },
    ],
    event: { type: 'ping' },
    wantName: 'ping',
  },
  {
    name: 'equals: case sensitive no match',
    priorities: [
      { name: 'ping', match: [{ field: 'type', equals: 'ping' }] },
    ],
    event: { type: 'Ping' },
    wantName: '',
  },

  // ── Exists matcher ──────────────────────────────────────────────────────────
  {
    name: 'exists true: field present',
    priorities: [
      { name: 'tagged', match: [{ field: 'tag', exists: true }] },
    ],
    event: { tag: 'vip' },
    wantName: 'tagged',
  },
  {
    name: 'exists true: field absent',
    priorities: [
      { name: 'tagged', match: [{ field: 'tag', exists: true }] },
    ],
    event: { type: 'otp' },
    wantName: '',
  },
  {
    name: 'exists false: field absent',
    priorities: [
      { name: 'untagged', match: [{ field: 'tag', exists: false }] },
    ],
    event: { type: 'otp' },
    wantName: 'untagged',
  },
  {
    name: 'exists false: field present',
    priorities: [
      { name: 'untagged', match: [{ field: 'tag', exists: false }] },
    ],
    event: { tag: 'vip' },
    wantName: '',
  },

  // ── Multi-rule AND logic ────────────────────────────────────────────────────
  {
    name: 'multi-rule: all match',
    priorities: [
      {
        name: 'vip_otp',
        match: [
          { field: 'type', equals: 'otp' },
          { field: 'tier', equals: 'vip' },
        ],
      },
    ],
    event: { type: 'otp', tier: 'vip' },
    wantName: 'vip_otp',
  },
  {
    name: 'multi-rule: partial match fails',
    priorities: [
      {
        name: 'vip_otp',
        match: [
          { field: 'type', equals: 'otp' },
          { field: 'tier', equals: 'vip' },
        ],
      },
    ],
    event: { type: 'otp', tier: 'standard' },
    wantName: '',
  },

  // ── First-match wins ────────────────────────────────────────────────────────
  {
    name: 'first match wins over later match',
    priorities: [
      { name: 'first',  match: [{ field: 'type', equals: 'otp' }] },
      { name: 'second', match: [{ field: 'type', equals: 'otp' }] },
    ],
    event: { type: 'otp' },
    wantName: 'first',
  },

  // ── Default behaviour ───────────────────────────────────────────────────────
  {
    name: 'no match, no default returns null',
    priorities: [
      { name: 'critical', match: [{ field: 'type', equals: 'otp' }] },
    ],
    event: { type: 'newsletter' },
    wantName: '',
  },
  {
    name: 'empty rules priority never matches explicitly',
    priorities: [
      { name: 'empty',    match: [] },
      { name: 'fallback', default: true },
    ],
    event: { type: 'anything' },
    wantName: 'fallback',
  },

  // ── Missing field ───────────────────────────────────────────────────────────
  {
    name: 'missing field in event — no match',
    priorities: basePriorities,
    event: { channel: 'email' }, // no "type" field
    wantName: 'bulk',             // falls to default
  },
];

describe('matchPriority', () => {
  it.each(tests)('$name', ({ priorities, event, wantName }) => {
    const got = matchPriority(priorities, event);
    if (wantName === '') {
      expect(got).toBeNull();
    } else {
      expect(got).not.toBeNull();
      expect(got!.name).toBe(wantName);
    }
  });
});
