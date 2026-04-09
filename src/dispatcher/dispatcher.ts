// Dispatcher — sends webhook callbacks for fired scheduled events.
// Uses native fetch (Node 18+) with exponential-backoff retries.
// Mirrors the dispatcher package from flowgate-go.

import type { Config } from '../config/model.js';
import type { ScheduledEvent } from '../store/store.js';

// CallbackPayload is the JSON body POSTed to a delay_ready callback URL.
export interface CallbackPayload {
  event_id:         string;
  subject_id:       string;
  decision:         string;
  reason:           string;
  priority:         string;
  original_payload: unknown;
  fired_at:         string; // ISO 8601
}

// DigestPayload is the JSON body POSTed to the digest_ready callback URL.
export interface DigestPayload {
  subject_id: string;
  priority:   string;
  events:     CallbackPayload[];
}

export class FlowgateDispatcher {
  constructor(
    private readonly getConfig: () => Config,
    // These defaults match production; tests can pass lower values for speed.
    private readonly maxRetries:       number = 3,
    private readonly initialBackoffMs: number = 500,
  ) {}

  // dispatch fires a single scheduled event to the named callback type.
  // If no URL is configured for that type, logs and returns silently.
  async dispatch(event: ScheduledEvent, callbackType: string): Promise<void> {
    const url = this.getConfig().callbacks?.[callbackType]?.url ?? '';
    if (!url) {
      console.log(`FlowGate: no URL for callback type "${callbackType}", skipping`);
      return;
    }

    let original: unknown = {};
    try { original = JSON.parse(event.payload); } catch { /* keep empty object */ }

    const body: CallbackPayload = {
      event_id:         event.id,
      subject_id:       event.subjectId,
      decision:         'DELAY',
      reason:           'scheduled',
      priority:         event.priority,
      original_payload: original,
      fired_at:         new Date().toISOString(),
    };

    await this.sendWithRetry(url, body);
  }

  // dispatchDigest fires a batch of events to the digest_ready callback URL.
  async dispatchDigest(
    subjectId: string,
    priority: string,
    events: ScheduledEvent[],
  ): Promise<void> {
    const url = this.getConfig().callbacks?.['digest_ready']?.url ?? '';
    if (!url) {
      console.log('FlowGate: no URL for digest_ready callback, skipping');
      return;
    }

    const eventPayloads: CallbackPayload[] = events.map((e) => {
      let original: unknown = {};
      try { original = JSON.parse(e.payload); } catch { /* ok */ }
      return {
        event_id:         e.id,
        subject_id:       e.subjectId,
        decision:         'DELAY',
        reason:           'scheduled',
        priority:         e.priority,
        original_payload: original,
        fired_at:         new Date().toISOString(),
      };
    });

    const body: DigestPayload = { subject_id: subjectId, priority, events: eventPayloads };
    await this.sendWithRetry(url, body);
  }

  // sendWithRetry POSTs body as JSON to url, retrying up to maxRetries times
  // with exponential backoff capped at 30 s.
  private async sendWithRetry(url: string, body: unknown): Promise<void> {
    let lastErr: Error | undefined;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const resp = await fetch(url, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(body),
        });
        if (resp.ok) return;
        lastErr = new Error(`HTTP ${resp.status}`);
      } catch (err) {
        lastErr = err as Error;
      }

      if (attempt < this.maxRetries - 1) {
        const delay = Math.min(this.initialBackoffMs * Math.pow(2, attempt), 30_000);
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastErr ?? new Error(`dispatch failed after ${this.maxRetries} attempts to ${url}`);
  }
}
