// Priority matcher — mirrors internal/engine/matcher.go exactly.
// First-match-wins; falls back to default priority; returns null if no match.

import type { MatchRule, Priority } from '../config/model.js';

// Event is an arbitrary key-value payload submitted by the caller.
// Mirrors Go's `type Event map[string]string`.
export type Event = Record<string, string>;

// matchPriority returns the first priority whose match rules are satisfied
// by the event. If no priority matches, the default priority is returned.
// If there is no default, null is returned.
export function matchPriority(priorities: Priority[], event: Event): Priority | null {
  let defaultPriority: Priority | null = null;

  for (const priority of priorities) {
    if (priority.default) {
      defaultPriority = priority;
      continue; // keep scanning; an explicit match beats default
    }
    if (matchesAll(priority.match ?? [], event)) {
      return priority;
    }
  }

  // No explicit match — fall back to default if one exists.
  return defaultPriority;
}

// matchesAll returns true when every rule in rules is satisfied by event.
// An empty rules slice matches nothing (a priority with no rules is inert
// unless it is marked default).
function matchesAll(rules: MatchRule[], event: Event): boolean {
  if (rules.length === 0) {
    return false;
  }
  for (const rule of rules) {
    if (!evaluateRule(event, rule)) {
      return false;
    }
  }
  return true;
}

// evaluateRule evaluates a single MatchRule against the event.
// Mirrors matchesRule() in matcher.go.
export function evaluateRule(event: Event, rule: MatchRule): boolean {
  const val = event[rule.field];
  const present = val !== undefined;

  // exists check — must happen before string comparisons
  if (rule.exists !== undefined) {
    return present === rule.exists;
  }

  if (!present) {
    return false;
  }

  if (rule.in && rule.in.length > 0) {
    return rule.in.includes(val);
  }

  if (rule.prefix) {
    return val.startsWith(rule.prefix);
  }

  if (rule.suffix) {
    return val.endsWith(rule.suffix);
  }

  if (rule.equals) {
    return val === rule.equals;
  }

  // No matcher specified — treat as a field-presence check.
  return present;
}
