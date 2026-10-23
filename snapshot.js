/*
 * SkyGuardian - Snapshot locali 24h
 *
 * Uno snapshot è la "fotografia" dei pannelli aperti (con i dati già scaricati) per una località.
 * - Dura 24 ore: dopo la scadenza non viene mai restituito e viene cancellato alla prima occasione
 *   (avvio app, ritorno in primo piano, timer a 60 s mentre l'app è in primo piano).
 * - Al massimo 5 alla volta: il sesto richiede di sostituire il più vecchio (decide l'interfaccia).
 * - I dati JSON stanno in localStorage; le tile della mappa stanno in IndexedDB (tilestore.js)
 *   e vengono rimosse tramite l'hook onRemove.
 *
 * Nessuna dipendenza dal DOM: testabile con Node (scripts/test-snapshot.js).
 */
(function (root) {
    'use strict';

    const KEY = 'skyguardian.snapshots.v2';
    const OLD_KEYS = ['skyguardian.snapshots.v1'];
    const TTL_MS = 24 * 60 * 60 * 1000;
    const MAX_SNAPSHOTS = 5;
    const MATCH_TOL_DEG = 0.01;           // ~1 km: "stessa località" per il suggerimento offline

    function pad2(n) { return String(n).padStart(2, '0'); }

    function create(opts) {
        opts = opts || {};
        const storage = opts.storage || root.localStorage;
        const now = opts.now || (() => Date.now());
        const onRemove = opts.onRemove || function () {};

        function load() {
            try {
                const raw = storage.getItem(KEY);
                if (!raw) return {};
                const obj = JSON.parse(raw);
                return (obj && typeof obj === 'object') ? obj : {};
            } catch (e) {
                return {};   // JSON corrotto o storage non disponibile
            }
        }

        function persist(all) {
            storage.setItem(KEY, JSON.stringify(all));
        }

        function notifyRemoved(snaps) {
            for (const s of snaps) {
                try { onRemove(s); } catch (e) { /* l'hook non deve mai rompere lo storage */ }
            }
        }

        // Rimuove gli snapshot scaduti (o malformati). Ritorna quanti ne ha eliminati.
        function purge() {
            const all = load();
            const gone = [];
            const t = now();
            for (const id of Object.keys(all)) {
                const s = all[id];
                if (!s || typeof s.expiresAt !== 'number' || s.expiresAt <= t) {
                    gone.push(s || { id });
                    delete all[id];
                }
            }
            if (gone.length) {
                try { persist(all); } catch (e) { /* niente da fare */ }
                notifyRemoved(gone);
            }
            return gone.length;
        }

        // Pulizia delle chiavi del vecchio formato (versione precedente dell'app).
        function dropLegacy() {
            for (const k of OLD_KEYS) { try { storage.removeItem(k); } catch (e) { /* ignora */ } }
        }

        function list() {
            purge();
            return Object.values(load()).sort((a, b) => b.createdAt - a.createdAt);
        }

        function get(id) {
            purge();
            return load()[id] || null;
        }

        function isFull() { return list().length >= MAX_SNAPSHOTS; }

        function oldest() {
            const l = list();
            return l.length ? l[l.length - 1] : null;
        }

        function newId(t) {
            return 's' + t.toString(36) + Math.random().toString(36).slice(2, 6);
        }

        // Salva un nuovo snapshot. Con 5 già presenti lancia Error con code = 'LIMIT':
        // sta all'interfaccia chiedere conferma e chiamare removeOldest().
        function save(data) {
            if (!data || !isFinite(data.lat) || !isFinite(data.lon)) {
                throw new Error('Coordinate non valide per lo snapshot');
            }
            if (isFull()) {
                const e = new Error('Limite di ' + MAX_SNAPSHOTS + ' snapshot raggiunto');
                e.code = 'LIMIT';
                throw e;
            }
            const all = load();
            const t = now();
            const snap = Object.assign({}, data, { id: data.id || newId(t), createdAt: t, expiresAt: t + TTL_MS });
            all[snap.id] = snap;
            try {
                persist(all);
            } catch (err) {
                const e = new Error('Spazio di archiviazione insufficiente per lo snapshot');
                e.code = 'QUOTA';
                throw e;
            }
            return snap;
        }

        function remove(id) {
            const all = load();
            const s = all[id];
            if (!s) return false;
            delete all[id];
            persist(all);
            notifyRemoved([s]);
            return true;
        }

        function removeOldest() {
            const o = oldest();
            if (!o) return null;
            remove(o.id);
            return o;
        }

        function clear() {
            const all = load();
            try { storage.removeItem(KEY); } catch (e) { /* ignora */ }
            notifyRemoved(Object.values(all));
        }

        // Id degli snapshot validi (serve a ripulire le tile orfane in IndexedDB).
        function ids() { return list().map(s => s.id); }

        // Snapshot valido più vicino alle coordinate (entro ~1 km), oppure null. Solo per suggerimenti.
        function findNear(lat, lon) {
            let best = null, bestD = Infinity;
            for (const s of list()) {
                const d = Math.max(Math.abs(s.lat - lat), Math.abs(s.lon - lon));
                if (d <= MATCH_TOL_DEG && d < bestD) { best = s; bestD = d; }
            }
            return best;
        }

        function remainingMs(snap) {
            return Math.max(0, snap.expiresAt - now());
        }

        function formatRemaining(ms) {
            const totalMin = Math.max(0, Math.floor(ms / 60000));
            const h = Math.floor(totalMin / 60);
            const m = totalMin % 60;
            return h > 0 ? (h + 'h ' + pad2(m) + 'm') : (m + 'm');
        }

        // "Palermo, 22/10 11:10" (ora locale del dispositivo)
        function shortStamp(ms) {
            const d = new Date(ms);
            return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
        }

        function labelFor(snap) {
            const place = snap.cityName ? snap.cityName : (Number(snap.lat).toFixed(4) + ', ' + Number(snap.lon).toFixed(4));
            return place + ', ' + shortStamp(snap.createdAt);
        }

        function sizeBytes(snap) {
            try { return JSON.stringify(snap).length; } catch (e) { return 0; }
        }

        dropLegacy();

        // Id riservato in anticipo: serve a salvare le tile (IndexedDB) prima di registrare lo snapshot.
        function reserveId() { return newId(now()); }

        return { TTL_MS, MAX_SNAPSHOTS, newId: reserveId, purge, list, get, save, remove, removeOldest, oldest, isFull,
                 clear, ids, findNear, remainingMs, formatRemaining, shortStamp, labelFor, sizeBytes };
    }

    const api = create({});
    api.create = create;

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.SkySnapshot = api;
})(typeof window !== 'undefined' ? window : globalThis);
