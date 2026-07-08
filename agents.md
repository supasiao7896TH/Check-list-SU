# Instructions for AI Coding Agents

Read `context.md` first for what this project is and how it's built.
This file is about *how to work in this codebase* safely.

## Hard rules

1. **This repo has two nearly-identical HTML builds**
   (`interactive_checklist_su_app.html` desktop, `interactive_checklist_su_mobile.html`
   mobile). Whenever you change app behavior/logic, check whether the
   change needs to land in *both* files, or belongs in `shared/app-core.js`
   instead. Logic that's identical between the two builds (storage,
   crypto, sync, color sanitizers) belongs in `shared/app-core.js` — do
   not copy-paste it into both HTML files again; that's exactly how the
   desktop build ended up missing a bug fix the mobile build got
   (commit `539c8dc`).

2. **Never write the Gemini API key, or anything from `CRYPTO_VAULT`, to
   Firestore.** It's local-only by design. If you touch `SYNC_ENGINE` or
   the outbound/inbound sync payloads, double-check this invariant still
   holds.

3. **No build step exists on purpose.** Don't introduce npm, a bundler,
   or ES module imports across files. New shared code should be a plain
   global (`const`/`function`) in `shared/app-core.js`, loaded via a
   classic (non-`module`) `<script src="...">` tag *before* each HTML
   file's own `<script type="module">` block — that ordering is what lets
   the module script see the shared globals without an import statement.

4. **`STORAGE_ENGINE` is the single local source of truth.** If you add
   any new Firestore/network capability, do not enable Firestore's own
   offline persistence (`enableIndexedDbPersistence` or the modern SDK's
   default local cache) — it would create two competing local caches.
   Firestore should only ever be used as a relay between devices.

5. **CSP.** Both HTML files carry a `<meta http-equiv="Content-Security-Policy">`
   tag. Any new external domain (a CDN script, a new API endpoint) must be
   added to the relevant `script-src`/`connect-src`/etc. directive in
   *both* files, or the browser will silently block it — check the
   console for CSP violation warnings after any such change, since they
   don't surface as visible UI errors.

5a. **Service worker cache.** `sw.js` caches `shared/app-core.js` (and the
   rest of `SHELL`) cache-first under a fixed `CACHE` name. Whenever you
   change `shared/app-core.js` (or anything else in `SHELL`), **bump the
   `CACHE` version string** — otherwise browsers that already have this
   PWA installed/cached keep serving the old file indefinitely, even
   though the HTML itself updates (HTML navigations are network-first).
   This caused a real bug: a PIN-unlock feature shipped to `shared/app-core.js`
   silently failed for a user who'd cached the app before that change,
   because their browser kept serving the pre-PIN `shared/app-core.js`.

6. **Sync conflict granularity.** `SYNC_ENGINE`'s outbound diffing writes
   Firestore updates scoped to the exact field paths that changed (see
   `diffTaskFields` in `shared/app-core.js`), and inbound merging compares
   `updatedAt` per task-level-group and per-subtask (see
   `mergeIncomingTask`). If you add new task/subtask fields, make sure
   they're covered by both the outbound diff and the inbound merge, or
   they'll silently fail to sync or get clobbered.

7. **The viewer/admin PIN gate is UI-only — do not treat it as real access
   control.** `App.isEditingAllowed()` (each HTML file, reads
   `settings.adminUnlocked`) gates every mutating handler and hides/disables
   the corresponding controls, but `firestore.rules` still allows any
   anonymously-signed-in client to write. Anyone who opens devtools and
   calls the already-loaded Firebase SDK directly (or hits the Firestore
   REST API using the non-secret `FIREBASE_CONFIG`) bypasses this entirely.
   If you ever need this enforced for real, that requires distinguishing
   admin/viewer at the Firestore rules level (e.g. custom auth claims via a
   Cloud Function) — a real change, not a tweak to `isEditingAllowed()`.
   `ADMIN_PIN_HASH_HEX` (`shared/app-core.js`) is a SHA-256 hash, not
   encryption — never put the plaintext PIN in a commit, and remember the
   hash itself is visible in page source to anyone who looks.

## Testing changes

There's no automated test suite. To verify a change:
- Serve the repo root with any static file server (e.g.
  `python3 -m http.server`) and open the HTML file(s) you changed in a
  browser.
- For anything touching `SYNC_ENGINE`/Firebase, note that outbound
  network access to `www.gstatic.com`/Firestore endpoints may be blocked
  in sandboxed environments — mock the global `firebase` object (see the
  session history for an example mock shape: `firebase.initializeApp`,
  `.firestore()`, `.auth()`, collection/doc chains with `set`/`update`/
  `delete`/`onSnapshot`) to test sync logic without real network access.
- Always check the browser console for errors/CSP violations, and check
  IndexedDB (`STORAGE_ENGINE`) directly when testing persistence.
- If a change affects both HTML files, verify it in both — they are not
  guaranteed to behave identically unless the changed code lives in
  `shared/app-core.js`.

## Firebase / Firestore operational notes

- Project: `pta1-check-list-su`. Config lives in `FIREBASE_CONFIG` in
  `shared/app-core.js` (a Firebase web `apiKey` is not a secret — safe to
  commit; real access control is `firestore.rules`).
- Security rules (`firestore.rules`) can be edited and published directly
  in the Firebase Console's Rules tab (Firestore Database → Rules) — no
  CLI required, though `firebase.json` is present if you prefer
  `firebase deploy --only firestore:rules`.
- Auth is Anonymous-only (no passwords) — enabled in Firebase Console
  under Authentication → Sign-in method.
