import { FileDiff } from "@pierre/diffs";
import { FileTree } from "@pierre/trees";

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
  busy: false,
  settled: false,
};

const filesById = new Map(reviewData.files.map((file) => [file.id, file]));
const filesByTreePath = new Map(reviewData.files.map((file) => [file.treePath, file]));

const repoRootEl = document.getElementById("repo-root");
const summaryEl = document.getElementById("summary");
const currentFileLabelEl = document.getElementById("current-file-label");
const currentFileMetaEl = document.getElementById("current-file-meta");
const flashMessageEl = document.getElementById("flash-message");
const fileCommentsEl = document.getElementById("file-comments");
const diffRootEl = document.getElementById("diff-root");
const modalRootEl = document.getElementById("modal-root");
const submitButton = document.getElementById("submit-button");
const cancelButton = document.getElementById("cancel-button");
const overallNoteButton = document.getElementById("overall-note-button");
const fileCommentButton = document.getElementById("file-comment-button");

repoRootEl.textContent = reviewData.repoRoot;

let flashTimer = null;
let mountedFileId = null;

const fileTree = new FileTree(
  {
    initialFiles: reviewData.files.map((file) => file.treePath),
    gitStatus: reviewData.files.map((file) => ({
      path: file.treePath,
      status: file.status === "added" ? "added" : file.status === "deleted" ? "deleted" : "modified",
    })),
    flattenEmptyDirectories: true,
  },
  {
    initialSelectedItems: [activeFile().treePath],
    onSelection(items) {
      const nextSelection = items.find((item) => item.isFolder === false);
      if (nextSelection == null) return;
      const file = filesByTreePath.get(nextSelection.path);
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
    const comment = state.comments.find((item) => item.id === annotation.metadata.commentId);
    if (comment == null) {
      return document.createElement("div");
    }
    return createCommentCard(comment, { inline: true });
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
    description: "This note is prepended above the file and line comments in the generated pi prompt.",
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
    description: "Use this for feedback that applies to the whole file instead of one line or range.",
    initialValue: "",
    saveLabel: "Add comment",
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
        body,
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

function renderChrome() {
  const file = activeFile();
  const commentCount = state.comments.length;
  summaryEl.textContent = `${reviewData.files.length} file(s) · ${commentCount} comment(s)${state.overallComment ? " · overall note" : ""}`;
  currentFileLabelEl.textContent = file.displayPath;
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
  renderChrome();
  renderFileComments();
  mountActiveFile();

  if (syncTree) {
    const file = activeFile();
    fileTree.setSelectedItems([file.treePath]);
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
  return state.comments
    .filter((comment) => comment.fileId === fileId && comment.kind !== "file" && comment.side != null && comment.startLine != null)
    .map((comment) => ({
      side: comment.side,
      lineNumber: comment.startLine,
      metadata: {
        commentId: comment.id,
      },
    }));
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
    focusRequested: true,
  });

  diff.setSelectedLines(null);
  renderChrome();
  refreshInlineComments();
}

function renderFileComments() {
  const file = activeFile();
  const comments = state.comments.filter((comment) => comment.fileId === file.id && comment.kind === "file");

  fileCommentsEl.innerHTML = "";
  fileCommentsEl.hidden = comments.length === 0;
  if (comments.length === 0) {
    return;
  }

  for (const comment of comments) {
    fileCommentsEl.appendChild(createCommentCard(comment));
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

function createCommentCard(comment, options = {}) {
  const card = document.createElement("section");
  card.className = `comment-card${options.inline ? " inline-comment" : ""}`;

  const header = document.createElement("div");
  header.className = "comment-card-header";

  const title = document.createElement("div");
  title.className = "comment-card-title";
  title.textContent = describeCommentTarget(comment);

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "comment-delete";
  deleteButton.textContent = "Delete";
  deleteButton.disabled = state.busy || state.settled;
  deleteButton.addEventListener("click", () => {
    state.comments = state.comments.filter((item) => item.id !== comment.id);
    renderChrome();
    renderFileComments();
    refreshInlineComments();
  });

  header.append(title, deleteButton);

  const textarea = document.createElement("textarea");
  textarea.placeholder = "Leave a comment";
  textarea.value = comment.body ?? "";
  textarea.disabled = state.busy || state.settled;
  textarea.addEventListener("input", () => {
    comment.body = textarea.value;
  });

  card.append(header, textarea);

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
    comments: state.comments
      .map((comment) => ({
        id: comment.id,
        fileId: comment.fileId,
        kind: comment.kind,
        side: comment.side,
        startLine: comment.startLine,
        endLine: comment.endLine,
        body: comment.body.trim(),
      }))
      .filter((comment) => comment.body.length > 0),
  };
}

async function submitReview() {
  if (state.busy || state.settled) return;
  state.busy = true;
  renderChrome();

  try {
    const response = await fetch(`/api/submit?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(buildSubmitPayload()),
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
  renderChrome();

  try {
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
