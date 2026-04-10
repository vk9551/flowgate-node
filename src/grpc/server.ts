// gRPC server for FlowGate — mirrors the REST handlers in src/api/routes.ts.
// Additive only: REST is unchanged.

import { randomUUID } from 'node:crypto';
import { Server, ServerCredentials } from '@grpc/grpc-js';
import type { Config, Policy, OutcomeCfg } from '../config/model.js';
import {
  checkAndRecord,
  OUTCOME_SUPPRESS,
} from '../engine/enforcer.js';
import {
  EventNotFoundError,
  OutcomeConflictError,
  processOutcome,
} from '../engine/feedback.js';
import { matchPriority } from '../engine/matcher.js';
import type { Store, Subject } from '../store/store.js';
import { readConfig } from '../config/loader.js';
import {
  FlowGateService,
  type FlowGateServer as FlowGateServerImpl,
  type Decision,
  type EvaluateRequest,
  type OutcomeResult,
  type SubjectResponse,
  type ResetSubjectResponse,
  type PoliciesResponse,
  type ReloadPoliciesResponse,
  type Stats,
  type RecentEventsResponse,
  type HealthResponse,
  type EventSummary,
} from './gen/flowgate.js';

// GrpcDeps are the shared dependencies for the gRPC server.
export interface GrpcDeps {
  configRef: { current: Config };
  configPath: string;
  store: Store;
  startTime: number; // unix ms
}

// startGrpcServer binds the gRPC server on the given port and starts serving.
// Returns a promise that resolves when the server is bound.
export function startGrpcServer(port: number, deps: GrpcDeps): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = new Server();
    server.addService(FlowGateService, buildImpl(deps));
    server.bindAsync(
      `0.0.0.0:${port}`,
      ServerCredentials.createInsecure(),
      (err, boundPort) => {
        if (err) {
          reject(err);
          return;
        }
        console.log(`FlowGate: gRPC listening on :${boundPort}`);
        resolve();
      },
    );
  });
}

// buildImpl creates a FlowGateServer implementation bound to deps.
// Exported separately so tests can pass a custom store.
export function buildImpl(deps: GrpcDeps): FlowGateServerImpl {
  const { configRef, configPath, store, startTime } = deps;

  // ── evaluate helper ────────────────────────────────────────────────────────

  function evaluate(req: EvaluateRequest): Decision {
    const cfg = configRef.current;

    if (!req.subjectId) {
      throw Object.assign(new Error('subject_id is required'), { code: 3 }); // INVALID_ARGUMENT
    }

    const evt: Record<string, string> = {};
    evt[cfg.subject.id_field] = req.subjectId;
    if (req.type) evt['type'] = req.type;
    if (req.channel) evt['channel'] = req.channel;
    if (req.subjectTz && cfg.subject.timezone_field) {
      evt[cfg.subject.timezone_field] = req.subjectTz;
    }
    for (const [k, v] of Object.entries(req.metadata ?? {})) {
      evt[k] = v;
    }

    let subject: Subject = store.subjectGet(req.subjectId) ?? {
      id: req.subjectId,
      timezone: req.subjectTz ?? '',
      updatedAt: Date.now(),
      channelHealth: {},
    };
    if (req.subjectTz) subject = { ...subject, timezone: req.subjectTz };
    store.subjectUpsert({ ...subject, updatedAt: Date.now() });

    const priority = matchPriority(cfg.priorities ?? [], evt);
    if (!priority) {
      throw Object.assign(new Error('no matching priority and no default configured'), { code: 9 }); // FAILED_PRECONDITION
    }

    const policy: Policy = findPolicy(cfg, priority.name) ?? {
      priority: priority.name,
      decision: 'act_now',
    };

    const eventId = randomUUID();
    const now = new Date();
    const decision = checkAndRecord(subject, priority, policy, cfg.subject, store, eventId, now);

    const todayStartMs = new Date().setUTCHours(0, 0, 0, 0);
    const suppressedToday = store.countDecisions(req.subjectId, OUTCOME_SUPPRESS, todayStartMs);

    return {
      decision: decision.outcome,
      reason: decision.reason,
      deliverAt: decision.deliverAt,
      priority: decision.priority,
      eventId,
      suppressedToday,
    };
  }

  // ── service implementation ─────────────────────────────────────────────────

  const impl: FlowGateServerImpl = {

    health(_call, callback): void {
      const cfg = configRef.current;
      const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
      const resp: HealthResponse = { status: 'ok', uptime: uptimeSeconds, version: cfg.version ?? '' };
      callback(null, resp);
    },

    evaluate(call, callback): void {
      try {
        callback(null, evaluate(call.request));
      } catch (err: unknown) {
        callback(err as Error);
      }
    },

    reportOutcome(call, callback): void {
      const cfg = configRef.current;
      const { eventId, outcome, reason } = call.request;

      if (!eventId) { callback(Object.assign(new Error('event_id required'), { code: 3 })); return; }
      if (!outcome) { callback(Object.assign(new Error('outcome required'), { code: 3 })); return; }

      const outcomeCfg = findOutcomeCfg(cfg, outcome);
      if (!outcomeCfg) { callback(Object.assign(new Error(`unknown outcome: ${outcome}`), { code: 3 })); return; }

      const ev = store.eventGetById(eventId);
      if (!ev) { callback(Object.assign(new Error(`event not found: ${eventId}`), { code: 5 })); return; } // NOT_FOUND
      const previousOutcome = ev.outcome;

      try {
        processOutcome(eventId, outcome, reason ?? '', '', store, cfg);
      } catch (err) {
        if (err instanceof EventNotFoundError) {
          callback(Object.assign(new Error(err.message), { code: 5 }));
        } else if (err instanceof OutcomeConflictError) {
          callback(Object.assign(new Error(err.message), { code: 10 })); // ABORTED
        } else {
          callback(err as Error);
        }
        return;
      }

      const resp: OutcomeResult = { eventId, outcome, capRefunded: outcomeCfg.refund_cap ?? false, previousOutcome };
      callback(null, resp);
    },

    evaluateStream(call): void {
      call.on('data', (req: EvaluateRequest) => {
        try {
          call.write(evaluate(req));
        } catch (err) {
          call.destroy(err as Error);
        }
      });
      call.on('end', () => call.end());
      call.on('error', () => { /* client disconnected */ });
    },

    getSubject(call, callback): void {
      const { subjectId } = call.request;
      const sub = store.subjectGet(subjectId);
      if (!sub) { callback(Object.assign(new Error(`subject not found: ${subjectId}`), { code: 5 })); return; }

      const history = store.eventList(subjectId, 20);
      const recentEvents: EventSummary[] = history.map(ev => ({
        eventId: ev.id,
        type: ev.priority,
        decision: ev.decision,
        reason: ev.reason,
        outcome: ev.outcome,
        occurredAt: ev.occurredAt,
      }));

      const resp: SubjectResponse = {
        subjectId: sub.id,
        timezone: sub.timezone,
        channelHealth: sub.channelHealth ?? {},
        recentEvents,
      };
      callback(null, resp);
    },

    resetSubject(call, callback): void {
      store.subjectReset(call.request.subjectId);
      const resp: ResetSubjectResponse = { status: 'reset' };
      callback(null, resp);
    },

    getPolicies(_call, callback): void {
      const resp: PoliciesResponse = { configJson: JSON.stringify(configRef.current) };
      callback(null, resp);
    },

    reloadPolicies(_call, callback): void {
      try {
        const newCfg = readConfig(configPath);
        configRef.current = newCfg;
        const resp: ReloadPoliciesResponse = {
          status: 'reloaded',
          priorities: (newCfg.priorities ?? []).length,
        };
        callback(null, resp);
      } catch (err) {
        callback(err as Error);
      }
    },

    getStats(_call, callback): void {
      const s = store.statsToday();
      const resp: Stats = {
        totalToday: s.totalToday,
        sendNow: s.actNow,
        delayed: s.delayed,
        suppressed: s.suppressed,
        activeScheduled: 0,
        suppressionRate: s.suppressionRate,
        avgDelaySeconds: s.avgDelaySeconds,
        deliverySuccessRate: s.deliverySuccessRate,
        outcomeCounts: {
          success: s.outcomeCounts['success'] ?? 0,
          failedTemp: s.outcomeCounts['failed_temp'] ?? 0,
          failedPerm: s.outcomeCounts['failed_perm'] ?? 0,
          pending: s.outcomeCounts['pending'] ?? 0,
        },
      };
      callback(null, resp);
    },

    getRecentEvents(call, callback): void {
      const limit = call.request.limit > 0 ? call.request.limit : 50;
      const events = store.eventListRecent(limit);
      const resp: RecentEventsResponse = {
        events: events.map(ev => ({
          eventId: ev.id,
          type: ev.priority,
          decision: ev.decision,
          reason: ev.reason,
          outcome: ev.outcome,
          occurredAt: ev.occurredAt,
        })),
      };
      callback(null, resp);
    },
  };

  return impl;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function findPolicy(cfg: Config, priorityName: string): Policy | null {
  for (const p of cfg.policies ?? []) {
    if (p.priority === priorityName) return p;
  }
  return null;
}

function findOutcomeCfg(cfg: Config, name: string): OutcomeCfg | null {
  for (const o of cfg.outcomes ?? []) {
    if (o.name === name) return o;
  }
  return null;
}
