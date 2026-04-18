import type { LintResult } from "../types/osvScannerConfig.js";

export function printLintResult(
  result: LintResult,
  filePath: string,
  stream: NodeJS.WritableStream = process.stderr
): void {
  if (result.isClean && result.warnings.length === 0) return;
  for (const msg of result.errors) {
    stream.write(`${filePath}:${msg.line ?? 1}:${msg.column ?? 1}: error: ${msg.message}\n`);
  }
  for (const msg of result.warnings) {
    stream.write(`${filePath}:${msg.line ?? 1}:${msg.column ?? 1}: warning: ${msg.message}\n`);
  }
}
