export interface ReviewSubmitPayloadLike {
  overallComment: string;
  explanationReplies: unknown[];
  comments: unknown[];
  includedFindingIds?: string[];
  includeCallouts?: boolean;
}

export function hasReviewContent(payload: ReviewSubmitPayloadLike): boolean;
