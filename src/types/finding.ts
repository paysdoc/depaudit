export type Severity = "UNKNOWN" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type Ecosystem = "npm" | "pip" | "gomod" | "cargo" | "maven" | "gem" | "composer";
export type FindingSource = "osv" | "socket";

export interface Finding {
  source: FindingSource;
  ecosystem: Ecosystem;
  package: string;
  version: string;
  findingId: string;
  severity: Severity;
  summary?: string;
  manifestPath: string;
  /** Resolving upgrade version from OSV fix metadata; absent for Socket findings and OSV findings with no known fix */
  fixedIn?: string;
}
