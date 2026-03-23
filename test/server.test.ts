import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startReviewServer } from "../src/server.js";
import type { ReviewServerSession } from "../src/server.js";
import type { DiffReviewWindowData, ReviewSubmitPayload } from "../src/types.js";

const sampleData: DiffReviewWindowData = {
  repoRoot: "/tmp/example-repo",
  files: [
    {
      id: "file-1",
      status: "modified",
      oldPath: "src/example.ts",
      newPath: "src/example.ts",
      displayPath: "src/example.ts",
      treePath: "src/example.ts",
      oldContent: "export const value = 1;\n",
      newContent: "export const value = 2;\n",
    },
  ],
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const webChunksDir = join(__dirname, "..", "web", "chunks");

function getSessionParts(session: ReviewServerSession): { apiBase: string; token: string } {
  const url = new URL(session.url);
  const token = url.searchParams.get("token");
  if (token == null) {
    throw new Error("expected a review token in the session url");
  }
  return {
    apiBase: url.origin,
    token,
  };
}

test("review server serves browser assets needed by code-split chunks", async (t) => {
  const session = await startReviewServer(sampleData);
  t.after(async () => {
    await session.close();
  });

  const { apiBase } = getSessionParts(session);
  const chunkFiles = (await readdir(webChunksDir)).filter((name) => name.endsWith(".js"));
  assert.ok(chunkFiles.length > 0, "expected build:web to emit chunk files");

  const appResponse = await fetch(`${apiBase}/app.js`);
  assert.equal(appResponse.status, 200);
  assert.match(await appResponse.text(), /\.\/chunks\//);

  const chunkResponse = await fetch(`${apiBase}/chunks/${chunkFiles[0]}`);
  assert.equal(chunkResponse.status, 200);
  assert.equal(chunkResponse.headers.get("content-type"), "text/javascript; charset=utf-8");
});

test("review server serves review data only to callers with the session token", async (t) => {
  const session = await startReviewServer(sampleData);
  t.after(async () => {
    await session.close();
  });

  const { apiBase, token } = getSessionParts(session);

  const unauthorizedResponse = await fetch(`${apiBase}/api/review?token=wrong-token`);
  assert.equal(unauthorizedResponse.status, 403);

  const authorizedResponse = await fetch(`${apiBase}/api/review?token=${encodeURIComponent(token)}`);
  assert.equal(authorizedResponse.status, 200);
  assert.deepEqual(await authorizedResponse.json(), sampleData);
});

test("review server resolves the session with the submitted payload", async (t) => {
  const session = await startReviewServer(sampleData);
  t.after(async () => {
    await session.close();
  });

  const { apiBase, token } = getSessionParts(session);
  const resultPromise = session.waitForResult();
  const payload: ReviewSubmitPayload = {
    type: "submit",
    overallComment: "Please fix the naming and simplify the branch.",
    comments: [
      {
        id: "comment-1",
        fileId: "file-1",
        kind: "line",
        side: "additions",
        startLine: 1,
        endLine: 1,
        body: "Rename this constant to explain what changed.",
      },
    ],
  };

  const response = await fetch(`${apiBase}/api/submit?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await resultPromise, payload);
});

test("review server resolves the session with cancel", async (t) => {
  const session = await startReviewServer(sampleData);
  t.after(async () => {
    await session.close();
  });

  const { apiBase, token } = getSessionParts(session);
  const resultPromise = session.waitForResult();

  const response = await fetch(`${apiBase}/api/cancel?token=${encodeURIComponent(token)}`, {
    method: "POST",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await resultPromise, { type: "cancel" });
});
