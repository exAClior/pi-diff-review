import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { addHunkExplanations } from "./explain.js";
import { buildFilePatches } from "./patches.js";
import { getBaseRefCompletions, getDiffReviewFiles, getDiffReviewFilesForCommit, isCommitOnlyRef, resolveBaseRef } from "./git.js";
import { loadProjectReviewGuidelines } from "./guidelines.js";
import { getModelIdleSessionAuth } from "./model-auth.js";
import { composeReviewPrompt } from "./prompt.js";
import { runAutomatedReview } from "./review.js";
import { showReviewSelector } from "./selector.js";
import { startReviewServer, type ReviewServerSession } from "./server.js";
import { type DiffReviewFile, type ReviewSessionResult } from "./types.js";

type WaitingEditorResult = "escape" | "review-settled";

export interface ParsedCommandArgs {
  baseRef: string | null;
  extraInstruction: string | null;
  error: string | null;
}

function tokenizeArgs(value: string): { tokens: string[]; error: string | null } {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;
  let tokenStarted = false;

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];

    if (quote === "'") {
      tokenStarted = true;
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (quote === '"') {
      tokenStarted = true;

      if (escaping) {
        current += char;
        escaping = false;
        continue;
      }

      if (char === "\\") {
        escaping = true;
        continue;
      }

      if (char === '"') {
        quote = null;
        continue;
      }

      current += char;
      continue;
    }

    if (escaping) {
      current += char;
      escaping = false;
      tokenStarted = true;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      tokenStarted = true;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }

    tokenStarted = true;
    current += char;
  }

  if (quote != null) {
    return { tokens: [], error: "Unterminated quote in arguments" };
  }

  if (escaping) {
    return { tokens: [], error: "Trailing escape character in arguments" };
  }

  if (tokenStarted) {
    tokens.push(current);
  }

  return { tokens, error: null };
}

export function parseCommandArgs(args: string): ParsedCommandArgs {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    return {
      baseRef: null,
      extraInstruction: null,
      error: null,
    };
  }

  const tokenized = tokenizeArgs(trimmed);
  if (tokenized.error != null) {
    return {
      baseRef: null,
      extraInstruction: null,
      error: tokenized.error,
    };
  }

  const rawParts = tokenized.tokens;
  let baseRef: string | null = null;
  const extraInstructions: string[] = [];

  for (let index = 0; index < rawParts.length; index += 1) {
    const part = rawParts[index];

    if (part === "--") {
      const remainder = rawParts.slice(index + 1).join(" ").trim();
      if (remainder.length === 0) {
        break;
      }
      if (baseRef != null) {
        return { baseRef: null, extraInstruction: null, error: `Unexpected argument: ${remainder}` };
      }
      baseRef = remainder;
      break;
    }

    if (part === "--extra") {
      const next = rawParts[index + 1];
      if (next == null) {
        return { baseRef: null, extraInstruction: null, error: "Missing value for --extra" };
      }
      if (next.length > 0) {
        extraInstructions.push(next);
      }
      index += 1;
      continue;
    }

    if (part.startsWith("--extra=")) {
      const value = part.slice("--extra=".length);
      if (value.length > 0) {
        extraInstructions.push(value);
      }
      continue;
    }

    if (baseRef == null) {
      baseRef = part;
      continue;
    }

    return {
      baseRef: null,
      extraInstruction: null,
      error: `Unexpected argument: ${part}`,
    };
  }

  return {
    baseRef,
    extraInstruction: extraInstructions.length > 0 ? extraInstructions.join("\n") : null,
    error: null,
  };
}

// V1 keeps the session itself as the review artifact. Send the composed review
// back as a real user message instead of inventing a parallel persistence path.
export async function deliverReviewToSession(
  pi: Pick<ExtensionAPI, "appendEntry" | "sendUserMessage">,
  ctx: Pick<ExtensionCommandContext, "isIdle" | "model" | "modelRegistry" | "ui">,
  prompt: string,
): Promise<"sent" | "queued" | "drafted"> {
  const reviewMessage = prompt.trim();

  // Keep a session-local backup even if the live handoff to pi later fails.
  try {
    pi.appendEntry("diff-review-submission", { prompt: reviewMessage });
  } catch (error) {
    const reason = error instanceof Error ? ` (${error.message})` : "";
    ctx.ui.setEditorText(reviewMessage);
    ctx.ui.notify(`Pi could not save the diff review to the session${reason}, so it was drafted in the editor instead. Submit it manually to keep it.`, "warning");
    return "drafted";
  }


  if (!ctx.isIdle()) {
    pi.sendUserMessage(reviewMessage, { deliverAs: "followUp" });
    ctx.ui.notify("Saved diff review to the current session and queued it for pi.", "info");
    return "queued";
  }

  if (ctx.model == null) {
    ctx.ui.setEditorText(reviewMessage);
    ctx.ui.notify("Saved diff review to the current session. No model is selected, so it was also drafted in the editor. Submit it manually to add it to conversation history.", "warning");
    return "drafted";
  }

  const auth = await getModelIdleSessionAuth(ctx.modelRegistry, ctx.model);
  if (!auth.ok) {
    const reason = auth.error ? ` (${auth.error})` : "";
    ctx.ui.setEditorText(reviewMessage);
    ctx.ui.notify(`Saved diff review to the current session. Pi could not validate the current model${reason}, so it was also drafted in the editor. Submit it manually to add it to conversation history.`, "warning");
    return "drafted";
  }

  // Pass followUp even when idle. The runtime ignores it when idle, and if the
  // agent starts streaming between our check and the send, the review still
  // lands as a queued follow-up instead of failing the handoff.
  pi.sendUserMessage(reviewMessage, { deliverAs: "followUp" });
  ctx.ui.notify("Saved diff review to the current session and asked pi to continue from it.", "info");
  return "sent";
}

// Open the review URL in the user's default browser without dragging pi into
// any browser-specific integration details.
async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? { file: "open", args: [url] }
      : process.platform === "win32"
        ? { file: "cmd", args: ["/c", "start", "", url] }
        : { file: "xdg-open", args: [url] };

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export default function (pi: ExtensionAPI) {
  let activeSession: ReviewServerSession | null = null;
  let activeWaitingUIDismiss: (() => void) | null = null;

  async function closeActiveSession(): Promise<void> {
    if (activeSession == null) return;
    const session = activeSession;
    activeSession = null;
    try {
      await session.close();
    } catch {}
  }

  function showWaitingUI(ctx: ExtensionCommandContext): {
    promise: Promise<WaitingEditorResult>;
    dismiss: () => void;
  } {
    let settled = false;
    let doneFn: ((result: WaitingEditorResult) => void) | null = null;
    let pendingResult: WaitingEditorResult | null = null;

    const finish = (result: WaitingEditorResult): void => {
      if (settled) return;
      settled = true;
      if (activeWaitingUIDismiss === dismiss) {
        activeWaitingUIDismiss = null;
      }
      if (doneFn != null) {
        doneFn(result);
      } else {
        pendingResult = result;
      }
    };

    const promise = ctx.ui.custom<WaitingEditorResult>((_tui, theme, _kb, done) => {
      doneFn = done;
      if (pendingResult != null) {
        const result = pendingResult;
        pendingResult = null;
        queueMicrotask(() => done(result));
      }

      return {
        render(width: number): string[] {
          const innerWidth = Math.max(24, width - 2);
          const borderTop = theme.fg("border", `╭${"─".repeat(innerWidth)}╮`);
          const borderBottom = theme.fg("border", `╰${"─".repeat(innerWidth)}╯`);
          const lines = [
            theme.fg("accent", theme.bold("Waiting for browser review")),
            "A diff review page is open in your browser.",
            "Press Escape to cancel the review and shut down the local server.",
          ];
          return [
            borderTop,
            ...lines.map((line) => `${theme.fg("border", "│")}${truncateToWidth(line, innerWidth, "...", true).padEnd(innerWidth, " ")}${theme.fg("border", "│")}`),
            borderBottom,
          ];
        },
        handleInput(data: string): void {
          if (matchesKey(data, Key.escape)) {
            finish("escape");
          }
        },
        invalidate(): void {},
      };
    });

    const dismiss = (): void => {
      finish("review-settled");
    };

    activeWaitingUIDismiss = dismiss;

    return {
      promise,
      dismiss,
    };
  }

  async function reviewDiff(ctx: ExtensionCommandContext, parsedArgs: ParsedCommandArgs): Promise<void> {
    if (activeSession != null) {
      ctx.ui.notify("A diff review is already in progress.", "warning");
      return;
    }

    let repoRoot: string;
    let files: DiffReviewFile[];
    let emptyDiffMessage = "No git diff to review.";

    if (parsedArgs.baseRef != null) {
      if (await isCommitOnlyRef(pi, ctx.cwd, parsedArgs.baseRef)) {
        ctx.ui.notify("Bare refs only accept branches or tags. Use /diff-review with no arguments, then pick \"Review a specific commit\" for commit review.", "error");
        return;
      }

      const resolvedBaseRef = await resolveBaseRef(pi, ctx.cwd, parsedArgs.baseRef);
      ({ repoRoot, files } = await getDiffReviewFiles(pi, ctx.cwd, resolvedBaseRef));
    } else {
      const selection = await showReviewSelector(pi, ctx);
      if (selection == null) {
        ctx.ui.notify("Cancelled.", "info");
        return;
      }

      if (selection.type === "worktree") {
        ({ repoRoot, files } = await getDiffReviewFiles(pi, ctx.cwd, selection.baseRef));
        emptyDiffMessage = "No git diff to review.";
      } else {
        ({ repoRoot, files } = await getDiffReviewFilesForCommit(pi, ctx.cwd, selection.sha));
        emptyDiffMessage = "No changes in commit.";
      }
    }

    if (files.length === 0) {
      ctx.ui.notify(emptyDiffMessage, "info");
      return;
    }

    const patches = await buildFilePatches(pi, repoRoot, files);
    const projectGuidelines = await loadProjectReviewGuidelines(ctx.cwd);

    const [explanationResult, automatedReview] = await Promise.all([
      addHunkExplanations(pi, ctx, patches),
      runAutomatedReview(pi, ctx, patches, {
        projectGuidelines,
        extraInstruction: parsedArgs.extraInstruction,
      }),
    ]);
    const { files: filesWithExplanations, status: explanationStatus } = explanationResult;

    ctx.ui.notify(explanationStatus.summary, explanationStatus.state === "generated" ? "info" : "warning");
    ctx.ui.notify(automatedReview.status.summary, automatedReview.status.state === "generated" || automatedReview.status.state === "no-findings" ? "info" : "warning");

    const session = await startReviewServer({
      repoRoot,
      files: filesWithExplanations,
      explanationStatus,
      automatedReview,
    });
    activeSession = session;

    try {
      await openBrowser(session.url);
      ctx.ui.notify("Opened diff review in your browser.", "info");

      const waitingUI = showWaitingUI(ctx);

      const result = await Promise.race([
        session.waitForResult().then((message) => ({ type: "browser" as const, message })),
        waitingUI.promise.then((reason) => ({ type: "ui" as const, reason })),
      ]);

      if (result.type === "ui" && result.reason === "escape") {
        await session.cancel();
        ctx.ui.notify("Diff review cancelled.", "info");
        return;
      }

      const message: ReviewSessionResult = result.type === "browser" ? result.message : await session.waitForResult();

      waitingUI.dismiss();
      await waitingUI.promise;

      if (message.type === "cancel") {
        ctx.ui.notify("Diff review cancelled.", "info");
        return;
      }

      const prompt = composeReviewPrompt({
        files: filesWithExplanations,
        payload: message,
        includedFindings: automatedReview.findings.filter((finding) => message.includedFindingIds?.includes(finding.id)),
        curatedCallouts: message.includeCallouts ? automatedReview.callouts : [],
      });
      await deliverReviewToSession(pi, ctx, prompt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Diff review failed: ${message}`, "error");
    } finally {
      activeWaitingUIDismiss?.();
      await closeActiveSession();
    }
  }

  pi.registerCommand("diff-review", {
    description: "Review against the remote default branch, current upstream, or a branch/tag in your browser",
    getArgumentCompletions: (prefix) => getBaseRefCompletions(prefix),
    handler: async (args, ctx) => {
      const parsedArgs = parseCommandArgs(args);
      if (parsedArgs.error != null) {
        ctx.ui.notify(parsedArgs.error, "error");
        return;
      }

      await reviewDiff(ctx, parsedArgs);
    },
  });

  pi.on("session_shutdown", async () => {
    activeWaitingUIDismiss?.();
    await closeActiveSession();
  });
}
