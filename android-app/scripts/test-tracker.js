// Test dei calcoli del GPS Tracking (nessun DOM, nessun sensore)
const assert = require('assert');
const path = require('path');
global.window = global;
const { calc: C } = require(path.join(__dirname, '..', 'www', 'tracker.js'));

let n = 0;
function ok(name, fn) { fn(); n++; console.log('ok -', name); }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} atteso ${b} ± ${tol}, ottenuto ${a}`);

// Percorso simulato: verso Nord a velocità costante, un punto al secondo
const T0 = 1.8e12, LAT0 = 38.1, LON0 = 13.36, M_PER_DEG = 111194.9;
function walk(seconds, mps, opts) {
    const o = Object.assign({ from: 0, t0: T0, lat0: LAT0, p0: null }, opts);
    return Array.from({ length: seconds }, (_, i) => {
        const s = o.from + i;
        return { t: o.t0 + s * 1000, lat: o.lat0 + (s * mps) / M_PER_DEG, lon: LON0, hAcc: 4, speed: mps, speedAcc: 0.3,
                 msl: o.climb ? 100 + s * o.climb : 100, alt: NaN, vAcc: 5, p: o.p0 ? o.p0 - s * (o.climb || 0) * 0.118 : NaN };
    });
}

ok('distanza, durata e velocità media di un percorso a 5 m/s (18 km/h)', () => {
    const pts = walk(601, 5);
    const s = C.stats(pts, { startedAt: T0, now: T0 + 600000 });
    near(s.distance, 3000, 5, 'distanza');
    near(s.elapsed, 600000, 1);
    near(s.avg * 3.6, 18, 0.05, 'media'); near(s.avgMoving * 3.6, 18, 0.05);
    near(s.max * 3.6, 18, 0.01);
    assert.strictEqual(s.gaps.length, 0);
});

ok('app chiusa per 5 minuti: velocità zero nel grafico, nessuna distanza, media abbassata', () => {
    const a = walk(300, 5), b = walk(300, 5, { from: 600 });   // buco tra 300 s e 600 s
    const pts = a.concat(b);
    const s = C.stats(pts, { startedAt: T0, now: T0 + 899000 });
    assert.strictEqual(s.gaps.length, 1);
    near(s.gapTime, 301000, 1000, 'durata del buco');
    near(s.distance, 2990, 10, 'la distanza del buco non viene contata');
    assert.ok(s.avg * 3.6 < 12.5 && s.avgMoving * 3.6 > 17.9, `media ${s.avg * 3.6} su tutto, ${s.avgMoving * 3.6} in movimento`);
    const series = C.speedSeries(pts, { startedAt: T0 });
    const inGap = series.filter(([t]) => t >= T0 + 300000 && t < T0 + 600000);
    assert.ok(inGap.length >= 2 && inGap.every(([, v, gap]) => v === 0 && gap), 'zeri nel grafico durante il buco');
});

ok('da fermi il tremolio del GPS non aggiunge distanza', () => {
    const still = Array.from({ length: 300 }, (_, i) => ({ t: T0 + i * 1000, lat: LAT0 + Math.sin(i) * 2e-5, lon: LON0 + Math.cos(i * 1.3) * 2e-5,
                                                         hAcc: 5, speed: 0.1, speedAcc: 0.2, msl: 100 + Math.sin(i) * 3 }));
    const s = C.stats(still, { startedAt: T0 });
    assert.strictEqual(s.distance, 0);
    assert.strictEqual(s.moving, 0);
    assert.strictEqual(Math.round(s.gain), 0, 'oscillazioni di ±3 m sotto la soglia di 5 m: niente salita');
});

ok('fix imprecisi esclusi; picco isolato di velocità ignorato per la massima', () => {
    const pts = walk(120, 3);
    pts[50] = Object.assign({}, pts[50], { speed: 40 });           // picco isolato
    pts[60] = Object.assign({}, pts[60], { hAcc: 120, lat: pts[60].lat + 0.01 });   // fix pessimo
    const s = C.stats(pts, { startedAt: T0 });
    near(s.max, 3, 0.01, 'massima');
    near(s.distance, 357, 5, 'distanza senza il salto del fix pessimo');
});

ok('dislivello: barometro se presente, altrimenti GPS', () => {
    const baro = walk(600, 1, { climb: 0.5, p0: 1000 });   // +300 m, pressione che scende ~0,118 hPa/m
    const s1 = C.stats(baro, { startedAt: T0 });
    assert.ok(s1.useBaro);
    near(s1.gain, 300, 15, 'salita dal barometro'); near(s1.loss, 0, 2);
    const gps = walk(600, 1, { climb: -0.2 });
    const s2 = C.stats(gps, { startedAt: T0 });
    assert.ok(!s2.useBaro);
    near(s2.loss, 120, 6, 'discesa dal GPS'); near(s2.gain, 0, 1);
    near(s2.altitude, 100 - 0.2 * 599, 0.01);
});

ok('errore della velocità: Doppler nativo o stima dalla precisione', () => {
    assert.deepStrictEqual(C.speedSigma({ speedAcc: 0.4 }), { sigma: 0.4, estimated: false });
    const e = C.speedSigma({ hAcc: 12, speedAcc: NaN });
    assert.ok(e.estimated && e.sigma === 1);
    assert.strictEqual(C.speedSigma({ hAcc: 2 }).sigma, 0.3);
});

ok('GPX: un segmento per ogni tratto senza interruzioni, con quota, ora e velocità', () => {
    const pts = walk(5, 2).concat(walk(5, 2, { from: 100 }));
    const g = C.toGpx(pts, { name: 'Prova <1>' });
    assert.strictEqual((g.match(/<trkseg>/g) || []).length, 2);
    assert.strictEqual((g.match(/<trkpt /g) || []).length, 10);
    assert.ok(g.includes('<name>Prova &lt;1&gt;</name>') && g.includes('<ele>100.0</ele>') && g.includes('<speed>2.00</speed>'));
    assert.ok(g.includes(new Date(T0).toISOString()));
});

ok('formati: durata, passo, km/h, conversione dei punti nativi', () => {
    assert.strictEqual(C.fmtDuration(3723000), '1:02:03');
    assert.strictEqual(C.fmtPace(1000 / 330), '5:30 min/km');
    assert.strictEqual(C.fmtPace(0), '—');
    assert.strictEqual(C.kmh(5), '18,0');
    const p = C.fromArray([T0, 38, 13, 3, 1.5, null, 660, 703, 4, 940.1]);
    assert.ok(Number.isNaN(p.speedAcc) && p.msl === 660 && p.p === 940.1);
    assert.deepStrictEqual(C.toArray(p), [T0, 38, 13, 3, 1.5, null, 660, 703, 4, 940.1]);
});

console.log(`\n${n} test superati`);
