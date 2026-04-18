export interface IgnoredVuln {
  id: string;
  ignoreUntil: string;
  reason?: string;
  sourceLine?: number;
}

export interface OsvScannerConfig {
  ignoredVulns: IgnoredVuln[];
  filePath: string | null;
}

export type LintSeverity = "error" | "warning";

export interface LintMessage {
  severity: LintSeverity;
  message: string;
  line?: number;
  column?: number;
}

export interface LintResult {
  errors: LintMessage[];
  warnings: LintMessage[];
  isClean: boolean;
}

export class ConfigParseError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly line: number,
    public readonly column: number,
    message: string
  ) {
    super(message);
    this.name = "ConfigParseError";
  }
}
