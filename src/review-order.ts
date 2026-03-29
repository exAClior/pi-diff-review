import type { DiffReviewFile } from "./types.js";

const LOCKFILE_NAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

const CONFIG_FILE_REGEX = /(?:^|\/)(?:package\.json|tsconfig(?:\.[^.\/]+)?\.json|jsconfig(?:\.[^.\/]+)?\.json|biome\.json|eslint(?:\.config)?\.[^.\/]+|prettier(?:\.config)?\.[^.\/]+|vite\.config\.[^.\/]+|vitest\.config\.[^.\/]+|jest\.config\.[^.\/]+|rollup\.config\.[^.\/]+|webpack\.config\.[^.\/]+|turbo\.json)$/i;
const BUILD_SCRIPT_REGEX = /(?:^|\/)scripts\/.+\.[^.\/]+$/i;
const CORE_SOURCE_PATH_REGEX = /(?:^|\/)src\//i;
const BROWSER_SOURCE_PATH_REGEX = /(?:^|\/)web\/(?!chunks\/)(?!app\.js$).+/i;
const DOC_FILE_REGEX = /(?:^|\/)(?:readme|changelog|changes|license|contributing)(?:\.[^.\/]+)?$/i;
const TEST_PATH_REGEX = /(?:^|\/)(?:test|tests|__tests__|__snapshots__)(?:\/|$)|\.(?:test|spec)\.[^.\/]+$/i;
const GENERATED_PATH_REGEX = /(?:^|\/)(?:build|coverage|dist|node_modules|vendor|web\/chunks|\.next|\.nuxt|\.svelte-kit)(?:\/|$)|(?:^|\/)web\/app\.js$|\.map$/i;
const MINIFIED_FILE_REGEX = /\.min\.[^.\/]+$/i;

function getReviewPath(file: Pick<DiffReviewFile, "newPath" | "oldPath" | "treePath" | "displayPath">): string {
  return file.newPath ?? file.oldPath ?? file.treePath ?? file.displayPath;
}

function pathDepth(path: string): number {
  return path.split("/").filter((segment) => segment.length > 0).length;
}

function isLockfile(path: string): boolean {
  const fileName = path.split("/").pop() ?? path;
  return LOCKFILE_NAMES.has(fileName.toLowerCase());
}

function isGeneratedPath(path: string): boolean {
  return GENERATED_PATH_REGEX.test(path) || MINIFIED_FILE_REGEX.test(path) || isLockfile(path);
}

function isConfigPath(path: string): boolean {
  return CONFIG_FILE_REGEX.test(path);
}

function isBuildScriptPath(path: string): boolean {
  return BUILD_SCRIPT_REGEX.test(path);
}

function isCoreSourcePath(path: string): boolean {
  return CORE_SOURCE_PATH_REGEX.test(path);
}

function isBrowserSourcePath(path: string): boolean {
  return BROWSER_SOURCE_PATH_REGEX.test(path);
}

function isTestPath(path: string): boolean {
  return TEST_PATH_REGEX.test(path);
}

function isDocPath(path: string): boolean {
  return DOC_FILE_REGEX.test(path) || path.toLowerCase().startsWith("docs/");
}

// This repo has a small number of meaningful review surfaces. Put package and
// build plumbing first, then the extension backend in src/, then the browser
// UI in web/, followed by tests, docs, and finally generated output.
function reviewBucket(path: string): number {
  if (isGeneratedPath(path)) return 5;
  if (isDocPath(path)) return 4;
  if (isTestPath(path)) return 3;
  if (isBrowserSourcePath(path)) return 2;
  if (isCoreSourcePath(path)) return 1;
  if (isConfigPath(path) || isBuildScriptPath(path)) return 0;
  return 1;
}

function comparePathsForReview(a: string, b: string): number {
  const bucketDiff = reviewBucket(a) - reviewBucket(b);
  if (bucketDiff !== 0) return bucketDiff;

  const depthDiff = pathDepth(a) - pathDepth(b);
  if (depthDiff !== 0) return depthDiff;

  return a.localeCompare(b);
}

// Keep review navigation deterministic and boring for this repo shape:
// config/build first, then src/, then web/, then tests/docs, then generated.
export function sortFilesForReview(files: DiffReviewFile[]): DiffReviewFile[] {
  return [...files].sort((a, b) => comparePathsForReview(getReviewPath(a), getReviewPath(b)));
}
