# Review UI Layout Design

Date: 2026-04-02
Repo: `pi-diff-review`

## Problem

The browser review UI currently uses a fixed two-column shell: a `300px` file tree plus a main content pane. Evidence: [`web/styles.css`](file:///Users/exaclior/coding_agents/pi-diff-review/web/styles.css#L101-L191) defines `.content-grid` as `grid-template-columns: 300px minmax(0, 1fr)` and places the diff below a shared notes area.

The "Why this changed" content is rendered above the diff inside the same main pane. Evidence: [`renderFileComments`](file:///Users/exaclior/coding_agents/pi-diff-review/web/app-source.js#L371-L396) appends explainer cards into `fileCommentsEl`, which sits before `diffRootEl` in [`web/index.html`](file:///Users/exaclior/coding_agents/pi-diff-review/web/index.html). A long explanation list therefore pushes the diff and inline comment targets out of view.

The diff view is fixed to split mode. Evidence: the `FileDiff` instance is created with `diffStyle: "split"` in [`web/app-source.js`](file:///Users/exaclior/coding_agents/pi-diff-review/web/app-source.js#L107-L123).

## Goals

- Allow the user to resize the major desktop regions of the UI.
- Keep the file tree, diff, and explanation/comment content in separate scroll containers.
- Make long "Why this changed" content scrollable without hiding the diff.
- Add a user-visible toggle between column diff mode and stacked diff mode.
- Keep the implementation local to the browser app and avoid protocol or server changes.

## Non-Goals

- Persistent pane sizes or persistent diff mode across reloads. The user explicitly chose temporary per-tab state.
- A general-purpose docking or layout framework.
- Changing how explanations are generated or submitted back to Pi.

## Chosen Approach

Use a three-pane desktop shell with two draggable splitters:

- Left pane: changed-file tree.
- Center pane: diff view.
- Right pane: "Why this changed" cards plus file-level comments.

Reasoning: this is the smallest change that fully solves the stated issues. The current app already has isolated render roots for the tree, notes, and diff, so the work is primarily DOM layout and local UI state, not application architecture.

## Layout Changes

### Desktop

Replace the current two-column `.content-grid` with a five-track grid:

- left pane width
- left splitter width
- center pane flex width
- right splitter width
- right pane width

The center pane remains `minmax(0, 1fr)` so it absorbs remaining width after the two side panes take their current transient widths.

Each pane gets its own scroll container:

- file tree pane scrolls independently
- diff pane scrolls independently
- explanation/comment pane scrolls independently

Reasoning: separate overflow regions prevent explanation content from displacing the diff and preserve inline comment workflow.

### Mobile / Narrow Width

Retain the existing simplified responsive behavior under the current narrow breakpoint rather than keeping draggable panes. On narrow screens, stack the regions vertically and disable visible splitter affordances.

Reasoning: drag-resizing is much less reliable on constrained layouts, and the existing CSS already switches to a stacked shell below the breakpoint in [`web/styles.css`](file:///Users/exaclior/coding_agents/pi-diff-review/web/styles.css#L474-L493).

## Pane Resizing

Add two lightweight splitter elements in the HTML shell:

- splitter between file tree and diff
- splitter between diff and explanation pane

Use pointer events to update in-memory width state while dragging. Widths are applied through CSS custom properties on the shell element.

Constraints:

- left pane minimum width
- center pane minimum width
- right pane minimum width
- drag operations clamp to those minimums

No `localStorage` is used. A reload restores default widths.

Reasoning: the user requested temporary-only state, and CSS custom properties plus pointer handlers keep the implementation small and reversible.

## Explanation Pane Placement

Move the current `file-comments` section out of the vertical flow above the diff and into the new right pane.

The right pane contains:

- current file auxiliary content header
- "Why this changed" overview card and explanation summary cards
- file-level comment cards

The diff pane contains only the diff renderer and inline annotations.

Reasoning: this directly addresses the scrolling failure mode while preserving all existing explanation-card and comment-card rendering code.

## Diff Mode Toggle

Add a small topbar control that switches between:

- `Column` -> `diffStyle: "split"`
- `Stacked` -> `diffStyle: "unified"`

Implementation uses the existing `FileDiff` instance by updating its options and rerendering. Evidence that the library supports this: the diff package exports `FileDiffOptions` and its diff style supports `'unified' | 'split' | 'both'` in [`node_modules/@pierre/diffs/dist/components/FileDiff.d.ts`](file:///Users/exaclior/coding_agents/pi-diff-review/node_modules/%40pierre/diffs/dist/components/FileDiff.d.ts).

Reasoning: reuse of the current `FileDiff` object avoids multiple renderers or duplicated state.

## State Model

Add local browser state for:

- current diff mode
- left pane width
- right pane width
- active drag handle, if any

Keep existing review state unchanged for:

- active file
- overall comment
- inline comments
- explanation replies
- submission flow

Reasoning: the layout problem is orthogonal to review data, so layout state should stay isolated from review content state.

## Accessibility and Interaction

Splitters should use clear cursor feedback and visible hover/active styling.

At minimum, dragging must work with pointer input and not interfere with text selection once released. If keyboard resizing is not added in this pass, the splitters should still expose presentational semantics that do not break focus order.

Reasoning: pointer dragging is the requested capability; keyboard resizing would expand scope beyond the smallest correct change.

## Testing and Verification

Primary verification should be end-to-end in the browser app:

- long explanation list scrolls within the right pane
- diff remains visible while explanations overflow
- dragging left splitter resizes file tree and diff
- dragging right splitter resizes diff and explanation pane
- diff mode toggle switches between split and unified rendering without losing inline annotations
- active file switching still rerenders notes and diff correctly
- narrow-screen layout still renders without trapped overflow

Code-level regression tests are not required unless implementation reveals a subtle logic bug. Reasoning: the change is primarily layout and interaction behavior in a small browser app, and the existing guidance favors the smallest high-leverage verification path.

## Risks

- `FileDiff` rerender behavior could reset some transient visual state when diff mode changes. This risk is acceptable because the current app already rerenders on file changes and annotation updates.
- Splitter math can create unusable widths if not clamped. Minimum pane widths address this.
- Moving the notes area into a new pane could expose hidden CSS assumptions in the current layout. This is limited to the browser app files and should be caught in manual verification.

## Implementation Summary

The implementation should stay within:

- [`web/index.html`](file:///Users/exaclior/coding_agents/pi-diff-review/web/index.html) for the new shell structure and toggle control
- [`web/styles.css`](file:///Users/exaclior/coding_agents/pi-diff-review/web/styles.css) for the three-pane layout, splitters, and independent scroll containers
- [`web/app-source.js`](file:///Users/exaclior/coding_agents/pi-diff-review/web/app-source.js) for transient layout state, drag handlers, diff mode state, and rendering the notes area into the right pane

No server or extension-protocol changes are needed.
