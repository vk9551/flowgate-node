// Config loader — mirrors internal/config/loader.go exactly.
// Reads, env-expands, parses durations, validates, and applies default outcomes.

import * as fs from 'node:fs';
import yaml from 'js-yaml';
import chokidar from 'chokidar';
import type { Config } from './model.js';
import {
  OUTCOME_FAILED_PERM,
  OUTCOME_FAILED_TEMP,
  OUTCOME_PENDING,
  OUTCOME_SUCCESS,
} from './model.js';

const ENV_VAR_RE = /\$\{([^}]+)\}/g;

// readConfig reads, env-expands, and validates a config file at path.
// Mirrors Load() in loader.go.
export function readConfig(path: string): Config {
  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`config: read ${path}: ${(err as NodeJS.ErrnoException).message}`);
  }

  const expanded = expandEnvVars(raw);

  let cfg: Config;
  try {
    cfg = yaml.load(expanded) as Config;
  } catch (err) {
    throw new Error(`config: parse ${path}: ${(err as Error).message}`);
  }

  parseDurations(cfg);
  validateConfig(cfg);
  applyDefaultOutcomes(cfg);

  return cfg;
}

// expandEnvVars replaces ${VAR} references with environment variable values.
// If a variable is not set, the placeholder is left as-is.
export function expandEnvVars(raw: string): string {
  return raw.replace(ENV_VAR_RE, (_match, name: string) => {
    const val = process.env[name];
    return val !== undefined ? val : _match;
  });
}

// parseDuration converts a duration string to milliseconds.
// Supports "d" (days) in addition to standard h/m/s units.
// Mirrors parseDuration() in loader.go, but returns ms instead of time.Duration.
export function parseDuration(s: string): number {
  s = s.trim();

  if (s.endsWith('d')) {
    const n = parseInt(s.slice(0, -1), 10);
    if (isNaN(n)) {
      throw new Error(`invalid duration "${s}"`);
    }
    return n * 24 * 60 * 60 * 1000;
  }

  // Go's time.ParseDuration supports h, m, s, ms, us, ns.
  // We support the subset that appears in flowgate configs.
  const match = /^(\d+(?:\.\d+)?)(h|m|s|ms)$/.exec(s);
  if (!match) {
    throw new Error(`invalid duration "${s}"`);
  }
  const value = parseFloat(match[1]);
  switch (match[2]) {
    case 'h':  return value * 60 * 60 * 1000;
    case 'm':  return value * 60 * 1000;
    case 's':  return value * 1000;
    case 'ms': return value;
    default:   throw new Error(`invalid duration "${s}"`);
  }
}

function parseDurations(cfg: Config): void {
  for (const policy of cfg.policies ?? []) {
    if (policy.window?.max_delay) {
      policy.window.max_delay_ms = parseDuration(policy.window.max_delay);
    }
    for (const cap of policy.caps ?? []) {
      if (cap.period) {
        cap.period_ms = parseDuration(cap.period);
      }
    }
  }
}

// validateConfig checks for required fields and logical consistency.
// Mirrors validate() in loader.go.
export function validateConfig(cfg: Config): void {
  if (!cfg.subject?.id_field) {
    throw new Error('config: subject.id_field is required');
  }

  const priorityNames = new Set<string>();
  let defaultCount = 0;
  for (const p of cfg.priorities ?? []) {
    if (!p.name) {
      throw new Error('config: priority entry missing name');
    }
    if (priorityNames.has(p.name)) {
      throw new Error(`config: duplicate priority name "${p.name}"`);
    }
    priorityNames.add(p.name);
    if (p.default) {
      defaultCount++;
    }
  }
  if (defaultCount > 1) {
    throw new Error(
      `config: at most one priority may be marked default, found ${defaultCount}`,
    );
  }

  const outcomeNames = new Set<string>();
  for (const o of cfg.outcomes ?? []) {
    if (!o.name) {
      throw new Error('config: outcome entry missing name');
    }
    if (outcomeNames.has(o.name)) {
      throw new Error(`config: duplicate outcome name "${o.name}"`);
    }
    outcomeNames.add(o.name);
  }
  if (cfg.default_outcome && outcomeNames.size > 0 && !outcomeNames.has(cfg.default_outcome)) {
    throw new Error(
      `config: default_outcome "${cfg.default_outcome}" not in outcomes list`,
    );
  }

  for (const pol of cfg.policies ?? []) {
    if (!pol.priority) {
      throw new Error('config: policy entry missing priority name');
    }
    if (!priorityNames.has(pol.priority)) {
      throw new Error(`config: policy references unknown priority "${pol.priority}"`);
    }
  }
}

// applyDefaultOutcomes fills in built-in outcomes when none are configured in YAML.
// Mirrors applyDefaultOutcomes() in loader.go.
export function applyDefaultOutcomes(cfg: Config): void {
  if (!cfg.outcomes || cfg.outcomes.length === 0) {
    cfg.outcomes = [
      { name: OUTCOME_SUCCESS,     refund_cap: false, terminal: true  },
      { name: OUTCOME_FAILED_TEMP, refund_cap: true,  terminal: false },
      { name: OUTCOME_FAILED_PERM, refund_cap: true,  terminal: true  },
      { name: OUTCOME_PENDING,     refund_cap: false, terminal: false },
    ];
  }
  if (!cfg.default_outcome) {
    cfg.default_outcome = OUTCOME_PENDING;
  }
}

// watchConfig returns a chokidar watcher that calls onChange with the new Config
// whenever the file changes. Parse errors during watch are silently ignored
// (the previous config remains in effect).
export function watchConfig(
  path: string,
  onChange: (cfg: Config) => void,
): chokidar.FSWatcher {
  const watcher = chokidar.watch(path, { ignoreInitial: true });
  watcher.on('change', () => {
    try {
      const cfg = readConfig(path);
      onChange(cfg);
    } catch {
      // Ignore parse errors — keep the previous config.
    }
  });
  return watcher;
}
