// SQLite store — mirrors internal/store/sqlite.go.
// Uses better-sqlite3 (synchronous). All timestamps stored as unix seconds in SQLite;
// all timestamps exposed at the TypeScript boundary as unix milliseconds.

import Database from 'better-sqlite3';
import type { EventRecord, ScheduledEvent, Stats, Store, Subject } from './store.js';

// ── Schema ────────────────────────────────────────────────────────────────────

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS subjects (
    id             TEXT PRIMARY KEY,
    timezone       TEXT NOT NULL DEFAULT '',
    updated_at     INTEGER NOT NULL,
    channel_health TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS event_log (
    id             TEXT PRIMARY KEY,
    subject_id     TEXT NOT NULL,
    priority       TEXT NOT NULL,
    decision       TEXT NOT NULL,
    reason         TEXT NOT NULL DEFAULT '',
    occurred_at    INTEGER NOT NULL,
    deliver_at     INTEGER NOT NULL DEFAULT 0,
    outcome        TEXT NOT NULL DEFAULT 'pending',
    outcome_reason TEXT NOT NULL DEFAULT '',
    resolved_at    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_event_log_subject_priority_time
    ON event_log (subject_id, priority, occurred_at);

CREATE TABLE IF NOT EXISTS scheduled_events (
    id           TEXT PRIMARY KEY,
    subject_id   TEXT NOT NULL,
    priority     TEXT NOT NULL,
    deliver_at   INTEGER NOT NULL,
    callback_url TEXT NOT NULL DEFAULT '',
    payload      TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_scheduled_deliver_at
    ON scheduled_events (deliver_at);
`;

// ALTER TABLE migrations for existing databases that pre-date these columns.
// SQLite returns an error for duplicate columns; silently ignore it.
const MIGRATIONS = [
  `ALTER TABLE event_log ADD COLUMN deliver_at     INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE event_log ADD COLUMN outcome        TEXT    NOT NULL DEFAULT 'pending'`,
  `ALTER TABLE event_log ADD COLUMN outcome_reason TEXT    NOT NULL DEFAULT ''`,
  `ALTER TABLE event_log ADD COLUMN resolved_at    INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE subjects  ADD COLUMN channel_health TEXT    NOT NULL DEFAULT '{}'`,
];

// ── Raw row shapes returned by better-sqlite3 ──────────────────────────────

interface RawEventRow {
  id: string;
  subject_id: string;
  priority: string;
  decision: string;
  reason: string;
  occurred_at: number;
  deliver_at: number;
  outcome: string;
  outcome_reason: string;
  resolved_at: number;
}

interface RawScheduledRow {
  id: string;
  subject_id: string;
  priority: string;
  deliver_at: number;
  callback_url: string;
  payload: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function secToMs(s: number): number { return s * 1000; }
function msToSec(ms: number): number { return Math.floor(ms / 1000); }

function rowToEventRecord(row: RawEventRow): EventRecord {
  return {
    id: row.id,
    subjectId: row.subject_id,
    priority: row.priority,
    decision: row.decision,
    reason: row.reason,
    occurredAt: secToMs(row.occurred_at),
    deliverAt:  row.deliver_at  > 0 ? secToMs(row.deliver_at)  : 0,
    outcome:     row.outcome,
    outcomeReason: row.outcome_reason,
    resolvedAt: row.resolved_at > 0 ? secToMs(row.resolved_at) : 0,
  };
}

function rowToScheduledEvent(row: RawScheduledRow): ScheduledEvent {
  return {
    id:          row.id,
    subjectId:   row.subject_id,
    priority:    row.priority,
    deliverAt:   secToMs(row.deliver_at),
    callbackUrl: row.callback_url,
    payload:     row.payload,
  };
}

// ── SqliteStore ───────────────────────────────────────────────────────────────

export class SqliteStore implements Store {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(SCHEMA);
    for (const sql of MIGRATIONS) {
      try { this.db.exec(sql); } catch { /* column already exists */ }
    }
  }

  // ── Subject ──────────────────────────────────────────────────────────────

  subjectGet(id: string): Subject | null {
    const row = this.db.prepare(
      `SELECT id, timezone, updated_at, channel_health FROM subjects WHERE id = ?`,
    ).get(id) as { id: string; timezone: string; updated_at: number; channel_health: string } | undefined;

    if (!row) return null;

    let channelHealth: Record<string, string> = {};
    if (row.channel_health && row.channel_health !== '{}') {
      try { channelHealth = JSON.parse(row.channel_health) as Record<string, string>; } catch { /* ignore */ }
    }

    return {
      id:            row.id,
      timezone:      row.timezone,
      updatedAt:     secToMs(row.updated_at),
      channelHealth,
    };
  }

  // channel_health is never overwritten here; use subjectUpdateChannelHealth instead.
  subjectUpsert(s: Subject): void {
    this.db.prepare(
      `INSERT INTO subjects (id, timezone, updated_at, channel_health)
       VALUES (?, ?, ?, '{}')
       ON CONFLICT(id) DO UPDATE SET
           timezone   = excluded.timezone,
           updated_at = excluded.updated_at`,
    ).run(s.id, s.timezone, msToSec(s.updatedAt));
  }

  subjectReset(id: string): void {
    this.db.prepare(`DELETE FROM event_log WHERE subject_id = ?`).run(id);
  }

  subjectUpdateChannelHealth(subjectId: string, channel: string, outcome: string): void {
    const row = this.db.prepare(
      `SELECT channel_health FROM subjects WHERE id = ?`,
    ).get(subjectId) as { channel_health: string } | undefined;

    if (!row) {
      throw new Error(`store: subjectUpdateChannelHealth: subject "${subjectId}" not found`);
    }

    let health: Record<string, string> = {};
    if (row.channel_health && row.channel_health !== '{}') {
      try { health = JSON.parse(row.channel_health) as Record<string, string>; } catch { /* ignore */ }
    }
    health[channel] = outcome;

    this.db.prepare(
      `UPDATE subjects SET channel_health = ? WHERE id = ?`,
    ).run(JSON.stringify(health), subjectId);
  }

  // ── Event log ────────────────────────────────────────────────────────────

  eventAppend(subjectId: string, e: EventRecord): void {
    this.db.prepare(
      `INSERT INTO event_log
           (id, subject_id, priority, decision, reason, occurred_at, deliver_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      e.id, subjectId, e.priority, e.decision, e.reason,
      msToSec(e.occurredAt),
      e.deliverAt > 0 ? msToSec(e.deliverAt) : 0,
    );
  }

  eventList(subjectId: string, limit: number): EventRecord[] {
    const rows = this.db.prepare(
      `SELECT id, subject_id, priority, decision, reason, occurred_at, deliver_at,
              outcome, outcome_reason, resolved_at
       FROM event_log WHERE subject_id = ?
       ORDER BY occurred_at DESC LIMIT ?`,
    ).all(subjectId, limit) as RawEventRow[];
    return rows.map(rowToEventRecord);
  }

  eventListRecent(limit: number): EventRecord[] {
    const rows = this.db.prepare(
      `SELECT id, subject_id, priority, decision, reason, occurred_at, deliver_at,
              outcome, outcome_reason, resolved_at
       FROM event_log ORDER BY occurred_at DESC LIMIT ?`,
    ).all(limit) as RawEventRow[];
    return rows.map(rowToEventRecord);
  }

  eventGetById(eventId: string): EventRecord | null {
    const row = this.db.prepare(
      `SELECT id, subject_id, priority, decision, reason, occurred_at, deliver_at,
              outcome, outcome_reason, resolved_at
       FROM event_log WHERE id = ? LIMIT 1`,
    ).get(eventId) as RawEventRow | undefined;
    return row ? rowToEventRecord(row) : null;
  }

  // ── Cap counting ──────────────────────────────────────────────────────────

  // countEvents: how many events for subject+priority occurred in the last periodMs ms.
  countEvents(subjectId: string, priority: string, periodMs: number): number {
    const since = msToSec(Date.now() - periodMs);
    const result = this.db.prepare(
      `SELECT COUNT(*) AS n FROM event_log
       WHERE subject_id = ? AND priority = ? AND occurred_at >= ?`,
    ).get(subjectId, priority, since) as { n: number };
    return result.n;
  }

  // countDecisions: how many events for subject+decision occurred since sinceMs (absolute unix ms).
  countDecisions(subjectId: string, decision: string, sinceMs: number): number {
    const since = msToSec(sinceMs);
    const result = this.db.prepare(
      `SELECT COUNT(*) AS n FROM event_log
       WHERE subject_id = ? AND decision = ? AND occurred_at >= ?`,
    ).get(subjectId, decision, since) as { n: number };
    return result.n;
  }

  // ── Outcome feedback ──────────────────────────────────────────────────────

  outcomeUpdate(eventId: string, outcome: string, reason: string): void {
    const resolvedAt = msToSec(Date.now());
    this.db.prepare(
      `UPDATE event_log SET outcome = ?, outcome_reason = ?, resolved_at = ? WHERE id = ?`,
    ).run(outcome, reason, resolvedAt, eventId);
  }

  // capRefund deletes the matching event_log row, decrementing countEvents by 1.
  capRefund(subjectId: string, priority: string, occurredAt: number): void {
    this.db.prepare(
      `DELETE FROM event_log WHERE id = (
          SELECT id FROM event_log
          WHERE subject_id = ? AND priority = ? AND occurred_at = ?
          LIMIT 1
      )`,
    ).run(subjectId, priority, msToSec(occurredAt));
  }

  // ── Scheduler queue ───────────────────────────────────────────────────────

  scheduledInsert(e: ScheduledEvent): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO scheduled_events
           (id, subject_id, priority, deliver_at, callback_url, payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(e.id, e.subjectId, e.priority, msToSec(e.deliverAt), e.callbackUrl, e.payload);
  }

  scheduledDelete(id: string): void {
    this.db.prepare(`DELETE FROM scheduled_events WHERE id = ?`).run(id);
  }

  scheduledList(beforeMs: number): ScheduledEvent[] {
    const rows = this.db.prepare(
      `SELECT id, subject_id, priority, deliver_at, callback_url, payload
       FROM scheduled_events WHERE deliver_at <= ?
       ORDER BY deliver_at ASC`,
    ).all(msToSec(beforeMs)) as RawScheduledRow[];
    return rows.map(rowToScheduledEvent);
  }

  scheduledListAll(): ScheduledEvent[] {
    const rows = this.db.prepare(
      `SELECT id, subject_id, priority, deliver_at, callback_url, payload
       FROM scheduled_events ORDER BY deliver_at ASC`,
    ).all() as RawScheduledRow[];
    return rows.map(rowToScheduledEvent);
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  statsToday(): Stats {
    const now = new Date();
    const todayStartSec = Math.floor(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0) / 1000,
    );

    // Count by decision type.
    const decisionRows = this.db.prepare(
      `SELECT decision, COUNT(*) AS n FROM event_log WHERE occurred_at >= ? GROUP BY decision`,
    ).all(todayStartSec) as Array<{ decision: string; n: number }>;

    const stats: Stats = {
      totalToday: 0,
      actNow: 0,
      delayed: 0,
      suppressed: 0,
      suppressionRate: 0,
      avgDelaySeconds: 0,
      outcomeCounts: { success: 0, failed_temp: 0, failed_perm: 0, pending: 0 },
      deliverySuccessRate: 0,
    };

    for (const row of decisionRows) {
      stats.totalToday += row.n;
      if (row.decision === 'ACT_NOW')  stats.actNow    = row.n;
      if (row.decision === 'DELAY')    stats.delayed   = row.n;
      if (row.decision === 'SUPPRESS') stats.suppressed = row.n;
    }
    if (stats.totalToday > 0) {
      stats.suppressionRate = stats.suppressed / stats.totalToday * 100;
    }

    // Average delay in seconds (deliver_at − occurred_at, both in unix seconds).
    const avgRow = this.db.prepare(
      `SELECT AVG(CAST(deliver_at - occurred_at AS REAL)) AS avg
       FROM event_log
       WHERE decision = 'DELAY' AND deliver_at > 0 AND occurred_at >= ?`,
    ).get(todayStartSec) as { avg: number | null };
    if (avgRow.avg !== null) {
      stats.avgDelaySeconds = avgRow.avg;
    }

    // All-time outcome counts for delivery success rate.
    const outcomeRows = this.db.prepare(
      `SELECT outcome, COUNT(*) AS n FROM event_log GROUP BY outcome`,
    ).all() as Array<{ outcome: string; n: number }>;

    let successCount = 0;
    let resolvedCount = 0;
    for (const row of outcomeRows) {
      if (row.outcome) {
        stats.outcomeCounts[row.outcome] = (stats.outcomeCounts[row.outcome] ?? 0) + row.n;
        if (row.outcome !== 'pending') resolvedCount += row.n;
        if (row.outcome === 'success') successCount   = row.n;
      }
    }
    if (resolvedCount > 0) {
      stats.deliverySuccessRate = successCount / resolvedCount * 100;
    }

    return stats;
  }

  close(): void {
    this.db.close();
  }
}
