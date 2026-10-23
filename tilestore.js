/*
 * SkyGuardian - Tile della mappa per gli snapshot (IndexedDB)
 *
 * - planTiles(): calcola quali tile servono per la vista corrente (zoom attuale, poi -1, poi +1),
 *   fino a un massimo di tile (default 150). Funzione pura, testabile con Node.
 * - create(backend): archivio chiave/valore con backend sostituibile (IndexedDB nel browser,
 *   Map in memoria nei test). Le tile di uno snapshot si cancellano insieme allo snapshot.
 */
(function (root) {
    'use strict';

    const MAX_TILES = 150;

    function lon2x(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
    function lat2y(lat, z) {
        const r = lat * Math.PI / 180;
        return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z));
    }

    // bounds = { north, south, east, west } in gradi; zoom = livello attuale della mappa.
    // Ordine di priorità: zoom attuale, zoom-1, zoom+1. Un livello che non entra per intero nel
    // budget residuo viene saltato (meglio meno livelli completi che un livello a metà).
    function planTiles(bounds, zoom, opts) {
        opts = opts || {};
        const budget = opts.budget || MAX_TILES;
        const minZ = opts.minZoom != null ? opts.minZoom : 0;
        const maxZ = opts.maxZoom != null ? opts.maxZoom : 19;
        const tiles = [];
        const levels = [];
        for (const z of [zoom, zoom - 1, zoom + 1]) {
            if (z < minZ || z > maxZ) continue;
            const n = Math.pow(2, z);
            const x0 = Math.max(0, lon2x(bounds.west, z)), x1 = Math.min(n - 1, lon2x(bounds.east, z));
            const y0 = Math.max(0, lat2y(bounds.north, z)), y1 = Math.min(n - 1, lat2y(bounds.south, z));
            const count = (x1 - x0 + 1) * (y1 - y0 + 1);
            if (count <= 0 || tiles.length + count > budget) continue;
            for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tiles.push({ z, x, y });
            levels.push(z);
        }
        return { tiles, levels };
    }

    function tileUrl(template, t) {
        return template.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y);
    }

    function create(backend) {
        const key = (snap, layer, z, x, y) => [snap, layer, z, x, y].join('|');
        return {
            key,
            put: (snap, layer, z, x, y, blob) => backend.put(key(snap, layer, z, x, y), snap, blob),
            get: (snap, layer, z, x, y) => backend.get(key(snap, layer, z, x, y)),
            removeSnapshot: (snap) => backend.deleteSnap(snap),
            // Cancella le tile di tutti gli snapshot non più validi (orfane dopo scadenza o chiusura forzata).
            pruneTo: async (validIds) => {
                const keep = new Set(validIds);
                const present = await backend.snapIds();
                for (const id of present) if (!keep.has(id)) await backend.deleteSnap(id);
            }
        };
    }

    // Backend in memoria (test)
    function memoryBackend() {
        const m = new Map();
        return {
            put: async (k, snap, blob) => { m.set(k, { snap, blob }); },
            get: async (k) => (m.has(k) ? m.get(k).blob : null),
            deleteSnap: async (snap) => { for (const [k, v] of [...m]) if (v.snap === snap) m.delete(k); },
            snapIds: async () => [...new Set([...m.values()].map(v => v.snap))],
            _size: () => m.size
        };
    }

    // Backend IndexedDB (browser / WebView Android)
    function idbBackend() {
        let dbp = null;
        function open() {
            if (!dbp) {
                dbp = new Promise((resolve, reject) => {
                    const req = indexedDB.open('skyguardian-tiles', 1);
                    req.onupgradeneeded = () => {
                        const st = req.result.createObjectStore('tiles', { keyPath: 'k' });
                        st.createIndex('snap', 'snap');
                    };
                    req.onsuccess = () => {
                        req.result.onversionchange = () => { req.result.close(); dbp = null; };   // permette deleteDatabase
                        resolve(req.result);
                    };
                    req.onerror = () => reject(req.error);
                });
                dbp.catch(() => { dbp = null; });
            }
            return dbp;
        }
        function done(t) {
            return new Promise((resolve, reject) => {
                t.oncomplete = () => resolve();
                t.onerror = () => reject(t.error);
                t.onabort = () => reject(t.error);
            });
        }
        return {
            put: (k, snap, blob) => open().then(db => {
                const t = db.transaction('tiles', 'readwrite');
                t.objectStore('tiles').put({ k, snap, blob });
                return done(t);
            }),
            get: (k) => open().then(db => new Promise((resolve, reject) => {
                const r = db.transaction('tiles', 'readonly').objectStore('tiles').get(k);
                r.onsuccess = () => resolve(r.result ? r.result.blob : null);
                r.onerror = () => reject(r.error);
            })),
            deleteSnap: (snap) => open().then(db => {
                const t = db.transaction('tiles', 'readwrite');
                const req = t.objectStore('tiles').index('snap').openKeyCursor(IDBKeyRange.only(snap));
                req.onsuccess = () => {
                    const c = req.result;
                    if (c) { t.objectStore('tiles').delete(c.primaryKey); c.continue(); }
                };
                return done(t);
            }),
            snapIds: () => open().then(db => new Promise((resolve, reject) => {
                const ids = [];
                const req = db.transaction('tiles', 'readonly').objectStore('tiles').index('snap').openKeyCursor(null, 'nextunique');
                req.onsuccess = () => {
                    const c = req.result;
                    if (c) { ids.push(c.key); c.continue(); } else resolve(ids);
                };
                req.onerror = () => reject(req.error);
            }))
        };
    }

    const api = { MAX_TILES, planTiles, tileUrl, create, memoryBackend, idbBackend, lon2x, lat2y };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.SkyTiles = api;
})(typeof window !== 'undefined' ? window : globalThis);
