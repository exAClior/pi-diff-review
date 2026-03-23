import assert from "node:assert/strict";
import test from "node:test";
import { buildCompletedExplanationStatus, normalizeUnifiedPatchHeaders, parseHunkExplanationResponse, parseHunkExplanationsFromAssistantMessage, parseUnifiedDiffHunks } from "../src/explain.js";

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

test("parseHunkExplanationsFromAssistantMessage accepts tool-call arguments when text is empty", () => {
  const hunks = parseUnifiedDiffHunks(
    "file-1",
    [
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -4,1 +4,1 @@",
      "-return oldValue;",
      "+return newValue;",
      "",
    ].join("\n"),
  );

  const explanations = parseHunkExplanationsFromAssistantMessage(
    {
      role: "assistant",
      api: "openai-completions",
      provider: "openai",
      model: "gpt-5",
      stopReason: "toolUse",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "submit_hunk_explanations",
          arguments: {
            hunks: [{ hunkIndex: 0, body: "Renames the returned value to match the updated variable naming." }],
          },
        },
      ],
    },
    hunks,
  );

  assert.deepEqual(explanations, [
    {
      id: "file-1:explanation:0",
      fileId: "file-1",
      anchorSide: "additions",
      anchorLine: 4,
      oldStartLine: 4,
      oldEndLine: 4,
      newStartLine: 4,
      newEndLine: 4,
      body: "Renames the returned value to match the updated variable naming.",
    },
  ]);
});

test("parseHunkExplanationResponse accepts fenced json and maps explanations back to hunks", () => {
  const hunks = parseUnifiedDiffHunks(
    "file-1",
    [
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -4,1 +4,1 @@",
      "-return oldValue;",
      "+return newValue;",
      "@@ -10,2 +10,0 @@",
      "-cleanup();",
      "-notify();",
      "",
    ].join("\n"),
  );

  const responseText = [
    "```json",
    JSON.stringify(
      {
        hunks: [
          { hunkIndex: 0, body: "Renames the returned value to match the updated variable naming." },
          { hunkIndex: 1, body: "Removes the old cleanup notification path from this code path." },
        ],
      },
      null,
      2,
    ),
    "```",
  ].join("\n");

  const explanations = parseHunkExplanationResponse(responseText, hunks);

  assert.deepEqual(explanations, [
    {
      id: "file-1:explanation:0",
      fileId: "file-1",
      anchorSide: "additions",
      anchorLine: 4,
      oldStartLine: 4,
      oldEndLine: 4,
      newStartLine: 4,
      newEndLine: 4,
      body: "Renames the returned value to match the updated variable naming.",
    },
    {
      id: "file-1:explanation:1",
      fileId: "file-1",
      anchorSide: "deletions",
      anchorLine: 10,
      oldStartLine: 10,
      oldEndLine: 11,
      newStartLine: null,
      newEndLine: null,
      body: "Removes the old cleanup notification path from this code path.",
    },
  ]);
});

test("buildCompletedExplanationStatus explains why zero notes were produced", () => {
  const status = buildCompletedExplanationStatus("openai/gpt-5", [
    {
      fileId: "file-1",
      displayPath: "src/first.ts",
      hunkCount: 2,
      generatedCount: 0,
      reason: "invalid-response",
      message: "The model response could not be parsed: response did not contain a hunks array",
    },
    {
      fileId: "file-2",
      displayPath: "src/second.ts",
      hunkCount: 1,
      generatedCount: 0,
      reason: "no-usable-explanations",
      message: "The model responded, but none of the returned explanations matched diff hunks.",
    },
  ]);

  assert.equal(status.state, "completed-without-explanations");
  assert.equal(status.generatedCount, 0);
  assert.match(status.summary, /src\/first\.ts/);
  assert.match(status.summary, /could not be parsed/);
});

test("buildCompletedExplanationStatus reports partial success with diagnostics", () => {
  const status = buildCompletedExplanationStatus("openai/gpt-5", [
    {
      fileId: "file-1",
      displayPath: "src/good.ts",
      hunkCount: 1,
      generatedCount: 1,
      reason: "generated",
      message: "Generated 1 explainer note(s).",
    },
    {
      fileId: "file-2",
      displayPath: "src/bad.ts",
      hunkCount: 1,
      generatedCount: 0,
      reason: "request-failed",
      message: "The model request failed: timeout",
    },
  ]);

  assert.equal(status.state, "partial");
  assert.equal(status.generatedCount, 1);
  assert.match(status.summary, /some files were skipped/i);
  assert.match(status.summary, /src\/bad\.ts/);
});
