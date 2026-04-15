import { FileDiff } from "@pierre/diffs";
import { FileTree } from "@pierre/trees";
import {
  describeCommentSubmissionState,
  getCommentDraft,
  isCommentSubmitted,
  needsCommentSubmission,
  submitCommentDraft,
} from "./comment-submission.js";
import {
  describeExplanationReplySubmissionState,
  getExplanationReplyDraft,
  isExplanationReplySubmitted,
  needsExplanationReplySubmission,
  submitExplanationReplyDraft,
} from "./explanation-reply-submission.js";
import { highlightInlineExplanation, revealInlineExplanation as revealInlineExplanationCard } from "./inline-explanation.js";
import { createLayoutControls } from "./layout-controls.js";
import { compareReviewTreePaths, createReviewTreePaths } from "./review-tree-order.js";
import { hasReviewContent } from "./review-submit.js";

const token = new URL(window.location.href).searchParams.get("token");

if (token == null || token.length === 0) {
  fatal("Missing review token.");
}

let reviewData;

try {
  reviewData = await loadReviewData(token);
} catch (error) {
  fatal(error instanceof Error ? error.message : String(error));
}

if (!Array.isArray(reviewData.files) || reviewData.files.length === 0) {
  fatal("No changed files were provided for review.");
}

const automatedReview = reviewData.automatedReview ?? null;
const automatedFindings = Array.isArray(automatedReview?.findings) ? automatedReview.findings : [];
const automatedCallouts = Array.isArray(automatedReview?.callouts) ? automatedReview.callouts : [];

const state = {
  activeFileId: reviewData.files[0].id,
  activeRightPaneTab: "notes",
  overallComment: "",
  comments: [],
  explanationReplies: reviewData.files.flatMap((file) =>
    (Array.isArray(file.hunkExplanations) ? file.hunkExplanations : []).map((explanation) => ({
      id: `${explanation.id}:reply`,
      explanationId: explanation.id,
      body: "",
      draftBody: "",
    })),
  ),
  includedFindingIds: new Set(
    automatedFindings
      .filter((finding) => finding.priority === "P0" || finding.priority === "P1")
      .map((finding) => finding.id),
  ),
  includeCallouts: false,
  busy: false,
  settled: false,
};

const filesById = new Map(reviewData.files.map((file) => [file.id, file]));
const reviewIndexByFileId = new Map(reviewData.files.map((file, index) => [file.id, index]));
const reviewTreePaths = createReviewTreePaths(reviewData.files.map((file) => file.treePath));
const reviewTreePathByFileId = new Map(reviewData.files.map((file, index) => [file.id, reviewTreePaths[index]]));
const filesByReviewTreePath = new Map(reviewData.files.map((file, index) => [reviewTreePaths[index], file]));
const explanationsById = new Map(
  reviewData.files.flatMap((file) => (Array.isArray(file.hunkExplanations) ? file.hunkExplanations : []).map((explanation) => [explanation.id, explanation])),
);
const explanationRepliesByExplanationId = new Map(state.explanationReplies.map((reply) => [reply.explanationId, reply]));
const findingsById = new Map(automatedFindings.map((finding) => [finding.id, finding]));
const totalExplanationCount = reviewData.files.reduce(
  (count, file) => count + (Array.isArray(file.hunkExplanations) ? file.hunkExplanations.length : 0),
  0,
);

const repoRootEl = document.getElementById("repo-root");
const reviewVerdictEl = document.getElementById("review-verdict");
const summaryEl = document.getElementById("summary");
const contentGridEl = document.getElementById("content-grid");
const leftPaneSplitterEl = document.getElementById("left-pane-splitter");
const rightPaneSplitterEl = document.getElementById("right-pane-splitter");
const currentFileLabelEl = document.getElementById("current-file-label");
const currentFileOrderEl = document.getElementById("current-file-order");
const currentFileMetaEl = document.getElementById("current-file-meta");
const notesPaneMetaEl = document.getElementById("notes-pane-meta");
const flashMessageEl = document.getElementById("flash-message");
const fileCommentsEl = document.getElementById("file-comments");
const diffRootEl = document.getElementById("diff-root");
const modalRootEl = document.getElementById("modal-root");
const submitButton = document.getElementById("submit-button");
const cancelButton = document.getElementById("cancel-button");
const overallNoteButton = document.getElementById("overall-note-button");
const diffModeColumnButton = document.getElementById("diff-mode-column-button");
const diffModeStackedButton = document.getElementById("diff-mode-stacked-button");
const notesTabButton = document.getElementById("notes-tab-button");
const findingsTabButton = document.getElementById("findings-tab-button");
const fileCommentButton = document.getElementById("file-comment-button");

repoRootEl.textContent = reviewData.repoRoot;

let flashTimer = null;
let mountedFileId = null;
const initialSelectedTreePath = reviewTreePathByFileId.get(state.activeFileId) ?? null;

const fileTree = new FileTree(
  {
    initialFiles: reviewTreePaths,
    sort: {
      comparator: compareReviewTreePaths,
    },
    gitStatus: reviewData.files.map((file, index) => ({
      path: reviewTreePaths[index],
      status: file.status === "added" ? "added" : file.status === "deleted" ? "deleted" : "modified",
    })),
    flattenEmptyDirectories: true,
  },
  {
    initialSelectedItems: initialSelectedTreePath == null ? [] : [initialSelectedTreePath],
    onSelection(items) {
      const nextSelection = items.find((item) => item.isFolder === false);
      if (nextSelection == null) return;
      const file = filesByReviewTreePath.get(nextSelection.path);
      if (file == null) return;
      setActiveFile(file.id, false);
    },
  },
);

fileTree.render({ containerWrapper: document.getElementById("file-tree") });

const diff = new FileDiff({
  theme: { dark: "pierre-dark", light: "pierre-light" },
  themeType: "dark",
  diffStyle: "split",
  enableGutterUtility: true,
  enableLineSelection: true,
  onGutterUtilityClick(range) {
    addInlineCommentFromRange(range);
  },
  renderAnnotation(annotation) {
    if (annotation.metadata?.kind === "hunk-explanation") {
      const explanation = explanationsById.get(annotation.metadata.explanationId);
      if (explanation == null) {
        return document.createElement("div");
      }
      return createExplanationCard(explanation, { inline: true });
    }

    const comment = state.comments.find((item) => item.id === annotation.metadata.commentId);
    if (comment == null) {
      return document.createElement("div");
    }
    return createCommentCard(comment, { inline: true });
  },
});

createLayoutControls({
  shell: contentGridEl,
  leftSplitter: leftPaneSplitterEl,
  rightSplitter: rightPaneSplitterEl,
  columnButton: diffModeColumnButton,
  stackedButton: diffModeStackedButton,
  onDiffModeChange(diffStyle) {
    diff.setOptions({
      ...diff.options,
      diffStyle,
    });
    diff.rerender();
  },
});

submitButton.addEventListener("click", () => {
  void submitReview();
});

cancelButton.addEventListener("click", () => {
  void cancelReview();
});

overallNoteButton.addEventListener("click", () => {
  if (state.settled || state.busy) return;
  showTextModal({
    title: "Overall review note",
    description: "This note is prepended above the file and line comments in the review message sent back to pi.",
    initialValue: state.overallComment,
    saveLabel: "Save note",
    onSave(value) {
      state.overallComment = value.trim();
      renderChrome();
    },
  });
});

notesTabButton.addEventListener("click", () => {
  if (state.activeRightPaneTab === "notes") return;
  state.activeRightPaneTab = "notes";
  renderChrome();
  renderFileComments();
});

findingsTabButton.addEventListener("click", () => {
  if (state.activeRightPaneTab === "findings") return;
  state.activeRightPaneTab = "findings";
  renderChrome();
  renderFileComments();
});

fileCommentButton.addEventListener("click", () => {
  if (state.settled || state.busy) return;
  const file = activeFile();
  showTextModal({
    title: `File comment for ${file.displayPath}`,
    description: "Use this for feedback that applies to the whole file instead of one line or range. The comment stays draft until you submit it on the card.",
    initialValue: "",
    saveLabel: "Create draft",
    onSave(value) {
      const body = value.trim();
      if (body.length === 0) return;
      state.comments.push({
        id: createId(),
        fileId: file.id,
        kind: "file",
        side: null,
        startLine: null,
        endLine: null,
        body: "",
        draftBody: body,
      });
      renderChrome();
      renderFileComments();
    },
  });
});

window.addEventListener("beforeunload", () => {
  if (!state.settled && navigator.sendBeacon != null) {
    navigator.sendBeacon(`/api/cancel?token=${encodeURIComponent(token)}`);
  }
});

renderChrome();
renderFileComments();
mountActiveFile();

if (
  typeof reviewData.explanationStatus?.summary === "string" &&
  reviewData.explanationStatus.summary.length > 0 &&
  reviewData.explanationStatus.state !== "generated"
) {
  showFlash(reviewData.explanationStatus.summary, "warning", true);
}

function fatal(message) {
  document.body.innerHTML = `<main style="display:grid;place-items:center;min-height:100vh;background:#0d1117;color:#c9d1d9;font-family:Inter,system-ui,sans-serif;padding:24px;text-align:center;"><div><h1 style="margin:0 0 12px;font-size:20px;">Diff review failed</h1><p style="margin:0;color:#8b949e;">${escapeHtml(message)}</p></div></main>`;
  throw new Error(message);
}

async function loadReviewData(reviewToken) {
  const response = await fetch(`/api/review?token=${encodeURIComponent(reviewToken)}`, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Failed to load review data (${response.status}).`);
  }

  return response.json();
}

function activeFile() {
  return filesById.get(state.activeFileId);
}

function createId() {
  if (window.crypto?.randomUUID != null) {
    return window.crypto.randomUUID();
  }
  return `${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

function describeFileStatus(file) {
  if (file.status === "renamed") {
    return "Renamed file. Drag in the gutter to add a range comment on one side, or click once for a line comment.";
  }
  if (file.status === "added") {
    return "Added file. Click or drag in the gutter to add line or range comments on the new side.";
  }
  if (file.status === "deleted") {
    return "Deleted file. Click or drag in the gutter to add line or range comments on the old side.";
  }
  return "Click or drag in the gutter to add line or range comments on one side of the diff.";
}

function countSubmittedExplanationReplies() {
  return state.explanationReplies.filter(isExplanationReplySubmitted).length;
}

function describeAutomatedReviewVerdict() {
  if (automatedReview == null) {
    return null;
  }

  if (automatedReview.verdict === "correct") {
    return { tone: "correct", text: "✅ Looks correct" };
  }

  if (automatedReview.verdict === "needs_attention") {
    return { tone: "needs-attention", text: "⚠️ Needs attention" };
  }

  if (automatedReview.status?.state?.startsWith("skipped")) {
    return { tone: "skipped", text: "Automated review skipped" };
  }

  if (automatedReview.status?.state === "request-failed" || automatedReview.status?.state === "invalid-response") {
    return { tone: "failed", text: "Automated review unavailable" };
  }

  return null;
}

function describeFindingsSummary(includedFindingCount) {
  if (automatedReview == null) {
    return null;
  }

  if (automatedFindings.length > 0) {
    const priorityBreakdown = ["P0", "P1", "P2", "P3"]
      .map((priority) => {
        const count = automatedFindings.filter((finding) => finding.priority === priority).length;
        return count > 0 ? `${count} ${priority}` : null;
      })
      .filter(Boolean)
      .join(", ");

    return `review: ${automatedFindings.length} finding${automatedFindings.length === 1 ? "" : "s"} (${includedFindingCount} selected · ${priorityBreakdown})`;
  }

  if (automatedReview.status?.state === "no-findings") {
    return automatedCallouts.length > 0
      ? `review: clean (${automatedCallouts.length} optional callout${automatedCallouts.length === 1 ? "" : "s"})`
      : "review: clean";
  }

  if (automatedReview.status?.state?.startsWith("skipped")) {
    return "review: skipped";
  }

  if (automatedReview.status?.state === "request-failed" || automatedReview.status?.state === "invalid-response") {
    return "review: unavailable";
  }

  return "review: pending";
}

function countIncludedFindings() {
  return automatedFindings.filter((finding) => state.includedFindingIds.has(finding.id)).length;
}

function countOtherFileFindings(fileId) {
  return automatedFindings.filter((finding) => finding.location?.fileId != null && finding.location.fileId !== fileId).length;
}

function describeFindingsPaneMeta(currentFileFindings, globalFindings, otherFileFindingsCount) {
  if (automatedFindings.length === 0) {
    return automatedCallouts.length > 0
      ? `Clean · ${automatedCallouts.length} optional callout${automatedCallouts.length === 1 ? "" : "s"}`
      : "Clean";
  }

  const parts = [];
  if (currentFileFindings.length > 0) {
    parts.push(`${currentFileFindings.length} in this file`);
  }
  if (globalFindings.length > 0) {
    parts.push(`${globalFindings.length} across files`);
  }
  if (otherFileFindingsCount > 0) {
    parts.push(`${otherFileFindingsCount} on other files`);
  }

  return parts.join(" · ");
}

function createFindingsOverview(includedFindingCount) {
  if (automatedFindings.length === 0 && automatedCallouts.length === 0) {
    return null;
  }

  const overview = document.createElement("section");
  overview.className = "findings-overview";

  const title = document.createElement("div");
  title.className = "comment-card-title findings-overview-title";

  const summaryParts = [];
  if (automatedFindings.length > 0) {
    summaryParts.push(`${automatedFindings.length} total finding${automatedFindings.length === 1 ? "" : "s"}`);
    summaryParts.push(`${includedFindingCount} selected`);
  } else {
    summaryParts.push("No issues found. ✅");
  }
  if (automatedCallouts.length > 0) {
    summaryParts.push(`${automatedCallouts.length} optional callout${automatedCallouts.length === 1 ? "" : "s"}`);
  }
  title.textContent = summaryParts.join(" · ");

  const hint = document.createElement("p");
  hint.className = "findings-overview-hint";
  hint.textContent = automatedFindings.length > 0
    ? "Suggestions only. Only selected items are sent on submit."
    : "Informational only. Callouts stay off unless you include them.";

  overview.append(title, hint);
  return overview;
}

function renderChrome() {
  const file = activeFile();
  const submittedCommentCount = state.comments.filter(isCommentSubmitted).length;
  const draftCommentCount = state.comments.filter(needsCommentSubmission).length;
  const submittedExplanationReplyCount = countSubmittedExplanationReplies();
  const draftExplanationReplyCount = state.explanationReplies.filter(needsExplanationReplySubmission).length;
  const reviewIndex = reviewIndexByFileId.get(file.id) ?? 0;
  const includedFindingCount = countIncludedFindings();
  const summaryParts = [`${reviewData.files.length} file(s)`, `${totalExplanationCount} explainer note(s)`];
  const findingsSummary = describeFindingsSummary(includedFindingCount);

  if (findingsSummary != null) {
    summaryParts.push(findingsSummary);
  }
  if (submittedCommentCount > 0) {
    summaryParts.push(`${submittedCommentCount} submitted comment(s)`);
  }
  if (draftCommentCount > 0) {
    summaryParts.push(`${draftCommentCount} draft comment(s)`);
  }
  if (submittedExplanationReplyCount > 0) {
    summaryParts.push(`${submittedExplanationReplyCount} submitted explainer repl${submittedExplanationReplyCount === 1 ? "y" : "ies"}`);
  }
  if (draftExplanationReplyCount > 0) {
    summaryParts.push(`${draftExplanationReplyCount} draft explainer repl${draftExplanationReplyCount === 1 ? "y" : "ies"}`);
  }
  if (state.overallComment) {
    summaryParts.push("overall note");
  }
  if (state.includeCallouts && automatedCallouts.length > 0) {
    summaryParts.push("callouts included");
  }

  summaryEl.textContent = summaryParts.join(" · ");
  currentFileLabelEl.textContent = file.displayPath;
  currentFileOrderEl.textContent = `Recommended review ${reviewIndex + 1} of ${reviewData.files.length}`;
  currentFileMetaEl.textContent = describeFileStatus(file);

  const verdict = describeAutomatedReviewVerdict();
  if (verdict == null) {
    reviewVerdictEl.hidden = true;
    reviewVerdictEl.textContent = "";
    delete reviewVerdictEl.dataset.tone;
  } else {
    reviewVerdictEl.hidden = false;
    reviewVerdictEl.dataset.tone = verdict.tone;
    reviewVerdictEl.textContent = verdict.text;
  }

  notesTabButton.classList.toggle("is-active", state.activeRightPaneTab === "notes");
  findingsTabButton.classList.toggle("is-active", state.activeRightPaneTab === "findings");
  notesTabButton.setAttribute("aria-selected", String(state.activeRightPaneTab === "notes"));
  findingsTabButton.setAttribute("aria-selected", String(state.activeRightPaneTab === "findings"));

  const disabled = state.busy || state.settled;
  submitButton.disabled = disabled;
  cancelButton.disabled = disabled;
  overallNoteButton.disabled = disabled;
  fileCommentButton.disabled = disabled || state.activeRightPaneTab !== "notes";
}

function setActiveFile(fileId, syncTree = true) {
  if (!filesById.has(fileId) || state.activeFileId === fileId) {
    return;
  }

  state.activeFileId = fileId;
  diffRootEl.scrollTop = 0;
  diffRootEl.scrollLeft = 0;
  fileCommentsEl.scrollTop = 0;
  fileCommentsEl.scrollLeft = 0;
  renderChrome();
  renderFileComments();
  mountActiveFile();

  if (syncTree) {
    const reviewTreePath = reviewTreePathByFileId.get(fileId);
    if (reviewTreePath != null) {
      fileTree.setSelectedItems([reviewTreePath]);
    }
  }
}

// Keep one diff instance alive and only swap the active file into it.
// That keeps the browser UI small and avoids paying for every file at once.
function mountActiveFile() {
  const file = activeFile();
  mountedFileId = file.id;

  diff.render({
    oldFile: {
      name: file.oldPath ?? file.newPath ?? file.treePath,
      contents: file.oldContent,
    },
    newFile: {
      name: file.newPath ?? file.oldPath ?? file.treePath,
      contents: file.newContent,
    },
    lineAnnotations: buildInlineAnnotations(file.id),
    containerWrapper: diffRootEl,
  });
}

function refreshInlineComments() {
  const file = activeFile();
  if (mountedFileId !== file.id) {
    mountActiveFile();
    return;
  }

  diff.setLineAnnotations(buildInlineAnnotations(file.id));
  diff.rerender();
}

function buildInlineAnnotations(fileId) {
  const file = filesById.get(fileId);
  const explanationAnnotations = (Array.isArray(file?.hunkExplanations) ? file.hunkExplanations : []).map((explanation) => ({
    side: explanation.anchorSide,
    lineNumber: explanation.anchorLine,
    metadata: {
      kind: "hunk-explanation",
      explanationId: explanation.id,
    },
  }));

  const commentAnnotations = state.comments
    .filter((comment) => comment.fileId === fileId && comment.kind !== "file" && comment.side != null && comment.startLine != null)
    .map((comment) => ({
      side: comment.side,
      lineNumber: comment.startLine,
      metadata: {
        commentId: comment.id,
      },
    }));

  return [...explanationAnnotations, ...commentAnnotations];
}

function addInlineCommentFromRange(range) {
  if (state.settled || state.busy) return;

  const side = range.endSide ?? range.side;
  if (side !== "deletions" && side !== "additions") {
    showFlash("Inline comments need a concrete diff side.", "warning");
    return;
  }

  if ((range.side ?? side) !== side || (range.endSide ?? side) !== side) {
    showFlash("Range comments must stay on one side of the diff.", "warning");
    diff.setSelectedLines(null);
    return;
  }

  const startLine = Math.min(range.start, range.end);
  const endLine = Math.max(range.start, range.end);

  state.comments.push({
    id: createId(),
    fileId: activeFile().id,
    kind: startLine === endLine ? "line" : "range",
    side,
    startLine,
    endLine,
    body: "",
    draftBody: "",
    focusRequested: true,
  });

  diff.setSelectedLines(null);
  renderChrome();
  refreshInlineComments();
}

function renderNotesPane() {
  const file = activeFile();
  const explanations = Array.isArray(file.hunkExplanations) ? file.hunkExplanations : [];
  const comments = state.comments.filter((comment) => comment.fileId === file.id && comment.kind === "file");

  fileCommentsEl.innerHTML = "";
  notesPaneMetaEl.textContent = `${explanations.length} explainer note${explanations.length === 1 ? "" : "s"}${comments.length > 0 ? ` · ${comments.length} file comment${comments.length === 1 ? "" : "s"}` : ""}`;

  if (explanations.length > 0) {
    fileCommentsEl.appendChild(createNotesSectionLabel("Why this changed"));
    fileCommentsEl.appendChild(createExplanationOverviewCard(explanations.length));
    for (const explanation of explanations) {
      fileCommentsEl.appendChild(createExplanationSummaryCard(explanation));
    }
  }

  if (comments.length > 0) {
    fileCommentsEl.appendChild(createNotesSectionLabel("File comments"));
    for (const comment of comments) {
      fileCommentsEl.appendChild(createCommentCard(comment));
    }
  }

  if (explanations.length === 0 && comments.length === 0) {
    fileCommentsEl.appendChild(createEmptyNotesState());
  }
}

function renderFileComments() {
  if (state.activeRightPaneTab === "findings") {
    renderFindingsPane();
    return;
  }

  renderNotesPane();
}

function describeCommentTarget(comment) {
  if (comment.kind === "file") {
    return "File comment";
  }

  const sideLabel = comment.side === "deletions" ? "Old" : "New";
  if (comment.kind === "range" && comment.endLine != null && comment.endLine !== comment.startLine) {
    return `${sideLabel} lines ${comment.startLine}-${comment.endLine}`;
  }
  return `${sideLabel} line ${comment.startLine}`;
}

function createNotesSectionLabel(text) {
  const label = document.createElement("div");
  label.className = "notes-section-label";
  label.textContent = text;
  return label;
}

function createEmptyNotesState() {
  const emptyState = document.createElement("div");
  emptyState.className = "notes-empty-state";
  emptyState.textContent = "No explainer notes or file comments for this file yet.";
  return emptyState;
}

function createFindingsEmptyState(message) {
  const emptyState = document.createElement("div");
  emptyState.className = "notes-empty-state";
  emptyState.textContent = message;
  return emptyState;
}

function formatFindingLocation(location) {
  if (location.fileId == null) {
    return location.filePath || "Across files";
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

function renderFindingsPane() {
  const file = activeFile();
  const currentFileFindings = automatedFindings.filter((finding) => finding.location?.fileId === file.id);
  const globalFindings = automatedFindings.filter((finding) => finding.location?.fileId == null);
  const otherFileFindingsCount = countOtherFileFindings(file.id);
  const includedFindingCount = countIncludedFindings();

  fileCommentsEl.innerHTML = "";

  if (automatedReview == null) {
    notesPaneMetaEl.textContent = "Automated review unavailable";
    fileCommentsEl.appendChild(createFindingsEmptyState("Automated review data was not available for this diff."));
    return;
  }

  if (automatedReview.status?.state === "skipped-no-model" || automatedReview.status?.state === "skipped-no-auth" || automatedReview.status?.state === "skipped-too-large") {
    notesPaneMetaEl.textContent = "Automated review skipped";
    fileCommentsEl.appendChild(createFindingsEmptyState(automatedReview.status.summary));
    return;
  }

  if (automatedReview.status?.state === "request-failed" || automatedReview.status?.state === "invalid-response") {
    notesPaneMetaEl.textContent = "Automated review unavailable";
    fileCommentsEl.appendChild(createFindingsEmptyState(`${automatedReview.status.summary} You can still review manually.`));
    return;
  }

  notesPaneMetaEl.textContent = describeFindingsPaneMeta(currentFileFindings, globalFindings, otherFileFindingsCount);

  const overview = createFindingsOverview(includedFindingCount);
  if (overview != null) {
    fileCommentsEl.appendChild(overview);
  }

  if (currentFileFindings.length > 0) {
    fileCommentsEl.appendChild(createNotesSectionLabel("This file"));
    for (const finding of currentFileFindings) {
      fileCommentsEl.appendChild(createFindingCard(finding));
    }
  }

  if (globalFindings.length > 0) {
    fileCommentsEl.appendChild(createNotesSectionLabel("Across files"));
    for (const finding of globalFindings) {
      fileCommentsEl.appendChild(createFindingCard(finding));
    }
  }

  if (currentFileFindings.length === 0 && globalFindings.length === 0) {
    if (automatedFindings.length === 0 && automatedCallouts.length === 0) {
      fileCommentsEl.appendChild(createFindingsEmptyState("No issues found. ✅"));
    } else if (automatedFindings.length > 0) {
      fileCommentsEl.appendChild(
        createFindingsEmptyState(
          `No findings for this file. ${otherFileFindingsCount} finding${otherFileFindingsCount === 1 ? "" : "s"} ${otherFileFindingsCount === 1 ? "is" : "are"} on other file${otherFileFindingsCount === 1 ? "" : "s"}.`,
        ),
      );
    }
  }

  if (automatedCallouts.length > 0) {
    fileCommentsEl.appendChild(createCalloutsSection());
  }
}

function createFindingCard(finding) {
  const card = document.createElement("section");
  card.className = "comment-card finding-card";

  const header = document.createElement("div");
  header.className = "comment-card-header";

  const heading = document.createElement("div");
  heading.className = "comment-card-heading";

  const badge = document.createElement("span");
  badge.className = `finding-priority finding-priority-${finding.priority.toLowerCase()}`;
  badge.textContent = finding.priority;

  const title = document.createElement("div");
  title.className = "comment-card-title";
  title.textContent = finding.title;

  const locationButton = document.createElement(finding.location?.fileId != null ? "button" : "div");
  locationButton.className = finding.location?.fileId != null ? "finding-location finding-location-button" : "finding-location";
  locationButton.textContent = formatFindingLocation(finding.location);
  if (finding.location?.fileId != null) {
    locationButton.type = "button";
    locationButton.addEventListener("click", () => {
      setActiveFile(finding.location.fileId);
    });
  }

  heading.append(badge, title, locationButton);
  header.append(heading);

  const body = document.createElement("p");
  body.className = "explanation-body";
  body.textContent = finding.body;

  const actions = document.createElement("div");
  actions.className = "finding-actions";

  const includeLabel = document.createElement("label");
  includeLabel.className = "finding-toggle";

  const includeCheckbox = document.createElement("input");
  includeCheckbox.type = "checkbox";
  includeCheckbox.setAttribute("aria-label", `Include finding: ${finding.title}`);
  includeCheckbox.checked = state.includedFindingIds.has(finding.id);
  includeCheckbox.disabled = state.busy || state.settled;
  includeCheckbox.addEventListener("change", () => {
    if (includeCheckbox.checked) {
      state.includedFindingIds.add(finding.id);
    } else {
      state.includedFindingIds.delete(finding.id);
    }
    renderChrome();
    renderFileComments();
  });

  const includeText = document.createElement("span");
  includeText.textContent = "Include";

  includeLabel.append(includeCheckbox, includeText);
  actions.append(includeLabel);

  card.append(header, body);

  if (typeof finding.suggestion === "string" && finding.suggestion.length > 0) {
    const suggestionLabel = document.createElement("div");
    suggestionLabel.className = "notes-section-label";
    suggestionLabel.textContent = "Suggested change";

    const suggestionBlock = document.createElement("pre");
    suggestionBlock.className = "finding-suggestion";
    suggestionBlock.textContent = finding.suggestion;
    card.append(suggestionLabel, suggestionBlock);
  }

  card.append(actions);
  return card;
}

function createCalloutsSection() {
  const details = document.createElement("details");
  details.className = "callouts-section";

  const summary = document.createElement("summary");
  summary.textContent = `Optional callouts (${automatedCallouts.length})`;

  const hint = document.createElement("p");
  hint.className = "callouts-hint";
  hint.textContent = "Informational only. Not sent unless you include them.";

  const toggleLabel = document.createElement("label");
  toggleLabel.className = "finding-toggle callouts-toggle";

  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.checked = state.includeCallouts;
  toggle.disabled = state.busy || state.settled;
  toggle.addEventListener("change", () => {
    state.includeCallouts = toggle.checked;
    renderChrome();
  });

  const toggleText = document.createElement("span");
  toggleText.textContent = "Include callouts";
  toggleLabel.append(toggle, toggleText);

  const list = document.createElement("div");
  list.className = "callouts-list";

  for (const callout of automatedCallouts) {
    const item = document.createElement("section");
    item.className = "comment-card finding-card callout-card";

    const title = document.createElement("div");
    title.className = "comment-card-title";
    title.textContent = callout.category;

    const detail = document.createElement("p");
    detail.className = "explanation-body";
    detail.textContent = callout.detail;

    item.append(title, detail);
    list.appendChild(item);
  }

  details.append(summary, hint, toggleLabel, list);
  return details;
}

function formatExplanationRange(label, startLine, endLine) {
  if (startLine == null || endLine == null) {
    return null;
  }

  if (startLine === endLine) {
    return `${label} ${startLine}`;
  }

  return `${label} ${startLine}-${endLine}`;
}

function describeExplanationTarget(explanation) {
  const parts = [
    formatExplanationRange("old", explanation.oldStartLine, explanation.oldEndLine),
    formatExplanationRange("new", explanation.newStartLine, explanation.newEndLine),
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" · ") : "hunk explanation";
}

function createExplanationOverviewCard(explanationCount) {
  const card = document.createElement("section");
  card.className = "comment-card explanation-card explanation-help-card";

  const title = document.createElement("div");
  title.className = "comment-card-title";
  title.textContent = "Inline reason notes are attached to the diff";

  const body = document.createElement("p");
  body.className = "explanation-help-body";
  body.textContent = `${explanationCount} LLM explainer note(s) summarize the visible intent of the changed hunks. Use “Jump to inline note” to land on the exact modified lines, then reply there if the explanation is wrong or incomplete.`;

  card.append(title, body);
  return card;
}

function revealInlineExplanation(explanationId) {
  return revealInlineExplanationCard(diffRootEl, explanationId, {
    onMissing() {
      showFlash("Could not find the inline explainer note for this change yet.", "warning");
    },
    highlight: highlightInlineExplanation,
  });
}

function createExplanationSummaryCard(explanation) {
  const card = document.createElement("section");
  card.className = "comment-card explanation-card explanation-summary-card";

  const header = document.createElement("div");
  header.className = "comment-card-header";

  const heading = document.createElement("div");
  heading.className = "comment-card-heading";

  const badge = document.createElement("span");
  badge.className = "explanation-badge";
  badge.textContent = "LLM explainer";

  const title = document.createElement("div");
  title.className = "comment-card-title";
  title.textContent = describeExplanationTarget(explanation);

  heading.append(badge, title);
  header.append(heading);

  const body = document.createElement("p");
  body.className = "explanation-body";
  body.textContent = explanation.body;

  const actions = document.createElement("div");
  actions.className = "explanation-summary-actions";

  const hint = document.createElement("div");
  hint.className = "reply-hint";
  hint.textContent = "This note is also attached inline in the diff at the changed lines.";

  const jumpButton = document.createElement("button");
  jumpButton.type = "button";
  jumpButton.className = "button";
  jumpButton.textContent = "Jump to inline note";
  jumpButton.addEventListener("click", () => {
    revealInlineExplanation(explanation.id);
  });

  actions.append(hint, jumpButton);
  card.append(header, body, actions);
  return card;
}

function createExplanationCard(explanation, options = {}) {
  const reply = explanationRepliesByExplanationId.get(explanation.id);
  const card = document.createElement("section");
  card.className = `comment-card explanation-card${options.inline ? " inline-comment" : ""}`;
  if (options.inline) {
    card.dataset.inlineExplanationId = explanation.id;
  }

  const header = document.createElement("div");
  header.className = "comment-card-header";

  const heading = document.createElement("div");
  heading.className = "comment-card-heading";

  const badge = document.createElement("span");
  badge.className = "explanation-badge";
  badge.textContent = "LLM explainer";

  const title = document.createElement("div");
  title.className = "comment-card-title";
  title.textContent = describeExplanationTarget(explanation);

  const status = document.createElement("span");
  status.className = "comment-status";

  heading.append(badge, title, status);
  header.append(heading);

  const body = document.createElement("p");
  body.className = "explanation-body";
  body.textContent = explanation.body;

  card.append(header, body);

  if (reply != null) {
    const replyLabel = document.createElement("label");
    replyLabel.className = "reply-label";
    replyLabel.textContent = "Your reply";

    const replyHint = document.createElement("div");
    replyHint.className = "reply-hint";

    const textarea = document.createElement("textarea");
    textarea.className = "explanation-reply";
    textarea.placeholder = "Tell pi what this explanation got wrong, missed, or should emphasize.";
    textarea.value = getExplanationReplyDraft(reply);
    textarea.addEventListener("input", () => {
      reply.draftBody = textarea.value;
      syncExplanationReplyCardState();
      renderChrome();
    });

    const actions = document.createElement("div");
    actions.className = "comment-card-actions";

    const submitReplyButton = document.createElement("button");
    submitReplyButton.type = "button";
    submitReplyButton.className = "button button-primary comment-submit";
    submitReplyButton.addEventListener("click", () => {
      if (state.busy || state.settled) return;
      submitExplanationReplyDraft(reply);
      syncExplanationReplyCardState();
      renderChrome();
    });

    actions.append(replyHint, submitReplyButton);
    card.append(replyLabel, textarea, actions);

    function syncExplanationReplyCardState() {
      const submissionState = describeExplanationReplySubmissionState(reply);
      const disabled = state.busy || state.settled;

      status.dataset.tone = submissionState.tone;
      status.textContent = submissionState.label;
      replyHint.textContent = submissionState.hint;
      textarea.disabled = disabled;
      submitReplyButton.disabled = disabled || submissionState.buttonDisabled;
      submitReplyButton.textContent = submissionState.buttonLabel;
    }

    syncExplanationReplyCardState();
  } else {
    status.dataset.tone = "submitted";
    status.textContent = "Submitted";
  }

  return card;
}

function createCommentCard(comment, options = {}) {
  const card = document.createElement("section");
  card.className = `comment-card${options.inline ? " inline-comment" : ""}`;

  const header = document.createElement("div");
  header.className = "comment-card-header";

  const heading = document.createElement("div");
  heading.className = "comment-card-heading";

  const title = document.createElement("div");
  title.className = "comment-card-title";
  title.textContent = describeCommentTarget(comment);

  const status = document.createElement("span");
  status.className = "comment-status";

  heading.append(title, status);

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "comment-delete";
  deleteButton.textContent = "Delete";
  deleteButton.addEventListener("click", () => {
    state.comments = state.comments.filter((item) => item.id !== comment.id);
    renderChrome();
    renderFileComments();
    refreshInlineComments();
  });

  header.append(heading, deleteButton);

  const textarea = document.createElement("textarea");
  textarea.placeholder = "Leave a comment";
  textarea.value = getCommentDraft(comment);
  textarea.addEventListener("input", () => {
    comment.draftBody = textarea.value;
    syncCommentCardState();
    renderChrome();
  });

  const actions = document.createElement("div");
  actions.className = "comment-card-actions";

  const hint = document.createElement("div");
  hint.className = "comment-status-hint";

  const submitCommentButton = document.createElement("button");
  submitCommentButton.type = "button";
  submitCommentButton.className = "button button-primary comment-submit";
  submitCommentButton.addEventListener("click", () => {
    if (state.busy || state.settled) return;
    submitCommentDraft(comment);
    syncCommentCardState();
    renderChrome();
  });

  actions.append(hint, submitCommentButton);
  card.append(header, textarea, actions);

  function syncCommentCardState() {
    const submissionState = describeCommentSubmissionState(comment);
    const disabled = state.busy || state.settled;

    status.dataset.tone = submissionState.tone;
    status.textContent = submissionState.label;
    hint.textContent = submissionState.hint;
    textarea.disabled = disabled;
    deleteButton.disabled = disabled;
    submitCommentButton.disabled = disabled || submissionState.buttonDisabled;
    submitCommentButton.textContent = submissionState.buttonLabel;
  }

  syncCommentCardState();

  if (comment.focusRequested === true) {
    comment.focusRequested = false;
    queueMicrotask(() => textarea.focus());
  }

  return card;
}

function showFlash(message, tone = "error", persist = false) {
  if (flashTimer != null) {
    window.clearTimeout(flashTimer);
    flashTimer = null;
  }

  flashMessageEl.hidden = false;
  flashMessageEl.dataset.tone = tone;
  flashMessageEl.textContent = message;

  if (persist) {
    return;
  }

  flashTimer = window.setTimeout(() => {
    flashMessageEl.hidden = true;
    flashMessageEl.textContent = "";
    flashTimer = null;
  }, 4500);
}

function showTextModal(options) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";

  const modal = document.createElement("div");
  modal.className = "modal";

  const title = document.createElement("h2");
  title.textContent = options.title;

  const description = document.createElement("p");
  description.textContent = options.description;

  const textarea = document.createElement("textarea");
  textarea.value = options.initialValue ?? "";

  const actions = document.createElement("div");
  actions.className = "modal-actions";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "button";
  cancel.textContent = "Cancel";

  const save = document.createElement("button");
  save.type = "button";
  save.className = "button button-primary";
  save.textContent = options.saveLabel ?? "Save";

  function close() {
    backdrop.remove();
  }

  cancel.addEventListener("click", close);
  save.addEventListener("click", () => {
    options.onSave(textarea.value);
    close();
  });
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) {
      close();
    }
  });

  modal.append(title, description, textarea);
  actions.append(cancel, save);
  modal.append(actions);
  backdrop.append(modal);
  modalRootEl.append(backdrop);

  queueMicrotask(() => textarea.focus());
}

function buildSubmitPayload() {
  const includedFindingIds = automatedFindings.filter((finding) => state.includedFindingIds.has(finding.id)).map((finding) => finding.id);

  return {
    type: "submit",
    overallComment: state.overallComment.trim(),
    explanationReplies: state.explanationReplies
      .filter(isExplanationReplySubmitted)
      .map((reply) => ({
        id: reply.id,
        explanationId: reply.explanationId,
        body: reply.body.trim(),
      })),
    comments: state.comments
      .filter(isCommentSubmitted)
      .map((comment) => ({
        id: comment.id,
        fileId: comment.fileId,
        kind: comment.kind,
        side: comment.side,
        startLine: comment.startLine,
        endLine: comment.endLine,
        body: comment.body.trim(),
      })),
    ...(includedFindingIds.length > 0 ? { includedFindingIds } : {}),
    ...(automatedCallouts.length > 0 && state.includeCallouts ? { includeCallouts: true } : {}),
  };
}

async function submitReview() {
  if (state.busy || state.settled) return;

  const draftCommentCount = state.comments.filter(needsCommentSubmission).length;
  const draftExplanationReplyCount = state.explanationReplies.filter(needsExplanationReplySubmission).length;
  if (draftCommentCount > 0 || draftExplanationReplyCount > 0) {
    const pendingItems = [];
    if (draftExplanationReplyCount > 0) {
      pendingItems.push(`${draftExplanationReplyCount} explainer repl${draftExplanationReplyCount === 1 ? "y" : "ies"}`);
    }
    if (draftCommentCount > 0) {
      pendingItems.push(`${draftCommentCount} comment${draftCommentCount === 1 ? "" : "s"}`);
    }
    showFlash(`Submit or clear ${pendingItems.join(" and ")} before submitting the review.`, "warning");
    return;
  }

  const payload = buildSubmitPayload();
  if (!hasReviewContent(payload)) {
    showFlash("Add an overall note, an explainer reply, a submitted comment, or include automated review findings before submitting the review.", "warning");
    return;
  }

  state.busy = true;

  try {
    renderChrome();
    renderFileComments();
    refreshInlineComments();

    const response = await fetch(`/api/submit?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Submit failed with status ${response.status}.`);
    }

    state.settled = true;
    showFlash("Review submitted. You can close this tab.", "info", true);
  } catch (error) {
    showFlash(error instanceof Error ? error.message : String(error));
  } finally {
    state.busy = false;
    renderChrome();
    renderFileComments();
    refreshInlineComments();
  }
}

async function cancelReview() {
  if (state.busy || state.settled) return;
  state.busy = true;

  try {
    renderChrome();
    renderFileComments();
    refreshInlineComments();

    const response = await fetch(`/api/cancel?token=${encodeURIComponent(token)}`, {
      method: "POST",
    });

    if (!response.ok) {
      throw new Error(`Cancel failed with status ${response.status}.`);
    }

    state.settled = true;
    showFlash("Review cancelled. You can close this tab.", "info", true);
  } catch (error) {
    showFlash(error instanceof Error ? error.message : String(error));
  } finally {
    state.busy = false;
    renderChrome();
    renderFileComments();
    refreshInlineComments();
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}
