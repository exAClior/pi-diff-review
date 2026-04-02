import assert from "node:assert/strict";
import test from "node:test";
import {
  describeExplanationReplySubmissionState,
  getExplanationReplyDraft,
  hasPendingExplanationReplyChanges,
  isExplanationReplySubmitted,
  needsExplanationReplySubmission,
  submitExplanationReplyDraft,
} from "../web/explanation-reply-submission.js";

test("new explainer replies stay draft until explicitly submitted", () => {
  const reply = {
    id: "reply-1",
    explanationId: "exp-1",
    body: "",
    draftBody: "This explanation misses the behavior change.",
  };

  assert.equal(getExplanationReplyDraft(reply), "This explanation misses the behavior change.");
  assert.equal(isExplanationReplySubmitted(reply), false);
  assert.equal(hasPendingExplanationReplyChanges(reply), true);
  assert.deepEqual(describeExplanationReplySubmissionState(reply), {
    tone: "draft",
    label: "Draft",
    hint: "Submit this reply to include it in the review.",
    buttonLabel: "Submit reply",
    buttonDisabled: false,
  });

  submitExplanationReplyDraft(reply);

  assert.equal(reply.body, "This explanation misses the behavior change.");
  assert.equal(reply.draftBody, "This explanation misses the behavior change.");
  assert.equal(isExplanationReplySubmitted(reply), true);
  assert.equal(hasPendingExplanationReplyChanges(reply), false);
  assert.deepEqual(describeExplanationReplySubmissionState(reply), {
    tone: "submitted",
    label: "Submitted",
    hint: "Included when you submit the review so pi can revise this explanation.",
    buttonLabel: "Submitted",
    buttonDisabled: true,
  });
});

test("editing a submitted explainer reply requires another explicit submit", () => {
  const reply = {
    id: "reply-2",
    explanationId: "exp-2",
    body: "Current note.",
    draftBody: "Current note.",
  };

  reply.draftBody = "Current note, but it should mention the edge case too.";

  assert.equal(isExplanationReplySubmitted(reply), false);
  assert.equal(hasPendingExplanationReplyChanges(reply), true);
  assert.equal(needsExplanationReplySubmission(reply), true);
  assert.deepEqual(describeExplanationReplySubmissionState(reply), {
    tone: "pending",
    label: "Edited",
    hint: "Submit again to include the latest reply in the review.",
    buttonLabel: "Save changes",
    buttonDisabled: false,
  });
});

test("clearing a submitted explainer reply requires explicit confirmation", () => {
  const reply = {
    id: "reply-3",
    explanationId: "exp-3",
    body: "Remove me.",
    draftBody: "",
  };

  assert.equal(isExplanationReplySubmitted(reply), false);
  assert.equal(hasPendingExplanationReplyChanges(reply), true);
  assert.equal(needsExplanationReplySubmission(reply), true);
  assert.deepEqual(describeExplanationReplySubmissionState(reply), {
    tone: "pending",
    label: "Edited",
    hint: "Submit again to remove this reply from the review, or keep editing it.",
    buttonLabel: "Remove reply",
    buttonDisabled: false,
  });

  submitExplanationReplyDraft(reply);

  assert.equal(reply.body, "");
  assert.equal(reply.draftBody, "");
  assert.equal(needsExplanationReplySubmission(reply), false);
  assert.equal(isExplanationReplySubmitted(reply), false);
});

test("blank explainer reply drafts cannot be submitted", () => {
  const reply = {
    id: "reply-4",
    explanationId: "exp-4",
    body: "",
    draftBody: "   ",
  };

  assert.equal(isExplanationReplySubmitted(reply), false);
  assert.deepEqual(describeExplanationReplySubmissionState(reply), {
    tone: "draft",
    label: "Draft",
    hint: "Add text, then submit this reply to include it in the review.",
    buttonLabel: "Submit reply",
    buttonDisabled: true,
  });
});
