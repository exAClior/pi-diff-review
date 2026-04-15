import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
  REVIEW_RUBRIC,
  buildReviewPrompt,
  parseAutomatedReviewFromAssistantMessage,
  parseAutomatedReviewResponse,
  runAutomatedReview,
} from "../src/review.js";
import type { FilePatchResult } from "../src/patches.js";
import type { DiffReviewFile } from "../src/types.js";

const reviewedFiles: DiffReviewFile[] = [
  {
    id: "file-1",
    status: "modified",
    oldPath: "src/example.ts",
    newPath: "src/example.ts",
    displayPath: "src/example.ts",
    treePath: "src/example.ts",
    oldContent: "export const value = 1;\nreturn value;\n",
    newContent: "export const value = 2;\nreturn value;\nconsole.log(value);\n",
    hunkExplanations: [],
  },
  {
    id: "file-2",
    status: "renamed",
    oldPath: "src/old-name.ts",
    newPath: "src/new-name.ts",
    displayPath: "src/old-name.ts -> src/new-name.ts",
    treePath: "src/new-name.ts",
    oldContent: "old line\nsecond old line\n",
    newContent: "new line\nsecond new line\n",
    hunkExplanations: [],
  },
  {
    id: "file-3",
    status: "deleted",
    oldPath: "src/deleted.ts",
    newPath: null,
    displayPath: "src/deleted.ts",
    treePath: "src/deleted.ts",
    oldContent: "first line\nsecond line\n",
    newContent: "",
    hunkExplanations: [],
  },
];

const reviewedPatches: FilePatchResult[] = reviewedFiles.map((file) => ({
  file,
  patchText: [
    `diff --git a/${file.oldPath ?? file.newPath ?? file.displayPath} b/${file.newPath ?? file.oldPath ?? file.displayPath}`,
    file.oldPath == null ? "--- /dev/null" : `--- a/${file.oldPath}`,
    file.newPath == null ? "+++ /dev/null" : `+++ b/${file.newPath}`,
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n"),
  hunks: [],
  error: null,
}));

test("parseAutomatedReviewFromAssistantMessage accepts tool-call findings and normalizes locations", () => {
  const parsed = parseAutomatedReviewFromAssistantMessage(
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
          name: "submit_review_findings",
          arguments: {
            verdict: "needs_attention",
            findings: [
              {
                priority: "P1",
                title: "Rename introduced an unvalidated path",
                filePath: "src/old-name.ts",
                startLine: 2,
                endLine: 2,
                side: "new",
                body: "The renamed module now uses the new path without validating it first.",
                suggestion: "if (path == null) return;",
              },
              {
                priority: "P2",
                title: "Deleted file location is out of range",
                filePath: "src/deleted.ts",
                startLine: 99,
                side: "new",
                body: "This should be normalized back to a file-level finding.",
              },
            ],
            callouts: [
              {
                category: "This change introduces a new dependency",
                detail: "package.json adds example-lib.",
              },
            ],
          },
        },
      ],
    },
    reviewedFiles,
  );

  assert.equal(parsed.verdict, "needs_attention");
  assert.deepEqual(parsed.callouts, [
    {
      category: "This change introduces a new dependency",
      detail: "package.json adds example-lib.",
    },
  ]);
  assert.deepEqual(parsed.findings, [
    {
      id: "finding:0",
      priority: "P1",
      title: "Rename introduced an unvalidated path",
      body: "The renamed module now uses the new path without validating it first.",
      suggestion: "if (path == null) return;",
      location: {
        fileId: "file-2",
        filePath: "src/old-name.ts -> src/new-name.ts",
        startLine: 2,
        endLine: 2,
        side: "new",
      },
    },
    {
      id: "finding:1",
      priority: "P2",
      title: "Deleted file location is out of range",
      body: "This should be normalized back to a file-level finding.",
      location: {
        fileId: "file-3",
        filePath: "src/deleted.ts",
        startLine: null,
        endLine: null,
        side: null,
      },
    },
  ]);
});

test("parseAutomatedReviewResponse falls back to structured text parsing", () => {
  const responseText = [
    "Verdict: needs_attention",
    "",
    "1. [P1] Missing null guard",
    "   Location: src/example.ts:2-3 (new)",
    "   This path now reads from config without checking whether it exists.",
    "   ```suggestion",
    "   if (config == null) return;",
    "   ```",
    "",
    "## Human Reviewer Callouts (Non-Blocking)",
    "- **This change changes configuration defaults:** FEATURE_X now defaults to enabled.",
  ].join("\n");

  const parsed = parseAutomatedReviewResponse(responseText, reviewedFiles);

  assert.equal(parsed.verdict, "needs_attention");
  assert.deepEqual(parsed.findings, [
    {
      id: "finding:0",
      priority: "P1",
      title: "Missing null guard",
      body: "This path now reads from config without checking whether it exists.",
      suggestion: "if (config == null) return;",
      location: {
        fileId: "file-1",
        filePath: "src/example.ts",
        startLine: 2,
        endLine: 3,
        side: "new",
      },
    },
  ]);
  assert.deepEqual(parsed.callouts, [
    {
      category: "This change changes configuration defaults",
      detail: "FEATURE_X now defaults to enabled.",
    },
  ]);
});

test("buildReviewPrompt includes the rubric, diff, project guidelines, and extra instruction", () => {
  const prompt = buildReviewPrompt(
    [
      reviewedPatches[0],
      {
        ...reviewedPatches[1],
        patchText: "",
        error: "failed to build patch",
      },
    ],
    "Prefer request-scoped dependencies.",
    "Focus on config regressions.",
  );

  assert.match(prompt, /^# Review Guidelines/m);
  assert.match(prompt, /Review only the changes in the unified diff below/);
  assert.match(prompt, /diff --git a\/src\/example\.ts b\/src\/example\.ts/);
  assert.doesNotMatch(prompt, /src\/old-name\.ts -> src\/new-name\.ts/);
  assert.match(prompt, /## Project Review Guidelines\n\nPrefer request-scoped dependencies\./);
  assert.match(prompt, /## Additional User-Provided Review Instruction\n\nFocus on config regressions\./);
  assert.ok(prompt.startsWith(REVIEW_RUBRIC));
});

test("runAutomatedReview skips oversized diffs before making a model request", async () => {
  const notifications: Array<{ message: string; tone: string }> = [];
  const result = await runAutomatedReview(
    {} as never,
    {
      model: { provider: "openai", id: "gpt-5" },
      modelRegistry: {
        async getApiKeyAndHeaders() {
          return {
            ok: true,
            apiKey: "secret",
          };
        },
      },
      ui: {
        notify(message: string, tone: string) {
          notifications.push({ message, tone });
        },
      },
    } as unknown as ExtensionCommandContext,
    reviewedPatches,
    { maxPatchLines: 1 },
  );

  assert.deepEqual(notifications, []);
  assert.equal(result.verdict, null);
  assert.deepEqual(result.findings, []);
  assert.equal(result.status.state, "skipped-too-large");
  assert.match(result.status.summary, /Diff too large for automated review/);
});
