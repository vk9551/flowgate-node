// Store interface and data types — mirrors internal/store/store.go.
// All timestamps are unix milliseconds throughout the TypeScript layer;
// the SQLite implementation converts to/from unix seconds at the boundary.

// Subject represents a tracked entity (user, device, endpoint).
export interface Subject {
  id: string;
  timezone: string;            // IANA tz, e.g. "America/New_York"
  updatedAt: number;           // unix ms
  channelHealth: Record<string, string>; // last outcome per delivery channel
}

// EventRecord is a log entry written each time FlowGate makes a decision.
// Outcome fields are populated later via the feedback API.
export interface EventRecord {
  id: string;
  subjectId: string;
  priority: string;
  decision: string;            // ACT_NOW | DELAY | SUPPRESS
  reason: string;
  occurredAt: number;          // unix ms
  deliverAt: number;           // unix ms, 0 for non-DELAY decisions
  outcome: string;             // delivery outcome reported by caller
  outcomeReason: string;       // caller-provided reason for the outcome
  resolvedAt: number;          // unix ms, 0 until a terminal outcome is recorded
}

// ScheduledEvent is an entry in the scheduler queue; fired by the MinHeap tick loop.
// Used by Session 4 (scheduler). Stored in the SQLite scheduled_events table.
export interface ScheduledEvent {
  id: string;          // matches the event_log id
  subjectId: string;
  priority: string;
  deliverAt: number;   // unix ms — when to fire the callback
  callbackUrl: string;
  payload: string;     // JSON-serialised original event payload
}

// Stats holds aggregated decision counts (typically for today) plus delivery outcomes.
export interface Stats {
  totalToday: number;
  actNow: number;
  delayed: number;
  suppressed: number;
  suppressionRate: number;      // suppressed / totalToday × 100
  avgDelaySeconds: number;
  outcomeCounts: Record<string, number>; // all-time outcome tallies
  deliverySuccessRate: number;           // success / (success + failed_*) × 100
}

// Store is the persistence interface for FlowGate.
// All methods are synchronous (backed by better-sqlite3).
// Throw on SQL errors; return null for "not found".
export interface Store {
  // Subject CRUD
  subjectGet(id: string): Subject | null;
  subjectUpsert(s: Subject): void;
  subjectReset(id: string): void;
  subjectUpdateChannelHealth(subjectId: string, channel: string, outcome: string): void;

  // Event log
  eventAppend(subjectId: string, e: EventRecord): void;
  eventList(subjectId: string, limit: number): EventRecord[];
  eventListRecent(limit: number): EventRecord[];
  eventGetById(eventId: string): EventRecord | null;

  // Counting (for cap enforcement)
  // countEvents: how many events for subject+priority occurred in the last periodMs ms.
  countEvents(subjectId: string, priority: string, periodMs: number): number;
  // countDecisions: how many events for subject+decision occurred since sinceMs (absolute unix ms).
  countDecisions(subjectId: string, decision: string, sinceMs: number): number;

  // Outcome feedback
  outcomeUpdate(eventId: string, outcome: string, reason: string): void;
  capRefund(subjectId: string, priority: string, occurredAt: number): void;

  // Scheduler queue (Session 4)
  scheduledInsert(e: ScheduledEvent): void;
  scheduledDelete(id: string): void;
  scheduledList(beforeMs: number): ScheduledEvent[];
  scheduledListAll(): ScheduledEvent[];

  // Aggregates
  statsToday(): Stats;

  close(): void;
}
