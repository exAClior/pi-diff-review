import assert from "node:assert/strict";
import test from "node:test";
import {
  highlightInlineExplanation,
  resetInlineExplanationHighlight,
  revealInlineExplanation,
} from "../web/inline-explanation.js";

function createClassList() {
  const classes = new Set<string>();
  return {
    add(name: string) {
      classes.add(name);
    },
    remove(name: string) {
      classes.delete(name);
    },
    contains(name: string) {
      return classes.has(name);
    },
  };
}

function createInlineElement(explanationId: string) {
  const classList = createClassList();
  const scrollCalls: unknown[] = [];

  return {
    dataset: { inlineExplanationId: explanationId },
    classList,
    offsetWidth: 12,
    scrollCalls,
    scrollIntoView(options: unknown) {
      scrollCalls.push(options);
    },
  };
}

test.afterEach(() => {
  resetInlineExplanationHighlight({ clearTimer() {} });
});

test("revealInlineExplanation scrolls to and highlights the matching inline card", () => {
  const element = createInlineElement("exp-1");
  let highlighted = false;

  const result = revealInlineExplanation(
    {
      querySelectorAll() {
        return [element];
      },
    },
    "exp-1",
    {
      highlight(target) {
        highlighted = target === element;
      },
    },
  );

  assert.equal(result, element);
  assert.equal(highlighted, true);
  assert.deepEqual(element.scrollCalls, [{ behavior: "smooth", block: "center", inline: "nearest" }]);
});

test("revealInlineExplanation calls onMissing when no inline card exists", () => {
  let missingCount = 0;

  const result = revealInlineExplanation(
    {
      querySelectorAll() {
        return [];
      },
    },
    "exp-missing",
    {
      onMissing() {
        missingCount += 1;
      },
    },
  );

  assert.equal(result, null);
  assert.equal(missingCount, 1);
});

test("highlightInlineExplanation clears the previous timeout and removes the old highlight before scheduling another one", () => {
  const firstElement = createInlineElement("exp-1");
  const secondElement = createInlineElement("exp-2");
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const cleared: Array<{ callback: () => void; delay: number }> = [];

  const setTimer = (callback: () => void, delay: number) => {
    const timer = { callback, delay };
    timers.push(timer);
    return timer;
  };

  const clearTimer = (timer: unknown) => {
    cleared.push(timer as { callback: () => void; delay: number });
  };

  highlightInlineExplanation(firstElement, { setTimer, clearTimer });
  const firstTimer = timers[0];
  highlightInlineExplanation(secondElement, { setTimer, clearTimer });

  assert.equal(cleared.length, 1);
  assert.equal(cleared[0], firstTimer);
  assert.equal(timers.length, 2);
  assert.equal(firstElement.classList.contains("comment-jump-target"), false);
  assert.equal(secondElement.classList.contains("comment-jump-target"), true);

  timers[1].callback();
  assert.equal(secondElement.classList.contains("comment-jump-target"), false);
});
