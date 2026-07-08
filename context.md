# Check-list-SU — Project Context

## What this is

A Thai-language PTA (industrial plant) Start-Up checklist app — tracks
step-by-step procedures during plant start-up (valve positions, pump
starts, pressure/level checks, interlock confirmations, etc.). Deployed
as a static site via GitHub Pages.

## Tech stack

Plain vanilla JavaScript, no build tooling, no framework. Tailwind CSS
(via CDN) for styling, Chart.js (via CDN) for the dashboard charts. A
Progressive Web App (installable, offline-capable via a hand-written
service worker).

## File layout

```
index.html                              Landing page; links to both builds, registers the service worker
interactive_checklist_su_app.html       Desktop/PC build (self-contained: markup + inline <script type="module">)
interactive_checklist_su_mobile.html    Mobile/PWA build (same App logic, mobile-tuned UI/CSS)
shared/app-core.js                      Code shared by both builds — see below
sw.js                                   Service worker (cache-first/network-first offline asset caching)
manifest.webmanifest                    PWA manifest
firestore.rules, firebase.json          Firestore security rules (deploy via Firebase CLI or paste into console)
```

**The desktop and mobile builds are two separate HTML files that used to
duplicate all their JS inline.** They've historically drifted (a color-
sanitizer bug fix once landed only in the mobile file — see commit
`539c8dc`). Shared logic now lives in `shared/app-core.js`, included by
both files via a plain `<script src="./shared/app-core.js">` tag
*before* each file's own `<script type="module">` block. When adding new
shared logic, prefer extending `shared/app-core.js` over copying code
into both HTML files again.

## Data model

Tasks are a JSON array (see `App.tasks`), each task shaped like:

```js
{
  id, datetime, description, notes, responsible, textColor,
  completed, actualStartTime, actualEndTime,
  updatedAt, lastEditedBy,          // for sync conflict resolution — see below
  subtasks: [
    { id, text, checked, checkedAt, textColor, updatedAt, lastEditedBy }
  ]
}
```

Progress is **derived, not stored** — `App.calculateProgress(task)`
computes it from `subtasks[].checked` at render time.

## Persistence & sync architecture

- **`STORAGE_ENGINE`** (`shared/app-core.js`) — a promise-based IndexedDB
  key/value wrapper. This is the single local source of truth; each build
  uses its own DB name (`APP_DB_NAME`, set inline before the shared
  script tag) so desktop and mobile never share local storage.
- **`CRYPTO_VAULT`** (`shared/app-core.js`) — encrypts the user's Gemini
  API key with AES-GCM before storing it in IndexedDB. **This, and the
  API key itself, must never be sent to Firestore.**
- **`SYNC_ENGINE`** (`shared/app-core.js`) — bridges local `App.tasks`
  with a shared Firestore project for real-time multi-device sync:
  - Outbound: `App.saveTasks()` calls `SYNC_ENGINE.prepareSync()` (diffs
    against the last-known snapshot, stamps changed tasks/subtasks with
    `updatedAt`/`lastEditedBy`) then `SYNC_ENGINE.commitSync()` (queues +
    pushes only the changed field paths — never a whole-document
    overwrite). The outbound queue persists in IndexedDB (`_syncQueue`)
    so pending writes survive the app being closed while offline, and
    drain automatically on reconnect.
  - Inbound: an `onSnapshot` listener merges remote changes into
    `App.tasks` per task/subtask by comparing `updatedAt` (newer wins),
    applied via `App.applyRemoteTasks()` — which deliberately does *not*
    call `saveTasks()`, so absorbing a remote change never re-triggers an
    outbound push.
  - Firestore's own offline persistence is intentionally never enabled —
    `STORAGE_ENGINE` stays the only local cache; Firestore is purely a
    relay between devices.
  - Identity is password-free: each user picks a display name once (see
    `App.openDisplayNameModal`), and each device separately signs in via
    Firebase Anonymous Auth just to get a stable `uid` for Firestore
    security rules/presence — the `uid` is never shown in the UI.
  - A lightweight presence layer (`SYNC_ENGINE.startPresenceHeartbeat`/
    `listenPresence`) shows who else is currently online.

Firestore document shape: one document per task at
`projects/{FIREBASE_SYNC_PROJECT_ID}/tasks/{taskId}`, with `subtasks`
stored as a **map keyed by subtask id** (not an array/sub-collection) —
this is what lets outbound writes touch only the exact subtask that
changed via Firestore's dotted-path `update()`, without clobbering
concurrent edits to other subtasks of the same task.

## Deployment

Static hosting via GitHub Pages (`.nojekyll` present so Pages serves the
PWA files as-is). Firebase/Firestore calls are pure client-SDK calls over
HTTPS — no server process is needed or introduced.

## Known trade-offs

- `handleExportHTML()`'s "export as single portable HTML file" feature
  no longer produces a fully self-contained file, since it can't inline
  `shared/app-core.js`'s contents — the exported file references that
  script rather than embedding it. Acceptable since the export is
  normally used to redeploy the whole folder, not to email a single file.
- Firebase free tier (Spark plan) limits (~50k reads/20k writes per day)
  should comfortably cover normal usage since the data model scales with
  task count (tens), not subtask count (hundreds).
