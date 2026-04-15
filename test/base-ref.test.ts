import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getBaseRefCompletions, getDiffReviewFiles, getDiffReviewFilesForCommit, isCommitOnlyRef, resolveBaseRef } from "../src/git.js";

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

test("isCommitOnlyRef rejects named refs even when they look like SHAs", async () => {
  const repoRoot = "/repo";
  const ref = "abc1234";
  const { pi } = createGitPi({
    [key(["rev-parse", "--show-toplevel"])]: ok(`${repoRoot}\n`),
    [key(["show-ref", "--verify", "--quiet", `refs/heads/${ref}`])]: ok(""),
  });

  assert.equal(await isCommitOnlyRef(pi, repoRoot, ref), false);
});

test("isCommitOnlyRef flags commit-only bare refs", async () => {
  const repoRoot = "/repo";
  const ref = "abc1234";
  const { pi } = createGitPi({
    [key(["rev-parse", "--show-toplevel"])]: ok(`${repoRoot}\n`),
    [key(["show-ref", "--verify", "--quiet", `refs/heads/${ref}`])]: fail(""),
    [key(["show-ref", "--verify", "--quiet", `refs/tags/${ref}`])]: fail(""),
    [key(["show-ref", "--verify", "--quiet", `refs/remotes/${ref}`])]: fail(""),
    [key(["rev-parse", "--verify", `${ref}^{commit}`])]: ok(`${ref}\n`),
  });

  assert.equal(await isCommitOnlyRef(pi, repoRoot, ref), true);
});

test("isCommitOnlyRef flags commit expressions like HEAD~1", async () => {
  const repoRoot = "/repo";
  const ref = "HEAD~1";
  const { pi } = createGitPi({
    [key(["rev-parse", "--show-toplevel"])]: ok(`${repoRoot}\n`),
    [key(["show-ref", "--verify", "--quiet", `refs/heads/${ref}`])]: fail(""),
    [key(["show-ref", "--verify", "--quiet", `refs/tags/${ref}`])]: fail(""),
    [key(["show-ref", "--verify", "--quiet", `refs/remotes/${ref}`])]: fail(""),
    [key(["rev-parse", "--verify", `${ref}^{commit}`])]: ok("parent-sha\n"),
  });

  assert.equal(await isCommitOnlyRef(pi, repoRoot, ref), true);
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

test("getDiffReviewFiles includes tracked files before the first commit", async (t) => {
  const repoRoot = await mkdtemp(join(tmpdir(), "pi-diff-review-"));
  const trackedPath = "src/first.ts";
  const untrackedPath = "src/second.ts";

  t.after(async () => {
    await rm(repoRoot, { force: true, recursive: true });
  });

  await mkdir(join(repoRoot, dirname(trackedPath)), { recursive: true });
  await writeFile(join(repoRoot, trackedPath), "tracked file\n", "utf8");
  await writeFile(join(repoRoot, untrackedPath), "untracked file\n", "utf8");

  const { pi } = createGitPi({
    [key(["rev-parse", "--show-toplevel"])]: ok(`${repoRoot}\n`),
    [key(["rev-parse", "--verify", "HEAD"])]: fail("unknown revision"),
    [key(["ls-files", "-z"])]: ok(`${trackedPath}\0`),
    [key(["ls-files", "--others", "--exclude-standard", "-z"])]: ok(`${untrackedPath}\0`),
  });

  const { files } = await getDiffReviewFiles(pi, repoRoot, "HEAD");

  assert.deepEqual(files.map((file) => ({ path: file.treePath, oldContent: file.oldContent, newContent: file.newContent })), [
    { path: trackedPath, oldContent: "", newContent: "tracked file\n" },
    { path: untrackedPath, oldContent: "", newContent: "untracked file\n" },
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

test("getDiffReviewFilesForCommit materializes both sides from git objects", async () => {
  const repoRoot = "/repo";
  const sha = "abc123";
  const parent = "def456";
  const { pi } = createGitPi({
    [key(["rev-parse", "--show-toplevel"])]: ok(`${repoRoot}\n`),
    [key(["rev-parse", "--verify", sha])]: ok(`${sha}\n`),
    [key(["rev-list", "--parents", "-n", "1", sha])]: ok(`${sha} ${parent}\n`),
    [key(["diff", "--find-renames", "-M", "--name-status", "-z", parent, sha, "--"])]: ok("M\0src/example.ts\0R100\0src/old.ts\0src/new.ts\0D\0src/deleted.ts\0A\0src/added.ts\0"),
    [key(["show", `${parent}:src/example.ts`])]: ok("old example\n"),
    [key(["show", `${sha}:src/example.ts`])]: ok("new example\n"),
    [key(["show", `${parent}:src/old.ts`])]: ok("old renamed\n"),
    [key(["show", `${sha}:src/new.ts`])]: ok("new renamed\n"),
    [key(["show", `${parent}:src/deleted.ts`])]: ok("deleted old\n"),
    [key(["show", `${sha}:src/added.ts`])]: ok("added new\n"),
  });

  const { repoRoot: resolvedRepoRoot, files } = await getDiffReviewFilesForCommit(pi, repoRoot, sha);

  assert.equal(resolvedRepoRoot, repoRoot);
  assert.deepEqual(files, [
    {
      id: "3:added::src/added.ts",
      status: "added",
      oldPath: null,
      newPath: "src/added.ts",
      displayPath: "src/added.ts",
      treePath: "src/added.ts",
      oldContent: "",
      newContent: "added new\n",
      hunkExplanations: [],
    },
    {
      id: "2:deleted:src/deleted.ts:",
      status: "deleted",
      oldPath: "src/deleted.ts",
      newPath: null,
      displayPath: "src/deleted.ts",
      treePath: "src/deleted.ts",
      oldContent: "deleted old\n",
      newContent: "",
      hunkExplanations: [],
    },
    {
      id: "0:modified:src/example.ts:src/example.ts",
      status: "modified",
      oldPath: "src/example.ts",
      newPath: "src/example.ts",
      displayPath: "src/example.ts",
      treePath: "src/example.ts",
      oldContent: "old example\n",
      newContent: "new example\n",
      hunkExplanations: [],
    },
    {
      id: "1:renamed:src/old.ts:src/new.ts",
      status: "renamed",
      oldPath: "src/old.ts",
      newPath: "src/new.ts",
      displayPath: "src/old.ts -> src/new.ts",
      treePath: "src/new.ts",
      oldContent: "old renamed\n",
      newContent: "new renamed\n",
      hunkExplanations: [],
    },
  ]);
});

test("getDiffReviewFilesForCommit uses the empty tree for root commits", async () => {
  const repoRoot = "/repo";
  const sha = "root123";
  const emptyTree = "4b825dc642cb6eb9a060e54bf899d15363da7b23";
  const { pi, calls } = createGitPi({
    [key(["rev-parse", "--show-toplevel"])]: ok(`${repoRoot}\n`),
    [key(["rev-parse", "--verify", sha])]: ok(`${sha}\n`),
    [key(["rev-list", "--parents", "-n", "1", sha])]: ok(`${sha}\n`),
    [key(["diff", "--find-renames", "-M", "--name-status", "-z", emptyTree, sha, "--"])]: ok("A\0src/first.ts\0"),
    [key(["show", `${sha}:src/first.ts`])]: ok("first file\n"),
  });

  const { files } = await getDiffReviewFilesForCommit(pi, repoRoot, sha);

  assert.deepEqual(files, [
    {
      id: "0:added::src/first.ts",
      status: "added",
      oldPath: null,
      newPath: "src/first.ts",
      displayPath: "src/first.ts",
      treePath: "src/first.ts",
      oldContent: "",
      newContent: "first file\n",
      hunkExplanations: [],
    },
  ]);
  assert.deepEqual(calls, [
    ["rev-parse", "--show-toplevel"],
    ["rev-parse", "--verify", sha],
    ["rev-list", "--parents", "-n", "1", sha],
    ["diff", "--find-renames", "-M", "--name-status", "-z", emptyTree, sha, "--"],
    ["show", `${sha}:src/first.ts`],
  ]);
});

test("getDiffReviewFilesForCommit diffs merge commits against the first parent", async () => {
  const repoRoot = "/repo";
  const sha = "merge123";
  const firstParent = "parent-a";
  const secondParent = "parent-b";
  const { pi, calls } = createGitPi({
    [key(["rev-parse", "--show-toplevel"])]: ok(`${repoRoot}\n`),
    [key(["rev-parse", "--verify", sha])]: ok(`${sha}\n`),
    [key(["rev-list", "--parents", "-n", "1", sha])]: ok(`${sha} ${firstParent} ${secondParent}\n`),
    [key(["diff", "--find-renames", "-M", "--name-status", "-z", firstParent, sha, "--"])]: ok("M\0src/example.ts\0"),
    [key(["show", `${firstParent}:src/example.ts`])]: ok("first parent\n"),
    [key(["show", `${sha}:src/example.ts`])]: ok("merge result\n"),
  });

  const { files } = await getDiffReviewFilesForCommit(pi, repoRoot, sha);

  assert.equal(files[0]?.oldContent, "first parent\n");
  assert.equal(files[0]?.newContent, "merge result\n");
  assert.deepEqual(calls.slice(0, 4), [
    ["rev-parse", "--show-toplevel"],
    ["rev-parse", "--verify", sha],
    ["rev-list", "--parents", "-n", "1", sha],
    ["diff", "--find-renames", "-M", "--name-status", "-z", firstParent, sha, "--"],
  ]);
});

test("getDiffReviewFilesForCommit keeps binary files with empty content when git show fails", async () => {
  const repoRoot = "/repo";
  const sha = "abc123";
  const parent = "def456";
  const { pi } = createGitPi({
    [key(["rev-parse", "--show-toplevel"])]: ok(`${repoRoot}\n`),
    [key(["rev-parse", "--verify", sha])]: ok(`${sha}\n`),
    [key(["rev-list", "--parents", "-n", "1", sha])]: ok(`${sha} ${parent}\n`),
    [key(["diff", "--find-renames", "-M", "--name-status", "-z", parent, sha, "--"])]: ok("M\0assets/logo.png\0"),
    [key(["show", `${parent}:assets/logo.png`])]: fail("binary"),
    [key(["show", `${sha}:assets/logo.png`])]: fail("binary"),
  });

  const { files } = await getDiffReviewFilesForCommit(pi, repoRoot, sha);

  assert.deepEqual(files, [
    {
      id: "0:modified:assets/logo.png:assets/logo.png",
      status: "modified",
      oldPath: "assets/logo.png",
      newPath: "assets/logo.png",
      displayPath: "assets/logo.png",
      treePath: "assets/logo.png",
      oldContent: "",
      newContent: "",
      hunkExplanations: [],
    },
  ]);
});

test("getDiffReviewFilesForCommit returns an empty file list for empty commits", async () => {
  const repoRoot = "/repo";
  const sha = "empty123";
  const parent = "def456";
  const { pi } = createGitPi({
    [key(["rev-parse", "--show-toplevel"])]: ok(`${repoRoot}\n`),
    [key(["rev-parse", "--verify", sha])]: ok(`${sha}\n`),
    [key(["rev-list", "--parents", "-n", "1", sha])]: ok(`${sha} ${parent}\n`),
    [key(["diff", "--find-renames", "-M", "--name-status", "-z", parent, sha, "--"])]: ok(""),
  });

  const { files } = await getDiffReviewFilesForCommit(pi, repoRoot, sha);
  assert.deepEqual(files, []);
});

test("getDiffReviewFilesForCommit propagates invalid commit errors", async () => {
  const repoRoot = "/repo";
  const sha = "badsha";
  const { pi } = createGitPi({
    [key(["rev-parse", "--show-toplevel"])]: ok(`${repoRoot}\n`),
    [key(["rev-parse", "--verify", sha])]: fail("unknown revision"),
  });

  await assert.rejects(() => getDiffReviewFilesForCommit(pi, repoRoot, sha), /unknown revision/);
});
