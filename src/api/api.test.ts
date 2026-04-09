// Integration tests — mirrors internal/api/api_test.go.
// Uses fastify.inject() — no real HTTP port opened.
// All 16 Go test cases ported, plus a reload test.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config/model.js';
import { SqliteStore } from '../store/sqlite.js';
import { buildServer } from './server.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

// testConfig mirrors testCfg() in api_test.go.
function testConfig(secret: string): Config {
  return {
    version: '1.0',
    subject: {
      id_field:       'user_id',
      timezone_field: 'user_tz',
      waking_hours:   { start: '07:00', end: '22:00' },
    },
    priorities: [
      {
        name:       'critical',
        match:      [{ field: 'type', in: ['otp', 'order_confirmed'] }],
        bypass_all: true,
      },
      {
        name:    'bulk',
        match:   [{ field: 'type', prefix: 'marketing_' }],
        default: true,
      },
    ],
    policies: [
      { priority: 'critical', decision: 'act_now' },
      {
        priority: 'bulk',
        // respect_waking_hours=false — quiet hours disabled for test simplicity
        window: { respect_waking_hours: false },
        caps:   [{ scope: 'subject', period: '1d', period_ms: 24 * 60 * 60 * 1000, limit: 1 }],
        decision_on_cap_breach: 'suppress',
      },
    ],
    server: {
      port: 7700,
      auth: { type: 'jwt', secret },
    },
    outcomes: [
      { name: 'success',     refund_cap: false, terminal: true  },
      { name: 'failed_temp', refund_cap: true,  terminal: false },
      { name: 'failed_perm', refund_cap: true,  terminal: true  },
      { name: 'pending',     refund_cap: false, terminal: false },
    ],
    default_outcome: 'pending',
  };
}

// makeToken signs an HS256 JWT — mirrors makeToken() in api_test.go.
function makeToken(secret: string): string {
  return jwt.sign({ sub: 'test' }, secret, { algorithm: 'HS256', expiresIn: '1h' });
}

// writeTemp creates a temporary YAML config file.
function writeTemp(content: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowgate-'));
  const file = path.join(tmpDir, 'flowgate.yaml');
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

// ── Test server factory ───────────────────────────────────────────────────────

interface TestServer {
  server: FastifyInstance;
  store: SqliteStore;
}

async function newTestServer(secret: string, configPath?: string): Promise<TestServer> {
  const store = new SqliteStore(':memory:');
  const server = await buildServer({
    config:      testConfig(secret),
    store,
    configPath,
  });
  return { server, store };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('API integration', () => {
  let ts: TestServer;

  afterEach(async () => {
    await ts.server.close();
    ts.store.close();
  });

  // ── 1. Health endpoint is always public ────────────────────────────────────

  it('GET /v1/health — public, no auth needed', async () => {
    ts = await newTestServer('secret');
    const res = await ts.server.inject({ method: 'GET', url: '/v1/health' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string };
    expect(body.status).toBe('ok');
  });

  // ── 2. Unauthenticated request rejected ────────────────────────────────────

  it('POST /v1/events — no token → 401', async () => {
    ts = await newTestServer('topsecret');
    const res = await ts.server.inject({
      method:  'POST',
      url:     '/v1/events',
      payload: JSON.stringify({ user_id: 'u1', type: 'otp' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(401);
  });

  // ── 3. Malformed token rejected ────────────────────────────────────────────

  it('POST /v1/events — malformed token → 401', async () => {
    ts = await newTestServer('topsecret');
    const res = await ts.server.inject({
      method:  'POST',
      url:     '/v1/events',
      payload: JSON.stringify({ user_id: 'u1', type: 'otp' }),
      headers: { 'content-type': 'application/json', authorization: 'Bearer not.a.token' },
    });
    expect(res.statusCode).toBe(401);
  });

  // ── 4. Wrong signing secret rejected ──────────────────────────────────────

  it('POST /v1/events — wrong secret → 401', async () => {
    ts = await newTestServer('topsecret');
    const wrongToken = makeToken('different-secret');
    const res = await ts.server.inject({
      method:  'POST',
      url:     '/v1/events',
      payload: JSON.stringify({ user_id: 'u1', type: 'otp' }),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${wrongToken}` },
    });
    expect(res.statusCode).toBe(401);
  });

  // ── 5. bypass_all priority → SEND_NOW ─────────────────────────────────────

  it('POST /v1/events — OTP bypass_all → ACT_NOW', async () => {
    const secret = 's3cr3t';
    ts = await newTestServer(secret);
    const res = await ts.server.inject({
      method:  'POST',
      url:     '/v1/events',
      payload: JSON.stringify({ user_id: 'u1', type: 'otp' }),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${makeToken(secret)}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { decision: string; reason: string; priority: string; event_id: string };
    expect(body.decision).toBe('ACT_NOW');
    expect(body.reason).toBe('bypass_all');
    expect(body.priority).toBe('critical');
    expect(body.event_id).toBeTruthy();
  });

  // ── 6. Cap breach → SUPPRESS with suppressed_today count ──────────────────

  it('POST /v1/events — second marketing event → SUPPRESS', async () => {
    const secret = 's3cr3t';
    ts = await newTestServer(secret);
    const token = makeToken(secret);
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    const body1 = JSON.stringify({ user_id: 'u1', type: 'marketing_weekly' });

    // First event — under cap (limit=1).
    const res1 = await ts.server.inject({ method: 'POST', url: '/v1/events', payload: body1, headers });
    expect(res1.statusCode).toBe(200);
    const r1 = res1.json() as { decision: string };
    expect(r1.decision).toBe('ACT_NOW');

    // Second event — cap breached.
    const res2 = await ts.server.inject({ method: 'POST', url: '/v1/events', payload: body1, headers });
    expect(res2.statusCode).toBe(200);
    const r2 = res2.json() as { decision: string; reason: string; suppressed_today: number };
    expect(r2.decision).toBe('SUPPRESS');
    expect(r2.reason).toBe('cap_breached');
    expect(r2.suppressed_today).toBeGreaterThanOrEqual(1);
  });

  // ── 7. Missing subject ID → 400 ────────────────────────────────────────────

  it('POST /v1/events — missing user_id → 400', async () => {
    const secret = 's3cr3t';
    ts = await newTestServer(secret);
    const res = await ts.server.inject({
      method:  'POST',
      url:     '/v1/events',
      payload: JSON.stringify({ type: 'otp' }), // no user_id
      headers: { 'content-type': 'application/json', authorization: `Bearer ${makeToken(secret)}` },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── 8. Subject not found → 404 ─────────────────────────────────────────────

  it('GET /v1/subjects/:id — unknown subject → 404', async () => {
    const secret = 's3cr3t';
    ts = await newTestServer(secret);
    const res = await ts.server.inject({
      method:  'GET',
      url:     '/v1/subjects/nobody',
      headers: { authorization: `Bearer ${makeToken(secret)}` },
    });
    expect(res.statusCode).toBe(404);
  });

  // ── 9. Subject get with event history ─────────────────────────────────────

  it('GET /v1/subjects/:id — returns subject + history', async () => {
    const secret = 's3cr3t';
    ts = await newTestServer(secret);
    const token = makeToken(secret);
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

    // Create subject via POST /v1/events.
    await ts.server.inject({
      method: 'POST', url: '/v1/events',
      payload: JSON.stringify({ user_id: 'u42', type: 'otp' }), headers,
    });

    const res = await ts.server.inject({
      method: 'GET', url: '/v1/subjects/u42',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { subject: { id: string }; history: unknown[] };
    expect(body.subject.id).toBe('u42');
    expect(body.history).toHaveLength(1);
  });

  // ── 10. Delete resets history ──────────────────────────────────────────────

  it('DELETE /v1/subjects/:id — resets event history', async () => {
    const secret = 's3cr3t';
    ts = await newTestServer(secret);
    const token = makeToken(secret);
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    const evBody = JSON.stringify({ user_id: 'u99', type: 'otp' });

    // Build up history.
    await ts.server.inject({ method: 'POST', url: '/v1/events', payload: evBody, headers });
    await ts.server.inject({ method: 'POST', url: '/v1/events', payload: evBody, headers });

    // Delete.
    const del = await ts.server.inject({
      method: 'DELETE', url: '/v1/subjects/u99',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(200);

    // History should be empty now.
    const get = await ts.server.inject({
      method: 'GET', url: '/v1/subjects/u99',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = get.json() as { history: unknown[] };
    expect(body.history).toHaveLength(0);
  });

  // ── 11. GET /v1/policies returns config ────────────────────────────────────

  it('GET /v1/policies — returns full config with 2 priorities', async () => {
    const secret = 's3cr3t';
    ts = await newTestServer(secret);
    const res = await ts.server.inject({
      method: 'GET', url: '/v1/policies',
      headers: { authorization: `Bearer ${makeToken(secret)}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { priorities: unknown[] };
    expect(body.priorities).toHaveLength(2);
  });

  // ── 12. auth=none skips JWT verification ──────────────────────────────────

  it('POST /v1/events — auth=none allows requests without token', async () => {
    const store = new SqliteStore(':memory:');
    const cfg = testConfig('unused');
    cfg.server = { port: 7700, auth: { type: 'none' } };
    const server = await buildServer({ config: cfg, store });
    ts = { server, store };

    const res = await ts.server.inject({
      method:  'POST',
      url:     '/v1/events',
      payload: JSON.stringify({ user_id: 'u1', type: 'otp' }),
      headers: { 'content-type': 'application/json' },
      // no Authorization header
    });
    // Should NOT return 401 (may be 200 or 422 depending on matching).
    expect(res.statusCode).not.toBe(401);
  });

  // ── 13. Outcome: valid event → 200 + cap_refunded ─────────────────────────

  it('POST /v1/events/:id/outcome — failed_temp refunds cap', async () => {
    const secret = 's3cr3t';
    ts = await newTestServer(secret);
    const token = makeToken(secret);
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

    // Create event.
    const evRes = await ts.server.inject({
      method: 'POST', url: '/v1/events',
      payload: JSON.stringify({ user_id: 'u10', type: 'marketing_weekly' }), headers,
    });
    const evBody = evRes.json() as { event_id: string };

    // Report failed_temp.
    const orRes = await ts.server.inject({
      method: 'POST',
      url:    `/v1/events/${evBody.event_id}/outcome`,
      payload: JSON.stringify({ outcome: 'failed_temp', reason: 'connection_timeout' }),
      headers,
    });

    expect(orRes.statusCode).toBe(200);
    const or = orRes.json() as {
      event_id: string; outcome: string; cap_refunded: boolean; previous_outcome: string;
    };
    expect(or.event_id).toBe(evBody.event_id);
    expect(or.outcome).toBe('failed_temp');
    expect(or.cap_refunded).toBe(true);
    expect(or.previous_outcome).toBe('pending');
  });

  // ── 14. Outcome: unknown event → 404 ──────────────────────────────────────

  it('POST /v1/events/:id/outcome — nonexistent event → 404', async () => {
    const secret = 's3cr3t';
    ts = await newTestServer(secret);
    const res = await ts.server.inject({
      method:  'POST',
      url:     '/v1/events/no-such-event/outcome',
      payload: JSON.stringify({ outcome: 'success' }),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${makeToken(secret)}` },
    });
    expect(res.statusCode).toBe(404);
  });

  // ── 15. Outcome: invalid outcome name → 400 ────────────────────────────────

  it('POST /v1/events/:id/outcome — invalid outcome name → 400', async () => {
    const secret = 's3cr3t';
    ts = await newTestServer(secret);
    const token = makeToken(secret);
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

    const evRes = await ts.server.inject({
      method: 'POST', url: '/v1/events',
      payload: JSON.stringify({ user_id: 'u11', type: 'otp' }), headers,
    });
    const { event_id } = evRes.json() as { event_id: string };

    const res = await ts.server.inject({
      method:  'POST',
      url:     `/v1/events/${event_id}/outcome`,
      payload: JSON.stringify({ outcome: 'not_a_real_outcome' }),
      headers,
    });
    expect(res.statusCode).toBe(400);
  });

  // ── 16. GET subject shows channel_health after failed_perm ────────────────

  it('GET /v1/subjects/:id — channel_health updated after failed_perm', async () => {
    const secret = 's3cr3t';
    ts = await newTestServer(secret);
    const token = makeToken(secret);
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

    // Create event.
    const evRes = await ts.server.inject({
      method: 'POST', url: '/v1/events',
      payload: JSON.stringify({ user_id: 'u12', type: 'otp' }), headers,
    });
    const { event_id } = evRes.json() as { event_id: string };

    // Report failed_perm with channel=email.
    await ts.server.inject({
      method:  'POST',
      url:     `/v1/events/${event_id}/outcome`,
      payload: JSON.stringify({ outcome: 'failed_perm', reason: 'hard_bounce', metadata: { channel: 'email' } }),
      headers,
    });

    // GET subject — channel_health should show email: failed_perm.
    const res = await ts.server.inject({
      method: 'GET', url: '/v1/subjects/u12',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { subject: { channel_health?: Record<string, string> } };
    expect(body.subject.channel_health?.['email']).toBe('failed_perm');
  });

  // ── 17. POST /v1/policies/reload swaps config ─────────────────────────────

  it('POST /v1/policies/reload — reloads config from disk', async () => {
    const secret = 's3cr3t';
    // Write a minimal config to a temp file.
    const yaml = `
version: "2.0"
subject:
  id_field: user_id
priorities:
  - name: default_only
    default: true
storage:
  backend: sqlite
server:
  port: 7700
  auth:
    type: jwt
    secret: ${secret}
`;
    const configPath = writeTemp(yaml);
    ts = await newTestServer(secret, configPath);

    const res = await ts.server.inject({
      method:  'POST',
      url:     '/v1/policies/reload',
      headers: { authorization: `Bearer ${makeToken(secret)}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; priorities: number };
    expect(body.status).toBe('reloaded');
    expect(body.priorities).toBe(1);
  });
});
