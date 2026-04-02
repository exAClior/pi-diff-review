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

const state = {
  activeFileId: reviewData.files[0].id,
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
const totalExplanationCount = reviewData.files.reduce(
  (count, file) => count + (Array.isArray(file.hunkExplanations) ? file.hunkExplanations.length : 0),
  0,
);

const repoRootEl = document.getElementById("repo-root");
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

function renderChrome() {
  const file = activeFile();
  const submittedCommentCount = state.comments.filter(isCommentSubmitted).length;
  const draftCommentCount = state.comments.filter(needsCommentSubmission).length;
  const submittedExplanationReplyCount = countSubmittedExplanationReplies();
  const draftExplanationReplyCount = state.explanationReplies.filter(needsExplanationReplySubmission).length;
  const reviewIndex = reviewIndexByFileId.get(file.id) ?? 0;
  summaryEl.textContent = `${reviewData.files.length} file(s) · ${totalExplanationCount} explainer note(s) · ${submittedCommentCount} submitted comment(s)${draftCommentCount > 0 ? ` · ${draftCommentCount} draft comment(s)` : ""}${submittedExplanationReplyCount > 0 ? ` · ${submittedExplanationReplyCount} submitted explainer repl${submittedExplanationReplyCount === 1 ? "y" : "ies"}` : ""}${draftExplanationReplyCount > 0 ? ` · ${draftExplanationReplyCount} draft explainer repl${draftExplanationReplyCount === 1 ? "y" : "ies"}` : ""}${state.overallComment ? " · overall note" : ""}`;
  currentFileLabelEl.textContent = file.displayPath;
  currentFileOrderEl.textContent = `Recommended review ${reviewIndex + 1} of ${reviewData.files.length}`;
  currentFileMetaEl.textContent = describeFileStatus(file);

  const disabled = state.busy || state.settled;
  submitButton.disabled = disabled;
  cancelButton.disabled = disabled;
  overallNoteButton.disabled = disabled;
  fileCommentButton.disabled = disabled;
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

function renderFileComments() {
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
    showFlash("Add an overall note, an explainer reply, or a submitted comment before submitting the review.", "warning");
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
