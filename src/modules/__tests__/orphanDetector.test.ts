import { describe, it, expect } from "vitest";
import { findOrphans } from "../orphanDetector.js";
import type { Finding } from "../../types/finding.js";
import type { DepauditConfig, SupplyChainAccept } from "../../types/depauditConfig.js";
import type { OsvScannerConfig, IgnoredVuln } from "../../types/osvScannerConfig.js";
import { DEFAULT_DEPAUDIT_CONFIG } from "../../types/depauditConfig.js";

const emptyOsvConfig: OsvScannerConfig = { ignoredVulns: [], filePath: null };
const emptyDepauditConfig: DepauditConfig = { ...DEFAULT_DEPAUDIT_CONFIG, filePath: "/tmp/.depaudit.yml" };

function makeSocketFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    source: "socket",
    ecosystem: "npm",
    package: "lodash",
    version: "4.17.21",
    findingId: "install-scripts",
    severity: "HIGH",
    manifestPath: "/tmp/package-lock.json",
    ...overrides,
  };
}

function makeOsvFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    source: "osv",
    ecosystem: "npm",
    package: "semver",
    version: "5.7.1",
    findingId: "CVE-2022-12345",
    severity: "HIGH",
    manifestPath: "/tmp/package-lock.json",
    ...overrides,
  };
}

function makeSca(pkg: string, version: string, findingId: string): SupplyChainAccept {
  return {
    package: pkg,
    version,
    findingId,
    expires: "2027-01-01",
    reason: "upstream fix pending in next major release cycle",
  };
}

function makeVuln(id: string): IgnoredVuln {
  return {
    id,
    ignoreUntil: "2027-01-01",
    reason: "pending upstream fix",
  };
}

describe("findOrphans", () => {
  it("empty configs → empty orphan sets", () => {
    const result = findOrphans([], emptyDepauditConfig, emptyOsvConfig);
    expect(result.orphanedSupplyChain).toHaveLength(0);
    expect(result.orphanedCve).toHaveLength(0);
  });

  it("empty findings + populated accepts → every accept is orphan", () => {
    const depauditConfig: DepauditConfig = {
      ...emptyDepauditConfig,
      supplyChainAccepts: [
        makeSca("ghost-pkg", "9.9.9", "install-scripts"),
        makeSca("evil-pkg", "1.0.0", "typosquat"),
      ],
    };
    const osvConfig: OsvScannerConfig = {
      ignoredVulns: [makeVuln("CVE-ORPHAN-0001"), makeVuln("CVE-ORPHAN-0002")],
      filePath: "/tmp/osv-scanner.toml",
    };
    const result = findOrphans([], depauditConfig, osvConfig);
    expect(result.orphanedSupplyChain).toHaveLength(2);
    expect(result.orphanedCve).toHaveLength(2);
  });

  it("all findings matching → zero orphans", () => {
    const socketFinding = makeSocketFinding({ package: "lodash", version: "4.17.21", findingId: "install-scripts" });
    const osvFinding = makeOsvFinding({ findingId: "CVE-2022-12345" });

    const depauditConfig: DepauditConfig = {
      ...emptyDepauditConfig,
      supplyChainAccepts: [makeSca("lodash", "4.17.21", "install-scripts")],
    };
    const osvConfig: OsvScannerConfig = {
      ignoredVulns: [makeVuln("CVE-2022-12345")],
      filePath: "/tmp/osv-scanner.toml",
    };

    const result = findOrphans([socketFinding, osvFinding], depauditConfig, osvConfig);
    expect(result.orphanedSupplyChain).toHaveLength(0);
    expect(result.orphanedCve).toHaveLength(0);
  });

  it("mixed: some match, some don't", () => {
    const socketFinding = makeSocketFinding({ package: "lodash", version: "4.17.21", findingId: "install-scripts" });

    const depauditConfig: DepauditConfig = {
      ...emptyDepauditConfig,
      supplyChainAccepts: [
        makeSca("lodash", "4.17.21", "install-scripts"), // matches
        makeSca("ghost-pkg", "9.9.9", "malware"),         // orphan
      ],
    };
    const osvConfig: OsvScannerConfig = {
      ignoredVulns: [
        makeVuln("CVE-2022-12345"),  // orphan
        makeVuln("GHSA-alive-0001"), // orphan
      ],
      filePath: "/tmp/osv-scanner.toml",
    };

    const result = findOrphans([socketFinding], depauditConfig, osvConfig);
    expect(result.orphanedSupplyChain).toHaveLength(1);
    expect(result.orphanedSupplyChain[0].package).toBe("ghost-pkg");
    expect(result.orphanedCve).toHaveLength(2);
  });

  it("same (package,version) but different findingId → still orphaned", () => {
    const socketFinding = makeSocketFinding({ package: "lodash", version: "4.17.21", findingId: "install-scripts" });

    const depauditConfig: DepauditConfig = {
      ...emptyDepauditConfig,
      supplyChainAccepts: [
        makeSca("lodash", "4.17.21", "typosquat"), // same pkg+version but different findingId
      ],
    };

    const result = findOrphans([socketFinding], depauditConfig, emptyOsvConfig);
    expect(result.orphanedSupplyChain).toHaveLength(1);
    expect(result.orphanedSupplyChain[0].findingId).toBe("typosquat");
  });

  it("source discrimination: osv finding does NOT protect supply chain accepts", () => {
    // OSV finding exists for lodash — but it should NOT mark lodash supply-chain accept as seen
    const osvFinding = makeOsvFinding({ package: "lodash", version: "4.17.21", findingId: "install-scripts" });

    const depauditConfig: DepauditConfig = {
      ...emptyDepauditConfig,
      supplyChainAccepts: [
        makeSca("lodash", "4.17.21", "install-scripts"), // same key, but sourced from osv not socket
      ],
    };

    const result = findOrphans([osvFinding], depauditConfig, emptyOsvConfig);
    expect(result.orphanedSupplyChain).toHaveLength(1);
  });

  it("source discrimination: socket finding does NOT protect CVE accepts", () => {
    // Socket finding exists for CVE-2022-12345 type alert — but it should NOT protect CVE accept
    const socketFinding = makeSocketFinding({ findingId: "CVE-2022-12345" });

    const osvConfig: OsvScannerConfig = {
      ignoredVulns: [makeVuln("CVE-2022-12345")],
      filePath: "/tmp/osv-scanner.toml",
    };

    const result = findOrphans([socketFinding], emptyDepauditConfig, osvConfig);
    expect(result.orphanedCve).toHaveLength(1);
  });

  it("multiple socket findings for same package protect that SCA entry only once", () => {
    const f1 = makeSocketFinding({ package: "lodash", version: "4.17.21", findingId: "install-scripts", manifestPath: "/a/package.json" });
    const f2 = makeSocketFinding({ package: "lodash", version: "4.17.21", findingId: "install-scripts", manifestPath: "/b/package.json" });

    const depauditConfig: DepauditConfig = {
      ...emptyDepauditConfig,
      supplyChainAccepts: [makeSca("lodash", "4.17.21", "install-scripts")],
    };

    const result = findOrphans([f1, f2], depauditConfig, emptyOsvConfig);
    expect(result.orphanedSupplyChain).toHaveLength(0);
  });

  it("no supplyChainAccepts key → empty orphaned supply chain", () => {
    const depauditConfig: DepauditConfig = {
      ...emptyDepauditConfig,
      supplyChainAccepts: [],
    };
    const result = findOrphans([], depauditConfig, emptyOsvConfig);
    expect(result.orphanedSupplyChain).toHaveLength(0);
  });
});
