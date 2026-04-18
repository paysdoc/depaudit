import type { Finding } from "../types/finding.js";

export function printFindings(
  findings: Finding[],
  stream: NodeJS.WritableStream = process.stdout
): void {
  for (const f of findings) {
    stream.write(`${f.package} ${f.version} ${f.findingId} ${f.severity}\n`);
  }
}
