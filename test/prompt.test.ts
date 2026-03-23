import assert from "node:assert/strict";
import test from "node:test";
import { composeReviewPrompt } from "../src/prompt.js";
import type { DiffReviewFile, ReviewSubmitPayload } from "../src/types.js";

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
  },
];

test("composeReviewPrompt formats file, line, and range comments", () => {
  const payload: ReviewSubmitPayload = {
    type: "submit",
    overallComment: "Please tighten this change.",
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
    composeReviewPrompt(files, payload),
    [
      "Please address the following feedback",
      "",
      "Please tighten this change.",
      "",
      "1. src/example.ts",
      "   This whole file still needs cleanup.",
      "",
      "2. src/example.ts:12 (new)",
      "   This branch name is too vague.",
      "",
      "3. src/example.ts:20-24 (old)",
      "   These removed lines carried important validation.",
    ].join("\n"),
  );
});
