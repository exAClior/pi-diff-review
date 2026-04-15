import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { sortFilesForReview } from "./review-order.js";
import type { ChangeStatus, DiffReviewFile } from "./types.js";

interface ChangedPath {
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
}

const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf899d15363da7b23";

const BASE_REF_COMPLETIONS = [
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
] as const;

async function runGit(pi: ExtensionAPI, repoRoot: string, args: string[]): Promise<string> {
  const result = await pi.exec("git", args, { cwd: repoRoot });
  if (result.code !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`;
    throw new Error(message);
  }
  return result.stdout;
}

async function runGitAllowFailure(pi: ExtensionAPI, repoRoot: string, args: string[]): Promise<string> {
  const result = await pi.exec("git", args, { cwd: repoRoot });
  if (result.code !== 0) {
    return "";
  }
  return result.stdout;
}

async function commandSucceeds(pi: ExtensionAPI, repoRoot: string, args: string[]): Promise<boolean> {
  const result = await pi.exec("git", args, { cwd: repoRoot });
  return result.code === 0;
}

export async function getRepoRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
  const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (result.code !== 0) {
    throw new Error("Not inside a git repository.");
  }
  return result.stdout.trim();
}

async function hasHead(pi: ExtensionAPI, repoRoot: string): Promise<boolean> {
  const result = await pi.exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot });
  return result.code === 0;
}

function splitNulRecords(output: string): string[] {
  const records = output.split("\0");
  if (records[records.length - 1] === "") {
    records.pop();
  }
  return records.filter((record) => record.length > 0);
}

function parseNameStatus(output: string): ChangedPath[] {
  const changes: ChangedPath[] = [];

  if (output.includes("\0")) {
    const records = splitNulRecords(output);

    for (let index = 0; index < records.length;) {
      const rawStatus = records[index] ?? "";
      index += 1;
      const code = rawStatus[0];

      if (code === "R") {
        const oldPath = records[index] ?? null;
        const newPath = records[index + 1] ?? null;
        index += 2;
        if (oldPath != null && newPath != null) {
          changes.push({ status: "renamed", oldPath, newPath });
        }
        continue;
      }

      const path = records[index] ?? null;
      index += 1;
      if (path == null) {
        continue;
      }

      if (code === "M") {
        changes.push({ status: "modified", oldPath: path, newPath: path });
        continue;
      }

      if (code === "A") {
        changes.push({ status: "added", oldPath: null, newPath: path });
        continue;
      }

      if (code === "D") {
        changes.push({ status: "deleted", oldPath: path, newPath: null });
      }
    }

    return changes;
  }

  const lines = output.split(/\r?\n/).filter((line) => line.length > 0);

  for (const line of lines) {
    const parts = line.split("\t");
    const rawStatus = parts[0] ?? "";
    const code = rawStatus[0];

    if (code === "R") {
      const oldPath = parts[1] ?? null;
      const newPath = parts[2] ?? null;
      if (oldPath != null && newPath != null) {
        changes.push({ status: "renamed", oldPath, newPath });
      }
      continue;
    }

    const path = parts[1] ?? null;
    if (path == null) {
      continue;
    }

    if (code === "M") {
      changes.push({ status: "modified", oldPath: path, newPath: path });
      continue;
    }

    if (code === "A") {
      changes.push({ status: "added", oldPath: null, newPath: path });
      continue;
    }

    if (code === "D") {
      changes.push({ status: "deleted", oldPath: path, newPath: null });
    }
  }

  return changes;
}

async function getRefContent(pi: ExtensionAPI, repoRoot: string, ref: string, path: string): Promise<string> {
  const result = await pi.exec("git", ["show", `${ref}:${path}`], { cwd: repoRoot });
  if (result.code !== 0) {
    return "";
  }
  return result.stdout;
}

async function getWorkingTreeContent(repoRoot: string, path: string): Promise<string> {
  try {
    return await readFile(join(repoRoot, path), "utf8");
  } catch {
    return "";
  }
}

function parseUntrackedPaths(output: string): ChangedPath[] {
  const paths = output.includes("\0") ? splitNulRecords(output) : output.split(/\r?\n/).filter((line) => line.length > 0);

  return paths.map((path) => ({
    status: "added" as const,
    oldPath: null,
    newPath: path,
  }));
}

function parseTrackedPaths(output: string): ChangedPath[] {
  return parseUntrackedPaths(output);
}

function mergeChangedPaths(tracked: ChangedPath[], untracked: ChangedPath[]): ChangedPath[] {
  const seen = new Set(tracked.map((change) => `${change.status}:${change.oldPath ?? ""}:${change.newPath ?? ""}`));
  const merged = [...tracked];

  for (const change of untracked) {
    const key = `${change.status}:${change.oldPath ?? ""}:${change.newPath ?? ""}`;
    if (seen.has(key)) continue;
    merged.push(change);
    seen.add(key);
  }

  return merged;
}

function toDisplayPath(change: ChangedPath): string {
  if (change.status === "renamed") {
    return `${change.oldPath ?? ""} -> ${change.newPath ?? ""}`;
  }
  return change.newPath ?? change.oldPath ?? "(unknown)";
}

function toTreePath(change: ChangedPath): string {
  return change.newPath ?? change.oldPath ?? "(unknown)";
}

function toDiffReviewFile(change: ChangedPath, index: number, oldContent: string, newContent: string): DiffReviewFile {
  return {
    id: `${index}:${change.status}:${change.oldPath ?? ""}:${change.newPath ?? ""}`,
    status: change.status,
    oldPath: change.oldPath,
    newPath: change.newPath,
    displayPath: toDisplayPath(change),
    treePath: toTreePath(change),
    oldContent,
    newContent,
    hunkExplanations: [],
  };
}

async function materializeDiffReviewFiles(
  changedPaths: ChangedPath[],
  readOldContent: (change: ChangedPath) => Promise<string>,
  readNewContent: (change: ChangedPath) => Promise<string>,
): Promise<DiffReviewFile[]> {
  const files = await Promise.all(
    changedPaths.map(async (change, index) => {
      const oldContent = change.oldPath == null ? "" : await readOldContent(change);
      const newContent = change.newPath == null ? "" : await readNewContent(change);
      return toDiffReviewFile(change, index, oldContent, newContent);
    }),
  );

  return sortFilesForReview(files);
}

function parseRemoteNames(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function getRemoteNameFromRef(ref: string | null): string | null {
  if (ref == null) {
    return null;
  }

  const slashIndex = ref.indexOf("/");
  if (slashIndex <= 0) {
    return null;
  }

  return ref.slice(0, slashIndex);
}

async function refExists(pi: ExtensionAPI, repoRoot: string, ref: string): Promise<boolean> {
  const output = await runGitAllowFailure(pi, repoRoot, ["rev-parse", "--verify", ref]);
  return output.trim().length > 0;
}

async function getUpstreamRef(pi: ExtensionAPI, repoRoot: string): Promise<string | null> {
  const output = await runGitAllowFailure(pi, repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const ref = output.trim();
  return ref.length > 0 ? ref : null;
}

async function listRemoteNames(pi: ExtensionAPI, repoRoot: string): Promise<string[]> {
  return parseRemoteNames(await runGitAllowFailure(pi, repoRoot, ["remote"]));
}

async function getRemoteHeadRef(pi: ExtensionAPI, repoRoot: string, remote: string): Promise<string | null> {
  const output = await runGitAllowFailure(pi, repoRoot, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]);
  const ref = output.trim();
  return ref.length > 0 ? ref : null;
}

async function getRemoteDefaultBranch(pi: ExtensionAPI, repoRoot: string, remote: string): Promise<string | null> {
  const remoteHead = await getRemoteHeadRef(pi, repoRoot, remote);
  if (remoteHead != null) {
    return remoteHead;
  }

  for (const candidate of [`${remote}/main`, `${remote}/master`]) {
    if (await refExists(pi, repoRoot, candidate)) {
      return candidate;
    }
  }

  return null;
}

async function getDefaultRemoteBranch(pi: ExtensionAPI, repoRoot: string): Promise<string> {
  const upstreamRemote = getRemoteNameFromRef(await getUpstreamRef(pi, repoRoot));
  const remotes = [upstreamRemote, "origin", ...(await listRemoteNames(pi, repoRoot))].filter(
    (remote, index, values): remote is string => remote != null && values.indexOf(remote) === index,
  );

  for (const remote of remotes) {
    const candidate = await getRemoteDefaultBranch(pi, repoRoot, remote);
    if (candidate != null) {
      return candidate;
    }
  }

  return "HEAD";
}

function parseRecentCommits(output: string): Array<{ sha: string; title: string }> {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha = "", ...rest] = line.split(/\s+/);
      return {
        sha,
        title: rest.join(" "),
      };
    })
    .filter((commit) => commit.sha.length > 0);
}

function parseParents(output: string): string[] {
  const [line = ""] = output.split(/\r?\n/);
  const tokens = line.trim().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length <= 1) {
    return [];
  }
  return tokens.slice(1);
}

async function getMergeBaseInRepo(pi: ExtensionAPI, repoRoot: string, ref: string, target = "HEAD"): Promise<string | null> {
  const mergeBaseOutput = await runGitAllowFailure(pi, repoRoot, ["merge-base", ref, target]);
  const mergeBase = mergeBaseOutput.trim();
  return mergeBase.length > 0 ? mergeBase : null;
}

export async function getMergeBase(pi: ExtensionAPI, cwd: string, ref: string, target = "HEAD"): Promise<string | null> {
  const repoRoot = await getRepoRoot(pi, cwd);
  return await getMergeBaseInRepo(pi, repoRoot, ref, target);
}

async function getLocalBranchesInRepo(pi: ExtensionAPI, repoRoot: string): Promise<string[]> {
  const output = await runGitAllowFailure(pi, repoRoot, ["branch", "--format=%(refname:short)"]);
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function getCurrentBranchInRepo(pi: ExtensionAPI, repoRoot: string): Promise<string | null> {
  const output = await runGitAllowFailure(pi, repoRoot, ["branch", "--show-current"]);
  const branch = output.trim();
  return branch.length > 0 ? branch : null;
}

async function getDefaultBranchInRepo(pi: ExtensionAPI, repoRoot: string): Promise<string> {
  const defaultRemoteBranch = await getDefaultRemoteBranch(pi, repoRoot);
  if (defaultRemoteBranch !== "HEAD") {
    const remoteName = getRemoteNameFromRef(defaultRemoteBranch);
    if (remoteName != null) {
      return defaultRemoteBranch.slice(remoteName.length + 1);
    }
  }

  const branches = await getLocalBranchesInRepo(pi, repoRoot);
  if (branches.includes("main")) return "main";
  if (branches.includes("master")) return "master";
  return (await getCurrentBranchInRepo(pi, repoRoot)) ?? "main";
}

export async function getLocalBranches(pi: ExtensionAPI, cwd: string): Promise<string[]> {
  const repoRoot = await getRepoRoot(pi, cwd);
  return await getLocalBranchesInRepo(pi, repoRoot);
}

export async function getRecentCommits(pi: ExtensionAPI, cwd: string, limit = 20): Promise<Array<{ sha: string; title: string }>> {
  const repoRoot = await getRepoRoot(pi, cwd);
  const output = await runGitAllowFailure(pi, repoRoot, ["log", "--oneline", `-n`, String(limit)]);
  return parseRecentCommits(output);
}

export async function getCurrentBranch(pi: ExtensionAPI, cwd: string): Promise<string | null> {
  const repoRoot = await getRepoRoot(pi, cwd);
  return await getCurrentBranchInRepo(pi, repoRoot);
}

export async function getDefaultBranch(pi: ExtensionAPI, cwd: string): Promise<string> {
  const repoRoot = await getRepoRoot(pi, cwd);
  return await getDefaultBranchInRepo(pi, repoRoot);
}

async function hasNamedRef(pi: ExtensionAPI, repoRoot: string, ref: string): Promise<boolean> {
  const candidates = [`refs/heads/${ref}`, `refs/tags/${ref}`, `refs/remotes/${ref}`];

  for (const candidate of candidates) {
    if (await commandSucceeds(pi, repoRoot, ["show-ref", "--verify", "--quiet", candidate])) {
      return true;
    }
  }

  return false;
}

export async function isCommitOnlyRef(pi: ExtensionAPI, cwd: string, ref: string): Promise<boolean> {
  const trimmed = ref.trim();
  if (trimmed.length === 0 || trimmed === "HEAD" || trimmed === "main" || trimmed === "current") {
    return false;
  }

  const repoRoot = await getRepoRoot(pi, cwd);
  if (await hasNamedRef(pi, repoRoot, trimmed)) {
    return false;
  }

  return await commandSucceeds(pi, repoRoot, ["rev-parse", "--verify", `${trimmed}^{commit}`]);
}

export async function hasUncommittedChanges(pi: ExtensionAPI, cwd: string): Promise<boolean> {
  const repoRoot = await getRepoRoot(pi, cwd);
  const output = await runGitAllowFailure(pi, repoRoot, ["status", "--porcelain"]);
  return output.trim().length > 0;
}

export async function resolveBaseRef(pi: ExtensionAPI, cwd: string, arg: string): Promise<string> {
  const repoRoot = await getRepoRoot(pi, cwd);
  const trimmed = arg.trim();
  if (trimmed.length === 0 || trimmed === "main") {
    return await getDefaultRemoteBranch(pi, repoRoot);
  }
  if (trimmed === "current") {
    return (await getUpstreamRef(pi, repoRoot)) ?? "HEAD";
  }
  return trimmed;
}

export function getBaseRefCompletions(prefix: string): { value: string; label: string; description: string }[] {
  return BASE_REF_COMPLETIONS.filter((item) => item.value.startsWith(prefix));
}

export async function getDiffReviewFiles(pi: ExtensionAPI, cwd: string, baseRef?: string): Promise<{ repoRoot: string; files: DiffReviewFile[] }> {
  const repoRoot = await getRepoRoot(pi, cwd);

  const ref = baseRef ?? await getDefaultRemoteBranch(pi, repoRoot);
  const isHead = ref === "HEAD";

  const repositoryHasHead = await hasHead(pi, repoRoot);

  let diffBase: string;
  if (!repositoryHasHead) {
    diffBase = "";
  } else if (isHead) {
    diffBase = "HEAD";
  } else {
    diffBase = (await getMergeBaseInRepo(pi, repoRoot, ref, "HEAD")) ?? ref;
  }

  const trackedOutput = diffBase.length > 0
    ? await runGit(pi, repoRoot, ["diff", "--find-renames", "-M", "--name-status", "-z", diffBase, "--"])
    : await runGitAllowFailure(pi, repoRoot, ["ls-files", "-z"]);
  const untrackedOutput = await runGitAllowFailure(pi, repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);

  const trackedPaths = diffBase.length > 0 ? parseNameStatus(trackedOutput) : parseTrackedPaths(trackedOutput);
  const untrackedPaths = parseUntrackedPaths(untrackedOutput);
  const changedPaths = mergeChangedPaths(trackedPaths, untrackedPaths);

  const files = await materializeDiffReviewFiles(
    changedPaths,
    async (change) => await getRefContent(pi, repoRoot, diffBase || "HEAD", change.oldPath ?? ""),
    async (change) => await getWorkingTreeContent(repoRoot, change.newPath ?? ""),
  );

  return { repoRoot, files };
}

export async function getDiffReviewFilesForCommit(
  pi: ExtensionAPI,
  cwd: string,
  sha: string,
): Promise<{ repoRoot: string; files: DiffReviewFile[] }> {
  const repoRoot = await getRepoRoot(pi, cwd);
  await runGit(pi, repoRoot, ["rev-parse", "--verify", sha]);

  const parents = parseParents(await runGit(pi, repoRoot, ["rev-list", "--parents", "-n", "1", sha]));
  const parentRef = parents[0] ?? EMPTY_TREE_SHA;
  const isRootCommit = parents.length === 0;

  const trackedOutput = await runGit(pi, repoRoot, ["diff", "--find-renames", "-M", "--name-status", "-z", parentRef, sha, "--"]);
  const changedPaths = parseNameStatus(trackedOutput);

  const files = await materializeDiffReviewFiles(
    changedPaths,
    async (change) => {
      if (isRootCommit) {
        return "";
      }
      return await getRefContent(pi, repoRoot, parentRef, change.oldPath ?? "");
    },
    async (change) => await getRefContent(pi, repoRoot, sha, change.newPath ?? ""),
  );

  return { repoRoot, files };
}
