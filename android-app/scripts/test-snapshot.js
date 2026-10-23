// Test dello storage snapshot e della pianificazione tile (Node puro, nessuna dipendenza)
const assert = require('assert');
const Snap = require('../www/snapshot.js');
const Tiles = require('../www/tilestore.js');

function fakeStorage(limitChars) {
    const m = new Map();
    return {
        getItem: k => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => {
            if (limitChars && v.length > limitChars) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }
            m.set(k, String(v));
        },
        removeItem: k => m.delete(k),
        _m: m
    };
}

let t = new Date(2026, 9, 22, 11, 10).getTime();   // 22/10/2026 11:10 locale
const clock = () => t;
const HOUR = 3600 * 1000;
let n = 0;
async function ok(name, fn) { await fn(); n++; console.log('ok -', name); }

(async () => {
    await ok('salva e rilegge uno snapshot, validità 24h', () => {
        const s = Snap.create({ storage: fakeStorage(), now: clock });
        const a = s.save({ lat: 38.1157, lon: 13.3615, cityName: 'Palermo', sections: { sectionOpenMeteo: { data: { x: 1 } } } });
        assert.strictEqual(a.expiresAt - a.createdAt, 24 * HOUR);
        assert.strictEqual(s.list().length, 1);
        assert.strictEqual(s.get(a.id).cityName, 'Palermo');
    });

    await ok('etichetta "Località, gg/mm hh:mm"', () => {
        const s = Snap.create({ storage: fakeStorage(), now: clock });
        const a = s.save({ lat: 38.1157, lon: 13.3615, cityName: 'Palermo' });
        assert.strictEqual(s.labelFor(a), 'Palermo, 22/10 11:10');
        const b = s.save({ lat: 38.1157, lon: 13.3615 });
        assert.strictEqual(s.labelFor(b), '38.1157, 13.3615, 22/10 11:10');
    });

    await ok('scade dopo 24h, non viene mai restituito ed è cancellato dallo storage', () => {
        const st = fakeStorage();
        const s = Snap.create({ storage: st, now: clock });
        const a = s.save({ lat: 1, lon: 2 });
        t += 24 * HOUR - 1;
        assert.ok(s.get(a.id), 'a 23h59m59s è ancora valido');
        t += 2;
        assert.strictEqual(s.get(a.id), null);
        assert.strictEqual(Object.keys(JSON.parse(st.getItem('skyguardian.snapshots.v2'))).length, 0);
    });

    await ok('due snapshot della stessa località coesistono', () => {
        const s = Snap.create({ storage: fakeStorage(), now: clock });
        s.save({ lat: 38.1, lon: 13.3 });
        t += HOUR;
        s.save({ lat: 38.1, lon: 13.3 });
        assert.strictEqual(s.list().length, 2);
    });

    await ok('massimo 5: il sesto lancia LIMIT e non salva nulla', () => {
        const s = Snap.create({ storage: fakeStorage(), now: clock });
        for (let i = 0; i < 5; i++) { t += 1000; s.save({ lat: 30 + i, lon: 10 }); }
        assert.strictEqual(s.isFull(), true);
        assert.throws(() => s.save({ lat: 50, lon: 10 }), e => e.code === 'LIMIT');
        assert.strictEqual(s.list().length, 5);
    });

    await ok('removeOldest libera uno slot e sceglie il più vecchio', () => {
        const removed = [];
        const s = Snap.create({ storage: fakeStorage(), now: clock, onRemove: x => removed.push(x.lat) });
        for (let i = 0; i < 5; i++) { t += 1000; s.save({ lat: 30 + i, lon: 10 }); }
        const gone = s.removeOldest();
        assert.strictEqual(gone.lat, 30);
        assert.deepStrictEqual(removed, [30]);
        s.save({ lat: 50, lon: 10 });
        assert.strictEqual(s.list().length, 5);
        assert.ok(!s.list().some(x => x.lat === 30));
    });

    await ok('onRemove scatta per scadenza, remove e clear', () => {
        const removed = [];
        const s = Snap.create({ storage: fakeStorage(), now: clock, onRemove: x => removed.push(x.id) });
        const a = s.save({ lat: 1, lon: 1 });
        const b = s.save({ lat: 2, lon: 2 });
        s.remove(a.id);
        assert.deepStrictEqual(removed, [a.id]);
        t += 25 * HOUR;
        assert.strictEqual(s.purge(), 1);
        assert.deepStrictEqual(removed, [a.id, b.id]);
        const c = s.save({ lat: 3, lon: 3 });
        s.clear();
        assert.strictEqual(removed[removed.length - 1], c.id);
        assert.strictEqual(s.list().length, 0);
    });

    await ok('un hook che lancia non rompe lo storage', () => {
        const s = Snap.create({ storage: fakeStorage(), now: clock, onRemove: () => { throw new Error('boom'); } });
        const a = s.save({ lat: 1, lon: 1 });
        assert.strictEqual(s.remove(a.id), true);
    });

    await ok('storage pieno: errore QUOTA e nessuno snapshot esistente viene toccato', () => {
        const s = Snap.create({ storage: fakeStorage(900), now: clock });
        s.save({ lat: 1, lon: 1, pad: 'x'.repeat(300) });
        s.save({ lat: 2, lon: 2, pad: 'x'.repeat(300) });
        assert.throws(() => s.save({ lat: 3, lon: 3, pad: 'x'.repeat(600) }), e => e.code === 'QUOTA');
        assert.strictEqual(s.list().length, 2);
    });

    await ok('findNear entro ~1 km, non oltre (solo per i suggerimenti)', () => {
        const s = Snap.create({ storage: fakeStorage(), now: clock });
        s.save({ lat: 38.1157, lon: 13.3615 });
        assert.ok(s.findNear(38.1200, 13.3650));
        assert.strictEqual(s.findNear(38.2, 13.3615), null);
    });

    await ok('JSON corrotto nello storage non rompe nulla; chiavi vecchie ripulite', () => {
        const st = fakeStorage();
        st.setItem('skyguardian.snapshots.v2', '{non json');
        st.setItem('skyguardian.snapshots.v1', '{}');
        const s = Snap.create({ storage: st, now: clock });
        assert.deepStrictEqual(s.list(), []);
        assert.strictEqual(st.getItem('skyguardian.snapshots.v1'), null);
        s.save({ lat: 5, lon: 5 });
        assert.strictEqual(s.list().length, 1);
    });

    await ok('coordinate non valide rifiutate', () => {
        const s = Snap.create({ storage: fakeStorage(), now: clock });
        assert.throws(() => s.save({ lat: NaN, lon: 1 }));
    });

    await ok('formatRemaining', () => {
        const s = Snap.create({ storage: fakeStorage(), now: clock });
        assert.strictEqual(s.formatRemaining(23 * HOUR + 5 * 60000), '23h 05m');
        assert.strictEqual(s.formatRemaining(42 * 60000), '42m');
        assert.strictEqual(s.formatRemaining(-5), '0m');
    });

    // ---------------- tile ----------------
    const PA = { north: 38.1200, south: 38.1110, east: 13.3700, west: 13.3530 };   // vista ~1 km su Palermo

    await ok('planTiles: priorità zoom attuale, -1, +1, mai oltre 150', () => {
        const p = Tiles.planTiles(PA, 15);
        assert.deepStrictEqual(p.levels.slice(0, 2), [15, 14]);
        assert.ok(p.tiles.length <= 150 && p.tiles.length > 0);
        assert.ok(p.tiles.every(x => [14, 15, 16].includes(x.z)));
        assert.strictEqual(new Set(p.tiles.map(x => x.z + '/' + x.x + '/' + x.y)).size, p.tiles.length, 'nessun duplicato');
    });

    await ok('planTiles: vista enorme -> un livello che non entra viene saltato intero', () => {
        const big = { north: 45, south: 36, east: 19, west: 6 };
        const p = Tiles.planTiles(big, 7, { budget: 150 });
        assert.ok(p.tiles.length <= 150);
        const perLevel = {};
        p.tiles.forEach(x => { perLevel[x.z] = (perLevel[x.z] || 0) + 1; });
        for (const z of p.levels) assert.ok(perLevel[z] > 0);
    });

    await ok('planTiles: rispetta zoom minimo/massimo', () => {
        const p = Tiles.planTiles(PA, 19, { maxZoom: 19 });
        assert.ok(!p.levels.includes(20));
        const q = Tiles.planTiles(PA, 0, { minZoom: 0 });
        assert.ok(!q.levels.includes(-1));
    });

    await ok('coordinate tile: confronto con formula alternativa (asinh) e valori noti', () => {
        for (const [lat, lon, z] of [[38.1157, 13.3615, 15], [45.4642, 9.19, 12], [-33.86, 151.21, 17], [0, 0, 1]]) {
            const x = Math.floor((lon + 180) / 360 * 2 ** z);
            const y = Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z);
            assert.strictEqual(Tiles.lon2x(lon, z), x);
            assert.strictEqual(Tiles.lat2y(lat, z), y);
        }
        assert.strictEqual(Tiles.lon2x(0, 1), 1);
        assert.strictEqual(Tiles.lat2y(0, 1), 1);
        assert.strictEqual(Tiles.lon2x(-180, 5), 0);
    });

    await ok('tileUrl sostituisce z/x/y', () => {
        assert.strictEqual(Tiles.tileUrl('https://a/{z}/{x}/{y}.png', { z: 3, x: 4, y: 5 }), 'https://a/3/4/5.png');
        assert.strictEqual(Tiles.tileUrl('https://a/{z}/{y}/{x}', { z: 3, x: 4, y: 5 }), 'https://a/3/5/4');
    });

    await ok('TileStore: put/get, cancellazione per snapshot, pruneTo', async () => {
        const be = Tiles.memoryBackend();
        const ts = Tiles.create(be);
        await ts.put('sA', 'osm', 15, 1, 2, 'blobA');
        await ts.put('sA', 'osm', 15, 1, 3, 'blobA2');
        await ts.put('sB', 'sat', 14, 0, 0, 'blobB');
        assert.strictEqual(await ts.get('sA', 'osm', 15, 1, 2), 'blobA');
        assert.strictEqual(await ts.get('sA', 'sat', 15, 1, 2), null);
        await ts.removeSnapshot('sA');
        assert.strictEqual(be._size(), 1);
        await ts.put('sC', 'osm', 1, 0, 0, 'c');
        await ts.pruneTo(['sC']);
        assert.strictEqual(be._size(), 1);
        assert.strictEqual(await ts.get('sB', 'sat', 14, 0, 0), null);
        assert.strictEqual(await ts.get('sC', 'osm', 1, 0, 0), 'c');
    });

    console.log(`\n${n} test superati`);
})().catch(e => { console.error('FALLITO:', e); process.exit(1); });
