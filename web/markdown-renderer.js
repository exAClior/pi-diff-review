const SECTION_LABEL_DISPLAY = new Map(
  [
    "Summary",
    "What changed",
    "How it works now",
    "How it works",
    "Why",
    "Why it changed",
    "Motivation",
    "Implementation",
    "Behavior",
    "Impact",
    "Tests",
    "Testing",
    "Test coverage",
    "Risks",
    "Risk",
    "Notes",
  ].map((label) => [normalizeSectionKey(label), label]),
);

function normalizeSectionKey(label) {
  return label
    .replace(/:$/, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizeMarkdown(markdown) {
  return String(markdown ?? "").replace(/\r\n?/g, "\n");
}

function matchHeading(line) {
  const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
  if (match == null) return null;

  return {
    level: match[1].length,
    text: match[2].replace(/\s+#+\s*$/, "").trim(),
  };
}

function matchFenceStart(line) {
  const match = line.match(/^\s*(```+|~~~+)\s*([^`]*)\s*$/);
  if (match == null) return null;

  return {
    marker: match[1],
    lang: match[2].trim(),
  };
}

function isFenceEnd(line, marker) {
  const fenceChar = marker[0];
  const minLength = marker.length;
  const match = line.match(/^\s*(```+|~~~+)\s*$/);
  return match != null && match[1][0] === fenceChar && match[1].length >= minLength;
}

function matchSectionLabel(line) {
  const trimmed = line.trim();
  const withoutBullet = trimmed.replace(/^[-*+]\s+/, "");
  let match = withoutBullet.match(/^\*\*([^*]{1,80}?)\*\*\s*:?\s*(.*)$/);

  if (match == null) {
    match = withoutBullet.match(/^([^:*`#[\]]{2,80}?):\s*(.*)$/);
  }

  if (match == null) return null;

  const rawLabel = match[1].replace(/:$/, "").trim();
  const key = normalizeSectionKey(rawLabel);
  const label = SECTION_LABEL_DISPLAY.get(key);
  if (label == null) return null;

  return {
    label,
    body: match[2].trim(),
  };
}

function matchListItem(line) {
  const trimmed = line.trim();
  const unordered = trimmed.match(/^[-*+]\s+(.+)$/);
  if (unordered != null) {
    return { ordered: false, text: unordered[1].trim() };
  }

  const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
  if (ordered != null) {
    return { ordered: true, text: ordered[1].trim() };
  }

  return null;
}

function isSectionBoundary(line) {
  return matchHeading(line) != null || matchSectionLabel(line) != null;
}

function isAnyBlockStart(line) {
  return matchFenceStart(line) != null || isSectionBoundary(line) || matchListItem(line) != null;
}

function parseBlocks(lines, start, end) {
  const blocks = [];
  let index = start;

  while (index < end) {
    const line = lines[index];
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    const fence = matchFenceStart(line);
    if (fence != null) {
      const codeLines = [];
      index += 1;
      while (index < end && !isFenceEnd(lines[index], fence.marker)) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < end) index += 1;
      blocks.push({ type: "code", lang: fence.lang, text: codeLines.join("\n") });
      continue;
    }

    const heading = matchHeading(line);
    if (heading != null) {
      blocks.push({ type: "heading", level: heading.level, text: heading.text });
      index += 1;
      continue;
    }

    const section = matchSectionLabel(line);
    if (section != null) {
      const bodyLines = [];
      let hasBody = section.body.length > 0;
      if (hasBody) bodyLines.push(section.body);
      index += 1;

      while (index < end) {
        const currentLine = lines[index];
        if (currentLine.trim().length === 0) {
          let next = index + 1;
          while (next < end && lines[next].trim().length === 0) next += 1;
          if (next >= end || isSectionBoundary(lines[next])) {
            index = next;
            break;
          }
          if (hasBody) bodyLines.push("");
          index = next;
          continue;
        }

        if (isSectionBoundary(currentLine)) break;

        bodyLines.push(currentLine);
        hasBody = true;
        index += 1;
      }

      blocks.push({
        type: "section",
        label: section.label,
        blocks: parseMarkdownBlocks(bodyLines.join("\n")),
      });
      continue;
    }

    const listItem = matchListItem(line);
    if (listItem != null) {
      const ordered = listItem.ordered;
      const items = [];
      while (index < end) {
        const item = matchListItem(lines[index]);
        if (item == null || item.ordered !== ordered) break;
        items.push(item.text);
        index += 1;
      }
      blocks.push({ type: ordered ? "ordered-list" : "unordered-list", items });
      continue;
    }

    const paragraphLines = [];
    while (index < end) {
      const currentLine = lines[index];
      if (currentLine.trim().length === 0) {
        index += 1;
        break;
      }
      if (paragraphLines.length > 0 && isAnyBlockStart(currentLine)) break;
      paragraphLines.push(currentLine.trim());
      index += 1;
    }

    if (paragraphLines.length > 0) {
      blocks.push({ type: "paragraph", text: paragraphLines.join(" ") });
    }
  }

  return blocks;
}

export function parseMarkdownBlocks(markdown) {
  const lines = normalizeMarkdown(markdown).split("\n");
  return parseBlocks(lines, 0, lines.length);
}

export function parseInlineMarkdown(text) {
  const tokens = [];
  const source = String(text ?? "");
  const pattern = /(`([^`]+)`|\*\*([^*]+?)\*\*|\*([^*]+?)\*|\[([^\]]+?)\]\(([^)\s]+?)\))/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(source)) != null) {
    if (match.index > lastIndex) {
      tokens.push({ type: "text", text: source.slice(lastIndex, match.index) });
    }

    if (match[2] != null) {
      tokens.push({ type: "code", text: match[2] });
    } else if (match[3] != null) {
      tokens.push({ type: "strong", text: match[3] });
    } else if (match[4] != null) {
      tokens.push({ type: "emphasis", text: match[4] });
    } else if (match[5] != null && match[6] != null) {
      tokens.push({ type: "link", text: match[5], href: match[6] });
    }

    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < source.length) {
    tokens.push({ type: "text", text: source.slice(lastIndex) });
  }

  return tokens;
}

function appendInline(parent, text, doc) {
  for (const token of parseInlineMarkdown(text)) {
    if (token.type === "text") {
      parent.appendChild(doc.createTextNode(token.text));
      continue;
    }

    if (token.type === "link") {
      const href = token.href.trim();
      if (/^(https?:|mailto:)/i.test(href)) {
        const link = doc.createElement("a");
        link.href = href;
        link.rel = "noopener noreferrer";
        link.target = "_blank";
        link.textContent = token.text;
        parent.appendChild(link);
      } else {
        parent.appendChild(doc.createTextNode(`[${token.text}](${token.href})`));
      }
      continue;
    }

    const tag = token.type === "code" ? "code" : token.type === "strong" ? "strong" : "em";
    const element = doc.createElement(tag);
    element.textContent = token.text;
    parent.appendChild(element);
  }
}

function appendBlocks(parent, blocks, doc) {
  for (const block of blocks) {
    if (block.type === "paragraph") {
      const paragraph = doc.createElement("p");
      paragraph.className = "markdown-paragraph";
      appendInline(paragraph, block.text, doc);
      parent.appendChild(paragraph);
      continue;
    }

    if (block.type === "heading") {
      const level = block.level <= 1 ? 3 : block.level === 2 ? 4 : 5;
      const heading = doc.createElement(`h${level}`);
      heading.className = "markdown-heading";
      heading.dataset.level = String(block.level);
      appendInline(heading, block.text, doc);
      parent.appendChild(heading);
      continue;
    }

    if (block.type === "section") {
      const section = doc.createElement("section");
      section.className = "markdown-section";

      const title = doc.createElement("h4");
      title.className = "markdown-section-title";
      title.textContent = block.label;
      section.appendChild(title);

      if (block.blocks.length > 0) {
        const body = doc.createElement("div");
        body.className = "markdown-section-body";
        appendBlocks(body, block.blocks, doc);
        section.appendChild(body);
      }

      parent.appendChild(section);
      continue;
    }

    if (block.type === "unordered-list" || block.type === "ordered-list") {
      const list = doc.createElement(block.type === "ordered-list" ? "ol" : "ul");
      list.className = "markdown-list";
      for (const item of block.items) {
        const listItemElement = doc.createElement("li");
        appendInline(listItemElement, item, doc);
        list.appendChild(listItemElement);
      }
      parent.appendChild(list);
      continue;
    }

    if (block.type === "code") {
      const pre = doc.createElement("pre");
      pre.className = "markdown-code-block";
      const code = doc.createElement("code");
      if (block.lang.length > 0) {
        code.dataset.lang = block.lang;
      }
      code.textContent = block.text;
      pre.appendChild(code);
      parent.appendChild(pre);
    }
  }
}

export function createMarkdownBody(markdown, options = {}) {
  const doc = options.document ?? document;
  const root = doc.createElement("div");
  root.className = options.className ?? "markdown-body";
  appendBlocks(root, parseMarkdownBlocks(markdown), doc);
  return root;
}
