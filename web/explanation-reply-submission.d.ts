export interface ExplanationReplyDraftLike {
  body?: string | null;
  draftBody?: string | null;
}

export interface ExplanationReplySubmissionState {
  tone: "draft" | "pending" | "submitted";
  label: string;
  hint: string;
  buttonLabel: string;
  buttonDisabled: boolean;
}

export function getExplanationReplyDraft(reply: ExplanationReplyDraftLike): string;
export function getSubmittedExplanationReplyBody(reply: ExplanationReplyDraftLike): string;
export function hasPendingExplanationReplyChanges(reply: ExplanationReplyDraftLike): boolean;
export function isExplanationReplySubmitted(reply: ExplanationReplyDraftLike): boolean;
export function hasStartedExplanationReplyDraft(reply: ExplanationReplyDraftLike): boolean;
export function needsExplanationReplySubmission(reply: ExplanationReplyDraftLike): boolean;
export function submitExplanationReplyDraft(reply: ExplanationReplyDraftLike): string;
export function describeExplanationReplySubmissionState(reply: ExplanationReplyDraftLike): ExplanationReplySubmissionState;
