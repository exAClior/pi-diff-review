# pi-diff-review

Minimal browser diff review UI for pi.

It keeps the original idea from the session thread, but drops the native window and Monaco plumbing in favor of a smaller browser-only flow:

- `/diff-review` collects the current git diff against `HEAD`
- pi starts a tiny localhost server and opens your browser
- `@pierre/trees` renders the changed-file tree with explicit review-order numbering
- the default review sequence in this repo is: config/build → `src/` → `web/` → tests → docs → generated output
- `@pierre/diffs` renders the active file diff
- the active pi model adds read-only hunk explainer notes before the browser opens
- explainer notes are summarized per file and attached inline in the diff, with jump links back to the changed lines and reply boxes on the inline notes
- you can add file comments, line comments, and same-side range comments
- comments stay as drafts until you hit their own Submit button
- submitting sends the composed review back as a real user message in the same pi session
- if pi cannot send immediately because no model/auth is ready, the review falls back to the editor instead of being lost

## Install

```bash
pi install git:https://github.com/badlogic/pi-diff-review
```

This package now targets `pi` `0.65.0` or newer.

## Requirements

- Node.js 20+
- `pi` `0.65.0+`
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
