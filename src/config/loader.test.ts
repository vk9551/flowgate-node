// Mirrors internal/config/loader_test.go — same 8 test cases.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readConfig } from './loader.js';

function writeTemp(content: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowgate-'));
  const filePath = path.join(tmpDir, 'flowgate.yaml');
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('readConfig', () => {
  it('valid minimal config', () => {
    const yaml = `
version: "1.0"
subject:
  id_field: user_id
priorities:
  - name: critical
    match:
      - field: type
        in: [otp]
    bypass_all: true
  - name: bulk
    match:
      - field: type
        prefix: marketing_
    default: true
policies:
  - priority: critical
    decision: act_now
  - priority: bulk
    decision: suppress
storage:
  backend: sqlite
server:
  port: 7700
`;
    const cfg = readConfig(writeTemp(yaml));
    expect(cfg.subject.id_field).toBe('user_id');
    expect(cfg.priorities).toHaveLength(2);
  });

  it('duration parsing — 48h and 1d', () => {
    const yaml = `
version: "1.0"
subject:
  id_field: user_id
priorities:
  - name: bulk
    default: true
policies:
  - priority: bulk
    window:
      max_delay: 48h
    caps:
      - scope: subject
        period: 1d
        limit: 5
`;
    const cfg = readConfig(writeTemp(yaml));
    const pol = cfg.policies![0];
    expect(pol.window!.max_delay_ms).toBe(48 * 60 * 60 * 1000);
    expect(pol.caps![0].period_ms).toBe(24 * 60 * 60 * 1000);
  });

  it('env var expansion', () => {
    vi.stubEnv('TEST_SECRET', 'mysecret');
    const yaml = `
version: "1.0"
subject:
  id_field: user_id
server:
  auth:
    secret: "\${TEST_SECRET}"
`;
    const cfg = readConfig(writeTemp(yaml));
    expect(cfg.server!.auth!.secret).toBe('mysecret');
  });

  it('missing id_field throws', () => {
    const yaml = `
version: "1.0"
subject:
  id_field: ""
`;
    expect(() => readConfig(writeTemp(yaml))).toThrow('id_field');
  });

  it('duplicate priority name throws', () => {
    const yaml = `
version: "1.0"
subject:
  id_field: user_id
priorities:
  - name: bulk
  - name: bulk
`;
    expect(() => readConfig(writeTemp(yaml))).toThrow('duplicate');
  });

  it('policy references unknown priority throws', () => {
    const yaml = `
version: "1.0"
subject:
  id_field: user_id
priorities:
  - name: critical
policies:
  - priority: ghost
    decision: act_now
`;
    expect(() => readConfig(writeTemp(yaml))).toThrow('unknown priority');
  });

  it('multiple defaults throws', () => {
    const yaml = `
version: "1.0"
subject:
  id_field: user_id
priorities:
  - name: a
    default: true
  - name: b
    default: true
`;
    expect(() => readConfig(writeTemp(yaml))).toThrow('default');
  });

  it('file not found throws', () => {
    expect(() => readConfig(path.join(os.tmpdir(), 'nonexistent-flowgate.yaml'))).toThrow();
  });
});
