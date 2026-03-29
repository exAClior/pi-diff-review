import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDirectoryReviewIndices,
  buildReviewTreePath,
  compareReviewTreePaths,
  createReviewTreePaths,
} from "../web/review-tree-order.js";

test("buildDirectoryReviewIndices tracks the earliest review index for each directory", () => {
  const indices = buildDirectoryReviewIndices(["src/tsconfig.json", "lib/utils.ts", "src/index.ts"]);

  assert.equal(indices.get("src"), 0);
  assert.equal(indices.get("lib"), 1);
});

test("buildReviewTreePath prefixes both folders and files with review numbers", () => {
  const indices = buildDirectoryReviewIndices(["src/tsconfig.json", "lib/utils.ts", "src/index.ts"]);

  assert.equal(buildReviewTreePath("src/tsconfig.json", 0, 3, indices), "1 · src/1 · tsconfig.json");
  assert.equal(buildReviewTreePath("lib/utils.ts", 1, 3, indices), "2 · lib/2 · utils.ts");
  assert.equal(buildReviewTreePath("src/index.ts", 2, 3, indices), "1 · src/3 · index.ts");
});

test("createReviewTreePaths keeps the review sequence visible even when folders group files together", () => {
  assert.deepEqual(createReviewTreePaths(["src/tsconfig.json", "lib/utils.ts", "src/index.ts"]), [
    "1 · src/1 · tsconfig.json",
    "2 · lib/2 · utils.ts",
    "1 · src/3 · index.ts",
  ]);
});

test("compareReviewTreePaths sorts numbered tree paths alphabetically by their review prefix", () => {
  assert.equal(compareReviewTreePaths("02 · lib", "10 · web"), -1);
  assert.equal(compareReviewTreePaths("10 · web", "02 · lib"), 1);
  assert.equal(compareReviewTreePaths("03 · src", "03 · src"), 0);
});
