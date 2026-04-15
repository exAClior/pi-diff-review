import assert from "node:assert/strict";
import test from "node:test";
import { normalizeUnifiedPatchHeaders, parseUnifiedDiffHunks } from "../src/patches.js";

test("parseUnifiedDiffHunks captures hunk anchors and line ranges", () => {
  const diffText = [
    "diff --git a/src/example.ts b/src/example.ts",
    "index 1111111..2222222 100644",
    "--- a/src/example.ts",
    "+++ b/src/example.ts",
    "@@ -1,2 +1,2 @@",
    "-const oldValue = 1;",
    "+const newValue = 2;",
    " export const unchanged = true;",
    "@@ -10,0 +10,3 @@ export function demo() {",
    "+  prepare();",
    "+  run();",
    "+  cleanup();",
    "",
  ].join("\n");

  const hunks = parseUnifiedDiffHunks("file-1", diffText);

  assert.deepEqual(hunks, [
    {
      fileId: "file-1",
      hunkIndex: 0,
      anchorSide: "additions",
      anchorLine: 1,
      oldStartLine: 1,
      oldEndLine: 2,
      newStartLine: 1,
      newEndLine: 2,
      patchText: [
        "@@ -1,2 +1,2 @@",
        "-const oldValue = 1;",
        "+const newValue = 2;",
        " export const unchanged = true;",
      ].join("\n"),
    },
    {
      fileId: "file-1",
      hunkIndex: 1,
      anchorSide: "additions",
      anchorLine: 10,
      oldStartLine: null,
      oldEndLine: null,
      newStartLine: 10,
      newEndLine: 12,
      patchText: [
        "@@ -10,0 +10,3 @@ export function demo() {",
        "+  prepare();",
        "+  run();",
        "+  cleanup();",
      ].join("\n"),
    },
  ]);
});

test("parseUnifiedDiffHunks anchors explainers to the first changed line instead of the hunk header context", () => {
  const diffText = [
    "diff --git a/src/example.ts b/src/example.ts",
    "index 1111111..2222222 100644",
    "--- a/src/example.ts",
    "+++ b/src/example.ts",
    "@@ -10,4 +10,4 @@",
    " const preservedHeader = true;",
    "-const oldValue = computeOldValue();",
    "+const newValue = computeNewValue();",
    " return newValue;",
    "}",
    "@@ -20,4 +20,2 @@",
    " export function cleanup() {",
    "-  flushQueue();",
    "-  notifyObservers();",
    " }",
    "",
  ].join("\n");

  const hunks = parseUnifiedDiffHunks("file-1", diffText);

  assert.equal(hunks[0]?.anchorSide, "additions");
  assert.equal(hunks[0]?.anchorLine, 11);
  assert.equal(hunks[1]?.anchorSide, "deletions");
  assert.equal(hunks[1]?.anchorLine, 21);
});

test("normalizeUnifiedPatchHeaders removes temp file paths from no-index diffs", () => {
  const normalized = normalizeUnifiedPatchHeaders(
    [
      "diff --git a/tmp/agent/before.txt b/tmp/agent/after.txt",
      "index 1111111..2222222 100644",
      "--- a/tmp/agent/before.txt",
      "+++ b/tmp/agent/after.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n"),
    {
      id: "file-1",
      status: "modified",
      oldPath: "src/example.ts",
      newPath: "src/example.ts",
      displayPath: "src/example.ts",
      treePath: "src/example.ts",
      oldContent: "old\n",
      newContent: "new\n",
      hunkExplanations: [],
    },
  );

  assert.match(normalized, /^diff --git a\/src\/example\.ts b\/src\/example\.ts/m);
  assert.match(normalized, /^--- a\/src\/example\.ts$/m);
  assert.match(normalized, /^\+\+\+ b\/src\/example\.ts$/m);
});
