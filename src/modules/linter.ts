import type { OsvScannerConfig, LintMessage, LintResult, IgnoredVuln } from "../types/osvScannerConfig.js";
import type { DepauditConfig, DepauditPolicy, CommonAndFineEntry, SupplyChainAccept } from "../types/depauditConfig.js";
import { SUPPORTED_ECOSYSTEMS } from "../types/depauditConfig.js";

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

// ─── depauditConfig linting ───────────────────────────────────────────────────

function checkVersion(config: DepauditConfig, errors: LintMessage[]): void {
  if (config.version !== 1) {
    errors.push({
      severity: "error",
      message: `schema version ${config.version} is not supported (expected: 1). See migration guide.`,
      line: 1,
      column: 1,
    });
  }
}

function checkSeverityThreshold(policy: DepauditPolicy, errors: LintMessage[]): void {
  const valid = ["medium", "high", "critical"];
  if (!valid.includes(policy.severityThreshold as string)) {
    errors.push({
      severity: "error",
      message: `policy.severityThreshold must be one of: medium, high, critical (got: '${policy.severityThreshold}')`,
      line: undefined,
      column: 1,
    });
  }
}

function checkEcosystems(policy: DepauditPolicy, errors: LintMessage[]): void {
  if (policy.ecosystems === "auto") return;
  if (!Array.isArray(policy.ecosystems)) {
    errors.push({
      severity: "error",
      message: `policy.ecosystems must be "auto" or a list of supported ecosystems (supported: ${SUPPORTED_ECOSYSTEMS.join(", ")})`,
      line: undefined,
      column: 1,
    });
    return;
  }
  for (const eco of policy.ecosystems) {
    if (!(SUPPORTED_ECOSYSTEMS as readonly string[]).includes(eco)) {
      errors.push({
        severity: "error",
        message: `policy.ecosystems contains unsupported value "${eco}" (supported: ${SUPPORTED_ECOSYSTEMS.join(", ")})`,
        line: undefined,
        column: 1,
      });
    }
  }
}

function checkMaxAcceptDays(policy: DepauditPolicy, errors: LintMessage[]): void {
  const v = policy.maxAcceptDays;
  if (!Number.isInteger(v) || v < 1 || v > 90) {
    errors.push({
      severity: "error",
      message: `policy.maxAcceptDays must be a positive integer ≤ 90 (got: ${v})`,
      line: undefined,
      column: 1,
    });
  }
}

function checkMaxCommonAndFineDays(policy: DepauditPolicy, errors: LintMessage[]): void {
  const v = policy.maxCommonAndFineDays;
  if (!Number.isInteger(v) || v < 1 || v > 365) {
    errors.push({
      severity: "error",
      message: `policy.maxCommonAndFineDays must be a positive integer ≤ 365 (got: ${v})`,
      line: undefined,
      column: 1,
    });
  }
}

function checkCommonAndFineEntry(entry: CommonAndFineEntry, now: Date, errors: LintMessage[]): void {
  if (isNaN(Date.parse(entry.expires))) {
    errors.push({
      severity: "error",
      message: `commonAndFine entry expires must be a valid ISO-8601 date (got: "${entry.expires}")`,
      line: entry.sourceLine,
      column: 1,
    });
    return;
  }
  const expiresDate = new Date(entry.expires);
  if (expiresDate < now) {
    errors.push({
      severity: "error",
      message: `commonAndFine entry expires has already passed (${entry.expires})`,
      line: entry.sourceLine,
      column: 1,
    });
    return;
  }
  const maxDate = new Date(now.getTime() + 365 * MS_PER_DAY);
  if (expiresDate > maxDate) {
    errors.push({
      severity: "error",
      message: `commonAndFine entry expires exceeds 365-day cap (max: ${maxDate.toISOString().slice(0, 10)}, got: ${entry.expires})`,
      line: entry.sourceLine,
      column: 1,
    });
  }
}

function checkSupplyChainEntry(entry: SupplyChainAccept, now: Date, errors: LintMessage[]): void {
  if (isNaN(Date.parse(entry.expires))) {
    errors.push({
      severity: "error",
      message: `supplyChainAccepts entry expires must be a valid ISO-8601 date (got: "${entry.expires}")`,
      line: entry.sourceLine,
      column: 1,
    });
    return;
  }
  const expiresDate = new Date(entry.expires);
  if (expiresDate < now) {
    errors.push({
      severity: "error",
      message: `supplyChainAccepts entry expires has already passed (${entry.expires})`,
      line: entry.sourceLine,
      column: 1,
    });
    return;
  }
  const maxDate = new Date(now.getTime() + 90 * MS_PER_DAY);
  if (expiresDate > maxDate) {
    errors.push({
      severity: "error",
      message: `supplyChainAccepts entry expires exceeds 90-day cap (max: ${maxDate.toISOString().slice(0, 10)}, got: ${entry.expires})`,
      line: entry.sourceLine,
      column: 1,
    });
  }
  if (entry.reason === undefined) {
    errors.push({
      severity: "error",
      message: `supplyChainAccepts entry reason is required`,
      line: entry.sourceLine,
      column: 1,
    });
  } else if (entry.reason.length < 20) {
    errors.push({
      severity: "error",
      message: `supplyChainAccepts entry reason must be at least 20 characters (got ${entry.reason.length})`,
      line: entry.sourceLine,
      column: 1,
    });
  }
}

function checkSupplyChainDuplicates(entries: SupplyChainAccept[], warnings: LintMessage[]): void {
  const seen = new Map<string, number>();
  for (const entry of entries) {
    const key = `${entry.package}|${entry.version}|${entry.findingId}`;
    const count = seen.get(key) ?? 0;
    if (count > 0) {
      warnings.push({
        severity: "warning",
        message: `duplicate supplyChainAccepts entry for (${entry.package}, ${entry.version}, ${entry.findingId})`,
        line: entry.sourceLine,
        column: 1,
      });
    }
    seen.set(key, count + 1);
  }
}

function checkCommonAndFineDuplicates(entries: CommonAndFineEntry[], warnings: LintMessage[]): void {
  const seen = new Map<string, number>();
  for (const entry of entries) {
    const key = `${entry.package}|${entry.alertType}`;
    const count = seen.get(key) ?? 0;
    if (count > 0) {
      warnings.push({
        severity: "warning",
        message: `duplicate commonAndFine entry for (${entry.package}, ${entry.alertType})`,
        line: entry.sourceLine,
        column: 1,
      });
    }
    seen.set(key, count + 1);
  }
}

export function lintDepauditConfig(config: DepauditConfig, now: Date = new Date()): LintResult {
  const errors: LintMessage[] = [];
  const warnings: LintMessage[] = [];

  checkVersion(config, errors);
  checkSeverityThreshold(config.policy, errors);
  checkEcosystems(config.policy, errors);
  checkMaxAcceptDays(config.policy, errors);
  checkMaxCommonAndFineDays(config.policy, errors);

  for (const entry of config.commonAndFine) {
    checkCommonAndFineEntry(entry, now, errors);
  }
  for (const entry of config.supplyChainAccepts) {
    checkSupplyChainEntry(entry, now, errors);
  }

  checkCommonAndFineDuplicates(config.commonAndFine, warnings);
  checkSupplyChainDuplicates(config.supplyChainAccepts, warnings);

  return { errors, warnings, isClean: errors.length === 0 };
}
