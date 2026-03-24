export function hasReviewContent(payload) {
  return payload.overallComment.length > 0 || payload.explanationReplies.length > 0 || payload.comments.length > 0;
}
