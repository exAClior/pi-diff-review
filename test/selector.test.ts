import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getSmartDefault } from "../src/selector.js";

type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
};

function key(args: string[]): string {
  return args.join("\u0000");
}

function ok(stdout = ""): ExecResult {
  return { code: 0, stdout, stderr: "" };
}

function createGitPi(responses: Record<string, ExecResult>): ExtensionAPI {
  return {
    async exec(command: string, args: string[]) {
      assert.equal(command, "git");
      const response = responses[key(args)];
      if (response == null) {
        throw new Error(`Unexpected git ${args.join(" ")}`);
      }
      return response;
    },
  } as unknown as ExtensionAPI;
}

test("getSmartDefault prefers uncommitted changes", async () => {
  const repoRoot = "/repo";
  const pi = createGitPi({
    [key(["rev-parse", "--show-toplevel"])]: ok(`${repoRoot}\n`),
    [key(["status", "--porcelain"])]: ok(" M src/example.ts\n"),
  });

  assert.equal(await getSmartDefault(pi, repoRoot), "uncommitted");
});

test("getSmartDefault prefers base-branch review on feature branches", async () => {
  const repoRoot = "/repo";
  const pi = createGitPi({
    [key(["rev-parse", "--show-toplevel"])]: ok(`${repoRoot}\n`),
    [key(["status", "--porcelain"])]: ok(""),
    [key(["branch", "--show-current"])]: ok("feature/login\n"),
    [key(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])]: ok(""),
    [key(["remote"])]: ok("origin\n"),
    [key(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])]: ok("origin/main\n"),
  });

  assert.equal(await getSmartDefault(pi, repoRoot), "baseBranch");
});

test("getSmartDefault falls back to commit review on the default branch", async () => {
  const repoRoot = "/repo";
  const pi = createGitPi({
    [key(["rev-parse", "--show-toplevel"])]: ok(`${repoRoot}\n`),
    [key(["status", "--porcelain"])]: ok(""),
    [key(["branch", "--show-current"])]: ok("main\n"),
    [key(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])]: ok(""),
    [key(["remote"])]: ok("origin\n"),
    [key(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])]: ok("origin/main\n"),
  });

  assert.equal(await getSmartDefault(pi, repoRoot), "commit");
});
