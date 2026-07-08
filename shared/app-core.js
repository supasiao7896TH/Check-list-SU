/**
 * Shared core for Check-list-SU (desktop + mobile).
 *
 * Loaded as a plain classic <script> (no type="module") BEFORE the page's
 * own <script type="module"> block, so STORAGE_ENGINE/CRYPTO_VAULT/etc.
 * stay visible as ordinary globals to that module script, exactly as they
 * were when each HTML file declared them inline.
 *
 * Each including HTML file must define `const APP_DB_NAME = '...';` in its
 * own inline <script> immediately before this file's <script src> tag, so
 * the desktop and mobile builds keep using their separate local IndexedDB
 * databases (this matches existing behavior — the two builds have never
 * shared local storage, only the Firestore sync layer added later is shared).
 */

/**
 * STORAGE_ENGINE — Promise-based IndexedDB key/value wrapper.
 * Ref: SKILL references/js-quality.md → STORAGE_ENGINE
 * Records are stored as { k: <key>, v: <value> } in a single object store.
 */
const STORAGE_ENGINE = (() => {
    'use strict';
    const DB_NAME = typeof APP_DB_NAME !== 'undefined' ? APP_DB_NAME : 'interactive_SU_DB';
    const DB_VERSION = 1;
    const STORE = 'appstore';
    let _db = null;

    function _open() {
        if (_db) return Promise.resolve(_db);
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE, { keyPath: 'k' });
                }
            };
            req.onsuccess = () => { _db = req.result; resolve(_db); };
            req.onerror = () => reject(req.error);
            req.onblocked = () => console.warn('IndexedDB upgrade blocked');
        });
    }

    function _tx(mode, fn) {
        return _open().then(db => new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, mode);
            const store = tx.objectStore(STORE);
            let req;
            try { req = fn(store); } catch (err) { reject(err); return; }
            tx.oncomplete = () => resolve(req ? req.result : undefined);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        }));
    }

    return {
        open: _open,
        async get(key) {
            const rec = await _tx('readonly', s => s.get(key));
            return rec ? rec.v : undefined;
        },
        put(key, value) { return _tx('readwrite', s => s.put({ k: key, v: value })); },
        delete(key) { return _tx('readwrite', s => s.delete(key)); },
    };
})();

/**
 * CRYPTO_VAULT — encrypts the Gemini API key with AES-GCM 256.
 * Ref: SKILL references/js-quality.md → AES-GCM API Key Vault
 * Uses a NON-EXTRACTABLE CryptoKey stored in IndexedDB, so the raw key
 * bytes can never be read back out — only used to encrypt/decrypt in-origin.
 * No passphrase required → no change to the existing UX.
 *
 * This vault, and anything stored through it, must NEVER be pushed to
 * Firestore by the sync engine below — it is strictly local-only.
 */
const CRYPTO_VAULT = (() => {
    'use strict';
    const ALGO = 'AES-GCM';
    const KEY_RECORD = 'cryptoKey';
    const SECRET_RECORD = 'apiKeySecret';

    async function _getKey() {
        let key = await STORAGE_ENGINE.get(KEY_RECORD);
        if (!key) {
            key = await crypto.subtle.generateKey({ name: ALGO, length: 256 }, false, ['encrypt', 'decrypt']);
            await STORAGE_ENGINE.put(KEY_RECORD, key);
        }
        return key;
    }

    return {
        async setApiKey(plaintext) {
            const key = await _getKey();
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const data = await crypto.subtle.encrypt({ name: ALGO, iv }, key, new TextEncoder().encode(plaintext));
            await STORAGE_ENGINE.put(SECRET_RECORD, { iv, data });
        },
        async getApiKey() {
            const rec = await STORAGE_ENGINE.get(SECRET_RECORD);
            if (!rec) return null;
            const key = await _getKey();
            const decrypted = await crypto.subtle.decrypt({ name: ALGO, iv: rec.iv }, key, rec.data);
            return new TextDecoder().decode(decrypted);
        },
        async clearApiKey() {
            await STORAGE_ENGINE.delete(SECRET_RECORD);
        },
    };
})();

/**
 * Color allow-lists — sanitize task/subtask textColor against a known-safe
 * set on load, since these values ultimately end up in class attributes.
 * Previously only present in the mobile build (see commit 539c8dc); the
 * desktop build silently skipped sanitization until this file unified both.
 */
const ALLOWED_TASK_COLORS = new Set([
    'text-slate-800', 'text-red-600', 'text-green-600', 'text-orange-500', 'text-blue-600',
]);
const ALLOWED_SUBTASK_COLORS = new Set([
    'text-slate-700', 'text-red-600', 'text-green-600', 'text-orange-500', 'text-blue-600',
]);

function sanitizeTaskColor(color) {
    return ALLOWED_TASK_COLORS.has(color) ? color : 'text-slate-800';
}
function sanitizeSubtaskColor(color) {
    return ALLOWED_SUBTASK_COLORS.has(color) ? color : 'text-slate-700';
}

/**
 * Firebase bootstrap (Firestore + Anonymous Auth) for real-time multi-device
 * sync. Config below is this project's actual Firebase web app config
 * (Firebase console → Project settings → General → Your apps → SDK setup).
 * A Firebase web apiKey is not a secret — it only identifies the project to
 * Google's servers; real access control lives in firestore.rules.
 */
const FIREBASE_CONFIG = {
    apiKey: 'AIzaSyDuCvvohpSgY5AasmvJJf4YvvBM368DUvM',
    authDomain: 'pta1-check-list-su.firebaseapp.com',
    projectId: 'pta1-check-list-su',
    storageBucket: 'pta1-check-list-su.firebasestorage.app',
    messagingSenderId: '292625103593',
    appId: '1:292625103593:web:46a181698f8235bad10e78',
};

// Fixed routing key: all devices read/write projects/{FIREBASE_SYNC_PROJECT_ID}/tasks.
// Not a secret — just a shared path prefix (see firestore.rules for the real access control).
const FIREBASE_SYNC_PROJECT_ID = 'pta-su-checklist';

let firebaseApp = null;
let firestoreDb = null;
let firebaseAuth = null;

function isFirebaseConfigured() {
    return typeof firebase !== 'undefined' && !FIREBASE_CONFIG.apiKey.startsWith('REPLACE_WITH_');
}

/**
 * Initializes the Firebase app + Firestore + Auth handles exactly once.
 * Returns the firebase.app.App instance, or null if not yet configured.
 * (Sign-in and sync wiring are added in later phases — this only bootstraps
 * the SDK handles so later phases have something to build on.)
 */
function initFirebase() {
    if (!isFirebaseConfigured()) {
        console.warn('[SYNC] Firebase not configured yet — realtime sync disabled. Fill in FIREBASE_CONFIG in shared/app-core.js.');
        return null;
    }
    if (!firebaseApp) {
        firebaseApp = firebase.initializeApp(FIREBASE_CONFIG);
        firestoreDb = firebase.firestore();
        firebaseAuth = firebase.auth();
    }
    return firebaseApp;
}

let _firebaseSignInPromise = null;

/**
 * Ensures exactly one anonymous Firebase Auth sign-in per page load.
 * Resolves to the signed-in user, or null if Firebase isn't configured.
 * This uid is only ever used for Firestore access control/presence — it is
 * never shown in the UI and is unrelated to the human-chosen displayName
 * the user types into the app (see App.settings.displayName).
 */
function ensureFirebaseSignedIn() {
    if (!isFirebaseConfigured()) return Promise.resolve(null);
    initFirebase();
    if (firebaseAuth.currentUser) return Promise.resolve(firebaseAuth.currentUser);
    if (!_firebaseSignInPromise) {
        _firebaseSignInPromise = firebaseAuth.signInAnonymously()
            .then(cred => cred.user)
            .catch(err => { _firebaseSignInPromise = null; throw err; });
    }
    return _firebaseSignInPromise;
}

/**
 * SYNC_ENGINE — bridges local STORAGE_ENGINE/App.tasks with Firestore.
 *
 * STORAGE_ENGINE stays the ONE local source of truth; Firestore's own
 * offline persistence is intentionally never enabled (see plan notes) —
 * Firestore here is purely a relay between devices. All read/render logic
 * in App keeps working unchanged: this engine only ever calls the existing
 * STORAGE_ENGINE.put('tasks', ...) + App.render() to apply remote changes,
 * and only ever reads App.tasks to push local changes out.
 *
 * Local plain-object markers (never real Firestore SDK objects) are used
 * inside queued operations so the queue stays IndexedDB-structured-clone
 * safe — Firestore's FieldValue sentinels are NOT clonable and must only
 * be constructed at the moment of an actual network write.
 */
const SYNC_QUEUE_KEY = '_syncQueue';
const SERVER_TIMESTAMP_MARKER = '__FIRESTORE_SERVER_TIMESTAMP__';
const FIELD_DELETE_MARKER = '__FIRESTORE_FIELD_DELETE__';

const SYNC_ENGINE = (() => {
    'use strict';
    let queue = [];
    let queueLoaded = false;
    let flushing = false;
    let lastKnownSnapshot = null; // last App.tasks state we've already diffed

    function tasksCollection() {
        return firestoreDb.collection('projects').doc(FIREBASE_SYNC_PROJECT_ID).collection('tasks');
    }

    function subtaskArrayToMap(subtasks) {
        const map = {};
        (subtasks || []).forEach((st, index) => {
            map[st.id] = {
                text: st.text || '',
                checked: !!st.checked,
                checkedAt: st.checkedAt || null,
                textColor: st.textColor || 'text-slate-700',
                order: index,
                updatedAt: Date.now(),
                lastEditedBy: null,
            };
        });
        return map;
    }

    /** Full-document shape for a brand-new task (op.type === 'set' only). */
    function taskToFirestoreDoc(task, displayName) {
        return {
            description: task.description || '',
            datetime: task.datetime || '',
            notes: task.notes || '',
            responsible: task.responsible || '',
            textColor: task.textColor || 'text-slate-800',
            completed: !!task.completed,
            actualStartTime: task.actualStartTime || null,
            actualEndTime: task.actualEndTime || null,
            subtasks: subtaskArrayToMap(task.subtasks),
            updatedAt: Date.now(),
            lastEditedBy: displayName || null,
        };
    }

    /**
     * Diffs one existing task's fields, returning a flat dotted-path
     * field map (Firestore update() syntax) with ONLY the paths that
     * actually changed — so a subtask checkbox toggle never touches any
     * other subtask, and never clobbers a concurrent edit from another
     * device to a different field/subtask of the same task. Returns null
     * if nothing changed.
     */
    function diffTaskFields(prevTask, task, displayName) {
        const fields = {};
        let changed = false;
        ['description', 'datetime', 'notes', 'responsible', 'textColor', 'completed', 'actualStartTime', 'actualEndTime']
            .forEach(key => {
                if (prevTask[key] !== task[key]) {
                    fields[key] = task[key] ?? null;
                    changed = true;
                }
            });

        const prevSubtasksById = new Map((prevTask.subtasks || []).map((st, i) => [st.id, { ...st, order: i }]));
        (task.subtasks || []).forEach((st, index) => {
            const prevSt = prevSubtasksById.get(st.id);
            const subtaskChanged = !prevSt || ['text', 'checked', 'checkedAt', 'textColor'].some(key => prevSt[key] !== st[key]) || prevSt.order !== index;
            if (subtaskChanged) {
                fields[`subtasks.${st.id}.text`] = st.text || '';
                fields[`subtasks.${st.id}.checked`] = !!st.checked;
                fields[`subtasks.${st.id}.checkedAt`] = st.checkedAt || null;
                fields[`subtasks.${st.id}.textColor`] = st.textColor || 'text-slate-700';
                fields[`subtasks.${st.id}.order`] = index;
                fields[`subtasks.${st.id}.updatedAt`] = SERVER_TIMESTAMP_MARKER;
                fields[`subtasks.${st.id}.lastEditedBy`] = displayName || null;
                changed = true;
            }
        });
        prevSubtasksById.forEach((_prevSt, subId) => {
            if (!(task.subtasks || []).some(st => st.id === subId)) {
                fields[`subtasks.${subId}`] = FIELD_DELETE_MARKER;
                changed = true;
            }
        });

        if (!changed) return null;
        fields.updatedAt = SERVER_TIMESTAMP_MARKER;
        fields.lastEditedBy = displayName || null;
        return fields;
    }

    /** Replaces local markers with real Firestore SDK sentinels, at write time only. */
    function resolveMarkers(flatObj) {
        const out = {};
        for (const [key, value] of Object.entries(flatObj)) {
            if (value === SERVER_TIMESTAMP_MARKER) out[key] = firebase.firestore.FieldValue.serverTimestamp();
            else if (value === FIELD_DELETE_MARKER) out[key] = firebase.firestore.FieldValue.delete();
            else out[key] = value;
        }
        return out;
    }

    async function loadQueue() {
        if (queueLoaded) return;
        const stored = await STORAGE_ENGINE.get(SYNC_QUEUE_KEY);
        queue = Array.isArray(stored) ? stored : [];
        queueLoaded = true;
    }

    async function persistQueue() {
        await STORAGE_ENGINE.put(SYNC_QUEUE_KEY, queue);
    }

    async function enqueue(op) {
        await loadQueue();
        queue.push(op);
        await persistQueue();
        flush(); // fire-and-forget best-effort attempt; safe to ignore the promise
    }

    /** Establishes the baseline for future diffs, without enqueueing anything. */
    function seedSnapshot(tasks) {
        lastKnownSnapshot = JSON.parse(JSON.stringify(tasks || []));
    }

    /**
     * Called after every successful local saveTasks(). Diffs against the
     * last-seeded snapshot and enqueues exactly the operations needed to
     * bring Firestore up to date — full `set` for brand-new tasks, `delete`
     * for removed tasks, field-scoped `update` for everything else.
     */
    async function onLocalTasksSaved(tasks, displayName) {
        const prevTasks = lastKnownSnapshot || [];
        seedSnapshot(tasks); // update baseline immediately so we never double-diff
        if (!isFirebaseConfigured()) return;

        const prevById = new Map(prevTasks.map(t => [t.id, t]));
        const nextById = new Map(tasks.map(t => [t.id, t]));

        for (const [id, task] of nextById) {
            if (!prevById.has(id)) {
                await enqueue({ type: 'set', taskId: id, doc: taskToFirestoreDoc(task, displayName), ts: Date.now() });
                continue;
            }
            const fields = diffTaskFields(prevById.get(id), task, displayName);
            if (fields) {
                await enqueue({ type: 'update', taskId: id, fields, ts: Date.now() });
            }
        }
        for (const id of prevById.keys()) {
            if (!nextById.has(id)) {
                await enqueue({ type: 'delete', taskId: id, ts: Date.now() });
            }
        }
    }

    /** Drains the persisted queue in order; stops (keeping remaining ops) on first failure. */
    async function flush() {
        if (flushing || !isFirebaseConfigured()) return;
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
        flushing = true;
        try {
            await loadQueue();
            await ensureFirebaseSignedIn();
            while (queue.length) {
                const op = queue[0];
                try {
                    const ref = tasksCollection().doc(op.taskId);
                    if (op.type === 'set') {
                        await ref.set(op.doc, { merge: true });
                    } else if (op.type === 'update') {
                        await ref.update(resolveMarkers(op.fields));
                    } else if (op.type === 'delete') {
                        await ref.delete();
                    }
                    queue.shift();
                    await persistQueue();
                } catch (err) {
                    console.warn('[SYNC] push failed, will retry later:', err);
                    break;
                }
            }
        } finally {
            flushing = false;
        }
    }

    function scheduleFlushOnReconnect() {
        if (typeof window === 'undefined') return;
        window.addEventListener('online', () => flush());
        setInterval(() => flush(), 30000); // periodic safety-net retry
    }

    return { seedSnapshot, onLocalTasksSaved, flush, scheduleFlushOnReconnect };
})();

SYNC_ENGINE.scheduleFlushOnReconnect();
