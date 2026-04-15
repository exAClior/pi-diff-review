import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { DiffReviewFile, ReviewCommentSide } from "./types.js";

export interface DiffHunkSeed {
  fileId: string;
  hunkIndex: number;
  anchorSide: ReviewCommentSide;
  anchorLine: number;
  oldStartLine: number | null;
  oldEndLine: number | null;
  newStartLine: number | null;
  newEndLine: number | null;
  patchText: string;
}

export interface FilePatchResult {
  file: DiffReviewFile;
  patchText: string;
  hunks: DiffHunkSeed[];
  error: string | null;
}

const HUNK_HEADER_REGEX = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function toLineRange(startLine: number, lineCount: number): { startLine: number | null; endLine: number | null } {
  if (lineCount <= 0) {
    return {
      startLine: null,
      endLine: null,
    };
  }

  return {
    startLine,
    endLine: startLine + lineCount - 1,
  };
}

function findHunkAnchor(
  oldStartLine: number,
  newStartLine: number,
  hunkBody: string[],
): { anchorSide: ReviewCommentSide; anchorLine: number } {
  let oldLine = oldStartLine;
  let newLine = newStartLine;
  let firstDeletionLine: number | null = null;
  let firstAdditionLine: number | null = null;

  for (const line of hunkBody) {
    if (line.startsWith("+")) {
      firstAdditionLine ??= newLine;
      newLine += 1;
      continue;
    }

    if (line.startsWith("-")) {
      firstDeletionLine ??= oldLine;
      oldLine += 1;
      continue;
    }

    if (line.startsWith("\\")) {
      continue;
    }

    oldLine += 1;
    newLine += 1;
  }

  if (firstAdditionLine != null) {
    return {
      anchorSide: "additions",
      anchorLine: firstAdditionLine,
    };
  }

  if (firstDeletionLine != null) {
    return {
      anchorSide: "deletions",
      anchorLine: firstDeletionLine,
    };
  }

  return {
    anchorSide: "additions",
    anchorLine: newStartLine,
  };
}

export function parseUnifiedDiffHunks(fileId: string, diffText: string): DiffHunkSeed[] {
  const lines = diffText.split(/\r?\n/);
  const hunks: DiffHunkSeed[] = [];
  let currentHeader: string | null = null;
  let currentBody: string[] = [];

  const flush = () => {
    if (currentHeader == null) {
      currentBody = [];
      return;
    }

    const match = currentHeader.match(HUNK_HEADER_REGEX);
    if (match == null) {
      currentHeader = null;
      currentBody = [];
      return;
    }

    const oldStart = Number(match[1]);
    const oldCount = match[2] == null ? 1 : Number(match[2]);
    const newStart = Number(match[3]);
    const newCount = match[4] == null ? 1 : Number(match[4]);
    const oldRange = toLineRange(oldStart, oldCount);
    const newRange = toLineRange(newStart, newCount);
    const { anchorSide, anchorLine } = findHunkAnchor(oldStart, newStart, currentBody);

    hunks.push({
      fileId,
      hunkIndex: hunks.length,
      anchorSide,
      anchorLine,
      oldStartLine: oldRange.startLine,
      oldEndLine: oldRange.endLine,
      newStartLine: newRange.startLine,
      newEndLine: newRange.endLine,
      patchText: [currentHeader, ...currentBody].join("\n").trimEnd(),
    });

    currentHeader = null;
    currentBody = [];
  };

  for (const line of lines) {
    if (line.startsWith("@@ ")) {
      flush();
      currentHeader = line;
      continue;
    }

    if (currentHeader != null) {
      currentBody.push(line);
    }
  }

  flush();
  return hunks;
}

export function normalizeUnifiedPatchHeaders(diffText: string, file: DiffReviewFile): string {
  const lines = diffText.split(/\r?\n/);
  const normalizedPath = file.newPath ?? file.oldPath ?? file.displayPath;

  if (lines[0]?.startsWith("diff --git ")) {
    lines[0] = `diff --git a/${normalizedPath} b/${normalizedPath}`;
  }

  if (lines[2]?.startsWith("--- ")) {
    lines[2] = `--- ${file.oldPath == null ? "/dev/null" : `a/${file.oldPath}`}`;
  }

  if (lines[3]?.startsWith("+++ ")) {
    lines[3] = `+++ ${file.newPath == null ? "/dev/null" : `b/${file.newPath}`}`;
  }

  return lines.join("\n");
}

export async function buildUnifiedPatch(pi: ExtensionAPI, repoRoot: string, file: DiffReviewFile): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-diff-review-"));
  const oldFilePath = join(tempDir, "before.txt");
  const newFilePath = join(tempDir, "after.txt");

  try {
    await Promise.all([writeFile(oldFilePath, file.oldContent, "utf8"), writeFile(newFilePath, file.newContent, "utf8")]);

    const result = await pi.exec("git", ["diff", "--no-index", "--no-ext-diff", "--no-color", "--unified=3", oldFilePath, newFilePath], {
      cwd: repoRoot,
    });

    if (result.code !== 0 && result.code !== 1) {
      const message = result.stderr.trim() || result.stdout.trim() || `failed to diff ${file.displayPath}`;
      throw new Error(message);
    }

    return normalizeUnifiedPatchHeaders(result.stdout, file);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

export async function buildFilePatches(pi: ExtensionAPI, repoRoot: string, files: DiffReviewFile[]): Promise<FilePatchResult[]> {
  return await Promise.all(
    files.map(async (file) => {
      try {
        const patchText = await buildUnifiedPatch(pi, repoRoot, file);
        return {
          file,
          patchText,
          hunks: parseUnifiedDiffHunks(file.id, patchText),
          error: null,
        } satisfies FilePatchResult;
      } catch (error) {
        return {
          file,
          patchText: "",
          hunks: [],
          error: error instanceof Error ? error.message : String(error),
        } satisfies FilePatchResult;
      }
    }),
  );
}
