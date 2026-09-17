# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read these first

This repo has two other docs that are not auto-loaded but are load-bearing — read them before making non-trivial changes:

- `context.md` — what this app is, file layout, data model, persistence/sync architecture, access control, deployment.
- `agents.md` — hard rules for editing this codebase safely (desktop/mobile drift, no build step, CSP, service-worker cache versioning, sync field coverage, PIN gate scope, the Firebase API-key false-positive).

## Commands

There is no build system, package manager, or test suite (no `package.json`). This is plain vanilla JS/HTML/CSS served as static files.

- **Run locally:** serve the repo root with any static file server, e.g. `python3 -m http.server` or `npx http-server`, then open `interactive_checklist_su_app.html` / `interactive_checklist_su_mobile.html` in a browser. Opening the files directly via `file://` will break the service worker and module script loading.
- **No lint/typecheck/test commands exist.** Verify changes by loading the page and checking the browser console for errors/CSP violations, and inspect IndexedDB directly for persistence issues.
- **Deploy:** push to `main` on GitHub — Cloudflare Pages auto-deploys from the repo. There is no separate build step to run before pushing.

## Architecture

A Thai-language PTA (industrial plant) Start-Up checklist app with two parallel builds sharing logic via plain `<script src>` includes (no bundler, no ES module imports across files):

- `interactive_checklist_su_app.html` (desktop) and `interactive_checklist_su_mobile.html` (mobile PWA) — each is markup + an inline `<script type="module">` with the app logic, preceded by classic `<script src>` tags for the shared files below. The two files historically drifted when a fix landed in only one of them (see `agents.md` rule 1) — always check whether a change belongs in both HTML files or in one of the shared files instead.
- `shared/app-core.js` — shared logic: `STORAGE_ENGINE` (IndexedDB), `SYNC_ENGINE` (Firestore diff/sync), color sanitizers, PIN verification.
- `shared/default-tasks.js` — the default/seed task list (`INITIAL_TASKS_JSON`), deliberately a double-quoted string literal, **not** a backtick template literal — Chrome/V8 has a real parsing bug with template literals over ~72KB evaluated synchronously at script-parse time that corrupts the string and makes `JSON.parse` throw. Keep it a string literal.
- `sw.js` — service worker; navigable HTML is network-first, everything else (including `shared/*.js`) is cache-first under a versioned `CACHE` name. **Any edit to a file listed in `SHELL`** (including the two HTML builds themselves) **requires bumping `CACHE`**, or browsers with the PWA already installed keep serving the stale cached version indefinitely — this has caused real production bugs (see `agents.md` rule 5a).
- Persistence is local-first: `STORAGE_ENGINE` (IndexedDB) is the single source of truth per device; `SYNC_ENGINE` relays diffs to/from Firestore purely as a cross-device channel (Firestore's own offline cache is intentionally never enabled).
- Access control is UI-only: a shared PIN unlocks "edit mode" client-side, but `firestore.rules` allows any anonymously-authenticated client to write. Do not treat `isEditingAllowed()` as real security.
