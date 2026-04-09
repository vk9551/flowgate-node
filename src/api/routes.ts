// Route handlers — mirrors internal/api/handlers.go.
// All 9 endpoints with identical behaviour, status codes, and response shapes.

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { readConfig } from '../config/loader.js';
import type { Policy, Priority } from '../config/model.js';
import {
  checkAndRecord,
  OUTCOME_DELAY,
  OUTCOME_SUPPRESS,
} from '../engine/enforcer.js';
import {
  EventNotFoundError,
  OutcomeConflictError,
  processOutcome,
} from '../engine/feedback.js';
import { matchPriority } from '../engine/matcher.js';
import type { EventRecord, Store, Subject } from '../store/store.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { ConfigRef } from './middleware.js';

export interface RouteContext {
  configRef:  ConfigRef;
  configPath: string;
  store:      Store;
  startTime:  number; // unix ms
  scheduler?: Scheduler;
}

// ── JSON serialisation helpers ────────────────────────────────────────────────
// These map TypeScript camelCase store types to snake_case JSON matching Go's output.

function serializeStats(s: ReturnType<Store['statsToday']>): Record<string, unknown> {
  return {
    total_today:          s.totalToday,
    act_now:              s.actNow,
    delayed:              s.delayed,
    suppressed:           s.suppressed,
    suppression_rate:     s.suppressionRate,
    avg_delay_seconds:    s.avgDelaySeconds,
    outcome_counts:       s.outcomeCounts,
    delivery_success_rate: s.deliverySuccessRate,
  };
}

function serializeSubject(s: Subject): Record<string, unknown> {
  return {
    id:             s.id,
    timezone:       s.timezone,
    updated_at:     new Date(s.updatedAt).toISOString(),
    channel_health: Object.keys(s.channelHealth).length > 0 ? s.channelHealth : undefined,
  };
}

function serializeEvent(e: EventRecord): Record<string, unknown> {
  return {
    id:             e.id,
    subject_id:     e.subjectId,
    priority:       e.priority,
    decision:       e.decision,
    reason:         e.reason,
    occurred_at:    new Date(e.occurredAt).toISOString(),
    deliver_at:     e.deliverAt  > 0 ? new Date(e.deliverAt).toISOString()  : undefined,
    outcome:        e.outcome    || undefined,
    outcome_reason: e.outcomeReason || undefined,
    resolved_at:    e.resolvedAt > 0 ? new Date(e.resolvedAt).toISOString() : undefined,
  };
}

// findPolicy locates the Policy for the named priority. Returns null if absent.
function findPolicy(configRef: ConfigRef, priorityName: string): Policy | null {
  for (const p of configRef.current.policies ?? []) {
    if (p.priority === priorityName) return p;
  }
  return null;
}

// findOutcomeCfg returns the OutcomeCfg for the named outcome, or null if not found.
function findOutcomeCfg(configRef: ConfigRef, name: string) {
  for (const o of configRef.current.outcomes ?? []) {
    if (o.name === name) return o;
  }
  return null;
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerRoutes(fastify: FastifyInstance, ctx: RouteContext): void {
  const { configRef, configPath, store, startTime, scheduler } = ctx;

  // ── POST /v1/events ────────────────────────────────────────────────────────

  fastify.post<{ Body: Record<string, unknown> }>('/v1/events', async (request, reply) => {
    const cfg = configRef.current;
    const raw = request.body ?? {};

    // Convert all field values to strings for the matcher (mirrors Go's Event map[string]string).
    const evt: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      evt[k] = typeof v === 'string' ? v : String(v);
    }

    // Extract subject ID.
    const subjectId = evt[cfg.subject.id_field] ?? '';
    if (!subjectId) {
      return reply.status(400).send({ error: `missing required field "${cfg.subject.id_field}"` });
    }

    // Upsert subject — preserve stored timezone if event doesn't supply one.
    const tzField = cfg.subject.timezone_field ?? '';
    const subject: Subject = {
      id:            subjectId,
      timezone:      '',
      updatedAt:     Date.now(),
      channelHealth: {},
    };

    const providedTz = tzField ? (evt[tzField] ?? '') : '';
    if (providedTz) {
      subject.timezone = providedTz;
    } else {
      const existing = store.subjectGet(subjectId);
      if (existing) subject.timezone = existing.timezone;
    }

    store.subjectUpsert(subject);

    // Match priority.
    const priority = matchPriority(cfg.priorities ?? [], evt);
    if (!priority) {
      return reply.status(422).send({ error: 'no matching priority and no default configured' });
    }

    // Find policy (default: act_now with no constraints).
    const policy = findPolicy(configRef, priority.name)
      ?? { priority: priority.name, decision: 'act_now' } satisfies Policy;

    const eventId = randomUUID();
    const now = new Date();

    const decision = checkAndRecord(subject, priority, policy, cfg.subject, store, eventId, now);

    // If the decision is DELAY and a scheduler is wired in, enqueue the event.
    if (decision.outcome === OUTCOME_DELAY && scheduler) {
      scheduler.schedule({
        id:          eventId,
        subjectId,
        priority:    priority.name,
        deliverAt:   decision.deliverAt,
        callbackUrl: '',
        payload:     JSON.stringify(raw),
      });
    }

    // Count suppressed events in the last 24 h for this subject (best-effort, non-fatal).
    let suppressedToday = 0;
    try {
      suppressedToday = store.countDecisions(subjectId, OUTCOME_SUPPRESS, Date.now() - 24 * 60 * 60 * 1000);
    } catch { /* non-fatal */ }

    const resp: Record<string, unknown> = {
      event_id:         eventId,
      decision:         decision.outcome,
      reason:           decision.reason,
      priority:         decision.priority,
      suppressed_today: suppressedToday,
    };
    if (decision.deliverAt > 0) {
      resp.deliver_at = new Date(decision.deliverAt).toISOString();
    }

    return reply.send(resp);
  });

  // ── POST /v1/events/:event_id/outcome ──────────────────────────────────────

  fastify.post<{
    Params: { event_id: string };
    Body: { outcome: string; reason?: string; metadata?: Record<string, unknown> };
  }>('/v1/events/:event_id/outcome', async (request, reply) => {
    const { event_id: eventId } = request.params;
    const body = request.body ?? ({} as typeof request.body);

    if (!body.outcome) {
      return reply.status(400).send({ error: 'outcome is required' });
    }

    // Validate outcome name before mutating state.
    const outcomeCfg = findOutcomeCfg(configRef, body.outcome);
    if (!outcomeCfg) {
      return reply.status(400).send({ error: `unknown outcome: ${body.outcome}` });
    }

    // Capture previous outcome before update.
    const ev = store.eventGetById(eventId);
    if (!ev) {
      return reply.status(404).send({ error: `event not found: ${eventId}` });
    }
    const previousOutcome = ev.outcome;

    // Extract optional channel from metadata.
    const channel = typeof body.metadata?.channel === 'string'
      ? body.metadata.channel
      : '';

    try {
      processOutcome(eventId, body.outcome, body.reason ?? '', channel, store, configRef.current);
    } catch (err) {
      if (err instanceof EventNotFoundError) {
        return reply.status(404).send({ error: `event not found: ${eventId}` });
      }
      if (err instanceof OutcomeConflictError) {
        return reply.status(409).send({ error: (err as Error).message });
      }
      return reply.status(400).send({ error: (err as Error).message });
    }

    return reply.send({
      event_id:         eventId,
      outcome:          body.outcome,
      cap_refunded:     outcomeCfg.refund_cap ?? false,
      previous_outcome: previousOutcome,
    });
  });

  // ── GET /v1/subjects/:id ───────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>('/v1/subjects/:id', async (request, reply) => {
    const { id } = request.params;

    const sub = store.subjectGet(id);
    if (!sub) {
      return reply.status(404).send({ error: `subject "${id}" not found` });
    }

    const history = store.eventList(id, 20);

    return reply.send({
      subject: serializeSubject(sub),
      history: history.map(serializeEvent),
    });
  });

  // ── DELETE /v1/subjects/:id ────────────────────────────────────────────────

  fastify.delete<{ Params: { id: string } }>('/v1/subjects/:id', async (request, reply) => {
    const { id } = request.params;
    store.subjectReset(id);
    return reply.send({ status: 'reset', subject_id: id });
  });

  // ── GET /v1/policies ───────────────────────────────────────────────────────

  fastify.get('/v1/policies', async (_request, reply) => {
    return reply.send(configRef.current);
  });

  // ── POST /v1/policies/reload ───────────────────────────────────────────────

  fastify.post('/v1/policies/reload', async (_request, reply) => {
    if (!configPath) {
      return reply.status(422).send({ error: 'no config path configured' });
    }
    try {
      const newCfg = readConfig(configPath);
      configRef.current = newCfg;
      return reply.send({
        status:     'reloaded',
        priorities: newCfg.priorities?.length ?? 0,
      });
    } catch (err) {
      return reply.status(422).send({ error: `reload failed: ${(err as Error).message}` });
    }
  });

  // ── GET /v1/stats ──────────────────────────────────────────────────────────

  fastify.get('/v1/stats', async (_request, reply) => {
    const stats = store.statsToday();
    return reply.send(serializeStats(stats));
  });

  // ── GET /v1/events/recent ──────────────────────────────────────────────────

  fastify.get<{ Querystring: { limit?: string } }>('/v1/events/recent', async (request, reply) => {
    let limit = 50;
    const qs = request.query.limit;
    if (qs) {
      const n = parseInt(qs, 10);
      if (!isNaN(n) && n > 0 && n <= 500) limit = n;
    }
    const events = store.eventListRecent(limit);
    return reply.send(events.map(serializeEvent));
  });

  // ── GET /v1/health ─────────────────────────────────────────────────────────

  fastify.get('/v1/health', async (_request, reply) => {
    const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
    return reply.send({
      status:  'ok',
      uptime:  `${uptimeSec}s`,
      version: configRef.current.version ?? '',
    });
  });
}
