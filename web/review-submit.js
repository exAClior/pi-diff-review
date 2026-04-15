/**
 * @param {{
 *   overallComment: string;
 *   explanationReplies: unknown[];
 *   comments: unknown[];
 *   includedFindingIds?: string[];
 *   includeCallouts?: boolean;
 * }} payload
 */
export function hasReviewContent(payload) {
  return (
    payload.overallComment.length > 0 ||
    payload.explanationReplies.length > 0 ||
    payload.comments.length > 0 ||
    (Array.isArray(payload.includedFindingIds) && payload.includedFindingIds.length > 0) ||
    payload.includeCallouts === true
  );
}
