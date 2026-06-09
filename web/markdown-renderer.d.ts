export type MarkdownBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "section"; label: string; blocks: MarkdownBlock[] }
  | { type: "unordered-list"; items: string[] }
  | { type: "ordered-list"; items: string[] }
  | { type: "code"; lang: string; text: string };

export type InlineMarkdownToken =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; text: string }
  | { type: "emphasis"; text: string }
  | { type: "link"; text: string; href: string };

export function parseMarkdownBlocks(markdown: unknown): MarkdownBlock[];
export function parseInlineMarkdown(text: unknown): InlineMarkdownToken[];
export function createMarkdownBody(markdown: unknown, options?: { document?: Document; className?: string }): HTMLElement;
