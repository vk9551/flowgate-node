// Feedback processor — mirrors internal/engine/feedback.go.
// processOutcome records a delivery outcome for a previously-decided event.
// It applies cap refunds and channel health updates as configured.

import type { Config, OutcomeCfg } from '../config/model.js';
import type { Store } from '../store/store.js';

// ── Error types ───────────────────────────────────────────────────────────────

// EventNotFoundError mirrors Go's ErrEventNotFound.
export class EventNotFoundError extends Error {
  constructor() {
    super('event not found');
    this.name = 'EventNotFoundError';
  }
}

// OutcomeConflictError mirrors Go's ErrOutcomeConflict.
export class OutcomeConflictError extends Error {
  constructor() {
    super('event already has a different terminal outcome');
    this.name = 'OutcomeConflictError';
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

// processOutcome records a delivery outcome for a previously-decided event.
// Applies cap refunds and channel health updates as configured in cfg.
// channel is the delivery channel to tag on the subject health record (e.g. "email", "push").
// If channel is empty, the event's priority name is used as a fallback.
// Mirrors ProcessOutcome() in feedback.go.
// Throws EventNotFoundError, OutcomeConflictError, or Error on failure.
export function processOutcome(
  eventId: string,
  outcome: string,
  reason: string,
  channel: string,
  store: Store,
  config: Config,
): void {
  // Look up the event.
  const ev = store.eventGetById(eventId);
  if (ev === null) {
    throw new EventNotFoundError();
  }

  // Validate the outcome name.
  const outcomeCfg = findOutcomeCfg(config, outcome);
  if (outcomeCfg === null) {
    throw new Error(`feedback: unknown outcome "${outcome}"`);
  }

  // Check whether the existing outcome is already terminal.
  const defaultOutcome = config.default_outcome ?? 'pending';
  if (ev.outcome && ev.outcome !== defaultOutcome) {
    const existing = findOutcomeCfg(config, ev.outcome);
    if (existing !== null && existing.terminal) {
      if (ev.outcome === outcome) {
        // Same terminal outcome — idempotent, nothing to do.
        return;
      }
      throw new OutcomeConflictError();
    }
  }

  // Refund the cap slot for this event if configured.
  if (outcomeCfg.refund_cap) {
    store.capRefund(ev.subjectId, ev.priority, ev.occurredAt);
  }

  // Mark the delivery channel unhealthy for terminal non-success outcomes.
  if (outcomeCfg.terminal && outcome !== 'success') {
    const ch = channel || ev.priority;
    store.subjectUpdateChannelHealth(ev.subjectId, ch, outcome);
  }

  // Persist the outcome.
  store.outcomeUpdate(eventId, outcome, reason);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// findOutcomeCfg returns the OutcomeCfg for the named outcome, or null if not found.
// Mirrors findOutcomeCfg() in feedback.go.
export function findOutcomeCfg(config: Config, name: string): OutcomeCfg | null {
  for (const o of config.outcomes ?? []) {
    if (o.name === name) return o;
  }
  return null;
}
