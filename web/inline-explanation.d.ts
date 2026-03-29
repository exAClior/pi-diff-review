export interface InlineExplanationElement {
  dataset: {
    inlineExplanationId?: string;
  };
  classList: {
    add(name: string): void;
    remove(name: string): void;
  };
  offsetWidth: number;
  scrollIntoView(options: ScrollIntoViewOptions): void;
}

export interface InlineExplanationRoot {
  querySelectorAll(selector: string): Iterable<InlineExplanationElement>;
}

export interface HighlightInlineExplanationOptions {
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (timerId: unknown) => void;
}

export function findInlineExplanation(root: InlineExplanationRoot, explanationId: string): InlineExplanationElement | null;
export function resetInlineExplanationHighlight(options?: { clearTimer?: (timerId: unknown) => void }): void;
export function highlightInlineExplanation(element: InlineExplanationElement, options?: HighlightInlineExplanationOptions): void;
export function revealInlineExplanation(
  root: InlineExplanationRoot,
  explanationId: string,
  options?: {
    onMissing?: () => void;
    highlight?: (element: InlineExplanationElement) => void;
  },
): InlineExplanationElement | null;
