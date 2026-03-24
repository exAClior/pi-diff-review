import assert from "node:assert/strict";
import test from "node:test";
import {
  describeCommentSubmissionState,
  getCommentDraft,
  hasPendingCommentChanges,
  isCommentSubmitted,
  needsCommentSubmission,
  submitCommentDraft,
} from "../web/comment-submission.js";

test("new comments stay draft until explicitly submitted", () => {
  const comment = {
    id: "comment-1",
    body: "",
    draftBody: "Needs a clearer name.",
  };

  assert.equal(getCommentDraft(comment), "Needs a clearer name.");
  assert.equal(isCommentSubmitted(comment), false);
  assert.equal(hasPendingCommentChanges(comment), true);
  assert.deepEqual(describeCommentSubmissionState(comment), {
    tone: "draft",
    label: "Draft",
    hint: "Submit this comment to include it in the review.",
    buttonLabel: "Submit comment",
    buttonDisabled: false,
  });

  submitCommentDraft(comment);

  assert.equal(comment.body, "Needs a clearer name.");
  assert.equal(comment.draftBody, "Needs a clearer name.");
  assert.equal(isCommentSubmitted(comment), true);
  assert.equal(hasPendingCommentChanges(comment), false);
  assert.deepEqual(describeCommentSubmissionState(comment), {
    tone: "submitted",
    label: "Submitted",
    hint: "Included when you submit the review.",
    buttonLabel: "Submitted",
    buttonDisabled: true,
  });
});

test("editing a submitted comment requires another explicit submit", () => {
  const comment = {
    id: "comment-2",
    body: "Current wording.",
    draftBody: "Current wording.",
  };

  comment.draftBody = "Current wording, but tighter.";

  assert.equal(isCommentSubmitted(comment), false);
  assert.equal(hasPendingCommentChanges(comment), true);
  assert.equal(needsCommentSubmission(comment), true);
  assert.deepEqual(describeCommentSubmissionState(comment), {
    tone: "pending",
    label: "Edited",
    hint: "Submit again to include the latest text in the review.",
    buttonLabel: "Save changes",
    buttonDisabled: false,
  });
});

test("clearing a submitted comment requires explicit confirmation", () => {
  const comment = {
    id: "comment-3",
    body: "Remove me.",
    draftBody: "",
  };

  assert.equal(isCommentSubmitted(comment), false);
  assert.equal(hasPendingCommentChanges(comment), true);
  assert.equal(needsCommentSubmission(comment), true);
  assert.deepEqual(describeCommentSubmissionState(comment), {
    tone: "pending",
    label: "Edited",
    hint: "Submit again to remove this comment from the review, or delete it.",
    buttonLabel: "Remove comment",
    buttonDisabled: false,
  });

  submitCommentDraft(comment);

  assert.equal(comment.body, "");
  assert.equal(comment.draftBody, "");
  assert.equal(needsCommentSubmission(comment), false);
  assert.equal(isCommentSubmitted(comment), false);
});

test("blank drafts cannot be submitted", () => {
  const comment = {
    id: "comment-3",
    body: "",
    draftBody: "   ",
  };

  assert.equal(isCommentSubmitted(comment), false);
  assert.deepEqual(describeCommentSubmissionState(comment), {
    tone: "draft",
    label: "Draft",
    hint: "Add text, then submit this comment to include it in the review.",
    buttonLabel: "Submit comment",
    buttonDisabled: true,
  });
});
