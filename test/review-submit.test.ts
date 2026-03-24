import assert from "node:assert/strict";
import test from "node:test";
import { hasReviewContent } from "../web/review-submit.js";

test("hasReviewContent rejects an empty review payload", () => {
  assert.equal(
    hasReviewContent({
      overallComment: "",
      explanationReplies: [],
      comments: [],
    }),
    false,
  );
});

test("hasReviewContent accepts an overall comment on its own", () => {
  assert.equal(
    hasReviewContent({
      overallComment: "Please simplify this branch.",
      explanationReplies: [],
      comments: [],
    }),
    true,
  );
});

test("hasReviewContent accepts explainer replies or submitted comments without an overall note", () => {
  assert.equal(
    hasReviewContent({
      overallComment: "",
      explanationReplies: [{ id: "reply-1", explanationId: "exp-1", body: "This misses the behavior change." }],
      comments: [],
    }),
    true,
  );

  assert.equal(
    hasReviewContent({
      overallComment: "",
      explanationReplies: [],
      comments: [{ id: "comment-1", fileId: "file-1", kind: "file", side: null, startLine: null, endLine: null, body: "Whole-file note." }],
    }),
    true,
  );
});
