// Test dei calcoli astronomici delle Effemeridi 3D (nessun DOM, nessun Three.js)
process.env.TZ = 'Europe/Rome';
const assert = require('assert');
const path = require('path');
const SunCalc = require('suncalc');
const { astro: A } = require(path.join(__dirname, '..', 'www', 'ephemeris.js'));

let n = 0;
function ok(name, fn) { fn(); n++; console.log('ok -', name); }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} atteso ${b} ± ${tol}, ottenuto ${a}`);
const minutes = ms => ms / 60000;
const PALERMO = { lat: 38.1157, lon: 13.3615 };

ok('centro galattico in coordinate equatoriali (Sagittario A*)', () => {
    near(A.GALACTIC_CENTER.ra, 266.405, 0.02, 'AR');
    near(A.GALACTIC_CENTER.dec, -28.936, 0.02, 'Dec');
});

ok('la Polare sta a un\'altezza pari alla latitudine (±1°) e a Nord', () => {
    for (const ms of [Date.UTC(2026, 0, 1), Date.UTC(2026, 6, 15, 21)]) {
        const h = A.equToHor(37.95, 89.264, ms, PALERMO.lat, PALERMO.lon);
        near(h.alt, PALERMO.lat, 1.0, 'altezza');
        assert.ok(h.az < 2 || h.az > 358, 'azimut ' + h.az);
    }
});

ok('equToHor coincide con SunCalc per il Sole (stessa AR/Dec)', () => {
    // AR/Dec del Sole dall'algoritmo di SunCalc (eclittica semplificata) e confronto delle altezze
    const ms = Date.UTC(2026, 10, 5, 10, 30);
    const d = ms / 86400000 - 10957.5;
    const M = (357.5291 + 0.98560028 * d) * Math.PI / 180;
    const C = (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) * Math.PI / 180;
    const L = M + C + 102.9372 * Math.PI / 180 + Math.PI;
    const e = 23.4397 * Math.PI / 180;
    const ra = Math.atan2(Math.sin(L) * Math.cos(e), Math.cos(L)) * 180 / Math.PI;
    const dec = Math.asin(Math.sin(e) * Math.sin(L)) * 180 / Math.PI;
    const h = A.equToHor(ra, dec, ms, PALERMO.lat, PALERMO.lon);
    const s = A.sunAltAz(SunCalc, ms, PALERMO.lat, PALERMO.lon);
    near(h.alt, s.alt, 0.3, 'altezza');
    near(h.az, s.az, 1.0, 'azimut');   // SunCalc usa un tempo siderale semplificato (280.16° vs 280.46°): ~0.3° di angolo orario
});

ok('rotazione della Via Lattea: la base equatoriale riproduce equToHor per qualunque punto', () => {
    const ms = Date.UTC(2026, 7, 10, 22);
    const { lat, lon } = PALERMO;
    const basis = [[0, 0], [90, 0], [0, 90]].map(([ra, dec]) => { const h = A.equToHor(ra, dec, ms, lat, lon); return A.horToVec(h.alt, h.az); });
    for (const [ra, dec] of [[10, 20], [123, -45], [266.4, -28.9], [300, 75], [200, -80]]) {
        const r = ra * Math.PI / 180, d = dec * Math.PI / 180;
        const q = [Math.cos(d) * Math.cos(r), Math.cos(d) * Math.sin(r), Math.sin(d)];
        const v = [0, 1, 2].map(k => q[0] * basis[0][k] + q[1] * basis[1][k] + q[2] * basis[2][k]);
        const h = A.equToHor(ra, dec, ms, lat, lon);
        const w = A.horToVec(h.alt, h.az);
        [0, 1, 2].forEach(k => near(v[k], w[k], 1e-9, `componente ${k} di (${ra},${dec})`));
        const back = A.vecToHor(...w);
        near(back.alt, h.alt, 1e-9); near(A.norm360(back.az - h.az + 180) - 180, 0, 1e-7);
    }
});

// getTimes di SunCalc usa un'approssimazione del transito: confronto entro 2 minuti
ok('eventi del Sole a Palermo (21 giugno 2026) coerenti con SunCalc', () => {
    const ev = A.dayEvents(SunCalc, '2026-06-21', PALERMO.lat, PALERMO.lon);
    const t = SunCalc.getTimes(new Date(2026, 5, 21, 12), PALERMO.lat, PALERMO.lon);
    const L = ev.sunLevels;
    near(minutes(L['-0.833'].rise.t), minutes(t.sunrise.getTime()), 2, 'alba');
    near(minutes(L['-0.833'].set.t), minutes(t.sunset.getTime()), 2, 'tramonto');
    near(minutes(L['-6'].set.t), minutes(t.dusk.getTime()), 2, 'fine crepuscolo civile');
    near(minutes(L['-12'].rise.t), minutes(t.nauticalDawn.getTime()), 2, 'alba nautica');
    near(minutes(L['-18'].set.t), minutes(t.night.getTime()), 2, 'notte astronomica');
    near(minutes(L['6'].set.t), minutes(t.goldenHour.getTime()), 2, "inizio ora d'oro");
    const sunrise = new Date(L['-0.833'].rise.t);
    assert.strictEqual(sunrise.getHours(), 5, 'alba alle 5 e qualcosa (ora legale)');
    assert.ok(L['-0.833'].rise.az > 55 && L['-0.833'].rise.az < 65, 'alba a ENE: ' + L['-0.833'].rise.az);
    // ordine della sera: ora d'oro -> tramonto -> -4° -> -6° -> -12° -> -18°
    const order = ['6', '-0.833', '-4', '-6', '-12', '-18'].map(k => L[k].set.t);
    order.reduce((a, b) => { assert.ok(b > a, 'ordine crescente'); return b; });
    assert.ok(ev.events.some(e => e.culmination && e.body === 'sun'), 'mezzogiorno solare presente');
    for (let i = 1; i < ev.events.length; i++) assert.ok(ev.events[i].t >= ev.events[i - 1].t, 'eventi ordinati');
});

ok('sorgere e tramonto della Luna coerenti con SunCalc (±3 min)', () => {
    for (const ds of ['2026-11-05', '2026-11-12', '2026-11-20']) {
        const ev = A.dayEvents(SunCalc, ds, PALERMO.lat, PALERMO.lon);
        const [y, m, d] = ds.split('-').map(Number);
        const mt = SunCalc.getMoonTimes(new Date(y, m - 1, d), PALERMO.lat, PALERMO.lon);
        const rise = ev.events.find(e => e.body === 'moon' && e.rising);
        const set = ev.events.find(e => e.body === 'moon' && !e.rising);
        if (mt.rise) near(minutes(rise.t), minutes(mt.rise.getTime()), 3, 'sorge ' + ds);
        if (mt.set) near(minutes(set.t), minutes(mt.set.getTime()), 3, 'tramonta ' + ds);
    }
});

ok('centro della Via Lattea: sorge e tramonta a Palermo, culmina a ~23° verso Sud', () => {
    const ev = A.dayEvents(SunCalc, '2026-07-15', PALERMO.lat, PALERMO.lon);
    assert.ok(ev.gcCrossings.some(c => c.rising) && ev.gcCrossings.some(c => !c.rising), 'sorge e tramonta');
    const top = ev.events.find(e => e.body === 'mw' && e.culmination);
    assert.ok(top, 'culminazione presente');
    near(top.az, 180, 1, 'culmina a Sud');
    const alt = A.gcAltAz(top.t, PALERMO.lat, PALERMO.lon).alt;
    near(alt, 90 - PALERMO.lat - 28.94, 0.3, 'altezza massima');
});

ok('giorno locale: 23 h nel cambio all\'ora legale, 25 h al ritorno all\'ora solare', () => {
    const a = A.localDayRange('2026-03-29'), b = A.localDayRange('2026-10-25'), c = A.localDayRange('2026-11-05');
    assert.strictEqual((a.end - a.start) / 3600000, 23);
    assert.strictEqual((b.end - b.start) / 3600000, 25);
    assert.strictEqual((c.end - c.start) / 3600000, 24);
    assert.strictEqual(A.localDateStr(c.start), '2026-11-05');
});

ok('fasi del giorno e formattazioni', () => {
    assert.strictEqual(A.sunPhase(20).key, 'day');
    assert.strictEqual(A.sunPhase(2).key, 'golden');
    assert.strictEqual(A.sunPhase(-5).key, 'blue');
    assert.strictEqual(A.sunPhase(-10).key, 'nautical');
    assert.strictEqual(A.sunPhase(-15).key, 'astro');
    assert.strictEqual(A.sunPhase(-30).key, 'night');
    assert.strictEqual(A.cardinal(0), 'N'); assert.strictEqual(A.cardinal(225), 'SO'); assert.strictEqual(A.cardinal(270), 'O');
    assert.strictEqual(A.formatCoords(38.1157, 13.3615), '38° 06′ N  13° 21′ E');
    assert.strictEqual(A.gmtLabel(Date.UTC(2026, 10, 5)), 'GMT+1');
    assert.strictEqual(A.gmtLabel(Date.UTC(2026, 6, 5)), 'GMT+2');
});

ok('punti della Via Lattea deterministici e concentrati sul piano galattico', () => {
    const a = A.milkyWayPoints(500), b = A.milkyWayPoints(500);
    assert.deepStrictEqual(a, b);
    const inBand = a.filter(p => Math.abs(p.b) < 15).length;
    assert.ok(inBand / a.length > 0.95, 'quasi tutti entro ±15° dal piano');
});

console.log(`\n${n} test superati`);
