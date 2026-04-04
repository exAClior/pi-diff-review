# Pi 0.65.0 Migration Design

Date: 2026-04-04
Repo: `pi-diff-review`

## Problem

Pi `0.65.0` introduces several SDK and extension changes, but this repo only appears to touch a narrow part of that surface. Evidence: a repo-wide search in `src/`, `README.md`, and `package.json` found no uses of removed extension events such as `session_switch` or `session_fork`, no uses of removed session-replacement methods such as `newSession()` or `switchSession()` on `AgentSession`, and no uses of `session_directory`.

The one concrete changelog-aligned pattern in this repo is a standalone custom tool definition in [`src/explain.ts`](file:///Users/exaclior/coding_agents/pi-diff-review/src/explain.ts). That file currently defines `EXPLANATION_TOOL` as a manually widened `Tool` object imported from `@mariozechner/pi-ai`.

Pi `0.65.0` adds `defineTool()` specifically to preserve TypeScript parameter inference for standalone custom tool definitions without manual casts. Evidence: upstream docs in `pi-mono` describe `defineTool()` in `packages/coding-agent/docs/extensions.md`, and the helper is exported from `packages/coding-agent/src/core/extensions/types.ts`.

## Goals

- Update this repo to align with the relevant `0.65.0` extension API surface.
- Adopt `defineTool()` where this repo currently uses the exact standalone-tool pattern it was added to improve.
- Keep the migration intentionally small and grounded in actual local usage rather than the full upstream changelog.
- Verify the change with the repo's existing typecheck and test commands.

## Non-Goals

- Adding `AgentSessionRuntime` or `AgentSessionRuntimeHost` integration. Reasoning: no local code currently performs session replacement.
- Reworking extension lifecycle handling around `session_start`. Reasoning: this repo does not use the removed `session_switch` or `session_fork` hooks.
- Refactoring toward unified diagnostics handling. Reasoning: this extension does not own Pi app-layer startup or CLI diagnostics presentation.
- Broad API modernization not required by this repo's actual code.

## Chosen Approach

Use a selective modernization pass:

- migrate the standalone explainer tool in [`src/explain.ts`](file:///Users/exaclior/coding_agents/pi-diff-review/src/explain.ts) to `defineTool()`
- keep the explanation-generation flow and review delivery logic unchanged unless verification reveals a real incompatibility
- update package or README wording only where it improves clarity about current Pi compatibility

Reasoning: this is the smallest change that captures the one clearly applicable `0.65.0` improvement without introducing speculative runtime churn.

## Architecture

Keep the current extension structure intact:

- [`src/index.ts`](file:///Users/exaclior/coding_agents/pi-diff-review/src/index.ts) remains the extension entrypoint and `/diff-review` command host
- [`src/server.ts`](file:///Users/exaclior/coding_agents/pi-diff-review/src/server.ts) remains the localhost browser-review server
- [`src/explain.ts`](file:///Users/exaclior/coding_agents/pi-diff-review/src/explain.ts) remains the hunk-explanation module

The only architecture-level API change is replacing the standalone `Tool` annotation in [`src/explain.ts`](file:///Users/exaclior/coding_agents/pi-diff-review/src/explain.ts) with `defineTool(...)` from `@mariozechner/pi-coding-agent`.

Reasoning: `defineTool()` improves type inference for standalone tool definitions, but it does not require a different runtime model or a different completion API. The `complete(...)` call from `@mariozechner/pi-ai` should remain unchanged because tool execution semantics are not changing.

## Behavior Changes

### Tool Definition

Replace:

- a manually typed `Tool` object used as `EXPLANATION_TOOL`

With:

- a `defineTool(...)` declaration whose schema and `execute` signature remain inferred from the declared parameters

Reasoning: this is the exact migration target described by the upstream changelog item for `defineTool()`.

### Explanation Flow

Do not change:

- diff parsing
- prompt construction
- completion request behavior
- assistant tool-call parsing
- JSON fallback parsing
- per-file status aggregation

Reasoning: none of those behaviors are implicated by the `0.65.0` changes relevant to this repo, and changing them would expand scope without evidence.

### Session Handling

Do not add:

- `createAgentSessionRuntime()`
- `AgentSessionRuntimeHost`
- replacement-session rebinding logic

Reasoning: this repo consumes Pi as an extension and does not appear to own session replacement. The upstream runtime API matters for applications embedding Pi sessions, not for this extension's current architecture.

## Package And Documentation

Review:

- [`package.json`](file:///Users/exaclior/coding_agents/pi-diff-review/package.json)
- [`README.md`](file:///Users/exaclior/coding_agents/pi-diff-review/README.md)

for any wording that now undersells or misstates compatibility with the current Pi release.

Likely actions:

- keep the existing loose peer dependency on `@mariozechner/pi-coding-agent` unless verification shows a stricter version floor is necessary
- mention `0.65.0` compatibility in the README only if that improves clarity and does not create unnecessary maintenance overhead

Reasoning: upstream package metadata shows both `@mariozechner/pi-coding-agent` and `@mariozechner/pi-ai` publish `0.65.0`, but the repo should avoid pinning more tightly than needed unless a concrete compatibility reason appears during verification.

## Verification

Primary verification should use the commands already declared in [`package.json`](file:///Users/exaclior/coding_agents/pi-diff-review/package.json):

- `npm run check`
- `npm test`

Success criteria:

- the explainer tool still typechecks after migration to `defineTool()`
- existing tests continue to pass
- no new runtime behavior changes are introduced in the review flow

Reasoning: the migration target is mostly type-surface alignment, so the highest-value checks are the repository's existing type and behavior gates.

## Risks

- Local unrelated edits already exist in [`src/explain.ts`](file:///Users/exaclior/coding_agents/pi-diff-review/src/explain.ts), [`src/index.ts`](file:///Users/exaclior/coding_agents/pi-diff-review/src/index.ts), [`test/index.test.ts`](file:///Users/exaclior/coding_agents/pi-diff-review/test/index.test.ts), and an untracked [`src/model-auth.ts`](file:///Users/exaclior/coding_agents/pi-diff-review/src/model-auth.ts). Reasoning: `git status --short` showed them, so the migration must stay narrowly scoped and avoid overwriting concurrent work.
- `defineTool()` may require a small import reshuffle between `@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent`. Reasoning: the current tool type lives in the AI package, while the new helper lives in the coding-agent package.
- README changes can create accidental version promises if written too strongly. Reasoning: compatibility claims should match what was actually verified in this repo.

## Implementation Summary

The intended implementation should stay within:

- [`src/explain.ts`](file:///Users/exaclior/coding_agents/pi-diff-review/src/explain.ts) for the `defineTool()` migration
- optionally [`README.md`](file:///Users/exaclior/coding_agents/pi-diff-review/README.md) for a small compatibility note
- optionally [`package.json`](file:///Users/exaclior/coding_agents/pi-diff-review/package.json) if verification shows a package-level adjustment is warranted

No session-runtime refactor, extension event migration, or diagnostics subsystem work is planned unless implementation evidence proves it necessary.
