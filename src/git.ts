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

function parseNameStatus(output: string): ChangedPath[] {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const changes: ChangedPath[] = [];

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

    if (code === "M") {
      const path = parts[1] ?? null;
      if (path != null) {
        changes.push({ status: "modified", oldPath: path, newPath: path });
      }
      continue;
    }

    if (code === "A") {
      const path = parts[1] ?? null;
      if (path != null) {
        changes.push({ status: "added", oldPath: null, newPath: path });
      }
      continue;
    }

    if (code === "D") {
      const path = parts[1] ?? null;
      if (path != null) {
        changes.push({ status: "deleted", oldPath: path, newPath: null });
      }
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
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((path) => ({
      status: "added" as const,
      oldPath: null,
      newPath: path,
    }));
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

  // When diffing against a remote ref, we need the merge-base to get a clean diff
  let diffBase: string;
  if (!repositoryHasHead) {
    diffBase = "";
  } else if (isHead) {
    diffBase = "HEAD";
  } else {
    const mergeBaseOutput = await runGitAllowFailure(pi, repoRoot, ["merge-base", ref, "HEAD"]);
    diffBase = mergeBaseOutput.trim() || ref;
  }

  const trackedOutput = diffBase.length > 0
    ? await runGit(pi, repoRoot, ["diff", "--find-renames", "-M", "--name-status", diffBase, "--"])
    : "";
  const untrackedOutput = await runGitAllowFailure(pi, repoRoot, ["ls-files", "--others", "--exclude-standard"]);

  const trackedPaths = parseNameStatus(trackedOutput);
  const untrackedPaths = parseUntrackedPaths(untrackedOutput);
  const changedPaths = mergeChangedPaths(trackedPaths, untrackedPaths);

  const files = await Promise.all(
    changedPaths.map(async (change, index): Promise<DiffReviewFile> => {
      const oldContent = change.oldPath == null ? "" : await getRefContent(pi, repoRoot, diffBase || "HEAD", change.oldPath);
      const newContent = change.newPath == null ? "" : await getWorkingTreeContent(repoRoot, change.newPath);
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
    }),
  );

  return { repoRoot, files: sortFilesForReview(files) };
}
