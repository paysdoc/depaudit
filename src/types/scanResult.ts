import type { ClassifiedFinding } from "./depauditConfig.js";

export interface ScanResult {
  findings: ClassifiedFinding[];
  socketAvailable: boolean;
  exitCode: number;
}
