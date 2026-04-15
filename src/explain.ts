import { complete, Type, type AssistantMessage, type Tool, type ToolCall } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { DiffReviewFile, ExplanationFileReason, ExplanationFileStatus, ExplanationStatus, HunkExplanation } from "./types.js";
import type { DiffHunkSeed, FilePatchResult } from "./patches.js";
import { getModelCompletionAuth } from "./model-auth.js";
const EXPLANATION_TOOL_NAME = "submit_hunk_explanations";
const EXPLANATION_TOOL: Tool = {
  name: EXPLANATION_TOOL_NAME,
  description: "Return one concise explanation for each diff hunk.",
  parameters: Type.Object({
    hunks: Type.Array(
      Type.Object({
        hunkIndex: Type.Integer({ minimum: 0 }),
        body: Type.String({ minLength: 1 }),
      }),
    ),
  }),
};

function formatRangeLabel(prefix: string, startLine: number | null, endLine: number | null): string {
  if (startLine == null || endLine == null) {
    return `${prefix}: none`;
  }

  if (startLine === endLine) {
    return `${prefix}: ${startLine}`;
  }

  return `${prefix}: ${startLine}-${endLine}`;
}

// Ask the model for a structured analysis per hunk: what changed, how it works,
// why it was done, test coverage, and risks.
function buildExplainPrompt(file: DiffReviewFile, hunks: DiffHunkSeed[]): string {
  const headerLines = [
    "You are explaining code modifications to a developer reading a diff.",
    `Call the ${EXPLANATION_TOOL_NAME} tool exactly once with one explanation per hunk.`,
    "Do not answer with plain prose unless tool calling is impossible.",
    "",
    "For each hunk, provide a structured analysis with these sections:",
    "- **What changed**: the modification in plain language",
    "- **How it works now**: behavior after the change",
    "- **Why**: motivation or best-supported inference from the diff",
    "- **Tests**: how these lines are tested (reference test files if visible in the diff, or state 'not yet tested')",
    "- **Risks**: regressions or edge cases to watch",
    "",
    "Rules:",
    "- Do not give review advice or suggest changes.",
    '- If the purpose is unclear from the diff alone, say: "Purpose unclear from the diff alone." Then briefly state the visible change.',
    "",
    `File: ${file.displayPath}`,
    `Status: ${file.status}`,
  ];

  if (file.status === "renamed") {
    headerLines.push(`Previous path: ${file.oldPath ?? "(none)"}`);
    headerLines.push(`New path: ${file.newPath ?? "(none)"}`);
  }

  const hunkBlocks = hunks.map((hunk) => {
    return [
      `Hunk ${hunk.hunkIndex}`,
      formatRangeLabel("Old lines", hunk.oldStartLine, hunk.oldEndLine),
      formatRangeLabel("New lines", hunk.newStartLine, hunk.newEndLine),
      "```diff",
      hunk.patchText,
      "```",
    ].join("\n");
  });

  return [...headerLines, "", ...hunkBlocks].join("\n");
}

function extractJsonText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error("empty explanation response");
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

  const arrayStart = trimmed.indexOf("[");
  const arrayEnd = trimmed.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    return trimmed.slice(arrayStart, arrayEnd + 1);
  }

  return trimmed;
}

function normalizeExplanationBody(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const body = value.trim().replace(/\n{3,}/g, "\n\n");
  return body.length > 0 ? body : null;
}

// Accept only the hunk-indexed shape we asked the model for and map it back
// onto the parsed hunk anchors used by the browser diff view.
export function parseHunkExplanationPayload(payload: unknown, hunks: DiffHunkSeed[]): HunkExplanation[] {
  const rawHunks = Array.isArray(payload)
    ? payload
    : typeof payload === "object" && payload != null && Array.isArray((payload as { hunks?: unknown }).hunks)
      ? (payload as { hunks: unknown[] }).hunks
      : null;

  if (rawHunks == null) {
    throw new Error("response did not contain a hunks array");
  }

  const hunkMap = new Map(hunks.map((hunk) => [hunk.hunkIndex, hunk]));
  const explanations: HunkExplanation[] = [];

  for (const item of rawHunks) {
    if (typeof item !== "object" || item == null) {
      continue;
    }

    const candidate = item as { hunkIndex?: unknown; body?: unknown; summary?: unknown; explanation?: unknown };
    if (!Number.isInteger(candidate.hunkIndex)) {
      continue;
    }

    const hunk = hunkMap.get(candidate.hunkIndex as number);
    if (hunk == null) {
      continue;
    }

    const body = normalizeExplanationBody(candidate.body ?? candidate.summary ?? candidate.explanation);
    if (body == null) {
      continue;
    }

    explanations.push({
      id: `${hunk.fileId}:explanation:${hunk.hunkIndex}`,
      fileId: hunk.fileId,
      anchorSide: hunk.anchorSide,
      anchorLine: hunk.anchorLine,
      oldStartLine: hunk.oldStartLine,
      oldEndLine: hunk.oldEndLine,
      newStartLine: hunk.newStartLine,
      newEndLine: hunk.newEndLine,
      body,
    });
  }

  return explanations;
}

export function parseHunkExplanationResponse(responseText: string, hunks: DiffHunkSeed[]): HunkExplanation[] {
  return parseHunkExplanationPayload(JSON.parse(extractJsonText(responseText)) as unknown, hunks);
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

export function parseHunkExplanationsFromAssistantMessage(message: AssistantMessage, hunks: DiffHunkSeed[]): HunkExplanation[] {
  const toolCall = collectToolCalls(message.content).find((item) => item.name === EXPLANATION_TOOL_NAME);
  if (toolCall != null) {
    return parseHunkExplanationPayload(toolCall.arguments, hunks);
  }

  const responseText = collectTextContent(message.content).trim();
  if (responseText.length === 0) {
    throw new Error(`The model returned no text or tool call (${describeAssistantResponse(message)}).`);
  }

  return parseHunkExplanationResponse(responseText, hunks);
}

function createFileStatus(
  file: DiffReviewFile,
  reason: ExplanationFileReason,
  hunkCount: number,
  generatedCount: number,
  message: string,
): ExplanationFileStatus {
  return {
    fileId: file.id,
    displayPath: file.displayPath,
    hunkCount,
    generatedCount,
    reason,
    message,
  };
}

function formatStatusExamples(fileStatuses: ExplanationFileStatus[], limit = 2): string {
  const examples = fileStatuses.slice(0, limit).map((status) => `${status.displayPath}: ${status.message}`);
  if (fileStatuses.length <= limit) {
    return examples.join(" ");
  }
  return `${examples.join(" ")} +${fileStatuses.length - limit} more.`;
}

// Summarize the explainer run into a user-facing reason instead of a vague
// zero-count banner. This gives both pi and the browser a deterministic answer.
export function buildCompletedExplanationStatus(modelLabel: string, fileStatuses: ExplanationFileStatus[]): ExplanationStatus {
  const generatedCount = fileStatuses.reduce((count, status) => count + status.generatedCount, 0);
  const problemStatuses = fileStatuses.filter((status) => status.reason !== "generated");

  if (generatedCount === 0) {
    const summary =
      problemStatuses.length === 0
        ? "No LLM explainer notes were generated, but no file-level reason was recorded."
        : `No LLM explainer notes were generated. ${formatStatusExamples(problemStatuses)}`;

    return {
      state: "completed-without-explanations",
      attempted: true,
      modelLabel,
      generatedCount,
      summary,
      fileStatuses,
    };
  }

  if (problemStatuses.length > 0) {
    return {
      state: "partial",
      attempted: true,
      modelLabel,
      generatedCount,
      summary: `Generated ${generatedCount} LLM explainer note(s), but some files were skipped. ${formatStatusExamples(problemStatuses)}`,
      fileStatuses,
    };
  }

  return {
    state: "generated",
    attempted: true,
    modelLabel,
    generatedCount,
    summary: `Generated ${generatedCount} LLM explainer note(s) with ${modelLabel}.`,
    fileStatuses,
  };
}

export interface AddHunkExplanationsResult {
  files: DiffReviewFile[];
  status: ExplanationStatus;
}

// Generate read-only LLM explainer notes before the browser opens so the diff
// view arrives fully annotated instead of streaming in partial state.
export async function addHunkExplanations(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  patches: FilePatchResult[],
): Promise<AddHunkExplanationsResult> {
  const files = patches.map((patch) => patch.file);
  const model = ctx.model;
  if (model == null) {
    return {
      files,
      status: {
        state: "skipped-no-model",
        attempted: false,
        modelLabel: null,
        generatedCount: 0,
        summary: "No model selected, so LLM explainer notes were skipped.",
        fileStatuses: [],
      },
    };
  }

  const modelLabel = `${model.provider}/${model.id}`;
  const auth = await getModelCompletionAuth(ctx.modelRegistry, model);
  if (!auth.ok) {
    return {
      files,
      status: {
        state: "skipped-no-auth",
        attempted: false,
        modelLabel,
        generatedCount: 0,
        summary: `No API key or OAuth access was available for ${modelLabel}, so LLM explainer notes were skipped (${auth.error}).`,
        fileStatuses: [],
      },
    };
  }

  ctx.ui.notify(`Generating hunk explanations with ${modelLabel}...`, "info");

  const explainedFiles: DiffReviewFile[] = [];
  const fileStatuses: ExplanationFileStatus[] = [];

  for (const patch of patches) {
    const { file, hunks, error } = patch;

    if (error != null) {
      explainedFiles.push(file);
      fileStatuses.push(createFileStatus(file, "request-failed", 0, 0, `Could not build a patch for explanation: ${error}`));
      continue;
    }

    if (hunks.length === 0) {
      explainedFiles.push(file);
      fileStatuses.push(createFileStatus(file, "no-hunks", 0, 0, "No diff hunks were found to explain."));
      continue;
    }

    let response: AssistantMessage;
    try {
      response = await complete(
        model,
        {
          systemPrompt: `You are a structured diff explanation generator. Call the ${EXPLANATION_TOOL_NAME} tool exactly once. Do not use any other tool and do not answer with free-form prose unless tool calling is impossible.`,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: buildExplainPrompt(file, hunks) }],
              timestamp: Date.now(),
            },
          ],
          tools: [EXPLANATION_TOOL],
        },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          maxTokens: Math.min(4096, 512 + hunks.length * 256),
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      explainedFiles.push(file);
      fileStatuses.push(createFileStatus(file, "request-failed", hunks.length, 0, `The model request failed: ${message}`));
      continue;
    }

    let hunkExplanations: HunkExplanation[];
    try {
      hunkExplanations = parseHunkExplanationsFromAssistantMessage(response, hunks);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isEmpty = message.includes("returned no text or tool call");
      explainedFiles.push(file);
      fileStatuses.push(
        createFileStatus(
          file,
          isEmpty ? "empty-response" : "invalid-response",
          hunks.length,
          0,
          isEmpty ? message : `The model response could not be parsed: ${message}`,
        ),
      );
      continue;
    }

    if (hunkExplanations.length === 0) {
      explainedFiles.push(file);
      fileStatuses.push(createFileStatus(file, "no-usable-explanations", hunks.length, 0, "The model responded, but none of the returned explanations matched diff hunks."));
      continue;
    }

    explainedFiles.push({
      ...file,
      hunkExplanations,
    });
    fileStatuses.push(createFileStatus(file, "generated", hunks.length, hunkExplanations.length, `Generated ${hunkExplanations.length} explainer note(s).`));
  }

  return {
    files: explainedFiles,
    status: buildCompletedExplanationStatus(modelLabel, fileStatuses),
  };
}
