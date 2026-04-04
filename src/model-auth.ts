import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

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

type ContextModel = NonNullable<ExtensionCommandContext["model"]>;
type LegacyModelRegistry = ExtensionCommandContext["modelRegistry"] & {
  hasConfiguredAuth?: (model: ContextModel) => boolean;
  getApiKeyAndHeaders?: (model: ContextModel) => Promise<RequestAuth>;
  getApiKey?: (model: Model<Api>) => Promise<string | undefined>;
};

function noApiKeyError(model: ContextModel): string {
  return `No API key found for "${model.provider}"`;
}

function hasApiKey(auth: RequestAuth): auth is Extract<RequestAuth, { ok: true }> & { apiKey: string } {
  return auth.ok && auth.apiKey != null;
}

// Pi 0.63+ resolves per-request auth dynamically via getApiKeyAndHeaders().
// Keep a narrow fallback for older registries so the extension still works
// against older test doubles or older local installs.
export async function getModelRequestAuth(modelRegistry: LegacyModelRegistry, model: ContextModel): Promise<RequestAuth> {
  try {
    if (typeof modelRegistry.getApiKeyAndHeaders === "function") {
      return await modelRegistry.getApiKeyAndHeaders(model);
    }

    if (typeof modelRegistry.getApiKey === "function") {
      const apiKey = await modelRegistry.getApiKey(model);
      if (apiKey == null) {
        return {
          ok: false,
          error: noApiKeyError(model),
        };
      }

      return {
        ok: true,
        apiKey,
      };
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    ok: false,
    error: "The current Pi model registry does not support request auth lookup.",
  };
}

// The browser reviewer calls complete(...) directly, so it needs a concrete API
// key even when Pi's registry can still resolve auxiliary headers.
export async function getModelCompletionAuth(modelRegistry: LegacyModelRegistry, model: ContextModel): Promise<RequestAuth> {
  const auth = await getModelRequestAuth(modelRegistry, model);
  if (!auth.ok || hasApiKey(auth)) {
    return auth;
  }

  return {
    ok: false,
    error: noApiKeyError(model),
  };
}

// Idle sendUserMessage() follows Pi's hasConfiguredAuth() gate before it ever
// attempts per-request auth resolution, so match that behavior here.
export async function getModelIdleSessionAuth(modelRegistry: LegacyModelRegistry, model: ContextModel): Promise<RequestAuth> {
  if (typeof modelRegistry.hasConfiguredAuth === "function" && !modelRegistry.hasConfiguredAuth(model)) {
    return {
      ok: false,
      error: noApiKeyError(model),
    };
  }

  const auth = await getModelRequestAuth(modelRegistry, model);
  if (!auth.ok || typeof modelRegistry.hasConfiguredAuth === "function" || hasApiKey(auth)) {
    return auth;
  }

  return {
    ok: false,
    error: noApiKeyError(model),
  };
}
