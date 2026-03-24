export interface ReviewSubmitPayloadLike {
  overallComment: string;
  explanationReplies: unknown[];
  comments: unknown[];
}

export function hasReviewContent(payload: ReviewSubmitPayloadLike): boolean;
