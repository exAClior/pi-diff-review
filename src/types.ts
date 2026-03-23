export type ChangeStatus = "modified" | "added" | "deleted" | "renamed";

export interface DiffReviewFile {
  id: string;
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
  displayPath: string;
  treePath: string;
  oldContent: string;
  newContent: string;
}

export type ReviewCommentKind = "file" | "line" | "range";
export type ReviewCommentSide = "deletions" | "additions";

interface ReviewCommentBase {
  id: string;
  fileId: string;
  body: string;
}

export interface FileReviewComment extends ReviewCommentBase {
  kind: "file";
  side: null;
  startLine: null;
  endLine: null;
}

export interface LineReviewComment extends ReviewCommentBase {
  kind: "line";
  side: ReviewCommentSide;
  startLine: number;
  endLine: number | null;
}

export interface RangeReviewComment extends ReviewCommentBase {
  kind: "range";
  side: ReviewCommentSide;
  startLine: number;
  endLine: number;
}

export type ReviewComment = FileReviewComment | LineReviewComment | RangeReviewComment;

export interface ReviewSubmitPayload {
  type: "submit";
  overallComment: string;
  comments: ReviewComment[];
}

export interface ReviewCancelPayload {
  type: "cancel";
}

export type ReviewSessionResult = ReviewSubmitPayload | ReviewCancelPayload;

export interface DiffReviewWindowData {
  repoRoot: string;
  files: DiffReviewFile[];
}

function isLineNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isReviewCommentSide(value: unknown): value is ReviewCommentSide {
  return value === "deletions" || value === "additions";
}

function hasCommonCommentFields(candidate: Record<string, unknown>): candidate is Record<string, unknown> & ReviewCommentBase {
  return typeof candidate.id === "string" && typeof candidate.fileId === "string" && typeof candidate.body === "string";
}

// Keep the runtime validator aligned with the comment shapes we actually emit
// from the browser UI so the local review server rejects malformed payloads
// instead of silently producing a bad prompt.
function isReviewComment(value: unknown): value is ReviewComment {
  if (typeof value !== "object" || value == null) return false;

  const candidate = value as Record<string, unknown>;
  if (!hasCommonCommentFields(candidate)) {
    return false;
  }

  if (candidate.kind === "file") {
    return candidate.side == null && candidate.startLine == null && candidate.endLine == null;
  }

  if (candidate.kind === "line") {
    return (
      isReviewCommentSide(candidate.side) &&
      isLineNumber(candidate.startLine) &&
      (candidate.endLine == null || (isLineNumber(candidate.endLine) && candidate.endLine === candidate.startLine))
    );
  }

  if (candidate.kind === "range") {
    return (
      isReviewCommentSide(candidate.side) &&
      isLineNumber(candidate.startLine) &&
      isLineNumber(candidate.endLine) &&
      candidate.endLine > candidate.startLine
    );
  }

  return false;
}

export function isReviewSubmitPayload(value: unknown): value is ReviewSubmitPayload {
  if (typeof value !== "object" || value == null) return false;

  const candidate = value as Record<string, unknown>;

  return (
    candidate.type === "submit" &&
    typeof candidate.overallComment === "string" &&
    Array.isArray(candidate.comments) &&
    candidate.comments.every(isReviewComment)
  );
}
