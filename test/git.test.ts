import assert from "node:assert/strict";
import test from "node:test";
import { sortFilesForReview } from "../src/review-order.js";
import type { DiffReviewFile } from "../src/types.js";

function makeFile(path: string): DiffReviewFile {
  return {
    id: path,
    status: "modified",
    oldPath: path,
    newPath: path,
    displayPath: path,
    treePath: path,
    oldContent: "",
    newContent: "",
    hunkExplanations: [],
  };
}

test("sortFilesForReview follows this repo's config -> src -> web -> tests -> docs -> generated order", () => {
  const files = [
    makeFile("web/chunks/generated.js"),
    makeFile("web/app.js"),
    makeFile("README.md"),
    makeFile("test/review-order.test.ts"),
    makeFile("src/index.ts"),
    makeFile("scripts/build-web.mjs"),
    makeFile("package.json"),
    makeFile("web/app-source.js"),
    makeFile("package-lock.json"),
  ];

  assert.deepEqual(
    sortFilesForReview(files).map((file) => file.treePath),
    [
      "package.json",
      "scripts/build-web.mjs",
      "src/index.ts",
      "web/app-source.js",
      "test/review-order.test.ts",
      "README.md",
      "package-lock.json",
      "web/app.js",
      "web/chunks/generated.js",
    ],
  );
});

test("sortFilesForReview prefers shallower files within the same review bucket", () => {
  const files = [
    makeFile("src/components/tree/item.ts"),
    makeFile("src/index.ts"),
    makeFile("src/components/tree.ts"),
  ];

  assert.deepEqual(
    sortFilesForReview(files).map((file) => file.treePath),
    ["src/index.ts", "src/components/tree.ts", "src/components/tree/item.ts"],
  );
});

test("sortFilesForReview uses the surviving path for deletions and additions", () => {
  const deletedFile: DiffReviewFile = {
    ...makeFile("src/deleted.ts"),
    id: "deleted",
    status: "deleted",
    newPath: null,
    treePath: "src/deleted.ts",
  };
  const addedFile: DiffReviewFile = {
    ...makeFile("src/added.ts"),
    id: "added",
    status: "added",
    oldPath: null,
    treePath: "src/added.ts",
  };

  assert.deepEqual(
    sortFilesForReview([deletedFile, addedFile]).map((file) => file.treePath),
    ["src/added.ts", "src/deleted.ts"],
  );
});
