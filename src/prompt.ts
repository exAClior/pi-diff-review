import type { DiffReviewFile, HunkExplanation, ReviewCallout, ReviewComment, ReviewFinding, ReviewSubmitPayload } from "./types.js";

export interface ComposeReviewPromptOptions {
  files: DiffReviewFile[];
  payload: ReviewSubmitPayload;
  includedFindings?: ReviewFinding[];
  curatedCallouts?: ReviewCallout[];
}

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

function formatFindingLocation(finding: ReviewFinding): string {
  const { location } = finding;

  if (location.fileId == null) {
    return location.filePath || "Global";
  }

  if (location.startLine == null || location.side == null) {
    return location.filePath;
  }

  const suffix = location.side === "old" ? " (old)" : " (new)";
  if (location.endLine != null && location.endLine !== location.startLine) {
    return `${location.filePath}:${location.startLine}-${location.endLine}${suffix}`;
  }

  return `${location.filePath}:${location.startLine}${suffix}`;
}

function appendSection(lines: string[], heading: string, bodyLines: string[]): void {
  if (bodyLines.length === 0) {
    return;
  }

  if (lines.length > 0) {
    lines.push("");
  }

  lines.push(heading, "", ...bodyLines);
}

function toNumberedList(items: string[][]): string[] {
  return items.flatMap((itemLines, index) => {
    const [firstLine = "", ...rest] = itemLines;
    const formatted = [`${index + 1}. ${firstLine}`, ...rest.map((line) => `   ${line}`)];
    return index === items.length - 1 ? formatted : [...formatted, ""];
  });
}

function buildRequestedActions(hasFindings: boolean, hasReviewNotes: boolean, hasCallouts: boolean): string[][] {
  if (hasFindings) {
    return [
      ["Address each finding above in priority order."],
      ["For each finding, either fix it or explain why it doesn't apply."],
      ["Run relevant tests for touched code."],
      ["Summarize what you fixed and what you skipped (with reasons)."],
    ];
  }

  if (hasReviewNotes) {
    return [
      ["Address each review note above."],
      ["For each note, either make the change or explain why it doesn't apply."],
      ["Run relevant tests for touched code."],
      ["Summarize what you fixed and what you skipped (with reasons)."],
    ];
  }

  if (hasCallouts) {
    return [
      ["Review the informational callouts above before landing the change."],
      ["Only make code changes if a callout exposes a real issue or missing rollout work."],
      ["If no code changes are needed, say so explicitly."],
      ["Summarize any follow-up or rollout work that still needs to happen."],
    ];
  }

  return [];
}

export function composeReviewPrompt(options: ComposeReviewPromptOptions): string {
  const { files, payload, includedFindings = [], curatedCallouts = [] } = options;
  const fileMap = new Map(files.map((file) => [file.id, file]));
  const explanationMap = new Map(
    files.flatMap((file) => file.hunkExplanations.map((explanation) => [explanation.id, { explanation, filePath: file.displayPath }])),
  );
  const lines: string[] = ["# Diff Review Feedback"];

  const overallComment = payload.overallComment.trim();
  appendSection(lines, "## Overall Note", overallComment.length > 0 ? [overallComment] : []);

  const explanationReplies = payload.explanationReplies.filter((reply) => reply.body.trim().length > 0);
  const comments = payload.comments.filter((comment) => comment.body.trim().length > 0);
  const hasReviewNotes = overallComment.length > 0 || explanationReplies.length > 0 || comments.length > 0;
  appendSection(
    lines,
    "## LLM Explainer Note Replies",
    toNumberedList(
      explanationReplies.map((reply) => {
        const match = explanationMap.get(reply.explanationId);
        const location = match == null ? reply.explanationId : formatExplanationLocation(match.explanation, match.filePath);
        const originalNote = match?.explanation.body.trim() || "Original explainer note unavailable.";
        return [location, `LLM explainer note: ${originalNote}`, `Reviewer reply: ${reply.body.trim()}`];
      }),
    ),
  );

  appendSection(
    lines,
    "## Review Comments",
    toNumberedList(
      comments.map((comment) => {
        const file = fileMap.get(comment.fileId);
        const filePath = file?.displayPath ?? comment.fileId;
        return [formatLocation(comment, filePath), comment.body.trim()];
      }),
    ),
  );

  appendSection(
    lines,
    "## Automated Review Findings",
    toNumberedList(
      includedFindings.map((finding) => {
        const findingLines = [`[${finding.priority}] ${finding.title}`, `Location: ${formatFindingLocation(finding)}`, finding.body.trim()];
        if (typeof finding.suggestion === "string" && finding.suggestion.trim().length > 0) {
          findingLines.push("Suggested fix:", "```suggestion", finding.suggestion.trim(), "```");
        }
        return findingLines;
      }),
    ),
  );

  appendSection(
    lines,
    "## Human Reviewer Callouts (Non-Blocking)",
    curatedCallouts.flatMap((callout, index) => {
      const item = `- ${callout.category}: ${callout.detail}`;
      return index === curatedCallouts.length - 1 ? [item] : [item, ""];
    }),
  );

  appendSection(lines, "## Requested Actions", toNumberedList(buildRequestedActions(includedFindings.length > 0, hasReviewNotes, curatedCallouts.length > 0)));

  return lines.join("\n").trim();
}
