import type { Ecosystem, FindingSource, Severity } from "./finding.js";
import type { FindingCategory } from "./depauditConfig.js";

export const CURRENT_SCHEMA_VERSION = 1 as const;

export interface SourceAvailability {
  osv: boolean;
  socket: boolean;
}

export interface FindingsJsonEntry {
  package: string;
  version: string;
  ecosystem: Ecosystem;
  manifestPath: string;
  findingId: string;
  severity: Severity;
  summary: string;
  classification: FindingCategory;
  source: FindingSource;
  upgradeSuggestion: string | null;
}

export interface FindingsJsonSchema {
  schemaVersion: 1;
  sourceAvailability: SourceAvailability;
  findings: FindingsJsonEntry[];
}
