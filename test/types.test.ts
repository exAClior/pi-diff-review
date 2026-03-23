import assert from "node:assert/strict";
import test from "node:test";
import { isReviewSubmitPayload } from "../src/types.js";

test("isReviewSubmitPayload accepts the payload emitted by the browser UI", () => {
  assert.equal(
    isReviewSubmitPayload({
      type: "submit",
      overallComment: "Looks mostly right.",
      explanationReplies: [
        {
          id: "reply-1",
          explanationId: "file-1:explanation:0",
          body: "This explanation misses the behavior change in the fallback path.",
        },
      ],
      comments: [
        {
          id: "file-comment",
          fileId: "file-1",
          kind: "file",
          side: null,
          startLine: null,
          endLine: null,
          body: "Whole-file note.",
        },
        {
          id: "line-comment",
          fileId: "file-1",
          kind: "line",
          side: "additions",
          startLine: 8,
          endLine: 8,
          body: "Single-line note.",
        },
        {
          id: "range-comment",
          fileId: "file-1",
          kind: "range",
          side: "deletions",
          startLine: 12,
          endLine: 15,
          body: "Range note.",
        },
      ],
    }),
    true,
  );
});

test("isReviewSubmitPayload rejects malformed explainer replies", () => {
  assert.equal(
    isReviewSubmitPayload({
      type: "submit",
      overallComment: "",
      explanationReplies: [
        {
          id: "reply-1",
          explanationId: 42,
          body: "The explanation id must stay a string.",
        },
      ],
      comments: [],
    }),
    false,
  );
});

test("isReviewSubmitPayload rejects malformed file comments", () => {
  assert.equal(
    isReviewSubmitPayload({
      type: "submit",
      overallComment: "",
      explanationReplies: [],
      comments: [
        {
          id: "bad-file-comment",
          fileId: "file-1",
          kind: "file",
          side: "additions",
          startLine: null,
          endLine: null,
          body: "File comments must not carry a diff side.",
        },
      ],
    }),
    false,
  );
});

test("isReviewSubmitPayload rejects malformed line comments", () => {
  assert.equal(
    isReviewSubmitPayload({
      type: "submit",
      overallComment: "",
      explanationReplies: [],
      comments: [
        {
          id: "bad-line-comment",
          fileId: "file-1",
          kind: "line",
          side: "additions",
          startLine: 5,
          endLine: 7,
          body: "A line comment cannot pretend to be a range.",
        },
      ],
    }),
    false,
  );
});

test("isReviewSubmitPayload rejects malformed range comments", () => {
  assert.equal(
    isReviewSubmitPayload({
      type: "submit",
      overallComment: "",
      explanationReplies: [],
      comments: [
        {
          id: "bad-range-comment",
          fileId: "file-1",
          kind: "range",
          side: "deletions",
          startLine: 10,
          endLine: 10,
          body: "A range needs more than one line.",
        },
      ],
    }),
    false,
  );
});
