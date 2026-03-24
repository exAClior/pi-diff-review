export interface ReviewDraftCommentLike {
  body?: string | null;
  draftBody?: string | null;
}

export interface CommentSubmissionState {
  tone: "draft" | "pending" | "submitted";
  label: string;
  hint: string;
  buttonLabel: string;
  buttonDisabled: boolean;
}

export function getCommentDraft(comment: ReviewDraftCommentLike): string;
export function getSubmittedCommentBody(comment: ReviewDraftCommentLike): string;
export function hasPendingCommentChanges(comment: ReviewDraftCommentLike): boolean;
export function isCommentSubmitted(comment: ReviewDraftCommentLike): boolean;
export function hasStartedCommentDraft(comment: ReviewDraftCommentLike): boolean;
export function needsCommentSubmission(comment: ReviewDraftCommentLike): boolean;
export function submitCommentDraft(comment: ReviewDraftCommentLike): string;
export function describeCommentSubmissionState(comment: ReviewDraftCommentLike): CommentSubmissionState;
