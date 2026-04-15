import { complete, Type, type AssistantMessage, type Tool, type ToolCall } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { getModelCompletionAuth } from "./model-auth.js";
import type {
  AutomatedReviewResult,
  AutomatedReviewStatus,
  ReviewCallout,
  ReviewFinding,
  ReviewFindingPriority,
  ReviewFindingSide,
  ReviewVerdict,
  DiffReviewFile,
} from "./types.js";
import type { FilePatchResult } from "./patches.js";

export const REVIEW_RUBRIC = `# Review Guidelines

You are acting as a code reviewer for a proposed code change made by another engineer.

Below are default guidelines for determining what to flag. These are not the final word — if you encounter more specific guidelines elsewhere (in a developer message, user message, file, or project review guidelines appended below), those override these general instructions.

## Determining what to flag

Flag issues that:
1. Meaningfully impact the accuracy, performance, security, or maintainability of the code.
2. Are discrete and actionable (not general issues or multiple combined issues).
3. Don't demand rigor inconsistent with the rest of the codebase.
4. Were introduced in the changes being reviewed (not pre-existing bugs).
5. The author would likely fix if aware of them.
6. Don't rely on unstated assumptions about the codebase or author's intent.
7. Have provable impact on other parts of the code — it is not enough to speculate that a change may disrupt another part, you must identify the parts that are provably affected.
8. Are clearly not intentional changes by the author.
9. Be particularly careful with untrusted user input and follow the specific guidelines to review.
10. Treat silent local error recovery (especially parsing/IO/network fallbacks) as high-signal review candidates unless there is explicit boundary-level justification.

## Untrusted User Input

1. Be careful with open redirects, they must always be checked to only go to trusted domains (?next_page=...)
2. Always flag SQL that is not parametrized
3. In systems with user supplied URL input, http fetches always need to be protected against access to local resources (intercept DNS resolver!)
4. Escape, don't sanitize if you have the option (eg: HTML escaping)

## Comment guidelines

1. Be clear about why the issue is a problem.
2. Communicate severity appropriately - don't exaggerate.
3. Be brief - at most 1 paragraph.
4. Keep code snippets under 3 lines, wrapped in inline code or code blocks.
5. Use \`\`\`suggestion blocks ONLY for concrete replacement code (minimal lines; no commentary inside the block). Preserve the exact leading whitespace of the replaced lines.
6. Explicitly state scenarios/environments where the issue arises.
7. Use a matter-of-fact tone - helpful AI assistant, not accusatory.
8. Write for quick comprehension without close reading.
9. Avoid excessive flattery or unhelpful phrases like "Great job...".

## Review priorities

1. Surface critical non-blocking human callouts (migrations, dependency churn, auth/permissions, compatibility, destructive operations) at the end.
2. Prefer simple, direct solutions over wrappers or abstractions without clear value.
3. Treat back pressure handling as critical to system stability.
4. Apply system-level thinking; flag changes that increase operational risk or on-call wakeups.
5. Ensure that errors are always checked against codes or stable identifiers, never error messages.

## Fail-fast error handling (strict)

When reviewing added or modified error handling, default to fail-fast behavior.

1. Evaluate every new or changed \`try/catch\`: identify what can fail and why local handling is correct at that exact layer.
2. Prefer propagation over local recovery. If the current scope cannot fully recover while preserving correctness, rethrow (optionally with context) instead of returning fallbacks.
3. Flag catch blocks that hide failure signals (e.g. returning \`null\`/\`[]\`/\`false\`, swallowing JSON parse failures, logging-and-continue, or “best effort” silent recovery).
4. JSON parsing/decoding should fail loudly by default. Quiet fallback parsing is only acceptable with an explicit compatibility requirement and clear tested behavior.
5. Boundary handlers (HTTP routes, CLI entrypoints, supervisors) may translate errors, but must not pretend success or silently degrade.
6. If a catch exists only to satisfy lint/style without real handling, treat it as a bug.
7. When uncertain, prefer crashing fast over silent degradation.

## Required human callouts (non-blocking, at the very end)

After findings/verdict, you MUST append this final section:

## Human Reviewer Callouts (Non-Blocking)

Include only applicable callouts (no yes/no lines):

- **This change adds a database migration:** <files/details>
- **This change introduces a new dependency:** <package(s)/details>
- **This change changes a dependency (or the lockfile):** <files/package(s)/details>
- **This change modifies auth/permission behavior:** <what changed and where>
- **This change introduces backwards-incompatible public schema/API/contract changes:** <what changed and where>
- **This change includes irreversible or destructive operations:** <operation and scope>
- **This change adds or removes feature flags:** <feature flags changed> (call out re-use of dormant feature flags!)
- **This change changes configuration defaults:** <config var changed>

Rules for this section:
1. These are informational callouts for the human reviewer, not fix items.
2. Do not include them in Findings unless there is an independent defect.
3. These callouts alone must not change the verdict.
4. Only include callouts that apply to the reviewed change.
5. Keep each emitted callout bold exactly as written.
6. If none apply, write "- (none)".

## Priority levels

Tag each finding with a priority level in the title:
- [P0] - Drop everything to fix. Blocking release/operations. Only for universal issues that do not depend on assumptions about inputs.
- [P1] - Urgent. Should be addressed in the next cycle.
- [P2] - Normal. To be fixed eventually.
- [P3] - Low. Nice to have.

## Output format

Provide your findings in a clear, structured format:
1. List each finding with its priority tag, file location, and explanation.
2. Findings must reference locations that overlap with the actual diff — don't flag pre-existing code.
3. Keep line references as short as possible (avoid ranges over 5-10 lines; pick the most suitable subrange).
4. Provide an overall verdict: "correct" (no blocking issues) or "needs attention" (has blocking issues).
5. Ignore trivial style issues unless they obscure meaning or violate documented standards.
6. Do not generate a full PR fix — only flag issues and optionally provide short suggestion blocks.
7. End with the required "Human Reviewer Callouts (Non-Blocking)" section and all applicable bold callouts (no yes/no).

Output all findings the author would fix if they knew about them. If there are no qualifying findings, explicitly state the code looks good. Don't stop at the first finding - list every qualifying issue. Then append the required non-blocking callouts section.`;

export const REVIEW_FINDINGS_TOOL_NAME = "submit_review_findings";
export const DEFAULT_MAX_AUTOMATED_REVIEW_PATCH_LINES = 5000;

const REVIEW_FINDINGS_TOOL: Tool = {
  name: REVIEW_FINDINGS_TOOL_NAME,
  description: "Submit structured code review findings.",
  parameters: Type.Object({
    verdict: Type.Union([Type.Literal("correct"), Type.Literal("needs_attention")]),
    findings: Type.Array(
      Type.Object({
        priority: Type.Union([Type.Literal("P0"), Type.Literal("P1"), Type.Literal("P2"), Type.Literal("P3")]),
        title: Type.String(),
        filePath: Type.String(),
        startLine: Type.Optional(Type.Integer({ minimum: 1 })),
        endLine: Type.Optional(Type.Integer({ minimum: 1 })),
        side: Type.Optional(Type.Union([Type.Literal("old"), Type.Literal("new")])),
        body: Type.String(),
        suggestion: Type.Optional(Type.String()),
      }),
    ),
    callouts: Type.Array(
      Type.Object({
        category: Type.String(),
        detail: Type.String(),
      }),
    ),
  }),
};

interface RawReviewFinding {
  priority: ReviewFindingPriority;
  title: string;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  side: ReviewFindingSide | null;
  body: string;
  suggestion?: string;
}

interface ParsedReviewPayload {
  verdict: ReviewVerdict | null;
  findings: RawReviewFinding[];
  callouts: ReviewCallout[];
}

export interface RunAutomatedReviewOptions {
  projectGuidelines?: string | null;
  extraInstruction?: string | null;
  maxPatchLines?: number;
}

function normalizeVerdict(value: unknown): ReviewVerdict | null {
  if (typeof value !== "string") {
    return null;
  }

  if (value === "correct") {
    return "correct";
  }

  if (value === "needs_attention" || value === "needs attention") {
    return "needs_attention";
  }

  return null;
}

function normalizePriority(value: unknown): ReviewFindingPriority | null {
  return value === "P0" || value === "P1" || value === "P2" || value === "P3" ? value : null;
}

function normalizeSide(value: unknown): ReviewFindingSide | null {
  return value === "old" || value === "new" ? value : null;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim().replace(/\n{3,}/g, "\n\n");
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeLineNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

function normalizeCallouts(callouts: unknown): ReviewCallout[] {
  if (!Array.isArray(callouts)) {
    return [];
  }

  return callouts.flatMap((item) => {
    if (typeof item !== "object" || item == null) {
      return [];
    }

    const category = normalizeText((item as { category?: unknown }).category);
    const detail = normalizeText((item as { detail?: unknown }).detail);
    if (category == null || detail == null) {
      return [];
    }

    return [{ category, detail }];
  });
}

function normalizeRawReviewFindings(findings: unknown): RawReviewFinding[] {
  if (!Array.isArray(findings)) {
    return [];
  }

  return findings.flatMap((item) => {
    if (typeof item !== "object" || item == null) {
      return [];
    }

    const priority = normalizePriority((item as { priority?: unknown }).priority);
    const title = normalizeText((item as { title?: unknown }).title);
    const body = normalizeText((item as { body?: unknown }).body);
    const filePath = normalizeText((item as { filePath?: unknown }).filePath) ?? "";
    const suggestion = normalizeText((item as { suggestion?: unknown }).suggestion) ?? undefined;
    const startLine = normalizeLineNumber((item as { startLine?: unknown }).startLine);
    const endLine = normalizeLineNumber((item as { endLine?: unknown }).endLine) ?? startLine;
    const side = normalizeSide((item as { side?: unknown }).side);

    if (priority == null || title == null || body == null) {
      return [];
    }

    return [{
      priority,
      title,
      filePath,
      startLine,
      endLine,
      side,
      body,
      suggestion,
    } satisfies RawReviewFinding];
  });
}

function parseReviewPayload(payload: unknown): ParsedReviewPayload {
  if (typeof payload !== "object" || payload == null) {
    throw new Error("response did not contain a structured review payload");
  }

  const candidate = payload as { verdict?: unknown; findings?: unknown; callouts?: unknown };
  const verdict = normalizeVerdict(candidate.verdict);
  const findings = normalizeRawReviewFindings(candidate.findings);
  const callouts = normalizeCallouts(candidate.callouts);

  if (candidate.findings != null && !Array.isArray(candidate.findings)) {
    throw new Error("review payload findings were not an array");
  }

  if (candidate.callouts != null && !Array.isArray(candidate.callouts)) {
    throw new Error("review payload callouts were not an array");
  }

  return { verdict, findings, callouts };
}

function extractJsonText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error("empty automated review response");
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1] != null) {
    return fencedMatch[1].trim();
  }

  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart !== -1 && objectEnd > objectStart) {
    return trimmed.slice(objectStart, objectEnd + 1);
  }

  return trimmed;
}

function splitCalloutsSection(text: string): { findingsText: string; calloutsText: string } {
  const match = text.match(/^##\s+Human Reviewer Callouts.*$/im);
  if (match?.index == null) {
    return {
      findingsText: text,
      calloutsText: "",
    };
  }

  return {
    findingsText: text.slice(0, match.index).trimEnd(),
    calloutsText: text.slice(match.index).trim(),
  };
}

function parseLocationText(text: string): Pick<RawReviewFinding, "filePath" | "startLine" | "endLine" | "side"> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return {
      filePath: "",
      startLine: null,
      endLine: null,
      side: null,
    };
  }

  const match = trimmed.match(/^(.*?)(?::(\d+)(?:-(\d+))?)?(?:\s*\((old|new)\))?$/i);
  if (match == null) {
    return {
      filePath: trimmed,
      startLine: null,
      endLine: null,
      side: null,
    };
  }

  const startLine = match[2] != null ? Number(match[2]) : null;
  const endLine = match[3] != null ? Number(match[3]) : startLine;

  return {
    filePath: match[1]?.trim() || trimmed,
    startLine,
    endLine,
    side: normalizeSide(match[4]?.toLowerCase() ?? null),
  };
}

function extractSuggestion(body: string): { body: string; suggestion?: string } {
  const match = body.match(/```suggestion\s*([\s\S]*?)```/i);
  if (match?.[0] == null || match[1] == null) {
    return { body };
  }

  const suggestion = match[1].trim();
  const nextBody = body.replace(match[0], "").trim();
  return suggestion.length > 0 ? { body: nextBody, suggestion } : { body: nextBody };
}

function parseTextFindings(text: string): RawReviewFinding[] {
  const lines = text.split(/\r?\n/);
  const findingHeader = /^\s*(?:[-*]|\d+\.)?\s*\[(P[0-3])\]\s*(.+?)\s*$/;
  const findings: RawReviewFinding[] = [];
  let current: { priority: ReviewFindingPriority; title: string; bodyLines: string[]; locationText: string | null } | null = null;

  const flush = () => {
    if (current == null) {
      return;
    }

    const bodyText = current.bodyLines.join("\n").trim();
    const { body, suggestion } = extractSuggestion(bodyText);
    if (body.length === 0) {
      current = null;
      return;
    }

    const location = current.locationText == null ? { filePath: "", startLine: null, endLine: null, side: null } : parseLocationText(current.locationText);
    findings.push({
      priority: current.priority,
      title: current.title,
      filePath: location.filePath,
      startLine: location.startLine,
      endLine: location.endLine,
      side: location.side,
      body,
      suggestion,
    });
    current = null;
  };

  for (const line of lines) {
    const headerMatch = line.match(findingHeader);
    if (headerMatch != null) {
      flush();
      current = {
        priority: headerMatch[1] as ReviewFindingPriority,
        title: headerMatch[2].trim(),
        bodyLines: [],
        locationText: null,
      };
      continue;
    }

    if (current == null) {
      continue;
    }

    const locationMatch = line.match(/^\s*(?:File|Location)\s*:\s*(.+?)\s*$/i);
    if (locationMatch != null) {
      current.locationText = locationMatch[1].trim();
      continue;
    }

    if (line.trim().length === 0 && current.bodyLines.length === 0) {
      continue;
    }

    current.bodyLines.push(line.trimEnd());
  }

  flush();
  return findings;
}

function parseTextCallouts(text: string): ReviewCallout[] {
  if (text.trim().length === 0) {
    return [];
  }

  const lines = text.split(/\r?\n/).slice(1);
  const bullets: string[] = [];
  let current = "";

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed.length > 0) {
      bullets.push(trimmed);
    }
    current = "";
  };

  for (const line of lines) {
    if (/^\s*[-*]\s+/.test(line)) {
      flush();
      current = line.replace(/^\s*[-*]\s+/, "");
      continue;
    }

    if (current.length > 0) {
      current += ` ${line.trim()}`;
    }
  }

  flush();

  return bullets.flatMap((bullet) => {
    if (bullet === "(none)") {
      return [];
    }

    const boldMatch = bullet.match(/^\*\*(.+?)\*\*:\s*(.+)$/) ?? bullet.match(/^\*\*(.+?):\*\*\s*(.+)$/);
    if (boldMatch != null) {
      return [{ category: boldMatch[1].trim(), detail: boldMatch[2].trim() }];
    }

    const plainMatch = bullet.match(/^([^:]+):\s*(.+)$/);
    if (plainMatch != null) {
      return [{ category: plainMatch[1].trim(), detail: plainMatch[2].trim() }];
    }

    return [];
  });
}

function parseTextFallbackPayload(text: string): ParsedReviewPayload {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error("empty automated review response");
  }

  try {
    return parseReviewPayload(JSON.parse(extractJsonText(trimmed)) as unknown);
  } catch {}

  const { findingsText, calloutsText } = splitCalloutsSection(trimmed);
  const verdictMatch = findingsText.match(/\bverdict\b\s*[:|-]?\s*(correct|needs[_ -]?attention)/i);
  const verdict = normalizeVerdict(verdictMatch?.[1]?.replace(/\s+/g, "_").toLowerCase() ?? null);
  const findings = parseTextFindings(findingsText);
  const callouts = parseTextCallouts(calloutsText);

  if (verdict == null && findings.length === 0 && callouts.length === 0) {
    throw new Error("response did not contain structured findings");
  }

  return { verdict, findings, callouts };
}

function collectTextContent(content: unknown[]): string {
  return content
    .filter((item): item is { type: "text"; text: string } => {
      return typeof item === "object" && item != null && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string";
    })
    .map((item) => item.text)
    .join("\n");
}

function collectToolCalls(content: unknown[]): ToolCall[] {
  return content.filter((item): item is ToolCall => {
    return (
      typeof item === "object" &&
      item != null &&
      (item as { type?: unknown }).type === "toolCall" &&
      typeof (item as { name?: unknown }).name === "string" &&
      typeof (item as { id?: unknown }).id === "string" &&
      typeof (item as { arguments?: unknown }).arguments === "object" &&
      (item as { arguments?: unknown }).arguments != null
    );
  });
}

function describeAssistantResponse(message: AssistantMessage): string {
  const blockTypes = message.content.map((item) => item.type).join(", ") || "none";
  return `stopReason=${message.stopReason}, content=[${blockTypes}]`;
}

function normalizePathKey(value: string): string {
  return value.trim().replace(/^[ab]\//, "");
}

function countContentLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }

  const lines = content.split(/\r?\n/);
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.length;
}

function normalizeFindingLocation(rawFinding: RawReviewFinding, files: DiffReviewFile[]): ReviewFinding["location"] {
  const trimmedPath = rawFinding.filePath.trim();
  const fileByPath = new Map<string, DiffReviewFile>();

  for (const file of files) {
    for (const candidate of [file.oldPath, file.newPath, file.displayPath, file.treePath]) {
      if (candidate != null && candidate.trim().length > 0) {
        fileByPath.set(normalizePathKey(candidate), file);
      }
    }
  }

  const matchedFile = trimmedPath.length > 0 ? fileByPath.get(normalizePathKey(trimmedPath)) ?? null : null;
  if (matchedFile == null) {
    return {
      fileId: null,
      filePath: trimmedPath || "Global",
      startLine: null,
      endLine: null,
      side: null,
    };
  }

  let side = rawFinding.side;
  if (matchedFile.status === "added") {
    side = "new";
  } else if (matchedFile.status === "deleted") {
    side = "old";
  }

  if (side == null || rawFinding.startLine == null) {
    return {
      fileId: matchedFile.id,
      filePath: matchedFile.displayPath,
      startLine: null,
      endLine: null,
      side: null,
    };
  }

  const startLine = rawFinding.startLine;
  const endLine = rawFinding.endLine ?? startLine;
  const maxLine = side === "old" ? countContentLines(matchedFile.oldContent) : countContentLines(matchedFile.newContent);

  if (startLine < 1 || endLine < startLine || startLine > maxLine || endLine > maxLine) {
    return {
      fileId: matchedFile.id,
      filePath: matchedFile.displayPath,
      startLine: null,
      endLine: null,
      side: null,
    };
  }

  return {
    fileId: matchedFile.id,
    filePath: matchedFile.displayPath,
    startLine,
    endLine,
    side,
  };
}

export function assignFindingIds(rawFindings: RawReviewFinding[], files: DiffReviewFile[]): ReviewFinding[] {
  return rawFindings.map((rawFinding, index) => ({
    id: `finding:${index}`,
    priority: rawFinding.priority,
    title: rawFinding.title,
    body: rawFinding.body,
    ...(rawFinding.suggestion ? { suggestion: rawFinding.suggestion } : {}),
    location: normalizeFindingLocation(rawFinding, files),
  }));
}

export function parseAutomatedReviewPayload(payload: unknown, files: DiffReviewFile[]): Pick<AutomatedReviewResult, "verdict" | "findings" | "callouts"> {
  const parsed = parseReviewPayload(payload);
  const findings = assignFindingIds(parsed.findings, files);
  const verdict = findings.length === 0 ? "correct" : parsed.verdict ?? "needs_attention";
  return {
    verdict,
    findings,
    callouts: parsed.callouts,
  };
}

export function parseAutomatedReviewResponse(responseText: string, files: DiffReviewFile[]): Pick<AutomatedReviewResult, "verdict" | "findings" | "callouts"> {
  try {
    return parseAutomatedReviewPayload(JSON.parse(extractJsonText(responseText)) as unknown, files);
  } catch {
    const parsed = parseTextFallbackPayload(responseText);
    const findings = assignFindingIds(parsed.findings, files);
    const verdict = findings.length === 0 ? "correct" : parsed.verdict ?? "needs_attention";
    return {
      verdict,
      findings,
      callouts: parsed.callouts,
    };
  }
}

export function parseAutomatedReviewFromAssistantMessage(
  message: AssistantMessage,
  files: DiffReviewFile[],
): Pick<AutomatedReviewResult, "verdict" | "findings" | "callouts"> {
  const toolCall = collectToolCalls(message.content).find((item) => item.name === REVIEW_FINDINGS_TOOL_NAME);
  if (toolCall != null) {
    return parseAutomatedReviewPayload(toolCall.arguments, files);
  }

  const responseText = collectTextContent(message.content).trim();
  if (responseText.length === 0) {
    throw new Error(`The model returned no text or tool call (${describeAssistantResponse(message)}).`);
  }

  return parseAutomatedReviewResponse(responseText, files);
}

export function countPatchLines(patches: FilePatchResult[]): number {
  return patches.reduce((count, patch) => count + countContentLines(patch.patchText), 0);
}

export function buildReviewPrompt(
  patches: FilePatchResult[],
  projectGuidelines: string | null = null,
  extraInstruction: string | null = null,
): string {
  const usablePatches = patches.filter((patch) => patch.error == null && patch.patchText.trim().length > 0);
  const lines = [
    REVIEW_RUBRIC,
    "",
    "---",
    "",
    `Review only the changes in the unified diff below. Call the ${REVIEW_FINDINGS_TOOL_NAME} tool exactly once.`,
    "If there are no qualifying findings, return verdict \"correct\" with an empty findings array.",
    "Do not emit prose outside the tool call unless tool calling is impossible.",
    "",
    "## Unified Diff",
    "",
    "```diff",
    usablePatches.map((patch) => patch.patchText.trimEnd()).join("\n\n").trim(),
    "```",
  ];

  if (projectGuidelines?.trim()) {
    lines.push("", "## Project Review Guidelines", "", projectGuidelines.trim());
  }

  if (extraInstruction?.trim()) {
    lines.push("", "## Additional User-Provided Review Instruction", "", extraInstruction.trim());
  }

  return lines.join("\n").trim();
}

function buildStatus(state: AutomatedReviewStatus["state"], attempted: boolean, modelLabel: string | null, summary: string): AutomatedReviewStatus {
  return { state, attempted, modelLabel, summary };
}

export async function runAutomatedReview(
  _pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  patches: FilePatchResult[],
  options: RunAutomatedReviewOptions = {},
): Promise<AutomatedReviewResult> {
  const files = patches.map((patch) => patch.file);
  const model = ctx.model;
  if (model == null) {
    return {
      verdict: null,
      findings: [],
      callouts: [],
      status: buildStatus("skipped-no-model", false, null, "No model selected, so automated review was skipped."),
    };
  }

  const modelLabel = `${model.provider}/${model.id}`;
  const auth = await getModelCompletionAuth(ctx.modelRegistry, model);
  if (!auth.ok) {
    return {
      verdict: null,
      findings: [],
      callouts: [],
      status: buildStatus(
        "skipped-no-auth",
        false,
        modelLabel,
        `No API key or OAuth access was available for ${modelLabel}, so automated review was skipped (${auth.error}).`,
      ),
    };
  }

  const maxPatchLines = options.maxPatchLines ?? DEFAULT_MAX_AUTOMATED_REVIEW_PATCH_LINES;
  const totalPatchLines = countPatchLines(patches);
  if (totalPatchLines > maxPatchLines) {
    return {
      verdict: null,
      findings: [],
      callouts: [],
      status: buildStatus(
        "skipped-too-large",
        false,
        modelLabel,
        `Diff too large for automated review (${totalPatchLines} lines). Skipping.`,
      ),
    };
  }

  if (!patches.some((patch) => patch.error == null && patch.patchText.trim().length > 0)) {
    return {
      verdict: "correct",
      findings: [],
      callouts: [],
      status: buildStatus("no-findings", false, modelLabel, "No usable patches were available for automated review."),
    };
  }

  ctx.ui.notify(`Running automated review with ${modelLabel}...`, "info");

  let response: AssistantMessage;
  try {
    response = await complete(
      model,
      {
        systemPrompt: `You are a structured code reviewer. Call the ${REVIEW_FINDINGS_TOOL_NAME} tool exactly once. Do not use any other tool and do not answer with free-form prose unless tool calling is impossible.`,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: buildReviewPrompt(patches, options.projectGuidelines ?? null, options.extraInstruction ?? null),
              },
            ],
            timestamp: Date.now(),
          },
        ],
        tools: [REVIEW_FINDINGS_TOOL],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens: 4096,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      verdict: null,
      findings: [],
      callouts: [],
      status: buildStatus("request-failed", true, modelLabel, `Automated review failed: ${message}`),
    };
  }

  try {
    const parsed = parseAutomatedReviewFromAssistantMessage(response, files);
    const findings = parsed.findings;
    const verdict = findings.length === 0 ? "correct" : parsed.verdict ?? "needs_attention";

    return {
      verdict,
      findings,
      callouts: parsed.callouts,
      status: findings.length > 0
        ? buildStatus("generated", true, modelLabel, `Automated review found ${findings.length} finding(s) with ${modelLabel}.`)
        : buildStatus("no-findings", true, modelLabel, `Automated review found no issues with ${modelLabel}.`),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      verdict: null,
      findings: [],
      callouts: [],
      status: buildStatus("invalid-response", true, modelLabel, `Automated review response could not be parsed: ${message}`),
    };
  }
}
