import { discoverManifests } from "../modules/manifestDiscoverer.js";
import { runOsvScanner } from "../modules/osvScannerAdapter.js";
import { printFindings } from "../modules/stdoutReporter.js";

export async function runScanCommand(scanPath: string): Promise<number> {
  const manifests = await discoverManifests(scanPath);
  const findings = await runOsvScanner(manifests);
  printFindings(findings);
  return findings.length === 0 ? 0 : 1;
}
