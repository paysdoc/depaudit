import { describe, it, expect } from "vitest";
import { access } from "node:fs/promises";
import {
  listPrComments,
  createPrComment,
  updatePrComment,
  GhApiError,
} from "../ghPrCommentClient.js";

const COORDS = { repo: "owner/repo", prNumber: 42 };

const LIST_RESPONSE = [
  { id: 1, body: "hello", user: { login: "alice" } },
  { id: 2, body: "world", user: { login: "bob" } },
  { id: 3, body: "foo" },
];

describe("listPrComments", () => {
  it("returns mapped PrComment[] from realistic gh api JSON", async () => {
    const exec = async (_file: string, _args: readonly string[]) => ({
      stdout: JSON.stringify(LIST_RESPONSE),
      stderr: "",
    });
    const result = await listPrComments(COORDS, { execFile: exec });
    expect(result).toEqual([
      { id: 1, body: "hello", user: { login: "alice" } },
      { id: 2, body: "world", user: { login: "bob" } },
      { id: 3, body: "foo", user: undefined },
    ]);
  });

  it("returns [] for empty array response", async () => {
    const exec = async () => ({ stdout: "[]", stderr: "" });
    const result = await listPrComments(COORDS, { execFile: exec });
    expect(result).toEqual([]);
  });

  it("throws GhApiError when execFile rejects", async () => {
    const exec = async () => { throw Object.assign(new Error("not found"), { code: 127 }); };
    await expect(listPrComments(COORDS, { execFile: exec })).rejects.toThrow(GhApiError);
  });

  it("throws GhApiError with exit code from rejection", async () => {
    const exec = async () => { throw Object.assign(new Error("fail"), { code: 4 }); };
    let caught: GhApiError | null = null;
    try {
      await listPrComments(COORDS, { execFile: exec });
    } catch (e) {
      caught = e as GhApiError;
    }
    expect(caught?.exitCode).toBe(4);
  });

  it("throws GhApiError on malformed JSON stdout", async () => {
    const exec = async () => ({ stdout: "not json {{{", stderr: "" });
    await expect(listPrComments(COORDS, { execFile: exec })).rejects.toThrow(GhApiError);
  });
});

describe("createPrComment", () => {
  it("returns { id } from gh api response", async () => {
    const exec = async () => ({ stdout: JSON.stringify({ id: 99, body: "test" }), stderr: "" });
    const result = await createPrComment(COORDS, "test body", { execFile: exec });
    expect(result).toEqual({ id: 99 });
  });

  it("passes --field body=@ with a real temp file path", async () => {
    let capturedArgs: readonly string[] = [];
    const exec = async (_file: string, args: readonly string[]) => {
      capturedArgs = args;
      return { stdout: JSON.stringify({ id: 1 }), stderr: "" };
    };
    await createPrComment(COORDS, "some body content", { execFile: exec });
    const fieldIdx = capturedArgs.indexOf("--field");
    expect(fieldIdx).toBeGreaterThan(-1);
    const fieldValue = capturedArgs[fieldIdx + 1];
    expect(fieldValue).toMatch(/^body=@.+body\.md$/);
  });

  it("removes temp dir after success", async () => {
    let capturedArgs: readonly string[] = [];
    const exec = async (_file: string, args: readonly string[]) => {
      capturedArgs = args;
      return { stdout: JSON.stringify({ id: 1 }), stderr: "" };
    };
    await createPrComment(COORDS, "body", { execFile: exec });
    const fieldIdx = capturedArgs.indexOf("--field");
    const tempFile = capturedArgs[fieldIdx + 1].slice(6); // strip "body=@"
    const tempDir = tempFile.replace(/\/body\.md$/, "");
    await expect(access(tempDir)).rejects.toThrow();
  });

  it("removes temp dir after execFile error", async () => {
    let capturedArgs: readonly string[] = [];
    const exec = async (_file: string, args: readonly string[]) => {
      capturedArgs = args;
      throw Object.assign(new Error("gh failed"), { code: 1 });
    };
    await expect(createPrComment(COORDS, "body", { execFile: exec })).rejects.toThrow(GhApiError);
    if (capturedArgs.length > 0) {
      const fieldIdx = capturedArgs.indexOf("--field");
      if (fieldIdx !== -1) {
        const tempFile = capturedArgs[fieldIdx + 1].slice(6);
        const tempDir = tempFile.replace(/\/body\.md$/, "");
        await expect(access(tempDir)).rejects.toThrow();
      }
    }
  });

  it("throws GhApiError on execFile rejection", async () => {
    const exec = async () => { throw Object.assign(new Error("rate limit"), { code: 2 }); };
    await expect(createPrComment(COORDS, "body", { execFile: exec })).rejects.toThrow(GhApiError);
  });
});

describe("updatePrComment", () => {
  it("resolves void on success", async () => {
    const exec = async () => ({ stdout: "{}", stderr: "" });
    await expect(
      updatePrComment({ repo: "owner/repo", commentId: 42 }, "updated body", { execFile: exec })
    ).resolves.toBeUndefined();
  });

  it("passes correct endpoint with commentId", async () => {
    let capturedArgs: readonly string[] = [];
    const exec = async (_file: string, args: readonly string[]) => {
      capturedArgs = args;
      return { stdout: "{}", stderr: "" };
    };
    await updatePrComment({ repo: "owner/repo", commentId: 777 }, "body", { execFile: exec });
    expect(capturedArgs).toContain("repos/owner/repo/issues/comments/777");
  });

  it("uses PATCH method", async () => {
    let capturedArgs: readonly string[] = [];
    const exec = async (_file: string, args: readonly string[]) => {
      capturedArgs = args;
      return { stdout: "{}", stderr: "" };
    };
    await updatePrComment({ repo: "owner/repo", commentId: 1 }, "body", { execFile: exec });
    const methodIdx = capturedArgs.indexOf("--method");
    expect(capturedArgs[methodIdx + 1]).toBe("PATCH");
  });

  it("removes temp dir after success", async () => {
    let capturedArgs: readonly string[] = [];
    const exec = async (_file: string, args: readonly string[]) => {
      capturedArgs = args;
      return { stdout: "{}", stderr: "" };
    };
    await updatePrComment({ repo: "owner/repo", commentId: 1 }, "body", { execFile: exec });
    const fieldIdx = capturedArgs.indexOf("--field");
    const tempFile = capturedArgs[fieldIdx + 1].slice(6);
    const tempDir = tempFile.replace(/\/body\.md$/, "");
    await expect(access(tempDir)).rejects.toThrow();
  });

  it("throws GhApiError on execFile rejection", async () => {
    const exec = async () => { throw Object.assign(new Error("timeout"), { code: 1 }); };
    await expect(
      updatePrComment({ repo: "owner/repo", commentId: 1 }, "body", { execFile: exec })
    ).rejects.toThrow(GhApiError);
  });
});
