const HIGHLIGHT_CLASS = "comment-jump-target";
const HIGHLIGHT_DURATION_MS = 1800;
let activeHighlightTimer = null;
let activeHighlightedElement = null;

export function findInlineExplanation(root, explanationId) {
  return Array.from(root.querySelectorAll("[data-inline-explanation-id]"))
    .find((element) => element.dataset.inlineExplanationId === explanationId) ?? null;
}

export function resetInlineExplanationHighlight({ clearTimer = (timerId) => window.clearTimeout(timerId) } = {}) {
  if (activeHighlightTimer != null) {
    clearTimer(activeHighlightTimer);
    activeHighlightTimer = null;
  }

  activeHighlightedElement?.classList.remove(HIGHLIGHT_CLASS);
  activeHighlightedElement = null;
}

export function highlightInlineExplanation(
  element,
  {
    setTimer = (callback, delay) => window.setTimeout(callback, delay),
    clearTimer = (timerId) => window.clearTimeout(timerId),
  } = {},
) {
  if (activeHighlightTimer != null) {
    clearTimer(activeHighlightTimer);
    activeHighlightTimer = null;
  }

  if (activeHighlightedElement != null && activeHighlightedElement !== element) {
    activeHighlightedElement.classList.remove(HIGHLIGHT_CLASS);
  }

  element.classList.remove(HIGHLIGHT_CLASS);
  void element.offsetWidth;
  element.classList.add(HIGHLIGHT_CLASS);

  activeHighlightedElement = element;
  activeHighlightTimer = setTimer(() => {
    element.classList.remove(HIGHLIGHT_CLASS);
    if (activeHighlightedElement === element) {
      activeHighlightedElement = null;
    }
    activeHighlightTimer = null;
  }, HIGHLIGHT_DURATION_MS);
}

export function revealInlineExplanation(root, explanationId, { onMissing, highlight = highlightInlineExplanation } = {}) {
  const target = findInlineExplanation(root, explanationId);

  if (target == null) {
    onMissing?.();
    return null;
  }

  target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
  highlight(target);
  return target;
}
