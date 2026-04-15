# Plan: Review Features for pi-diff-review

> Borrows design, rubric, and review guidelines from
> `/Users/exaclior/trial/pi-review` — adapted to the browser-based
> architecture of pi-diff-review.

---

## Status: DRAFT — awaiting approval

## Guiding Principles

1. **The browser diff viewer is the core asset.** Every change must serve it.
2. **Human reviews code; LLM assists.** Automated findings are suggestions the
   user curates, never auto-delivered.
3. **Don't break what works.** The existing `/diff-review <ref>` fast path
   stays intact. New features layer on top.
4. **Stage the work.** Six steps, each independently shippable and testable.

---

## Architecture: Current vs. Proposed

### Current Flow
```
/diff-review [ref]
  → if ref given: resolveBaseRef(ref)
    else: getDiffReviewFiles() resolves default branch internally
  → getDiffReviewFiles()      (diff base-ref vs working tree)
  → addHunkExplanations()     (LLM: per-hunk what/how/why/tests/risks)
  → startReviewServer()       (localhost HTTP, browser opens)
  → user reviews in browser   (comments, replies to explanations)
  → composeReviewPrompt()     ("Please address the following feedback…")
  → deliverReviewToSession()  (send to pi)
```

Note: when no ref is given, `getDiffReviewFiles()` calls
`getDefaultRemoteBranch()` internally — the handler passes `undefined`
and the git layer picks the branch.

### Proposed Flow (after all 6 steps)
```
/diff-review [ref] [--extra "…"]
  → parseCommandArgs()            ← NEW: parse --extra flag, bare ref
  → if bare ref given:
      resolveBaseRef()             (preserved: fast path)
    else:
      showReviewSelector()         ← NEW: TUI selector
        returns SelectorResult:    ("worktree" with baseRef, or
                                    "commit" with sha)
  → getDiffReviewFiles() OR       (preserved: worktree materializer)
    getDiffReviewFilesForCommit()  ← NEW: git-vs-git materializer
  → loadProjectGuidelines()       ← NEW: REVIEW_GUIDELINES.md
  → buildPatches()                 ← NEW: shared patch/hunk artifact layer
  → [concurrent]
    ├─ addHunkExplanations()       (same, but consumes shared patches)
    └─ runAutomatedReview()        ← NEW: full rubric, structured findings
  → startReviewServer()           (extended: includes findings + guidelines)
  → user reviews in browser       (extended: verdict strip, findings list,
                                    user can include/dismiss each finding)
  → composeReviewPrompt()         ← ENHANCED: section-based builder
  → deliverReviewToSession()      (same)
```

Key constraint: **bare ref arguments are always branch/tag refs**, never
commit SHAs. Commit review is only available through the TUI selector
(Step 6). This avoids ambiguity — if someone types `/diff-review abc1234`,
it's treated as a branch name, matching current behavior.

---

## Step 1: Structured Delivery Prompt

**Goal:** Replace the vague "Please address the following feedback" with a
structured format that gives pi actionable instructions.

**Risk:** Low. Pure prompt text change, no new data dependencies.

### Files Changed

| File | Change |
|---|---|
| `src/prompt.ts` | Rewrite `composeReviewPrompt()` output format |
| `test/prompt.test.ts` | Update expected output in existing tests |

### Design

The composed prompt currently looks like:
```
Please address the following feedback

<overall comment>

1. src/foo.ts:42 (new)
   Fix the null check
```

After this step:
```
# Diff Review Feedback

## Overall Note
<overall comment>

## LLM Explainer Note Replies
1. src/foo.ts (old 10-15 · new 10-18)
   LLM explainer note: <original note>
   Reviewer reply: <user reply>

## Review Comments
1. src/foo.ts:42 (new)
   Fix the null check

## Requested Actions
1. Address each finding above in priority order.
2. For each finding, either fix it or explain why it doesn't apply.
3. Run relevant tests for touched code.
4. Summarize what you fixed and what you skipped (with reasons).
```

The "Requested Actions" section replaces the implicit expectation that pi
knows what to do with feedback. This borrows from pi-review's
`REVIEW_FIX_FINDINGS_PROMPT`.

**Forward-compatibility:** `composeReviewPrompt()` is refactored from a
2-arg function `(files, payload)` into a section-based builder that
accepts an options object:

```typescript
interface ComposeReviewPromptOptions {
  files: DiffReviewFile[];
  payload: ReviewSubmitPayload;
  includedFindings?: ReviewFinding[];    // Step 5 adds this
  curatedCallouts?: ReviewCallout[];     // Step 5 adds this
}

export function composeReviewPrompt(options: ComposeReviewPromptOptions): string;
```

In Step 1, `includedFindings` and `curatedCallouts` are always undefined.
Step 5 fills them in without changing the function signature.

### Test Plan
- Update existing `prompt.test.ts` cases for new format.
- Add a case with zero comments (should still produce a valid prompt if
  there's an overall note or explanation reply).
- Add a case with only explanation replies (no comments, no overall note).
- Verify the `ComposeReviewPromptOptions` type accepts optional
  `includedFindings`/`curatedCallouts` without breaking existing calls.

---

## Step 2: Shared Patch/Hunk Artifact Layer

**Goal:** Extract patch generation and hunk parsing into a shared layer that
both explanations and automated review can consume, avoiding redundant
`git diff --no-index` calls.

**Risk:** Medium. Touches the explanation hot path. Must not regress.

### Files Changed

| File | Change |
|---|---|
| `src/patches.ts` | **NEW.** Extract `buildUnifiedPatch()`, `parseUnifiedDiffHunks()`, `normalizeUnifiedPatchHeaders()` from `explain.ts`. Export a `FilePatchResult` type holding the raw patch text, parsed hunks, and file reference. |
| `src/explain.ts` | Remove extracted functions. Import from `patches.ts`. `addHunkExplanations()` receives pre-built patches instead of building them internally. |
| `src/types.ts` | Add `FilePatchResult` type (re-exported from patches). |
| `test/explain.test.ts` | Adapt imports. Existing tests must pass unchanged. |
| `test/patches.test.ts` | **NEW.** Move patch-specific tests here. |

### Design

```typescript
// src/patches.ts

export interface FilePatchResult {
  file: DiffReviewFile;
  patchText: string;
  hunks: DiffHunkSeed[];      // re-exported from explain.ts internals
  error: string | null;       // non-null if patch generation failed
}

/** Build patches for all files. Pure git operation, no model calls. */
export async function buildFilePatches(
  pi: ExtensionAPI,
  repoRoot: string,
  files: DiffReviewFile[],
): Promise<FilePatchResult[]>;
```

`addHunkExplanations()` signature changes from:
```typescript
addHunkExplanations(pi, ctx, repoRoot, files)
```
to:
```typescript
addHunkExplanations(pi, ctx, patches: FilePatchResult[])
```

The existing `buildUnifiedPatch` → temp file → `git diff --no-index` flow
moves verbatim into `patches.ts`. The only behavioral change is that patches
are built once, up front, and shared.

### Test Plan
- `test/patches.test.ts`: port existing hunk-parsing and patch-normalization
  tests from `explain.test.ts`.
- `test/explain.test.ts`: verify explanation generation still works when
  given pre-built patches.
- Run full suite: `npm test`.

---

## Step 3: Git-vs-Git Materializer (Commit Review)

**Goal:** Support reviewing a specific commit's changes. Both old and new
content come from git (not the working tree).

**Risk:** Medium. New git code paths. Edge cases: root commits, merge commits.

### Scope Decisions

| Mode | Status | Rationale |
|---|---|---|
| Base branch | ✅ Existing | Works today. |
| Uncommitted | ✅ Existing | `baseRef = "HEAD"` already works. |
| Commit | ✅ New in this step | Both sides from git. |
| Pull request | ❌ Deferred | `gh pr checkout` mutates working tree. Needs a non-mutating fetch strategy (e.g., `gh pr diff`) designed separately. |
| Folder | ❌ Omitted | No diff — doesn't fit the browser architecture. |

### Files Changed

| File | Change |
|---|---|
| `src/git.ts` | Add `getDiffReviewFilesForCommit(pi, cwd, sha)`. Add helpers: `getLocalBranches()`, `getRecentCommits()`, `getCurrentBranch()`, `getDefaultBranch()`, `hasUncommittedChanges()`, `getMergeBase()`. |
| `src/types.ts` | Add `ReviewTarget` union type (used by selector in Step 6, but the materializer uses `sha` directly). |
| `test/base-ref.test.ts` | Add commit-mode tests. |

### Design

```typescript
// src/git.ts — new export

/**
 * Materialize diff files for a single commit (commit^ vs commit).
 * Both old and new content come from git objects, not the working tree.
 *
 * For root commits (no parent), old content is empty.
 * For merge commits, diffs against first parent (git convention).
 */
export async function getDiffReviewFilesForCommit(
  pi: ExtensionAPI,
  cwd: string,
  sha: string,
): Promise<{ repoRoot: string; files: DiffReviewFile[] }>;
```

Implementation:
1. `git rev-parse --verify <sha>` — validate the commit exists.
2. `git rev-list --count --parents <sha> -1` — determine parent count.
3. **Root commit (0 parents):** Use git's empty tree hash
   (`4b825dc642cb6eb9a060e54bf899d15363da7b23`) as the base.
   `git diff --find-renames -M --name-status -z 4b825dc...  <sha> --`.
4. **Normal commit (1 parent):** `git diff --find-renames -M --name-status -z <sha>^1 <sha> --`.
5. **Merge commit (2+ parents):** Diff against first parent (`<sha>^1`).
   Matches `git show` default behavior.
6. For each changed file:
   - Old content: `git show <parent-or-empty-tree>:<path>` (empty for root/added).
   - New content: `git show <sha>:<path>` (empty for deleted).
   - If `git show` fails for a path (e.g., binary file), set content to
     empty string and continue (matches existing worktree behavior).
7. No untracked files (both sides are committed).
8. Sort with existing `sortFilesForReview()`.

### Edge Cases

| Case | Behavior |
|---|---|
| Root commit (no parent) | Diff against git's empty tree hash. Old content is always empty. |
| Merge commit | Diff against first parent (`<sha>^1`). Matches `git show` default. |
| Empty commit (no file changes) | Return empty files array. Notify user "No changes in commit." |
| Invalid SHA | Return error via notification, abort review. |
| Binary files | Set content to empty string. File appears in tree but diff is empty. |

### Test Plan
- Mock `git` responses for: normal commit, root commit, merge commit,
  empty commit, rename across commit.
- Verify old+new content comes from git objects, not filesystem.
- Root commit test: verify empty tree hash is used, not `<sha>^`.
- Binary file: verify content is empty string, file still appears.
- Invalid SHA: verify error propagation.
- Use temp git repos (same pattern as `base-ref.test.ts`) for
  integration tests where practical.

---

## Step 4: Automated Review Pass

**Goal:** Run a second LLM call with the full review rubric. Produces
structured findings with priority levels, a verdict, and human callouts.

**Risk:** High. New model call, new data type, new browser contract. Latency
concern (mitigated by running concurrently with explanations).

### Files Changed

| File | Change |
|---|---|
| `src/review.ts` | **NEW.** `REVIEW_RUBRIC` constant, `runAutomatedReview()`, response parser, types. |
| `src/guidelines.ts` | **NEW.** `loadProjectReviewGuidelines()`. |
| `src/types.ts` | Add `ReviewFinding`, `AutomatedReviewResult`, `AutomatedReviewStatus`. |
| `src/index.ts` | Run review concurrently with explanations. Pass results to server. |
| `src/server.ts` | Extend `DiffReviewWindowData` with review results. |
| `test/review.test.ts` | **NEW.** Parser tests, rubric assembly tests. |
| `test/guidelines.test.ts` | **NEW.** Path-walking tests. |

### Design: Review Rubric

Borrow the full `REVIEW_RUBRIC` from pi-review verbatim. It covers:

- **What to flag** (9 criteria — accuracy, performance, security,
  maintainability; only flag issues introduced in the diff, not pre-existing;
  must be provably impactful)
- **Untrusted user input** (open redirects, SQL injection, SSRF, escaping)
- **Comment guidelines** (brevity, severity, `suggestion` blocks, tone)
- **Fail-fast error handling** (flag try/catch that hides failures)
- **Priority levels** — `[P0]` Drop everything. `[P1]` Urgent. `[P2]` Normal. `[P3]` Low.
- **Required human callouts** (migrations, deps, auth, breaking API, destructive ops, feature flags, config defaults)
- **Output format** (findings with priority tags, verdict, callouts section)

### Design: Tool-Based Structured Output

Like the explanation generator, use a tool to enforce structure:

```typescript
const REVIEW_FINDINGS_TOOL_NAME = "submit_review_findings";
const REVIEW_FINDINGS_TOOL: Tool = {
  name: REVIEW_FINDINGS_TOOL_NAME,
  description: "Submit structured code review findings.",
  parameters: Type.Object({
    verdict: Type.Union([Type.Literal("correct"), Type.Literal("needs_attention")]),
    findings: Type.Array(
      Type.Object({
        priority: Type.Union([
          Type.Literal("P0"),
          Type.Literal("P1"),
          Type.Literal("P2"),
          Type.Literal("P3"),
        ]),
        title: Type.String(),
        filePath: Type.String(),
        startLine: Type.Optional(Type.Integer({ minimum: 1 })),
        endLine: Type.Optional(Type.Integer({ minimum: 1 })),
        side: Type.Optional(Type.Union([Type.Literal("old"), Type.Literal("new")])),
        body: Type.String(),
        suggestion: Type.Optional(Type.String()),
      }),
    ),
    callouts: Type.Array(
      Type.Object({
        category: Type.String(),  // e.g. "new dependency", "migration"
        detail: Type.String(),
      }),
    ),
  }),
};
```

### Design: Stable Finding IDs

Findings need stable IDs so the browser can reference them in
`includedFindingIds`. The model cannot generate these — we assign them
server-side after parsing the tool response:

```typescript
function assignFindingIds(rawFindings: RawReviewFinding[]): ReviewFinding[] {
  return rawFindings.map((finding, index) => ({
    ...finding,
    id: `finding:${index}`,
    // Validate location against actual reviewed files:
    // - If filePath doesn't match any reviewed file, mark as "global"
    // - If startLine/endLine exceed file bounds, clear them
    // - For renamed files, accept either old or new path
    // - For deleted files, force side to "old"
  }));
}
```

### Design: Location Model

Findings locations need to handle cases the model might get wrong:

```typescript
export interface ReviewFindingLocation {
  fileId: string | null;     // null = global/cross-file finding
  filePath: string;          // display path (may differ from fileId)
  startLine: number | null;  // null = file-level finding
  endLine: number | null;
  side: "old" | "new" | null; // null = file-level
}
```

For renamed files (`old.ts → new.ts`), the model might reference either
path. The normalization layer resolves both to the same `fileId`.
For deleted files, `side` is forced to `"old"`. For added files, forced
to `"new"`.

Global/cross-file findings (e.g., "this migration is missing a
rollback") have `fileId: null` and no line numbers.

### Design: Review Prompt Assembly

```typescript
async function buildReviewPrompt(
  patches: FilePatchResult[],
  projectGuidelines: string | null,
  extraInstruction: string | null,
): Promise<string> {
  // 1. REVIEW_RUBRIC (static, from pi-review)
  // 2. Full unified diff (all files concatenated)
  // 3. Project-specific guidelines (if REVIEW_GUIDELINES.md found)
  // 4. Extra instruction (if --extra given)
  // 5. Instruction to call the tool exactly once
}
```

### Design: Size Guard

Large diffs can exceed context windows. Add a guard:
- Count total patch lines across all files.
- If over a configurable threshold (default: 5000 lines), skip automated
  review and set status to `"skipped-too-large"`.
- Notify user: "Diff too large for automated review (N lines). Skipping."

### Design: Concurrency

```typescript
// src/index.ts — inside reviewDiff()

const patches = await buildFilePatches(pi, repoRoot, files);

const [explanationResult, reviewResult] = await Promise.all([
  addHunkExplanations(pi, ctx, patches),
  runAutomatedReview(pi, ctx, patches, { projectGuidelines, extraInstruction }),
]);
```

Both consume the shared `FilePatchResult[]` from Step 2. No data dependency
between them. The browser opens only after both complete.

### Design: AutomatedReviewStatus (parallel to ExplanationStatus)

```typescript
export type AutomatedReviewState =
  | "generated"           // findings produced
  | "no-findings"         // reviewed, nothing to flag
  | "skipped-no-model"
  | "skipped-no-auth"
  | "skipped-too-large"
  | "request-failed"
  | "invalid-response";

export interface AutomatedReviewStatus {
  state: AutomatedReviewState;
  attempted: boolean;
  modelLabel: string | null;
  summary: string;           // user-facing one-liner
}

export interface AutomatedReviewResult {
  verdict: "correct" | "needs_attention" | null;
  findings: ReviewFinding[];
  callouts: ReviewCallout[];
  status: AutomatedReviewStatus;
}
```

### Design: loadProjectReviewGuidelines()

Borrowed directly from pi-review. Walk up from `cwd`:
1. Check if `<dir>/.pi` exists and is a directory.
2. If yes, check if `<dir>/REVIEW_GUIDELINES.md` exists.
3. If yes, read and return its contents.
4. If no `.pi` found, move to parent. Stop at filesystem root.

```typescript
// src/guidelines.ts
export async function loadProjectReviewGuidelines(cwd: string): Promise<string | null>;
```

### Test Plan
- `test/review.test.ts`: Test tool-call parsing, text-fallback parsing,
  size guard, prompt assembly with/without guidelines.
- `test/guidelines.test.ts`: Test path walking with temp directories
  (`.pi` dir present/absent, guidelines present/absent).
- Integration: verify concurrent execution doesn't interfere.

---

## Step 5: Browser UI for Findings

**Goal:** Show automated review findings in the browser. Users can
include/dismiss each finding before submitting.

**Risk:** Medium. Browser code changes. Must not break existing
comment/explanation flows.

### Files Changed

| File | Change |
|---|---|
| `web/index.html` | Add verdict strip below topbar. Add findings count to summary. |
| `web/app-source.js` | Render findings list, verdict strip, include/dismiss controls. Wire findings into submit payload. |
| `web/styles.css` | Styles for verdict strip, finding cards, priority badges. |
| `src/types.ts` | Add `ReviewFindingAction` to `ReviewSubmitPayload`. |
| `src/server.ts` | Extend `DiffReviewWindowData` with `automatedReview`. |
| `src/prompt.ts` | Include user-curated findings in composed prompt. |
| `scripts/build-web.mjs` | No change (esbuild handles new code). |
| `test/types.test.ts` | Update `isReviewSubmitPayload` tests. |
| `test/prompt.test.ts` | Add cases with included findings. |

### Design: Browser Layout

```
┌─────────────────────────────────────────────────────┐
│ Diff review     ✅ correct / ⚠️ needs attention      │  ← verdict in topbar
│ repo-root       3 findings (1 P1, 2 P2)             │  ← count in summary
├──────────┬──────────────────────┬───────────────────┤
│ Changed  │                      │ [Notes] [Findings]│  ← tab toggle
│ files    │     Diff viewer      │                   │
│          │                      │ [P1] Title...     │
│          │                      │   ☑ Include       │
│          │                      │                   │
│          │                      │ [P2] Title...     │
│          │                      │   ☐ Dismiss       │
│          │                      │                   │
│          │                      │ ▸ Callouts (2)    │  ← collapsible
│          │                      │   ☐ Include       │
└──────────┴──────────────────────┴───────────────────┘
```

The right pane gets **two tabs**: "Notes" (existing: explanations + file
comments) and "Findings" (new: automated review findings for the active
file, plus global findings and callouts). The verdict appears in the
topbar summary line, not as a separate strip.

**Scope reality check:** This is a significant right-pane rewrite, not
just "add a tab." The current right pane has one state model
(explanations + file comments), one header, one container, and one
render cycle. Adding a tab means:
- Tab state tracking (active tab per file, or global)
- Separate render functions for each tab
- Submit payload builder extended with findings
- Empty/error/skipped states for findings tab
- Global findings (not tied to a file) shown in a "Global" section

The Notes tab itself is **not** rewritten — its render logic and state
are preserved exactly. The tab container wraps it.

### Design: Finding Cards

Each finding card shows:
- Priority badge: `[P0]` red, `[P1]` orange, `[P2]` yellow, `[P3]` gray
- Title (from the finding)
- File location (display only in v1 — clicking switches to the file
  but does **not** scroll to a specific line. Line-level jump requires
  validating model-generated line numbers against hunk boundaries,
  which is deferred to a follow-on)
- Body text (the explanation of the issue)
- Suggestion block (if present, in a code block)
- **Include/Dismiss toggle** (checkbox). Default: included for P0/P1,
  dismissed for P2/P3. User can change.

**Empty/error/skipped states:**
- If automated review was skipped (no model, no auth, diff too large):
  "Automated review was skipped: <reason>"
- If review ran but found nothing: "No issues found. ✅"
- If review failed: "Automated review failed: <error>. You can still
  review manually."

### Design: Submit Payload Extension

```typescript
// Extended ReviewSubmitPayload (backward-compatible: new fields optional)
export interface ReviewSubmitPayload {
  type: "submit";
  overallComment: string;
  explanationReplies: ExplanationReply[];
  comments: ReviewComment[];
  includedFindingIds?: string[];   // ← NEW: IDs of findings user chose to include
  includeCallouts?: boolean;       // ← NEW: whether to append callouts
}
```

Only included findings appear in the composed prompt. Dismissed findings
are silently dropped. Callouts are appended only if `includeCallouts` is
true. This ensures the human always curates what pi sees.

**Default behavior:** P0 and P1 findings are pre-checked (included).
P2 and P3 findings are unchecked (dismissed). Callouts default to
unchecked. User can change all of these before submitting.

### Design: Human Callouts Section

If the automated review produced callouts (migrations, new deps, etc.),
show them in a collapsible section at the bottom of the Findings tab.
These are informational only.

**Curation rule:** Callouts are shown in the browser but are **not**
included in the composed prompt unless the user explicitly checks an
"Include callouts" toggle. This preserves the principle that humans
curate everything the model sees.

The submit payload carries:
```typescript
includedFindingIds: string[];   // curated findings
includeCallouts: boolean;       // user opted in to include callouts
```

### Test Plan
- `test/types.test.ts`: Validate `isReviewSubmitPayload` accepts
  `includedFindingIds`.
- `test/prompt.test.ts`: Verify included findings appear in output,
  dismissed findings don't.
- Manual: open browser, verify finding cards render, toggle works, submit
  includes only selected findings.

---

## Step 6: TUI Selector + --extra Flag

**Goal:** When `/diff-review` is invoked without arguments, show an
interactive TUI selector instead of defaulting to the remote branch. Add
`--extra` flag support for all invocations.

**Risk:** Medium. TUI code is new but follows pi-review's proven patterns.
Must preserve the existing fast path (`/diff-review main`).

### Scope Decisions (Selector Presets)

| Preset | Included | Notes |
|---|---|---|
| Uncommitted changes | ✅ | Equivalent to `/diff-review HEAD` but explicit. |
| Base branch (with picker) | ✅ | Fuzzy-searchable local branch list. |
| Specific commit (with picker) | ✅ | Recent 20 commits, fuzzy search. |
| Pull request | ❌ Deferred | Needs non-mutating fetch design. |
| Folder (snapshot) | ❌ Omitted | No diff — doesn't fit architecture. |
| Custom review instructions | ❌ Deferred | Persistence + restore/remove UX is a follow-on. |

### Files Changed

| File | Change |
|---|---|
| `src/selector.ts` | **NEW.** `showReviewSelector()`, `showBranchSelector()`, `showCommitSelector()`, `getSmartDefault()`. |
| `src/index.ts` | Wire selector when no args. Parse `--extra`. Pass extra instruction to review. Dispatch to worktree or commit materializer based on selection. |
| `src/git.ts` | (Helpers already added in Step 3.) |
| `test/index.test.ts` | Add `--extra` parsing tests. |

### Design: Command Interface

```
/diff-review                       → show TUI selector
/diff-review main                  → fast path (existing behavior, preserved)
/diff-review current               → fast path (existing behavior, preserved)
/diff-review some-branch           → fast path (existing behavior, preserved)
/diff-review --extra "focus on X"  → selector + extra instruction
/diff-review main --extra "focus"  → fast path + extra instruction
```

**Bare refs are always branch/tag refs.** Commit review is only
available through the TUI selector's commit picker. This avoids
ambiguity — `abc1234` is treated as a branch name in fast-path mode,
matching current behavior exactly.

### Design: Arg Parsing

```typescript
interface ParsedArgs {
  baseRef: string | null;         // non-null → fast path, skip selector
  extraInstruction: string | null;
  error: string | null;           // non-null → show error, abort
}

function parseCommandArgs(args: string): ParsedArgs;
```

Tokenize with shell-like quoting (borrow `tokenizeArgs` from pi-review).

**`--extra` behavior (precise spec):**
- `--extra value` — consumes the next token as the instruction.
- `--extra=value` — inline form.
- `--extra` at end of args with no next token → error: `"Missing value for --extra"`.
- Multiple `--extra` flags → concatenate values with `\n` separator.
- `--extra ""` (empty explicit value) → ignored (treated as no extra).
- `--` ends flag parsing; everything after is part of `baseRef`.
- Any non-flag token is the `baseRef`. Multiple non-flag tokens → error.

**Examples:**
```
""                        → { baseRef: null, extraInstruction: null }
"main"                    → { baseRef: "main", extraInstruction: null }
"--extra 'focus on auth'" → { baseRef: null, extraInstruction: "focus on auth" }
"main --extra foo"        → { baseRef: "main", extraInstruction: "foo" }
"--extra a --extra b"     → { baseRef: null, extraInstruction: "a\nb" }
"--extra"                 → { error: "Missing value for --extra" }
"main develop"            → { error: "Unexpected argument: develop" }
```

### Design: Smart Defaults

When the selector opens, pre-select based on git state:
1. If uncommitted changes exist → pre-select "Uncommitted changes"
2. If on a feature branch (not default) → pre-select "Base branch"
3. Otherwise → pre-select "Specific commit"

### Design: TUI Selector

Uses pi-tui components available via peer dependency:
- `SelectList` for preset picker
- `SelectList` + `Input` + `fuzzyFilter` for branch/commit pickers
- Same patterns as pi-review (proven, working code)

```typescript
// src/selector.ts

export type SelectorResult =
  | { type: "worktree"; baseRef: string }   // feeds into getDiffReviewFiles()
  | { type: "commit"; sha: string }         // feeds into getDiffReviewFilesForCommit()
  | null;                                    // user cancelled

export async function showReviewSelector(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<SelectorResult>;
```

### Design: Integration in index.ts

```typescript
async function reviewDiff(ctx, args) {
  const parsed = parseCommandArgs(args);

  let files, repoRoot;

  if (parsed.baseRef != null) {
    // Fast path: existing behavior
    const baseRef = await resolveBaseRef(pi, ctx.cwd, parsed.baseRef);
    ({ repoRoot, files } = await getDiffReviewFiles(pi, ctx.cwd, baseRef));
  } else {
    // TUI selector
    const selection = await showReviewSelector(pi, ctx);
    if (selection == null) { ctx.ui.notify("Cancelled", "info"); return; }

    if (selection.type === "worktree") {
      const baseRef = await resolveBaseRef(pi, ctx.cwd, selection.baseRef);
      ({ repoRoot, files } = await getDiffReviewFiles(pi, ctx.cwd, baseRef));
    } else {
      ({ repoRoot, files } = await getDiffReviewFilesForCommit(pi, ctx.cwd, selection.sha));
    }
  }

  // ... rest of flow (patches, explanations, review, browser)
}
```

### Test Plan
- `test/index.test.ts`: `parseCommandArgs` with full matrix:
  - No args, single ref, `--extra value`, `--extra=value`,
    `--extra` at end (error), multiple `--extra`, empty extra,
    `--` separator, multiple non-flag tokens (error), quoted values.
- TUI selector: test `getSmartDefault()` in isolation with mocked git.
- Branch/commit pickers: test data preparation functions, not the
  interactive TUI (manual QA for that).

---

## Implementation Order & Dependencies

```
Step 1: Structured Delivery Prompt
  ↓ (no dependency, can ship alone)
Step 2: Shared Patch/Hunk Layer
  ↓ (required by Steps 4 and enables cleaner Step 3)
Step 3: Commit Materializer
  ↓ (required by Step 6's commit picker)
Step 4: Automated Review Pass
  ↓ (required by Step 5)
Step 5: Browser UI for Findings
  ↓ (required by Step 6 for full UX, but Step 6 works without it)
Step 6: TUI Selector + --extra
```

Steps 1 and 2 can be developed in parallel. Steps 3 and 4 can be developed
in parallel (both depend on Step 2). Step 5 depends on Step 4. Step 6
depends on Step 3 and is enhanced by Step 5.

```
        ┌─────────┐
        │ Step 1   │  Structured prompt
        │ (prompt) │
        └─────────┘
        ┌─────────┐
        │ Step 2   │  Shared patches
        │ (patch)  │
        └────┬─────┘
        ┌────┴────┐
   ┌────┴───┐ ┌───┴────┐
   │ Step 3  │ │ Step 4  │
   │(commit) │ │(review) │
   └────┬────┘ └───┬────┘
        │     ┌────┴───┐
        │     │ Step 5  │
        │     │(browser)│
        │     └───┬────┘
        └────┬────┘
        ┌────┴────┐
        │ Step 6   │
        │(selector)│
        └─────────┘
```

---

## Deferred Features

These are worth doing but should be separate work items:

| Feature | Reason for Deferral |
|---|---|
| **PR review mode** | `gh pr checkout` mutates working tree. Needs a non-mutating strategy (e.g., `gh pr diff --patch` piped through the materializer, or `git fetch` + ref-pair review). Design separately. |
| **Custom review instructions** (persistent) | Requires `appendEntry`/`getEntries` state management, add/remove UX in selector, restore on session reload. Follow-on after selector lands. |
| **Live browser updates** | Currently browser gets a snapshot at open time. Streaming findings/explanations into the browser after open would improve perceived latency but adds WebSocket/SSE complexity. |
| **Finding → diff line jump** | In v1, clicking a finding's file location switches to the file but doesn't scroll to a line. Full jump-to-line requires validating model-generated line numbers against hunk boundaries and anchoring to the diff view's coordinate system (same problem the explanation system solves with `anchorSide`/`anchorLine`). Follow-on after findings ship. |

---

## Risk Register

| Risk | Mitigation |
|---|---|
| Two LLM calls before browser opens = slow | Run concurrently (Step 4 design). Add timeout. Show progress notification. |
| Large diffs exceed context window | Size guard skips automated review above threshold. |
| Root/merge commit edge cases | Explicit handling in Step 3 design. Test coverage. |
| Browser findings UI breaks existing flows | Findings live in a separate tab; existing Notes tab is untouched. |
| Model produces unstructured findings | Tool-based approach enforces schema. Text fallback parser as safety net. |
| `pi-tui` API changes | Pin to existing peer dependency version. Use only stable components (`SelectList`, `Input`, `fuzzyFilter`, `Container`, `Text`). |

---

## Test Strategy

Each step includes its own test plan (above). Cross-cutting:

- **Unit tests**: All pure functions (parsers, prompt builders, git helpers)
  tested with mock data.
- **Integration tests**: `getDiffReviewFilesForCommit` tested against real
  temp git repos (same pattern as existing `base-ref.test.ts`).
- **Manual QA**: TUI selector, browser findings UI.
- **Regression**: Run `npm test` after every step. No test removals.
