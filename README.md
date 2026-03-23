# pi-diff-review

Minimal browser diff review UI for pi.

It keeps the original idea from the session thread, but drops the native window and Monaco plumbing in favor of a smaller browser-only flow:

- `/diff-review` collects the current git diff against `HEAD`
- pi starts a tiny localhost server and opens your browser
- `@pierre/trees` renders the changed-file tree
- `@pierre/diffs` renders the active file diff
- the active pi model adds read-only hunk explainer notes before the browser opens
- explainer notes are attached inline in the diff and accept reviewer replies
- you can add file comments, line comments, and same-side range comments
- submitting writes a review prompt back into the pi editor

## Install

```bash
pi install git:https://github.com/badlogic/pi-diff-review
```

## Requirements

- Node.js 20+
- `pi` installed
- a modern browser

## Development

```bash
npm install
npm run build:web
npm run check
npm test
```

Edit the browser app in `web/app-source.js`. The browser build emits the entry
chunk at `web/app.js` plus code-split assets in `web/chunks/` so Shiki
languages and themes load on demand instead of inflating one giant bundle.

## Next step

Tighten the generated review prompt wording so explainer replies more strongly
push pi to revise the original LLM explanation before acting on the rest of the
review feedback.

## What changed from the old version

- removed Glimpse/native window integration
- removed Monaco
- kept the pi extension command flow
- moved the UI to a tiny browser app served from localhost
- switched rendering to Pierre:
  - `@pierre/diffs` for the main diff view
  - `@pierre/trees` for the file tree
