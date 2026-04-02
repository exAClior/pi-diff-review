const DEFAULT_LEFT_PANE_WIDTH = 300;
const DEFAULT_RIGHT_PANE_WIDTH = 360;
const MIN_LEFT_PANE_WIDTH = 220;
const MIN_CENTER_PANE_WIDTH = 340;
const MIN_RIGHT_PANE_WIDTH = 260;
const SPLITTER_WIDTH = 10;
const NARROW_LAYOUT_MEDIA_QUERY = "(max-width: 860px)";

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getDiffStyle(mode) {
  return mode === "stacked" ? "unified" : "split";
}

export function createLayoutControls({
  shell,
  leftSplitter,
  rightSplitter,
  columnButton,
  stackedButton,
  onDiffModeChange,
}) {
  const state = {
    diffMode: "column",
    leftPaneWidth: DEFAULT_LEFT_PANE_WIDTH,
    rightPaneWidth: DEFAULT_RIGHT_PANE_WIDTH,
    drag: null,
  };

  const narrowLayoutQuery = window.matchMedia(NARROW_LAYOUT_MEDIA_QUERY);
  const resizeObserver = new ResizeObserver(() => {
    clampPaneWidths();
  });

  function syncDiffModeButtons() {
    for (const [mode, button] of [
      ["column", columnButton],
      ["stacked", stackedButton],
    ]) {
      const isActive = state.diffMode === mode;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
    }
  }

  function applyPaneWidths() {
    shell.style.setProperty("--left-pane-width", `${state.leftPaneWidth}px`);
    shell.style.setProperty("--right-pane-width", `${state.rightPaneWidth}px`);
    leftSplitter.dataset.dragging = String(state.drag?.side === "left");
    rightSplitter.dataset.dragging = String(state.drag?.side === "right");
  }

  function endResize(pointerId) {
    if (state.drag == null || (pointerId != null && state.drag.pointerId !== pointerId)) {
      return;
    }

    const activeSplitter = state.drag.side === "left" ? leftSplitter : rightSplitter;
    if (activeSplitter.hasPointerCapture?.(state.drag.pointerId)) {
      activeSplitter.releasePointerCapture(state.drag.pointerId);
    }

    state.drag = null;
    document.body.classList.remove("is-resizing");
    applyPaneWidths();
  }

  function clampPaneWidths() {
    if (narrowLayoutQuery.matches) {
      applyPaneWidths();
      return;
    }

    const containerWidth = shell.clientWidth;
    if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
      return;
    }

    const maxSideWidthBudget = containerWidth - SPLITTER_WIDTH * 2 - MIN_CENTER_PANE_WIDTH;
    const leftMax = Math.max(MIN_LEFT_PANE_WIDTH, maxSideWidthBudget - MIN_RIGHT_PANE_WIDTH);
    state.leftPaneWidth = clamp(state.leftPaneWidth, MIN_LEFT_PANE_WIDTH, leftMax);

    const rightMax = Math.max(MIN_RIGHT_PANE_WIDTH, maxSideWidthBudget - state.leftPaneWidth);
    state.rightPaneWidth = clamp(state.rightPaneWidth, MIN_RIGHT_PANE_WIDTH, rightMax);
    applyPaneWidths();
  }

  function beginResize(side, event) {
    if (event.button !== 0 || narrowLayoutQuery.matches) {
      return;
    }

    event.preventDefault();
    const splitter = side === "left" ? leftSplitter : rightSplitter;
    splitter.setPointerCapture?.(event.pointerId);

    state.drag = {
      side,
      pointerId: event.pointerId,
      startX: event.clientX,
      startLeftPaneWidth: state.leftPaneWidth,
      startRightPaneWidth: state.rightPaneWidth,
    };

    document.body.classList.add("is-resizing");
    applyPaneWidths();
  }

  function handlePointerMove(event) {
    if (state.drag == null || state.drag.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    const containerWidth = shell.clientWidth;
    const maxSideWidthBudget = containerWidth - SPLITTER_WIDTH * 2 - MIN_CENTER_PANE_WIDTH;
    const deltaX = event.clientX - state.drag.startX;

    if (state.drag.side === "left") {
      const leftMax = Math.max(MIN_LEFT_PANE_WIDTH, maxSideWidthBudget - state.rightPaneWidth);
      state.leftPaneWidth = clamp(state.drag.startLeftPaneWidth + deltaX, MIN_LEFT_PANE_WIDTH, leftMax);
    } else {
      const rightMax = Math.max(MIN_RIGHT_PANE_WIDTH, maxSideWidthBudget - state.leftPaneWidth);
      state.rightPaneWidth = clamp(state.drag.startRightPaneWidth - deltaX, MIN_RIGHT_PANE_WIDTH, rightMax);
    }

    applyPaneWidths();
  }

  function setDiffMode(mode) {
    if (mode !== "column" && mode !== "stacked") {
      return;
    }

    if (state.diffMode === mode) {
      syncDiffModeButtons();
      return;
    }

    state.diffMode = mode;
    syncDiffModeButtons();
    onDiffModeChange(getDiffStyle(mode));
  }

  leftSplitter.addEventListener("pointerdown", (event) => {
    beginResize("left", event);
  });
  rightSplitter.addEventListener("pointerdown", (event) => {
    beginResize("right", event);
  });
  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", (event) => {
    endResize(event.pointerId);
  });
  window.addEventListener("pointercancel", (event) => {
    endResize(event.pointerId);
  });

  columnButton.addEventListener("click", () => {
    setDiffMode("column");
  });
  stackedButton.addEventListener("click", () => {
    setDiffMode("stacked");
  });

  const handleLayoutChange = () => {
    endResize();
    clampPaneWidths();
  };

  if (typeof narrowLayoutQuery.addEventListener === "function") {
    narrowLayoutQuery.addEventListener("change", handleLayoutChange);
  } else {
    narrowLayoutQuery.addListener(handleLayoutChange);
  }

  resizeObserver.observe(shell);
  syncDiffModeButtons();
  clampPaneWidths();
}
