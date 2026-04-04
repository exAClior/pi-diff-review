# Pi 0.65.0 Migration Design

Date: 2026-04-04
Repo: `pi-diff-review`

## Problem

Pi `0.65.0` introduces several SDK and extension changes, but this repo only appears to touch a narrow part of that surface. Evidence: a repo-wide search in `src/`, `README.md`, and `package.json` found no uses of removed extension events such as `session_switch` or `session_fork`, no uses of removed session-replacement methods such as `newSession()` or `switchSession()` on `AgentSession`, and no uses of `session_directory`.

The repo's local package versions were still on `0.57.1`. Evidence: before migration, both the installed `@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent` packages resolved to `0.57.1`, and [`package.json`](file:///Users/exaclior/coding_agents/pi-diff-review/package.json) declared `@mariozechner/pi-ai` `^0.57.1` with an unconstrained `@mariozechner/pi-coding-agent` peer.

During implementation review against upstream source, the earlier `defineTool()` idea proved to be the wrong API boundary for this repo. Evidence: `defineTool()` in `pi-mono` applies to extension `ToolDefinition` objects in `packages/coding-agent/src/core/extensions/types.ts`, while [`src/explain.ts`](file:///Users/exaclior/coding_agents/pi-diff-review/src/explain.ts) uses a plain `Tool` schema from `@mariozechner/pi-ai` and passes it directly to `complete(...)`. That means the correct repo-level `0.65.0` migration is package and compatibility alignment, not a forced tool-definition rewrite.

## Goals

- Update this repo to align with the relevant `0.65.0` extension API surface.
- Move the local Pi package floor from `0.57.1` to `0.65.0`.
- Keep the migration intentionally small and grounded in actual local usage rather than the full upstream changelog.
- Verify the change with the repo's existing typecheck and test commands.

## Non-Goals

- Adding `AgentSessionRuntime` or `AgentSessionRuntimeHost` integration. Reasoning: no local code currently performs session replacement.
- Reworking extension lifecycle handling around `session_start`. Reasoning: this repo does not use the removed `session_switch` or `session_fork` hooks.
- Refactoring toward unified diagnostics handling. Reasoning: this extension does not own Pi app-layer startup or CLI diagnostics presentation.
- Broad API modernization not required by this repo's actual code.

## Chosen Approach

Use a selective modernization pass:

- update the Pi package versions and peer floor in [`package.json`](file:///Users/exaclior/coding_agents/pi-diff-review/package.json)
- refresh the lockfile by installing the `0.65.0` packages locally
- keep the explanation-generation flow and review delivery logic unchanged unless verification reveals a real incompatibility
- update README wording where it improves clarity about the new minimum supported Pi version

Reasoning: this is the smallest change that puts the repo on the intended Pi release without introducing speculative runtime churn or rewriting code that already typechecks and tests cleanly against `0.65.0`.

## Architecture

Keep the current extension structure intact:

- [`src/index.ts`](file:///Users/exaclior/coding_agents/pi-diff-review/src/index.ts) remains the extension entrypoint and `/diff-review` command host
- [`src/server.ts`](file:///Users/exaclior/coding_agents/pi-diff-review/src/server.ts) remains the localhost browser-review server
- [`src/explain.ts`](file:///Users/exaclior/coding_agents/pi-diff-review/src/explain.ts) remains the hunk-explanation module

No architecture-level source changes are required if the repo still typechecks and tests cleanly after the package upgrade.

Reasoning: the extension does not own session-runtime creation, and the only candidate source migration that initially looked relevant (`defineTool()`) turned out to target a different tool abstraction than the one this repo uses.

## Behavior Changes

### Package Alignment

Replace:

- `@mariozechner/pi-ai` `^0.57.1`
- unconstrained `@mariozechner/pi-coding-agent` peer dependency

With:

- `@mariozechner/pi-ai` `^0.65.0`
- `@mariozechner/pi-coding-agent` peer dependency `^0.65.0`

Reasoning: once the repo is declared and verified against Pi `0.65.0`, the package metadata should enforce that minimum supported version instead of silently allowing older hosts.

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

- set the `@mariozechner/pi-coding-agent` peer dependency floor to `^0.65.0`
- update `@mariozechner/pi-ai` to `^0.65.0`
- mention `0.65.0+` compatibility in the README so install requirements match the package metadata

Reasoning: after successful verification on `0.65.0`, the repo should declare that floor explicitly instead of leaving compatibility ambiguous.

## Verification

Primary verification should use the commands already declared in [`package.json`](file:///Users/exaclior/coding_agents/pi-diff-review/package.json):

- `npm run check`
- `npm test`

Success criteria:

- the repo typechecks against `@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent` `0.65.0`
- existing tests continue to pass
- no new runtime behavior changes are introduced in the review flow

Reasoning: the migration target is mostly type-surface alignment, so the highest-value checks are the repository's existing type and behavior gates.

## Risks

- Local unrelated edits already exist in [`src/explain.ts`](file:///Users/exaclior/coding_agents/pi-diff-review/src/explain.ts), [`src/index.ts`](file:///Users/exaclior/coding_agents/pi-diff-review/src/index.ts), [`test/index.test.ts`](file:///Users/exaclior/coding_agents/pi-diff-review/test/index.test.ts), and an untracked [`src/model-auth.ts`](file:///Users/exaclior/coding_agents/pi-diff-review/src/model-auth.ts). Reasoning: `git status --short` showed them, so the migration must stay narrowly scoped and avoid overwriting concurrent work.
- Upgrading from `0.57.1` to `0.65.0` could reveal hidden source incompatibilities during typecheck or tests. Reasoning: even when the repo does not obviously use changed APIs, version jumps can surface renamed types or stricter signatures.
- README changes can create accidental version promises if written too strongly. Reasoning: compatibility claims should match what was actually verified in this repo.

## Implementation Summary

The intended implementation should stay within:

- [`package.json`](file:///Users/exaclior/coding_agents/pi-diff-review/package.json) for the Pi version floor
- [`package-lock.json`](file:///Users/exaclior/coding_agents/pi-diff-review/package-lock.json) for the resolved dependency update
- optionally [`README.md`](file:///Users/exaclior/coding_agents/pi-diff-review/README.md) for a small compatibility note

No session-runtime refactor, extension event migration, diagnostics subsystem work, or `defineTool()` rewrite is planned unless implementation evidence proves it necessary.
