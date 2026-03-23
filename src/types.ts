export type ChangeStatus = "modified" | "added" | "deleted" | "renamed";

export interface HunkExplanation {
  id: string;
  fileId: string;
  anchorSide: ReviewCommentSide;
  anchorLine: number;
  oldStartLine: number | null;
  oldEndLine: number | null;
  newStartLine: number | null;
  newEndLine: number | null;
  body: string;
}

export interface ExplanationReply {
  id: string;
  explanationId: string;
  body: string;
}

export interface DiffReviewFile {
  id: string;
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
  displayPath: string;
  treePath: string;
  oldContent: string;
  newContent: string;
  hunkExplanations: HunkExplanation[];
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
  explanationReplies: ExplanationReply[];
  comments: ReviewComment[];
}

export interface ReviewCancelPayload {
  type: "cancel";
}

export type ReviewSessionResult = ReviewSubmitPayload | ReviewCancelPayload;

export type ExplanationRunState = "generated" | "partial" | "completed-without-explanations" | "skipped-no-model" | "skipped-no-auth";

export type ExplanationFileReason = "generated" | "no-hunks" | "empty-response" | "invalid-response" | "no-usable-explanations" | "request-failed";

export interface ExplanationFileStatus {
  fileId: string;
  displayPath: string;
  hunkCount: number;
  generatedCount: number;
  reason: ExplanationFileReason;
  message: string;
}

export interface ExplanationStatus {
  state: ExplanationRunState;
  attempted: boolean;
  modelLabel: string | null;
  generatedCount: number;
  summary: string;
  fileStatuses: ExplanationFileStatus[];
}

export interface DiffReviewWindowData {
  repoRoot: string;
  files: DiffReviewFile[];
  explanationStatus?: ExplanationStatus;
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

function isExplanationReply(value: unknown): value is ExplanationReply {
  if (typeof value !== "object" || value == null) return false;

  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string" && typeof candidate.explanationId === "string" && typeof candidate.body === "string";
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
    Array.isArray(candidate.explanationReplies) &&
    candidate.explanationReplies.every(isExplanationReply) &&
    Array.isArray(candidate.comments) &&
    candidate.comments.every(isReviewComment)
  );
}
