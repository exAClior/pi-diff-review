import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { getDiffReviewFiles } from "./git.js";
import { composeReviewPrompt } from "./prompt.js";
import { startReviewServer, type ReviewServerSession } from "./server.js";
import { type ReviewSessionResult } from "./types.js";

type WaitingEditorResult = "escape" | "review-settled";

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

  async function reviewDiff(ctx: ExtensionCommandContext): Promise<void> {
    if (activeSession != null) {
      ctx.ui.notify("A diff review is already in progress.", "warning");
      return;
    }

    const { repoRoot, files } = await getDiffReviewFiles(pi, ctx.cwd);
    if (files.length === 0) {
      ctx.ui.notify("No git diff to review.", "info");
      return;
    }

    const session = await startReviewServer({ repoRoot, files });
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

      const prompt = composeReviewPrompt(files, message);
      ctx.ui.setEditorText(prompt);
      ctx.ui.notify("Inserted diff review feedback into the editor.", "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Diff review failed: ${message}`, "error");
    } finally {
      activeWaitingUIDismiss?.();
      await closeActiveSession();
    }
  }

  pi.registerCommand("diff-review", {
    description: "Open a browser diff review page and insert review feedback into the editor",
    handler: async (_args, ctx) => {
      await reviewDiff(ctx);
    },
  });

  pi.on("session_shutdown", async () => {
    activeWaitingUIDismiss?.();
    await closeActiveSession();
  });
}
