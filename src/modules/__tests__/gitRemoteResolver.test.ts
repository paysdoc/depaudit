import { describe, it, expect } from "vitest";
import {
  resolveRepo,
  resolveTriggerBranch,
  branchExistsOnRemote,
  GitRemoteError,
} from "../gitRemoteResolver.js";
import { GhApiError } from "../ghPrCommentClient.js";

describe("resolveRepo", () => {
  it("parses SSH remote URL", async () => {
    const exec = async () => ({ stdout: "git@github.com:owner/name.git\n", stderr: "" });
    expect(await resolveRepo("/repo", { execFile: exec })).toBe("owner/name");
  });

  it("parses HTTPS remote URL with .git suffix", async () => {
    const exec = async () => ({ stdout: "https://github.com/owner/name.git\n", stderr: "" });
    expect(await resolveRepo("/repo", { execFile: exec })).toBe("owner/name");
  });

  it("parses HTTPS remote URL without .git suffix", async () => {
    const exec = async () => ({ stdout: "https://github.com/owner/name\n", stderr: "" });
    expect(await resolveRepo("/repo", { execFile: exec })).toBe("owner/name");
  });

  it("throws GitRemoteError on malformed URL", async () => {
    const exec = async () => ({ stdout: "not-a-valid-url\n", stderr: "" });
    await expect(resolveRepo("/repo", { execFile: exec })).rejects.toThrow(GitRemoteError);
  });

  it("throws GitRemoteError when execFile rejects", async () => {
    const exec = async () => { throw new Error("no remote"); };
    await expect(resolveRepo("/repo", { execFile: exec })).rejects.toThrow(GitRemoteError);
  });
});

describe("resolveTriggerBranch", () => {
  it("returns 'main' when gh api branches/main exits 0", async () => {
    const exec = async (_file: string, args: readonly string[]) => {
      if (args.includes("branches/main")) return { stdout: '{"name":"main"}', stderr: "" };
      return { stdout: "", stderr: "" };
    };
    expect(await resolveTriggerBranch("owner/repo", { execFile: exec })).toBe("main");
  });

  it("falls back to default_branch when branches/main returns 404", async () => {
    const exec = async (_file: string, args: readonly string[]) => {
      if (args.some((a) => a.includes("branches/main"))) {
        throw Object.assign(new Error("HTTP 404"), { stderr: "HTTP 404: Not Found", code: 1 });
      }
      if (args.includes("--jq")) return { stdout: "develop\n", stderr: "" };
      return { stdout: "", stderr: "" };
    };
    expect(await resolveTriggerBranch("owner/repo", { execFile: exec })).toBe("develop");
  });

  it("returns the default branch value when main is absent", async () => {
    const exec = async (_file: string, args: readonly string[]) => {
      if (args.some((a) => a.includes("branches/main"))) {
        throw Object.assign(new Error("404"), { stderr: "HTTP 404", code: 1 });
      }
      if (args.includes("--jq")) return { stdout: "trunk\n", stderr: "" };
      return { stdout: "", stderr: "" };
    };
    expect(await resolveTriggerBranch("owner/repo", { execFile: exec })).toBe("trunk");
  });

  it("throws GhApiError on non-404 branch check failure", async () => {
    const exec = async (_file: string, args: readonly string[]) => {
      if (args.some((a) => a.includes("branches/main"))) {
        throw Object.assign(new Error("rate limit"), { stderr: "HTTP 403: Forbidden", code: 1 });
      }
      return { stdout: "", stderr: "" };
    };
    await expect(resolveTriggerBranch("owner/repo", { execFile: exec })).rejects.toThrow(GhApiError);
  });
});

describe("branchExistsOnRemote", () => {
  it("returns true when git ls-remote exits 0", async () => {
    const exec = async () => ({ stdout: "abc123\trefs/heads/main\n", stderr: "" });
    expect(await branchExistsOnRemote("owner/repo", "main", { execFile: exec })).toBe(true);
  });

  it("returns false when git ls-remote exits 2", async () => {
    const exec = async () => {
      throw Object.assign(new Error("no match"), { code: 2 });
    };
    expect(await branchExistsOnRemote("owner/repo", "absent", { execFile: exec })).toBe(false);
  });

  it("re-throws on unexpected exit codes", async () => {
    const exec = async () => {
      throw Object.assign(new Error("network error"), { code: 128 });
    };
    await expect(branchExistsOnRemote("owner/repo", "branch", { execFile: exec })).rejects.toThrow();
  });
});
