// gRPC server tests — mirrors server_test.go.
// Uses a real port (0 = OS assigns) for simplicity.

import * as net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { credentials, type ServiceError } from '@grpc/grpc-js';
import type { Config } from '../config/model.js';
import { SqliteStore } from '../store/sqlite.js';
import { startGrpcServer } from './server.js';
import {
  FlowGateClient,
  type Decision,
  type HealthResponse,
  type OutcomeResult,
} from './gen/flowgate.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function testConfig(): Config {
  return {
    version: '1.0',
    subject: { id_field: 'user_id' },
    priorities: [
      {
        name: 'bypass',
        match: [{ field: 'type', in: ['otp'] }],
        bypass_all: true,
      },
      { name: 'normal', default: true },
    ],
    policies: [
      { priority: 'bypass', decision: 'act_now' },
      {
        priority: 'normal',
        decision: 'act_now',
        caps: [{ scope: 'subject', period: '1d', limit: 1 }],
        decision_on_cap_breach: 'suppress',
      },
    ],
    outcomes: [
      { name: 'success', terminal: true },
      { name: 'failed_temp', refund_cap: true },
      { name: 'pending' },
    ],
    default_outcome: 'pending',
  };
}

// getFreePort finds a free TCP port using a one-shot server.
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      srv.close(() => {
        if (addr && typeof addr === 'object') {
          resolve(addr.port);
        } else {
          reject(new Error('no address'));
        }
      });
    });
  });
}

// callUnary wraps a grpc-js unary call in a Promise.
function callUnary<Req, Res>(
  fn: (req: Req, cb: (err: ServiceError | null, res: Res) => void) => void,
  req: Req,
): Promise<Res> {
  return new Promise((resolve, reject) => {
    fn(req, (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('gRPC server', () => {
  let store: SqliteStore;
  let client: InstanceType<typeof FlowGateClient>;

  beforeEach(async () => {
    const cfg = testConfig();
    store = new SqliteStore(':memory:');
    const configRef = { current: cfg };
    const port = await getFreePort();

    await startGrpcServer(port, { configRef, configPath: 'test.yaml', store, startTime: Date.now() });
    client = new FlowGateClient(`localhost:${port}`, credentials.createInsecure());
  });

  afterEach(() => {
    client.close();
    store.close();
  });

  // T1: Health → status "ok"
  it('T1 health returns ok', async () => {
    const resp = await callUnary<Parameters<typeof client.health>[0], HealthResponse>(
      client.health.bind(client), {});
    expect(resp.status).toBe('ok');
  });

  // T2: Evaluate with bypass_all priority → ACT_NOW
  it('T2 evaluate bypass_all returns ACT_NOW', async () => {
    const resp = await callUnary<Parameters<typeof client.evaluate>[0], Decision>(
      client.evaluate.bind(client),
      { subjectId: 'user-1', type: '', channel: '', expiryAt: 0, subjectTz: '', metadata: { type: 'otp' } },
    );
    expect(resp.decision).toBe('ACT_NOW');
    expect(resp.reason).toBe('bypass_all');
  });

  // T3: Evaluate until cap breach → SUPPRESS
  it('T3 evaluate cap breach returns SUPPRESS', async () => {
    await callUnary(client.evaluate.bind(client), {
      subjectId: 'user-cap', type: '', channel: '', expiryAt: 0, subjectTz: '', metadata: {},
    });
    const resp = await callUnary<Parameters<typeof client.evaluate>[0], Decision>(
      client.evaluate.bind(client),
      { subjectId: 'user-cap', type: '', channel: '', expiryAt: 0, subjectTz: '', metadata: {} },
    );
    expect(resp.decision).toBe('SUPPRESS');
  });

  // T4: ReportOutcome failed_temp → cap_refunded: true
  it('T4 report outcome failed_temp has cap_refunded=true', async () => {
    const evResp = await callUnary<Parameters<typeof client.evaluate>[0], Decision>(
      client.evaluate.bind(client),
      { subjectId: 'user-outcome', type: '', channel: '', expiryAt: 0, subjectTz: '', metadata: {} },
    );
    const outResp = await callUnary<Parameters<typeof client.reportOutcome>[0], OutcomeResult>(
      client.reportOutcome.bind(client),
      { eventId: evResp.eventId, outcome: 'failed_temp', reason: '' },
    );
    expect(outResp.capRefunded).toBe(true);
  });

  // T5: EvaluateStream — send 3 events, receive 3 decisions
  it('T5 evaluate stream returns 3 decisions', async () => {
    const stream = client.evaluateStream();
    const decisions: Decision[] = [];

    const done = new Promise<void>((resolve, reject) => {
      stream.on('data', (d: Decision) => decisions.push(d));
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    stream.write({ subjectId: 'stream-1', type: '', channel: '', expiryAt: 0, subjectTz: '', metadata: {} });
    stream.write({ subjectId: 'stream-2', type: '', channel: '', expiryAt: 0, subjectTz: '', metadata: {} });
    stream.write({ subjectId: 'stream-3', type: '', channel: '', expiryAt: 0, subjectTz: '', metadata: {} });
    stream.end();

    await done;
    expect(decisions).toHaveLength(3);
  });
});
