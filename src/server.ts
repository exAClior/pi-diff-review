import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isReviewSubmitPayload, type DiffReviewWindowData, type ReviewSessionResult } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDir = join(__dirname, "..", "web");

export interface ReviewServerSession {
  url: string;
  waitForResult(): Promise<ReviewSessionResult>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    "cache-control": "no-store",
    connection: "close",
    "content-type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(payload));
}

function writeText(res: ServerResponse, statusCode: number, contentType: string, payload: string): void {
  res.writeHead(statusCode, {
    "cache-control": "no-store",
    connection: "close",
    "content-type": `${contentType}; charset=utf-8`,
  });
  res.end(payload);
}

// Keep the asset surface small and explicit so code-split chunks can be served
// without opening up arbitrary file reads from the extension directory.
function getStaticAssetInfo(pathname: string): { contentType: string; filePath: string } | null {
  if (pathname === "/app.js") {
    return {
      contentType: "text/javascript",
      filePath: join(webDir, "app.js"),
    };
  }

  if (pathname === "/styles.css") {
    return {
      contentType: "text/css",
      filePath: join(webDir, "styles.css"),
    };
  }

  if (!pathname.startsWith("/chunks/") || !pathname.endsWith(".js")) {
    return null;
  }

  const chunksDir = join(webDir, "chunks");
  const filePath = resolve(webDir, `.${pathname}`);
  if (!filePath.startsWith(`${chunksDir}${sep}`)) {
    return null;
  }

  return {
    contentType: "text/javascript",
    filePath,
  };
}

// Browser code splitting turns Shiki languages and themes into many local JS
// files. Serving them on demand keeps the main entry chunk small while staying
// fully offline and localhost-only.
async function tryServeStaticAsset(res: ServerResponse, pathname: string): Promise<boolean> {
  const asset = getStaticAssetInfo(pathname);
  if (asset == null) {
    return false;
  }

  try {
    const payload = await readFile(asset.filePath, "utf8");
    writeText(res, 200, asset.contentType, payload);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isAuthorized(url: URL, token: string): boolean {
  return url.searchParams.get("token") === token;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  if (chunks.length === 0) {
    return null;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// The review server only needs one HTML shell, some local static assets, and a
// couple of JSON routes. Keeping everything in one tiny loopback server avoids
// webview plumbing while still letting the browser fetch code-split chunks.
export async function startReviewServer(data: DiffReviewWindowData): Promise<ReviewServerSession> {
  const token = randomUUID();
  const indexHtml = await readFile(join(webDir, "index.html"), "utf8");

  let settled = false;
  let closePromise: Promise<void> | null = null;
  let resolveResult: ((result: ReviewSessionResult) => void) | null = null;

  const resultPromise = new Promise<ReviewSessionResult>((resolve) => {
    resolveResult = resolve;
  });

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  const closeServer = (): Promise<void> => {
    if (closePromise != null) {
      return closePromise;
    }

    closePromise = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error != null) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    return closePromise;
  };

  const finish = (result: ReviewSessionResult): void => {
    if (settled) return;
    settled = true;
    resolveResult?.(result);
    void closeServer();
  };

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (method === "GET" && url.pathname === "/") {
        writeText(res, 200, "text/html", indexHtml);
        return;
      }

      if (method === "GET" && (await tryServeStaticAsset(res, url.pathname))) {
        return;
      }

      if (!isAuthorized(url, token)) {
        writeJson(res, 403, { error: "Invalid review token." });
        return;
      }

      if (method === "GET" && url.pathname === "/api/review") {
        writeJson(res, 200, data);
        return;
      }

      if (method === "POST" && url.pathname === "/api/submit") {
        const body = await readJsonBody(req);
        if (!isReviewSubmitPayload(body)) {
          writeJson(res, 400, { error: "Invalid review payload." });
          return;
        }
        writeJson(res, 200, { ok: true });
        finish(body);
        return;
      }

      if (method === "POST" && url.pathname === "/api/cancel") {
        writeJson(res, 200, { ok: true });
        finish({ type: "cancel" });
        return;
      }

      writeJson(res, 404, { error: "Not found." });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeJson(res, 500, { error: message });
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address == null || typeof address === "string") {
    await closeServer();
    throw new Error("Failed to start review server.");
  }

  const port = (address as AddressInfo).port;
  const encodedToken = encodeURIComponent(token);

  return {
    url: `http://127.0.0.1:${port}/?token=${encodedToken}`,
    waitForResult(): Promise<ReviewSessionResult> {
      return resultPromise;
    },
    async cancel(): Promise<void> {
      finish({ type: "cancel" });
      await closeServer();
    },
    async close(): Promise<void> {
      finish({ type: "cancel" });
      await closeServer();
    },
  };
}
