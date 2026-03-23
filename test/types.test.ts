import assert from "node:assert/strict";
import test from "node:test";
import { isReviewSubmitPayload } from "../src/types.js";

test("isReviewSubmitPayload accepts the comment shapes emitted by the browser UI", () => {
  assert.equal(
    isReviewSubmitPayload({
      type: "submit",
      overallComment: "Looks mostly right.",
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

test("isReviewSubmitPayload rejects malformed file comments", () => {
  assert.equal(
    isReviewSubmitPayload({
      type: "submit",
      overallComment: "",
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
