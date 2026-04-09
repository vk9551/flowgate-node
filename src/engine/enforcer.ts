// Cap enforcer — mirrors internal/engine/enforcer.go.
// CheckAndRecord is the central decision point: it evaluates caps and waking-hour
// constraints, records the decision in the store, and returns the Decision.
// Uses Intl.DateTimeFormat for timezone-aware waking-hours (no external libs).

import { parseDuration } from '../config/loader.js';
import type { CapRule, Policy, Priority, SubjectCfg } from '../config/model.js';
import type { EventRecord, Store, Subject } from '../store/store.js';

// ── Decision ──────────────────────────────────────────────────────────────────

export interface Decision {
  outcome: string;   // ACT_NOW | DELAY | SUPPRESS
  reason: string;    // machine-readable reason code
  deliverAt: number; // unix ms, 0 for non-DELAY decisions
  priority: string;
}

// Reason codes — mirrors Go constants.
export const REASON_SEND_NOW       = 'act_now';
export const REASON_BYPASS_ALL     = 'bypass_all';
export const REASON_QUIET_HOURS    = 'quiet_hours';
export const REASON_CAP_BREACHED   = 'cap_breached';
export const REASON_NO_POLICY      = 'no_policy';

// Outcome values — mirrors Go constants.
export const OUTCOME_SEND_NOW  = 'ACT_NOW';
export const OUTCOME_DELAY     = 'DELAY';
export const OUTCOME_SUPPRESS  = 'SUPPRESS';

// ── Public API ────────────────────────────────────────────────────────────────

// checkAndRecord evaluates the event against caps and waking-hour constraints,
// writes the decision to the event log, and returns the Decision.
// Mirrors CheckAndRecord() in enforcer.go.
export function checkAndRecord(
  subject: Subject,
  priority: Priority,
  policy: Policy,
  subjectCfg: SubjectCfg,
  store: Store,
  eventId: string,
  now: Date,
): Decision {
  // P0 / bypass_all: ignore all caps and waking hours.
  if (priority.bypass_all) {
    const d: Decision = { outcome: OUTCOME_SEND_NOW, reason: REASON_BYPASS_ALL, deliverAt: 0, priority: priority.name };
    recordEvent(store, subject.id, eventId, priority.name, d, now);
    return d;
  }

  // Check caps first (cheaper than timezone lookup).
  if (anyCap(subject.id, priority.name, policy.caps ?? [], store)) {
    const outcome = normaliseOutcome(policy.decision_on_cap_breach ?? '');
    const d: Decision = { outcome, reason: REASON_CAP_BREACHED, deliverAt: 0, priority: priority.name };
    recordEvent(store, subject.id, eventId, priority.name, d, now);
    return d;
  }

  // Waking-hours check.
  if (policy.window?.respect_waking_hours) {
    try {
      const { inWindow, nextOpen } = inWakingWindow(subject, subjectCfg, now);
      if (!inWindow && nextOpen !== null) {
        const d: Decision = {
          outcome:   OUTCOME_DELAY,
          reason:    REASON_QUIET_HOURS,
          deliverAt: nextOpen.getTime(),
          priority:  priority.name,
        };
        recordEvent(store, subject.id, eventId, priority.name, d, now);
        return d;
      }
    } catch {
      // Non-fatal: unknown timezone or unparseable hours → fall through to ACT_NOW.
    }
  }

  // All clear.
  const d: Decision = { outcome: OUTCOME_SEND_NOW, reason: REASON_SEND_NOW, deliverAt: 0, priority: priority.name };
  recordEvent(store, subject.id, eventId, priority.name, d, now);
  return d;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

// anyCap returns true if any cap rule is currently breached.
function anyCap(
  subjectId: string,
  priorityName: string,
  caps: CapRule[],
  store: Store,
): boolean {
  for (const cap of caps) {
    // Use pre-parsed period_ms if available; fall back to parsing period string.
    let periodMs: number;
    if (cap.period_ms !== undefined && cap.period_ms > 0) {
      periodMs = cap.period_ms;
    } else if (cap.period) {
      periodMs = parseDuration(cap.period);
    } else {
      continue;
    }
    const count = store.countEvents(subjectId, priorityName, periodMs);
    if (count >= (cap.limit ?? 0)) {
      return true;
    }
  }
  return false;
}

// inWakingWindow reports whether now falls within the subject's waking hours.
// Returns inWindow=true if inside, inWindow=false + nextOpen if outside.
// Mirrors inWakingWindow() in enforcer.go.
function inWakingWindow(
  subject: Subject,
  subjectCfg: SubjectCfg,
  now: Date,
): { inWindow: boolean; nextOpen: Date | null } {
  const tz = subject.timezone || 'UTC';

  // Get date components in the subject's timezone.
  const local = getLocalParts(now, tz);

  const [startH, startM] = parseHHMM(subjectCfg.waking_hours?.start ?? '');
  const [endH, endM]     = parseHHMM(subjectCfg.waking_hours?.end   ?? '');

  // Build today's window boundaries as UTC Date objects.
  const windowStart = localToUTC(local.year, local.month, local.day, startH, startM, tz);
  const windowEnd   = localToUTC(local.year, local.month, local.day, endH,   endM,   tz);

  const nowMs   = now.getTime();
  const startMs = windowStart.getTime();
  const endMs   = windowEnd.getTime();

  if (nowMs >= startMs && nowMs < endMs) {
    return { inWindow: true, nextOpen: null };
  }

  // Outside the window — compute next open time.
  let nextOpen: Date;
  if (nowMs < startMs) {
    // Before today's window opens.
    nextOpen = windowStart;
  } else {
    // After today's window; next open is tomorrow's start.
    nextOpen = new Date(windowStart.getTime() + 24 * 60 * 60 * 1000);
  }
  return { inWindow: false, nextOpen };
}

// parseHHMM parses "HH:MM" into [hour, minute]. Throws on invalid format.
function parseHHMM(s: string): [number, number] {
  if (s.length !== 5 || s[2] !== ':') {
    throw new Error(`enforcer: invalid time format "${s}", expected HH:MM`);
  }
  const h = parseInt(s.slice(0, 2), 10);
  const m = parseInt(s.slice(3, 5), 10);
  if (isNaN(h) || isNaN(m)) {
    throw new Error(`enforcer: parse HH:MM "${s}"`);
  }
  return [h, m];
}

// getLocalParts returns the date/time components of `date` in the given IANA timezone.
function getLocalParts(date: Date, tz: string): {
  year: number; month: number; day: number; hour: number; minute: number; second: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year:     'numeric',
    month:    'numeric',
    day:      'numeric',
    hour:     'numeric',
    minute:   'numeric',
    second:   'numeric',
    hour12:   false,
  }).formatToParts(date);

  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }

  return {
    year:   parseInt(map.year,   10),
    month:  parseInt(map.month,  10),
    day:    parseInt(map.day,    10),
    hour:   parseInt(map.hour,   10) % 24, // guard against "24" at midnight
    minute: parseInt(map.minute, 10),
    second: parseInt(map.second, 10),
  };
}

// getUTCOffsetMs returns (localTime_as_UTC − actualUTC) for the given date in tz.
// Positive means local is ahead of UTC (e.g. UTC+5); negative means behind (e.g. EDT = UTC-4).
function getUTCOffsetMs(date: Date, tz: string): number {
  const local = getLocalParts(date, tz);
  const localAsUTC = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  return localAsUTC - date.getTime();
}

// localToUTC converts a local date/time in `tz` to a UTC Date.
// Uses two-iteration approach to handle DST boundary edge cases.
function localToUTC(
  year: number, month: number, day: number,
  hour: number, minute: number,
  tz: string,
): Date {
  // Treat the local time as UTC for a first rough estimate.
  const rough = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));

  // Compute the UTC offset at the rough estimate and adjust.
  const offset1 = getUTCOffsetMs(rough, tz);
  const guess   = new Date(rough.getTime() - offset1);

  // Second iteration to correct for DST boundary edge cases.
  const offset2 = getUTCOffsetMs(guess, tz);
  return new Date(rough.getTime() - offset2);
}

// normaliseOutcome maps config decision strings to canonical outcome constants.
function normaliseOutcome(s: string): string {
  switch (s) {
    case 'act_now':  return OUTCOME_SEND_NOW;
    case 'suppress': return OUTCOME_SUPPRESS;
    case 'delay':    return OUTCOME_DELAY;
    default:         return OUTCOME_SUPPRESS;
  }
}

// recordEvent writes the decision to the event log.
function recordEvent(
  store: Store,
  subjectId: string,
  eventId: string,
  priorityName: string,
  d: Decision,
  now: Date,
): void {
  const e: EventRecord = {
    id:            eventId,
    subjectId,
    priority:      priorityName,
    decision:      d.outcome,
    reason:        d.reason,
    occurredAt:    now.getTime(),
    deliverAt:     d.deliverAt,
    outcome:       'pending',
    outcomeReason: '',
    resolvedAt:    0,
  };
  store.eventAppend(subjectId, e);
}
