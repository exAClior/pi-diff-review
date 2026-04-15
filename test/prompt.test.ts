import assert from "node:assert/strict";
import test from "node:test";
import { composeReviewPrompt } from "../src/prompt.js";
import type { DiffReviewFile, ReviewCallout, ReviewFinding, ReviewSubmitPayload } from "../src/types.js";

const files: DiffReviewFile[] = [
  {
    id: "file-1",
    status: "modified",
    oldPath: "src/example.ts",
    newPath: "src/example.ts",
    displayPath: "src/example.ts",
    treePath: "src/example.ts",
    oldContent: "old",
    newContent: "new",
    hunkExplanations: [
      {
        id: "file-1:explanation:0",
        fileId: "file-1",
        anchorSide: "additions",
        anchorLine: 12,
        oldStartLine: 10,
        oldEndLine: 11,
        newStartLine: 10,
        newEndLine: 12,
        body: "Renames the returned value to match the updated variable naming.",
      },
    ],
  },
];

test("composeReviewPrompt groups explainer replies, review comments, and requested actions into sections", () => {
  const payload: ReviewSubmitPayload = {
    type: "submit",
    overallComment: "Please tighten this change.",
    explanationReplies: [
      {
        id: "reply-1",
        explanationId: "file-1:explanation:0",
        body: "This also changes behavior, so the explanation should call that out.",
      },
    ],
    comments: [
      {
        id: "comment-file",
        fileId: "file-1",
        kind: "file",
        side: null,
        startLine: null,
        endLine: null,
        body: "This whole file still needs cleanup.",
      },
      {
        id: "comment-line",
        fileId: "file-1",
        kind: "line",
        side: "additions",
        startLine: 12,
        endLine: 12,
        body: "This branch name is too vague.",
      },
      {
        id: "comment-range",
        fileId: "file-1",
        kind: "range",
        side: "deletions",
        startLine: 20,
        endLine: 24,
        body: "These removed lines carried important validation.",
      },
    ],
  };

  assert.equal(
    composeReviewPrompt({ files, payload }),
    [
      "# Diff Review Feedback",
      "",
      "## Overall Note",
      "",
      "Please tighten this change.",
      "",
      "## LLM Explainer Note Replies",
      "",
      "1. src/example.ts (old 10-11 · new 10-12)",
      "   LLM explainer note: Renames the returned value to match the updated variable naming.",
      "   Reviewer reply: This also changes behavior, so the explanation should call that out.",
      "",
      "## Review Comments",
      "",
      "1. src/example.ts",
      "   This whole file still needs cleanup.",
      "",
      "2. src/example.ts:12 (new)",
      "   This branch name is too vague.",
      "",
      "3. src/example.ts:20-24 (old)",
      "   These removed lines carried important validation.",
      "",
      "## Requested Actions",
      "",
      "1. Address each review note above.",
      "",
      "2. For each note, either make the change or explain why it doesn't apply.",
      "",
      "3. Run relevant tests for touched code.",
      "",
      "4. Summarize what you fixed and what you skipped (with reasons).",
    ].join("\n"),
  );
});

test("composeReviewPrompt still produces a valid prompt when there are no file comments", () => {
  const payload: ReviewSubmitPayload = {
    type: "submit",
    overallComment: "Double-check the edge cases.",
    explanationReplies: [
      {
        id: "reply-1",
        explanationId: "file-1:explanation:0",
        body: "This explanation misses the fallback behavior.",
      },
    ],
    comments: [],
  };

  assert.equal(
    composeReviewPrompt({ files, payload }),
    [
      "# Diff Review Feedback",
      "",
      "## Overall Note",
      "",
      "Double-check the edge cases.",
      "",
      "## LLM Explainer Note Replies",
      "",
      "1. src/example.ts (old 10-11 · new 10-12)",
      "   LLM explainer note: Renames the returned value to match the updated variable naming.",
      "   Reviewer reply: This explanation misses the fallback behavior.",
      "",
      "## Requested Actions",
      "",
      "1. Address each review note above.",
      "",
      "2. For each note, either make the change or explain why it doesn't apply.",
      "",
      "3. Run relevant tests for touched code.",
      "",
      "4. Summarize what you fixed and what you skipped (with reasons).",
    ].join("\n"),
  );
});

test("composeReviewPrompt supports prompts with only explainer replies", () => {
  const payload: ReviewSubmitPayload = {
    type: "submit",
    overallComment: "",
    explanationReplies: [
      {
        id: "reply-1",
        explanationId: "file-1:explanation:0",
        body: "The note should mention that this renames the public API output.",
      },
    ],
    comments: [],
  };

  assert.equal(
    composeReviewPrompt({
      files,
      payload,
      includedFindings: undefined,
      curatedCallouts: undefined,
    }),
    [
      "# Diff Review Feedback",
      "",
      "## LLM Explainer Note Replies",
      "",
      "1. src/example.ts (old 10-11 · new 10-12)",
      "   LLM explainer note: Renames the returned value to match the updated variable naming.",
      "   Reviewer reply: The note should mention that this renames the public API output.",
      "",
      "## Requested Actions",
      "",
      "1. Address each review note above.",
      "",
      "2. For each note, either make the change or explain why it doesn't apply.",
      "",
      "3. Run relevant tests for touched code.",
      "",
      "4. Summarize what you fixed and what you skipped (with reasons).",
    ].join("\n"),
  );
});

test("composeReviewPrompt includes curated automated findings and opted-in callouts", () => {
  const payload: ReviewSubmitPayload = {
    type: "submit",
    overallComment: "",
    explanationReplies: [],
    comments: [],
    includedFindingIds: ["finding:0"],
    includeCallouts: true,
  };

  const includedFindings: ReviewFinding[] = [
    {
      id: "finding:0",
      priority: "P1",
      title: "Guard missing for optional config",
      body: "This path now dereferences config before checking whether it exists.",
      suggestion: "if (config == null) return;",
      location: {
        fileId: "file-1",
        filePath: "src/example.ts",
        startLine: 12,
        endLine: 12,
        side: "new",
      },
    },
  ];

  const curatedCallouts: ReviewCallout[] = [
    {
      category: "This change changes configuration defaults",
      detail: "FEATURE_X now defaults to enabled.",
    },
  ];

  assert.equal(
    composeReviewPrompt({ files, payload, includedFindings, curatedCallouts }),
    [
      "# Diff Review Feedback",
      "",
      "## Automated Review Findings",
      "",
      "1. [P1] Guard missing for optional config",
      "   Location: src/example.ts:12 (new)",
      "   This path now dereferences config before checking whether it exists.",
      "   Suggested fix:",
      "   ```suggestion",
      "   if (config == null) return;",
      "   ```",
      "",
      "## Human Reviewer Callouts (Non-Blocking)",
      "",
      "- This change changes configuration defaults: FEATURE_X now defaults to enabled.",
      "",
      "## Requested Actions",
      "",
      "1. Address each finding above in priority order.",
      "",
      "2. For each finding, either fix it or explain why it doesn't apply.",
      "",
      "3. Run relevant tests for touched code.",
      "",
      "4. Summarize what you fixed and what you skipped (with reasons).",
    ].join("\n"),
  );
});

test("composeReviewPrompt keeps callout-only submissions informational", () => {
  const payload: ReviewSubmitPayload = {
    type: "submit",
    overallComment: "",
    explanationReplies: [],
    comments: [],
    includeCallouts: true,
  };

  const curatedCallouts: ReviewCallout[] = [
    {
      category: "This change introduces a new dependency",
      detail: "package.json adds example-lib.",
    },
  ];

  assert.equal(
    composeReviewPrompt({ files, payload, curatedCallouts }),
    [
      "# Diff Review Feedback",
      "",
      "## Human Reviewer Callouts (Non-Blocking)",
      "",
      "- This change introduces a new dependency: package.json adds example-lib.",
      "",
      "## Requested Actions",
      "",
      "1. Review the informational callouts above before landing the change.",
      "",
      "2. Only make code changes if a callout exposes a real issue or missing rollout work.",
      "",
      "3. If no code changes are needed, say so explicitly.",
      "",
      "4. Summarize any follow-up or rollout work that still needs to happen.",
    ].join("\n"),
  );
});
