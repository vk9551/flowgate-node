// Config model for flowgate.yaml — mirrors internal/config/model.go exactly.
// Field names use snake_case to match YAML keys directly, avoiding a mapping layer.

export interface WakingHours {
  start?: string;
  end?: string;
}

export interface SubjectCfg {
  id_field: string;
  timezone_field?: string;
  waking_hours?: WakingHours;
}

// MatchRule is a single field-level predicate.
// Exactly one of in, prefix, suffix, equals, or exists should be set.
export interface MatchRule {
  field: string;
  in?: string[];
  prefix?: string;
  suffix?: string;
  equals?: string;
  exists?: boolean; // undefined means unset (mirrors Go's *bool)
}

export interface Priority {
  name: string;
  match?: MatchRule[];
  bypass_all?: boolean;
  default?: boolean;
}

export interface WindowCfg {
  respect_waking_hours?: boolean;
  max_delay?: string;    // raw string from YAML, e.g. "48h"
  max_delay_ms?: number; // parsed milliseconds — set by loader, not from YAML
}

export interface CapRule {
  scope?: string;       // subject | global
  period?: string;      // raw string from YAML, e.g. "1d"
  period_ms?: number;   // parsed milliseconds — set by loader, not from YAML
  limit?: number;
}

export interface Policy {
  priority: string;
  decision?: string;              // act_now | suppress
  window?: WindowCfg;
  caps?: CapRule[];
  decision_on_cap_breach?: string;
}

export interface StorageCfg {
  backend?: string; // sqlite | redis | postgres
  dsn?: string;
}

export interface AuthCfg {
  type?: string;   // jwt | api_key | none
  secret?: string; // supports ${ENV_VAR} expansion
}

export interface DashCfg {
  enabled?: boolean;
}

export interface ServerCfg {
  port?: number;
  auth?: AuthCfg;
  dashboard?: DashCfg;
}

export interface OutcomeCfg {
  name: string;
  refund_cap?: boolean; // true → remove event from cap window on this outcome
  terminal?: boolean;   // true → no further outcome updates allowed
}

// CallbackCfg is a single callback endpoint (URL + optional auth headers).
export interface CallbackCfg {
  url?: string;
}

export interface Config {
  version?: string;
  subject: SubjectCfg;
  priorities?: Priority[];
  policies?: Policy[];
  storage?: StorageCfg;
  server?: ServerCfg;
  outcomes?: OutcomeCfg[];
  default_outcome?: string;
  callbacks?: Record<string, CallbackCfg>; // named callback endpoints, e.g. delay_ready, digest_ready
}

// Default outcome names — mirrors Go constants in model.go.
export const OUTCOME_SUCCESS = 'success';
export const OUTCOME_FAILED_TEMP = 'failed_temp';
export const OUTCOME_FAILED_PERM = 'failed_perm';
export const OUTCOME_PENDING = 'pending';
