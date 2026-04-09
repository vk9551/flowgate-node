// Dispatcher tests — payload shape, retry on 500, max-attempts throw, silent skip.

import * as http from 'node:http';
import { describe, it, expect } from 'vitest';
import { FlowgateDispatcher } from './dispatcher.js';
import type { Config } from '../config/model.js';
import type { ScheduledEvent } from '../store/store.js';

// startTestServer creates a local HTTP server that responds with the status
// returned by handler. Returns the server URL and a close() function.
function startTestServer(
  handler: (body: Record<string, unknown>) => number,
): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        const status = handler(body);
        res.writeHead(status);
        res.end();
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        url:   `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
      });
    });
  });
}

function makeEvent(id: string): ScheduledEvent {
  return {
    id,
    subjectId:   'user1',
    priority:    'bulk',
    deliverAt:   Date.now(),
    callbackUrl: '',
    payload:     JSON.stringify({ user_id: 'user1' }),
  };
}

describe('FlowgateDispatcher', () => {
  it('dispatches correct payload on success', async () => {
    const received: Record<string, unknown>[] = [];
    const { url, close } = await startTestServer((body) => {
      received.push(body);
      return 200;
    });

    const cfg: Config = {
      subject:   { id_field: 'user_id' },
      callbacks: { delay_ready: { url } },
    };
    // maxRetries=3, initialBackoffMs=1 for fast tests
    const dispatcher = new FlowgateDispatcher(() => cfg, 3, 1);

    await dispatcher.dispatch(makeEvent('evt1'), 'delay_ready');
    close();

    expect(received).toHaveLength(1);
    const payload = received[0];
    expect(payload.event_id).toBe('evt1');
    expect(payload.subject_id).toBe('user1');
    expect(payload.priority).toBe('bulk');
    expect(payload.decision).toBe('DELAY');
    expect(payload.reason).toBe('scheduled');
    expect(typeof payload.fired_at).toBe('string');
  });

  it('retries on HTTP 500 and succeeds on second attempt', async () => {
    let callCount = 0;
    const { url, close } = await startTestServer(() => {
      callCount++;
      return callCount === 1 ? 500 : 200;
    });

    const cfg: Config = {
      subject:   { id_field: 'user_id' },
      callbacks: { delay_ready: { url } },
    };
    const dispatcher = new FlowgateDispatcher(() => cfg, 3, 1);

    await dispatcher.dispatch(makeEvent('evt1'), 'delay_ready');
    close();

    expect(callCount).toBe(2);
  });

  it('throws after max attempts are exhausted', async () => {
    const { url, close } = await startTestServer(() => 500);

    const cfg: Config = {
      subject:   { id_field: 'user_id' },
      callbacks: { delay_ready: { url } },
    };
    const dispatcher = new FlowgateDispatcher(() => cfg, 3, 1);

    await expect(dispatcher.dispatch(makeEvent('evt1'), 'delay_ready')).rejects.toThrow();
    close();
  });

  it('silently skips when no URL is configured', async () => {
    const cfg: Config = { subject: { id_field: 'user_id' } };
    const dispatcher = new FlowgateDispatcher(() => cfg, 3, 1);

    // Must resolve without throwing even though no callback URL exists.
    await expect(dispatcher.dispatch(makeEvent('evt1'), 'delay_ready')).resolves.toBeUndefined();
  });

  it('dispatchDigest sends batch payload to digest_ready URL', async () => {
    const received: Record<string, unknown>[] = [];
    const { url, close } = await startTestServer((body) => {
      received.push(body);
      return 200;
    });

    const cfg: Config = {
      subject:   { id_field: 'user_id' },
      callbacks: { digest_ready: { url } },
    };
    const dispatcher = new FlowgateDispatcher(() => cfg, 3, 1);
    const events = [makeEvent('e1'), makeEvent('e2')];

    await dispatcher.dispatchDigest('user1', 'bulk', events);
    close();

    expect(received).toHaveLength(1);
    const payload = received[0];
    expect(payload.subject_id).toBe('user1');
    expect(payload.priority).toBe('bulk');
    expect(Array.isArray(payload.events)).toBe(true);
    expect((payload.events as unknown[]).length).toBe(2);
  });
});
