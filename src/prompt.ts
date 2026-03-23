import type { DiffReviewFile, HunkExplanation, ReviewComment, ReviewSubmitPayload } from "./types.js";

function formatLocation(comment: ReviewComment, filePath: string): string {
  if (comment.kind === "file" || comment.startLine == null) {
    return filePath;
  }

  const suffix = comment.side === "deletions" ? " (old)" : " (new)";

  if (comment.endLine != null && comment.endLine !== comment.startLine) {
    return `${filePath}:${comment.startLine}-${comment.endLine}${suffix}`;
  }

  return `${filePath}:${comment.startLine}${suffix}`;
}

function formatExplanationRange(label: string, startLine: number | null, endLine: number | null): string | null {
  if (startLine == null || endLine == null) {
    return null;
  }

  if (startLine === endLine) {
    return `${label} ${startLine}`;
  }

  return `${label} ${startLine}-${endLine}`;
}

function formatExplanationLocation(explanation: HunkExplanation, filePath: string): string {
  const ranges = [
    formatExplanationRange("old", explanation.oldStartLine, explanation.oldEndLine),
    formatExplanationRange("new", explanation.newStartLine, explanation.newEndLine),
  ].filter(Boolean);

  if (ranges.length > 0) {
    return `${filePath} (${ranges.join(" · ")})`;
  }

  const suffix = explanation.anchorSide === "deletions" ? " (old)" : " (new)";
  return `${filePath}:${explanation.anchorLine}${suffix}`;
}

export function composeReviewPrompt(files: DiffReviewFile[], payload: ReviewSubmitPayload): string {
  const fileMap = new Map(files.map((file) => [file.id, file]));
  const explanationMap = new Map(
    files.flatMap((file) => file.hunkExplanations.map((explanation) => [explanation.id, { explanation, filePath: file.displayPath }])),
  );
  const lines: string[] = [];

  lines.push("Please address the following feedback");
  lines.push("");

  const overallComment = payload.overallComment.trim();
  if (overallComment.length > 0) {
    lines.push(overallComment);
    lines.push("");
  }

  const explanationReplies = payload.explanationReplies.filter((reply) => reply.body.trim().length > 0);
  const comments = payload.comments.filter((comment) => comment.body.trim().length > 0);
  let itemIndex = 1;

  if (explanationReplies.length > 0) {
    lines.push("LLM explainer note replies:");
    lines.push("");

    explanationReplies.forEach((reply) => {
      const match = explanationMap.get(reply.explanationId);
      const location = match == null ? reply.explanationId : formatExplanationLocation(match.explanation, match.filePath);
      const originalNote = match?.explanation.body.trim() || "Original explainer note unavailable.";

      lines.push(`${itemIndex}. ${location}`);
      lines.push(`   LLM explainer note: ${originalNote}`);
      lines.push(`   Reviewer reply: ${reply.body.trim()}`);
      lines.push("");
      itemIndex += 1;
    });
  }

  if (comments.length > 0) {
    if (explanationReplies.length > 0) {
      lines.push("Review comments:");
      lines.push("");
    }

    comments.forEach((comment) => {
      const file = fileMap.get(comment.fileId);
      const filePath = file?.displayPath ?? comment.fileId;
      lines.push(`${itemIndex}. ${formatLocation(comment, filePath)}`);
      lines.push(`   ${comment.body.trim()}`);
      lines.push("");
      itemIndex += 1;
    });
  }

  return lines.join("\n").trim();
}
