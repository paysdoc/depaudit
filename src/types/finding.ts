export type Severity = "UNKNOWN" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type Ecosystem = "npm";
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
}
