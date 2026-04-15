import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadProjectReviewGuidelines } from "../src/guidelines.js";

test("loadProjectReviewGuidelines finds REVIEW_GUIDELINES.md next to the nearest .pi directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-diff-review-guidelines-"));
  const nested = join(root, "packages", "feature", "src");
  t.after(async () => {
    await rm(root, { force: true, recursive: true });
  });

  await mkdir(join(root, ".pi"), { recursive: true });
  await mkdir(nested, { recursive: true });
  await writeFile(join(root, "REVIEW_GUIDELINES.md"), "  Prefer explicit rollback steps.\n", "utf8");

  assert.equal(await loadProjectReviewGuidelines(nested), "Prefer explicit rollback steps.");
});

test("loadProjectReviewGuidelines stops at the nearest .pi even when no guidelines file exists", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-diff-review-guidelines-"));
  const nested = join(root, "apps", "web");
  t.after(async () => {
    await rm(root, { force: true, recursive: true });
  });

  await mkdir(join(root, ".pi"), { recursive: true });
  await mkdir(nested, { recursive: true });

  assert.equal(await loadProjectReviewGuidelines(nested), null);
});

test("loadProjectReviewGuidelines returns null when no .pi ancestor exists", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-diff-review-guidelines-"));
  const nested = join(root, "standalone", "src");
  t.after(async () => {
    await rm(root, { force: true, recursive: true });
  });

  await mkdir(nested, { recursive: true });
  await writeFile(join(root, "REVIEW_GUIDELINES.md"), "This should not be loaded.\n", "utf8");

  assert.equal(await loadProjectReviewGuidelines(nested), null);
});
