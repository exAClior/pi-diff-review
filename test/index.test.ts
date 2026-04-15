import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { deliverReviewToSession, parseCommandArgs } from "../src/index.js";

type RequestAuth =
  | {
      ok: true;
      apiKey?: string;
      headers?: Record<string, string>;
    }
  | {
      ok: false;
      error: string;
    };

function createHarness(options: {
  isIdle: boolean;
  model?: object;
  hasConfiguredAuth?: boolean;
  apiKey?: string;
  appendEntryError?: Error;
  getApiKey?: () => Promise<string | undefined>;
  authResult?: RequestAuth;
  getApiKeyAndHeaders?: () => Promise<RequestAuth>;
  includeLegacyGetApiKey?: boolean;
}) {
  const sentMessages: Array<{ content: string; options?: { deliverAs?: "steer" | "followUp" } }> = [];
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];
  const notifications: Array<{ message: string; tone: string }> = [];
  const editorTexts: string[] = [];

  const pi = {
    appendEntry(customType: string, data: unknown) {
      if (options.appendEntryError) {
        throw options.appendEntryError;
      }
      appendedEntries.push({ customType, data });
    },
    sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }) {
      sentMessages.push({ content, options });
    },
  };

  const ctx = {
    model: options.model,
    isIdle() {
      return options.isIdle;
    },
    modelRegistry: {
      async getApiKeyAndHeaders() {
        if (options.getApiKeyAndHeaders != null) {
          return options.getApiKeyAndHeaders();
        }

        if (options.authResult != null) {
          return options.authResult;
        }

        return {
          ok: true,
          apiKey: options.getApiKey != null ? await options.getApiKey() : options.apiKey,
        } satisfies RequestAuth;
      },
      hasConfiguredAuth() {
        if (options.hasConfiguredAuth != null) {
          return options.hasConfiguredAuth;
        }

        if (options.authResult != null) {
          return options.authResult.ok && options.authResult.apiKey != null;
        }

        return options.apiKey != null;
      },
      ...(options.includeLegacyGetApiKey === false
        ? {}
        : {
            async getApiKey() {
              return options.getApiKey != null ? options.getApiKey() : options.apiKey;
            },
          }),
    },
    ui: {
      notify(message: string, tone: string) {
        notifications.push({ message, tone });
      },
      setEditorText(text: string) {
        editorTexts.push(text);
      },
    },
  } as unknown as Pick<ExtensionCommandContext, "isIdle" | "model" | "modelRegistry" | "ui">;

  return { pi, ctx, sentMessages, appendedEntries, notifications, editorTexts };
}

test("deliverReviewToSession sends the review as a real same-session message when pi is idle and ready", async () => {
  const { pi, ctx, sentMessages, appendedEntries, notifications, editorTexts } = createHarness({
    isIdle: true,
    model: { provider: "openai", id: "gpt-5" },
    authResult: { ok: true, apiKey: "secret" },
  });

  const result = await deliverReviewToSession(pi, ctx, "\nPlease address the following feedback\n\n1. src/example.ts\n   Rename this variable.\n");

  assert.equal(result, "sent");
  assert.deepEqual(appendedEntries, [
    {
      customType: "diff-review-submission",
      data: {
        prompt: "Please address the following feedback\n\n1. src/example.ts\n   Rename this variable.",
      },
    },
  ]);
  assert.deepEqual(sentMessages, [
    {
      content: "Please address the following feedback\n\n1. src/example.ts\n   Rename this variable.",
      options: { deliverAs: "followUp" },
    },
  ]);
  assert.deepEqual(editorTexts, []);
  assert.deepEqual(notifications, [
    {
      message: "Saved diff review to the current session and asked pi to continue from it.",
      tone: "info",
    },
  ]);
});

test("deliverReviewToSession queues the review as a follow-up message when pi is busy", async () => {
  const { pi, ctx, sentMessages, appendedEntries, notifications, editorTexts } = createHarness({
    isIdle: false,
    model: { provider: "openai", id: "gpt-5" },
  });

  const result = await deliverReviewToSession(pi, ctx, "Please address the following feedback");

  assert.equal(result, "queued");
  assert.deepEqual(appendedEntries, [
    {
      customType: "diff-review-submission",
      data: {
        prompt: "Please address the following feedback",
      },
    },
  ]);
  assert.deepEqual(sentMessages, [
    {
      content: "Please address the following feedback",
      options: { deliverAs: "followUp" },
    },
  ]);
  assert.deepEqual(editorTexts, []);
  assert.deepEqual(notifications, [
    {
      message: "Saved diff review to the current session and queued it for pi.",
      tone: "info",
    },
  ]);
});

test("deliverReviewToSession falls back to the editor when the session backup write fails", async () => {
  const { pi, ctx, sentMessages, appendedEntries, notifications, editorTexts } = createHarness({
    isIdle: true,
    model: { provider: "openai", id: "gpt-5" },
    authResult: { ok: true, apiKey: "secret" },
    appendEntryError: new Error("disk full"),
  });

  const result = await deliverReviewToSession(pi, ctx, "Please address the following feedback");

  assert.equal(result, "drafted");
  assert.deepEqual(appendedEntries, []);
  assert.deepEqual(sentMessages, []);
  assert.deepEqual(editorTexts, ["Please address the following feedback"]);
  assert.deepEqual(notifications, [
    {
      message: "Pi could not save the diff review to the session (disk full), so it was drafted in the editor instead. Submit it manually to keep it.",
      tone: "warning",
    },
  ]);
});

test("deliverReviewToSession falls back to the editor when no model is selected", async () => {
  const { pi, ctx, sentMessages, appendedEntries, notifications, editorTexts } = createHarness({
    isIdle: true,
  });

  const result = await deliverReviewToSession(pi, ctx, "Please address the following feedback");

  assert.equal(result, "drafted");
  assert.deepEqual(appendedEntries, [
    {
      customType: "diff-review-submission",
      data: {
        prompt: "Please address the following feedback",
      },
    },
  ]);
  assert.deepEqual(sentMessages, []);
  assert.deepEqual(editorTexts, ["Please address the following feedback"]);
  assert.deepEqual(notifications, [
    {
      message:
        "Saved diff review to the current session. No model is selected, so it was also drafted in the editor. Submit it manually to add it to conversation history.",
      tone: "warning",
    },
  ]);
});

test("deliverReviewToSession falls back to the editor when the current model is not authenticated", async () => {
  const { pi, ctx, sentMessages, appendedEntries, notifications, editorTexts } = createHarness({
    isIdle: true,
    model: { provider: "openai", id: "gpt-5" },
    authResult: { ok: false, error: "No API key found for \"openai\"" },
  });

  const result = await deliverReviewToSession(pi, ctx, "Please address the following feedback");

  assert.equal(result, "drafted");
  assert.deepEqual(appendedEntries, [
    {
      customType: "diff-review-submission",
      data: {
        prompt: "Please address the following feedback",
      },
    },
  ]);
  assert.deepEqual(sentMessages, []);
  assert.deepEqual(editorTexts, ["Please address the following feedback"]);
  assert.deepEqual(notifications, [
    {
      message:
        'Saved diff review to the current session. Pi could not validate the current model (No API key found for "openai"), so it was also drafted in the editor. Submit it manually to add it to conversation history.',
      tone: "warning",
    },
  ]);
});

test("deliverReviewToSession falls back to the editor when api-key lookup fails", async () => {
  const { pi, ctx, sentMessages, appendedEntries, notifications, editorTexts } = createHarness({
    isIdle: true,
    model: { provider: "openai", id: "gpt-5" },
    hasConfiguredAuth: true,
    getApiKeyAndHeaders: async () => {
      throw new Error("lookup failed");
    },
  });

  const result = await deliverReviewToSession(pi, ctx, "Please address the following feedback");

  assert.equal(result, "drafted");
  assert.deepEqual(appendedEntries, [
    {
      customType: "diff-review-submission",
      data: {
        prompt: "Please address the following feedback",
      },
    },
  ]);
  assert.deepEqual(sentMessages, []);
  assert.deepEqual(editorTexts, ["Please address the following feedback"]);
  assert.deepEqual(notifications, [
    {
      message:
        "Saved diff review to the current session. Pi could not validate the current model (lookup failed), so it was also drafted in the editor. Submit it manually to add it to conversation history.",
      tone: "warning",
    },
  ]);
});

test("deliverReviewToSession falls back to the editor when modern auth only resolves headers", async () => {
  const { pi, ctx, sentMessages, appendedEntries, notifications, editorTexts } = createHarness({
    isIdle: true,
    model: { provider: "openai", id: "gpt-5" },
    authResult: { ok: true, headers: { Authorization: "Bearer oauth-token" } },
    hasConfiguredAuth: false,
  });

  const result = await deliverReviewToSession(pi, ctx, "Please address the following feedback");

  assert.equal(result, "drafted");
  assert.deepEqual(appendedEntries, [
    {
      customType: "diff-review-submission",
      data: {
        prompt: "Please address the following feedback",
      },
    },
  ]);
  assert.deepEqual(sentMessages, []);
  assert.deepEqual(editorTexts, ["Please address the following feedback"]);
  assert.deepEqual(notifications, [
    {
      message:
        'Saved diff review to the current session. Pi could not validate the current model (No API key found for "openai"), so it was also drafted in the editor. Submit it manually to add it to conversation history.',
      tone: "warning",
    },
  ]);
});

test("deliverReviewToSession falls back to legacy getApiKey registries", async () => {
  const { pi, ctx, sentMessages, appendedEntries, notifications, editorTexts } = createHarness({
    isIdle: true,
    model: { provider: "openai", id: "gpt-5" },
    apiKey: "legacy-secret",
    includeLegacyGetApiKey: true,
    getApiKeyAndHeaders: undefined,
  });

  delete (ctx.modelRegistry as { getApiKeyAndHeaders?: unknown }).getApiKeyAndHeaders;

  const result = await deliverReviewToSession(pi, ctx, "Please address the following feedback");

  assert.equal(result, "sent");
  assert.deepEqual(appendedEntries, [
    {
      customType: "diff-review-submission",
      data: {
        prompt: "Please address the following feedback",
      },
    },
  ]);
  assert.deepEqual(sentMessages, [
    {
      content: "Please address the following feedback",
      options: { deliverAs: "followUp" },
    },
  ]);
  assert.deepEqual(editorTexts, []);
  assert.deepEqual(notifications, [
    {
      message: "Saved diff review to the current session and asked pi to continue from it.",
      tone: "info",
    },
  ]);
});

test("parseCommandArgs handles empty args, refs, and quoted extra instructions", () => {
  assert.deepEqual(parseCommandArgs(""), {
    baseRef: null,
    extraInstruction: null,
    error: null,
  });

  assert.deepEqual(parseCommandArgs("main"), {
    baseRef: "main",
    extraInstruction: null,
    error: null,
  });

  assert.deepEqual(parseCommandArgs("--extra 'focus on auth'"), {
    baseRef: null,
    extraInstruction: "focus on auth",
    error: null,
  });

  assert.deepEqual(parseCommandArgs("main --extra \"focus on config defaults\""), {
    baseRef: "main",
    extraInstruction: "focus on config defaults",
    error: null,
  });
});

test("parseCommandArgs supports inline, repeated, and empty --extra values", () => {
  assert.deepEqual(parseCommandArgs("--extra=performance"), {
    baseRef: null,
    extraInstruction: "performance",
    error: null,
  });

  assert.deepEqual(parseCommandArgs("--extra a --extra b"), {
    baseRef: null,
    extraInstruction: "a\nb",
    error: null,
  });

  assert.deepEqual(parseCommandArgs("--extra '' main"), {
    baseRef: "main",
    extraInstruction: null,
    error: null,
  });
});

test("parseCommandArgs keeps backslashes literal in single-quoted --extra values", () => {
  assert.deepEqual(parseCommandArgs("--extra 'literal\\path'"), {
    baseRef: null,
    extraInstruction: "literal\\path",
    error: null,
  });
});

test("parseCommandArgs reports malformed invocations", () => {
  assert.deepEqual(parseCommandArgs("--extra"), {
    baseRef: null,
    extraInstruction: null,
    error: "Missing value for --extra",
  });

  assert.deepEqual(parseCommandArgs("main develop"), {
    baseRef: null,
    extraInstruction: null,
    error: "Unexpected argument: develop",
  });

  assert.deepEqual(parseCommandArgs("--extra 'oops"), {
    baseRef: null,
    extraInstruction: null,
    error: "Unterminated quote in arguments",
  });

  assert.deepEqual(parseCommandArgs("--extra trailing\\"), {
    baseRef: null,
    extraInstruction: null,
    error: "Trailing escape character in arguments",
  });
});

test("parseCommandArgs respects -- as the end of flag parsing", () => {
  assert.deepEqual(parseCommandArgs("--extra focus -- release/candidate"), {
    baseRef: "release/candidate",
    extraInstruction: "focus",
    error: null,
  });
});
