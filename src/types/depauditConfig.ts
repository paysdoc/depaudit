import type { Finding, Severity } from "./finding.js";

export type SeverityThreshold = "medium" | "high" | "critical";

export interface DepauditPolicy {
  severityThreshold: SeverityThreshold;
  ecosystems: "auto" | string[];
  maxAcceptDays: number;
  maxCommonAndFineDays: number;
}

export interface CommonAndFineEntry {
  package: string;
  alertType: string;
  expires: string;
  reason?: string;
  sourceLine?: number;
}

export interface SupplyChainAccept {
  package: string;
  version: string;
  findingId: string;
  expires: string;
  reason?: string;
  upstreamIssue?: string;
  sourceLine?: number;
}

export interface DepauditConfig {
  version: number;
  policy: DepauditPolicy;
  commonAndFine: CommonAndFineEntry[];
  supplyChainAccepts: SupplyChainAccept[];
  filePath: string | null;
}

export type FindingCategory = "new" | "accepted" | "whitelisted" | "expired-accept";

export interface ClassifiedFinding {
  finding: Finding;
  category: FindingCategory;
}

export const DEFAULT_DEPAUDIT_CONFIG: DepauditConfig = {
  version: 1,
  policy: {
    severityThreshold: "medium",
    ecosystems: "auto",
    maxAcceptDays: 90,
    maxCommonAndFineDays: 365,
  },
  commonAndFine: [],
  supplyChainAccepts: [],
  filePath: null,
};

export const SUPPORTED_ECOSYSTEMS = ["npm"] as const;

export const SEVERITY_RANK: Record<Severity, number> = {
  UNKNOWN: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};
