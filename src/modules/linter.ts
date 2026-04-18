import type { OsvScannerConfig, LintMessage, LintResult, IgnoredVuln } from "../types/osvScannerConfig.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const EXPIRY_CAP_DAYS = 90;

function checkIsoParseable(entry: IgnoredVuln): LintMessage | null {
  if (isNaN(Date.parse(entry.ignoreUntil))) {
    return {
      severity: "error",
      message: `ignoreUntil must be a valid ISO-8601 date (got: "${entry.ignoreUntil}")`,
      line: entry.sourceLine,
      column: 1,
    };
  }
  return null;
}

function checkNotExpired(entry: IgnoredVuln, now: Date): LintMessage | null {
  const until = new Date(entry.ignoreUntil);
  if (until < now) {
    return {
      severity: "error",
      message: `ignoreUntil has already passed (${entry.ignoreUntil})`,
      line: entry.sourceLine,
      column: 1,
    };
  }
  return null;
}

function checkWithinCap(entry: IgnoredVuln, now: Date): LintMessage | null {
  const until = new Date(entry.ignoreUntil);
  const maxDate = new Date(now.getTime() + EXPIRY_CAP_DAYS * MS_PER_DAY);
  if (until > maxDate) {
    return {
      severity: "error",
      message: `ignoreUntil exceeds 90-day cap (max: ${maxDate.toISOString().slice(0, 10)}, got: ${entry.ignoreUntil})`,
      line: entry.sourceLine,
      column: 1,
    };
  }
  return null;
}

function checkReason(entry: IgnoredVuln): LintMessage | null {
  if (entry.reason === undefined) {
    return {
      severity: "error",
      message: `reason is required (must be at least 20 characters)`,
      line: entry.sourceLine,
      column: 1,
    };
  }
  if (entry.reason.length < 20) {
    return {
      severity: "error",
      message: `reason must be at least 20 characters (got ${entry.reason.length})`,
      line: entry.sourceLine,
      column: 1,
    };
  }
  return null;
}

function checkDuplicates(entries: IgnoredVuln[]): LintMessage[] {
  const seen = new Map<string, number>();
  const warnings: LintMessage[] = [];
  for (const entry of entries) {
    const count = seen.get(entry.id) ?? 0;
    if (count > 0) {
      warnings.push({
        severity: "warning",
        message: `duplicate acceptance for ${entry.id}`,
        line: entry.sourceLine,
        column: 1,
      });
    }
    seen.set(entry.id, count + 1);
  }
  return warnings;
}

export function lintOsvScannerConfig(config: OsvScannerConfig, now: Date = new Date()): LintResult {
  const errors: LintMessage[] = [];
  const warnings: LintMessage[] = [];

  for (const entry of config.ignoredVulns) {
    const parseError = checkIsoParseable(entry);
    if (parseError) {
      errors.push(parseError);
      continue;
    }
    const expiredError = checkNotExpired(entry, now);
    if (expiredError) errors.push(expiredError);

    const capError = checkWithinCap(entry, now);
    if (capError) errors.push(capError);

    const reasonError = checkReason(entry);
    if (reasonError) errors.push(reasonError);
  }

  warnings.push(...checkDuplicates(config.ignoredVulns));

  return { errors, warnings, isClean: errors.length === 0 };
}
