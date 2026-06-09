import assert from "node:assert/strict";
import test from "node:test";
import { parseInlineMarkdown, parseMarkdownBlocks } from "../web/markdown-renderer.js";

test("parseMarkdownBlocks promotes known bold labels into visual sections", () => {
  const blocks = parseMarkdownBlocks(
    [
      "**What changed**: Adds markdown rendering for explainer notes.",
      "Keeps the body readable in the review pane.",
      "",
      "**Tests**:",
      "- `npm test`",
      "- Manual browser scan",
    ].join("\n"),
  );

  assert.deepEqual(blocks, [
    {
      type: "section",
      label: "What changed",
      blocks: [{ type: "paragraph", text: "Adds markdown rendering for explainer notes. Keeps the body readable in the review pane." }],
    },
    {
      type: "section",
      label: "Tests",
      blocks: [{ type: "unordered-list", items: ["`npm test`", "Manual browser scan"] }],
    },
  ]);
});

test("parseMarkdownBlocks keeps unknown colon labels as normal prose", () => {
  assert.deepEqual(parseMarkdownBlocks("Location: src/example.ts"), [{ type: "paragraph", text: "Location: src/example.ts" }]);
});

test("parseMarkdownBlocks handles headings and fenced code blocks", () => {
  assert.deepEqual(parseMarkdownBlocks("# Title\n\n## Subtitle\n\n```js\nconst x = 1 < 2;\n```"), [
    { type: "heading", level: 1, text: "Title" },
    { type: "heading", level: 2, text: "Subtitle" },
    { type: "code", lang: "js", text: "const x = 1 < 2;" },
  ]);
});

test("parseInlineMarkdown tokenizes emphasis without exposing raw html", () => {
  assert.deepEqual(parseInlineMarkdown("Use **bold**, `code`, and [docs](https://example.com)."), [
    { type: "text", text: "Use " },
    { type: "strong", text: "bold" },
    { type: "text", text: ", " },
    { type: "code", text: "code" },
    { type: "text", text: ", and " },
    { type: "link", text: "docs", href: "https://example.com" },
    { type: "text", text: "." },
  ]);
});
