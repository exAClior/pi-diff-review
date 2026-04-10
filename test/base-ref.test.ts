import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getBaseRefCompletions, getDiffReviewFiles, resolveBaseRef } from "../src/git.js";

type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type ExecResponse = ExecResult | ((args: string[]) => ExecResult | Promise<ExecResult>);

function key(args: string[]): string {
  return args.join("\u0000");
}

function ok(stdout = ""): ExecResult {
  return { code: 0, stdout, stderr: "" };
}

function fail(stderr = ""): ExecResult {
  return { code: 1, stdout: "", stderr };
}

function createGitPi(responses: Record<string, ExecResponse>): { pi: ExtensionAPI; calls: string[][] } {
  const calls: string[][] = [];

  const pi = {
    async exec(command: string, args: string[]) {
      assert.equal(command, "git");
      calls.push(args);

      const response = responses[key(args)];
      if (response == null) {
        throw new Error(`Unexpected git ${args.join(" ")}`);
      }

      return typeof response === "function" ? await response(args) : response;
    },
  } as unknown as ExtensionAPI;

  return { pi, calls };
}

test("resolveBaseRef uses the upstream remote's symbolic HEAD for main", async () => {
  const repoRoot = "/repo";
  const { pi } = createGitPi({
    [key(["rev-parse", "--show-toplevel"])]: ok(`${repoRoot}\n`),
    [key(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])]: ok("fork/feature\n"),
    [key(["remote"])]: ok("fork\norigin\n"),
    [key(["symbolic-ref", "--quiet", "--short", "refs/remotes/fork/HEAD"])]: ok("fork/trunk\n"),
  });

  assert.equal(await resolveBaseRef(pi, repoRoot, "main"), "fork/trunk");
});

test("resolveBaseRef falls back to HEAD for current when no upstream is configured", async () => {
  const repoRoot = "/repo";
  const { pi } = createGitPi({
    [key(["rev-parse", "--show-toplevel"])]: ok(`${repoRoot}\n`),
    [key(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])]: fail("no upstream"),
  });

  assert.equal(await resolveBaseRef(pi, repoRoot, "current"), "HEAD");
});

test("getBaseRefCompletions always offers main and current", () => {
  assert.deepEqual(getBaseRefCompletions(""), [
    {
      value: "main",
      label: "main",
      description: "Compare against the remote default branch (falls back to HEAD if unavailable)",
    },
    {
      value: "current",
      label: "current",
      description: "Compare against the current branch upstream (falls back to HEAD if unavailable)",
    },
  ]);

  assert.deepEqual(getBaseRefCompletions("cu"), [
    {
      value: "current",
      label: "current",
      description: "Compare against the current branch upstream (falls back to HEAD if unavailable)",
    },
  ]);
});

test("getDiffReviewFiles defaults to the remote default branch when no base ref is provided", async () => {
  const repoRoot = "/repo";
  const { pi, calls } = createGitPi({
    [key(["rev-parse", "--show-toplevel"])]: ok(`${repoRoot}\n`),
    [key(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])]: fail("no upstream"),
    [key(["remote"])]: ok("origin\n"),
    [key(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])]: ok("origin/main\n"),
    [key(["rev-parse", "--verify", "HEAD"])]: ok("head-sha\n"),
    [key(["merge-base", "origin/main", "HEAD"])]: ok("base-sha\n"),
    [key(["diff", "--find-renames", "-M", "--name-status", "-z", "base-sha", "--"])]: ok("D\0src/example.ts\0"),
    [key(["ls-files", "--others", "--exclude-standard", "-z"])]: ok(""),
    [key(["show", "base-sha:src/example.ts"])]: ok("old file\n"),
  });

  const { repoRoot: resolvedRepoRoot, files } = await getDiffReviewFiles(pi, repoRoot);

  assert.equal(resolvedRepoRoot, repoRoot);
  assert.deepEqual(files, [
    {
      id: "0:deleted:src/example.ts:",
      status: "deleted",
      oldPath: "src/example.ts",
      newPath: null,
      displayPath: "src/example.ts",
      treePath: "src/example.ts",
      oldContent: "old file\n",
      newContent: "",
      hunkExplanations: [],
    },
  ]);
  assert.deepEqual(calls, [
    ["rev-parse", "--show-toplevel"],
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    ["remote"],
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    ["rev-parse", "--verify", "HEAD"],
    ["merge-base", "origin/main", "HEAD"],
    ["diff", "--find-renames", "-M", "--name-status", "-z", "base-sha", "--"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
    ["show", "base-sha:src/example.ts"],
  ]);
});

test("getDiffReviewFiles preserves unusual paths from NUL-delimited git output", async () => {
  const repoRoot = "/repo";
  const weirdPath = "src/weird\tname.ts";
  const { pi } = createGitPi({
    [key(["rev-parse", "--show-toplevel"])]: ok(`${repoRoot}\n`),
    [key(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])]: fail("no upstream"),
    [key(["remote"])]: ok("origin\n"),
    [key(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])]: ok("origin/main\n"),
    [key(["rev-parse", "--verify", "HEAD"])]: ok("head-sha\n"),
    [key(["merge-base", "origin/main", "HEAD"])]: ok("base-sha\n"),
    [key(["diff", "--find-renames", "-M", "--name-status", "-z", "base-sha", "--"])]: ok(`D\0${weirdPath}\0`),
    [key(["ls-files", "--others", "--exclude-standard", "-z"])]: ok(""),
    [key(["show", `base-sha:${weirdPath}`])]: ok("old file\n"),
  });

  const { files } = await getDiffReviewFiles(pi, repoRoot);

  assert.deepEqual(files, [
    {
      id: `0:deleted:${weirdPath}:`,
      status: "deleted",
      oldPath: weirdPath,
      newPath: null,
      displayPath: weirdPath,
      treePath: weirdPath,
      oldContent: "old file\n",
      newContent: "",
      hunkExplanations: [],
    },
  ]);
});

test("getDiffReviewFiles preserves renamed paths from NUL-delimited git output", async (t) => {
  const repoRoot = await mkdtemp(join(tmpdir(), "pi-diff-review-"));
  const oldPath = "src/old\tname.ts";
  const newPath = "src/new\tname.ts";

  t.after(async () => {
    await rm(repoRoot, { force: true, recursive: true });
  });

  await mkdir(join(repoRoot, dirname(newPath)), { recursive: true });
  await writeFile(join(repoRoot, newPath), "new file\n", "utf8");

  const { pi } = createGitPi({
    [key(["rev-parse", "--show-toplevel"])]: ok(`${repoRoot}\n`),
    [key(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])]: fail("no upstream"),
    [key(["remote"])]: ok("origin\n"),
    [key(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])]: ok("origin/main\n"),
    [key(["rev-parse", "--verify", "HEAD"])]: ok("head-sha\n"),
    [key(["merge-base", "origin/main", "HEAD"])]: ok("base-sha\n"),
    [key(["diff", "--find-renames", "-M", "--name-status", "-z", "base-sha", "--"])]: ok(`R100\0${oldPath}\0${newPath}\0`),
    [key(["ls-files", "--others", "--exclude-standard", "-z"])]: ok(""),
    [key(["show", `base-sha:${oldPath}`])]: ok("old file\n"),
  });

  const { files } = await getDiffReviewFiles(pi, repoRoot);

  assert.deepEqual(files, [
    {
      id: `0:renamed:${oldPath}:${newPath}`,
      status: "renamed",
      oldPath,
      newPath,
      displayPath: `${oldPath} -> ${newPath}`,
      treePath: newPath,
      oldContent: "old file\n",
      newContent: "new file\n",
      hunkExplanations: [],
    },
  ]);
});
