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
