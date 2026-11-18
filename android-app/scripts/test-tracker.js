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
    const o = Object.assign({ from: 0, hAcc: 4, climb: 0, p0: null }, opts);
    return Array.from({ length: seconds }, (_, i) => {
        const s = o.from + i;
        return { t: T0 + s * 1000, lat: LAT0 + (s * mps) / M_PER_DEG, lon: LON0, hAcc: o.hAcc, speed: mps, speedAcc: 0.3,
                 msl: 100 + s * o.climb, alt: NaN, vAcc: 5, p: o.p0 ? o.p0 - s * o.climb * 0.1185 : NaN, sats: 28, satsL5: 9, course: 0 };
    });
}
const RAW = Object.assign({}, C.DEFAULTS, { intervalS: 1, minDistanceM: 0, maxHAcc: 50, warmupAcc: 50, autoPause: false, minSpeedKmh: 1, maxSpeedKmh: 200, elevation: 'gps' });
const run = (raw, s, o) => { const proc = C.process(raw, Object.assign({ settings: s || RAW }, o)); return { proc, st: C.stats(proc, Object.assign({ startedAt: T0 }, o)) }; };

ok('profili pronti e impostazioni normalizzate', () => {
    const w = C.settingsFor('walk');
    assert.strictEqual(w.profile, 'walk'); assert.strictEqual(w.intervalS, 2); assert.ok(w.autoPause);
    assert.ok(C.settingsFor('survey').fullGnss && C.settingsFor('survey').maxHAcc === 8);
    assert.strictEqual(C.settingsFor('battery').intervalS, 10);
    const bad = C.normalizeSettings({ intervalS: -5, maxHAcc: 'x', elevation: 'luna', extras: { acc: false } });
    assert.strictEqual(bad.intervalS, 1); assert.strictEqual(bad.maxHAcc, 25); assert.strictEqual(bad.elevation, 'combined');
    assert.strictEqual(bad.extras.acc, false); assert.strictEqual(bad.extras.sats, true);
});

ok('distanza, durata e velocità media a 5 m/s (18 km/h)', () => {
    const { st } = run(walk(601, 5), RAW, { now: T0 + 600000 });
    near(st.distance, 3000, 5); near(st.elapsed, 600000, 1);
    near(st.avg * 3.6, 18, 0.05); near(st.avgMoving * 3.6, 18, 0.05); near(st.max * 3.6, 18, 0.01);
    assert.strictEqual(st.gaps.length, 0);
});

ok('intervallo e distanza minima riducono i punti, non la distanza', () => {
    const s = Object.assign({}, RAW, { intervalS: 5 });
    const { proc, st } = run(walk(601, 5), s);
    assert.strictEqual(proc.points.length, 121); assert.strictEqual(proc.rejected.interval, 480);
    near(st.distance, 3000, 5);
    const d = run(walk(601, 5), Object.assign({}, RAW, { minDistanceM: 20 }));
    assert.strictEqual(d.proc.points.length, 151); near(d.st.distance, 3000, 25);
});

ok('precisione: attesa del primo fix preciso e scarto dei punti imprecisi', () => {
    const pts = walk(120, 3);
    for (let i = 0; i < 10; i++) pts[i].hAcc = 40;   // primi fix imprecisi
    pts[60] = Object.assign({}, pts[60], { hAcc: 80, lat: pts[60].lat + 0.002 });
    const s = Object.assign({}, RAW, { warmupAcc: 10, maxHAcc: 20 });
    const { proc, st } = run(pts, s);
    assert.strictEqual(proc.rejected.warmup, 10); assert.strictEqual(proc.rejected.accuracy, 1);
    near(st.distance, 327, 5, 'distanza senza i fix scartati');
});

ok('salti impossibili scartati con la velocità massima plausibile', () => {
    const pts = walk(100, 2);
    pts[50] = Object.assign({}, pts[50], { lat: pts[50].lat + 0.01 });   // salto di ~1 km in 1 s
    const { proc, st } = run(pts, Object.assign({}, RAW, { maxSpeedKmh: 30 }));
    assert.strictEqual(proc.rejected.jump, 1);
    near(st.distance, 198, 3);
});

ok('errore di velocità ammesso: oltre la soglia la velocità Doppler non si usa', () => {
    const pts = walk(30, 4).map((p, i) => i === 10 ? Object.assign({}, p, { speed: 30, speedAcc: 5 }) : p);
    const { proc, st } = run(pts, Object.assign({}, RAW, { maxSpeedAccKmh: 3 }));
    assert.strictEqual(proc.rejected.speedAcc, 1);
    near(st.max, 4, 0.01, 'la velocità incerta non entra nella massima');
});

ok('app chiusa per 5 minuti: buco a velocità zero, nessuna distanza, media abbassata', () => {
    const pts = walk(300, 5).concat(walk(300, 5, { from: 600 }));
    const { proc, st } = run(pts, RAW, { now: T0 + 899000 });
    assert.strictEqual(st.gaps.length, 1); near(st.gapTime, 301000, 1000);
    near(st.distance, 2990, 10);
    assert.ok(st.avg * 3.6 < 12.5 && st.avgMoving * 3.6 > 17.9);
    const series = C.speedSeries(proc, { startedAt: T0 });
    assert.ok(series.filter(([t, v, k]) => t >= T0 + 300000 && t < T0 + 600000).every(([, v, k]) => v === 0 && k === 'gap'));
});

ok('pausa manuale: non conta nella durata né nella media, nuovo segmento GPX', () => {
    const pts = walk(300, 5).concat(walk(300, 5, { from: 600 }));
    const pauses = [[T0 + 300000, T0 + 599500]];
    const { proc, st } = run(pts, RAW, { now: T0 + 899000, pauses });
    assert.strictEqual(st.gaps.length, 0, 'la pausa non è un buco');
    near(st.pauseTime, 299500, 1); near(st.elapsed, 599500, 1000);
    near(st.avg * 3.6, 18, 0.1, 'media come senza pausa');
    assert.strictEqual((C.toGpx(proc, {}).match(/<trkseg>/g) || []).length, 2);
    assert.ok(C.speedSeries(proc, { startedAt: T0 }).some(([, , k]) => k === 'pause'));
});

ok('pausa automatica: sosta di 2 minuti esclusa dal tempo in movimento', () => {
    const stop = Array.from({ length: 120 }, (_, i) => ({ t: T0 + (300 + i) * 1000, lat: LAT0 + 1500 / M_PER_DEG, lon: LON0, hAcc: 4, speed: 0.1, speedAcc: 0.2, msl: 100 }));
    const pts = walk(300, 5).concat(stop, walk(300, 5, { from: 420 }).map(p => Object.assign(p, { lat: p.lat - 120 * 5 / M_PER_DEG })));
    const s = Object.assign({}, RAW, { autoPause: true, autoPauseKmh: 1, autoPauseS: 20 });
    const { proc, st } = run(pts, s, { now: T0 + 719000 });
    assert.strictEqual(proc.autoPauses.length, 1);
    near(st.autoPauseTime, 120000, 2000);
    near(st.moving, 598000, 3000, 'tempo in movimento senza la sosta');
    near(st.avgMoving * 3.6, 18, 0.2);
    const off = run(pts, Object.assign({}, s, { autoPause: false }), { now: T0 + 719000 });
    assert.strictEqual(off.proc.autoPauses.length, 0);
});

ok('quota: GPS, barometro tarato sul primo minuto, combinata', () => {
    // GPS rumoroso (±6 m) su una salita di 150 m, barometro preciso
    const pts = walk(600, 1, { climb: 0.25, p0: 1000 }).map((p, i) => Object.assign(p, { msl: p.msl + Math.sin(i * 1.7) * 6 }));
    const g = run(pts, Object.assign({}, RAW, { elevation: 'gps' })).st;
    const c = run(pts, Object.assign({}, RAW, { elevation: 'combined' })).st;
    const b = run(pts, Object.assign({}, RAW, { elevation: 'baro' })).st;
    assert.strictEqual(c.elevationSource, 'combined'); assert.strictEqual(b.elevationSource, 'baro');
    near(c.gain, 150, 6, 'salita combinata'); near(b.gain, 150, 6, 'salita dal barometro');
    assert.ok(Math.abs(c.altitude - 249.75) < 3, 'quota finale ancorata al GPS: ' + c.altitude);
    assert.ok(g.gain > 150, 'il GPS rumoroso sovrastima la salita: ' + g.gain);
    const noBaro = run(walk(60, 1), Object.assign({}, RAW, { elevation: 'combined' })).st;
    assert.strictEqual(noBaro.elevationSource, 'gps', 'senza barometro si usa il GPS');
});

ok('GPX: segmenti, quota, ora e dati extra (Garmin + SkyGuardian) secondo le impostazioni', () => {
    const pts = walk(5, 2, { p0: 1000 });
    const all = C.toGpx(C.process(pts, { settings: RAW }), { name: 'Prova <1>', version: '2.0.0' });
    assert.ok(all.includes('<name>Prova &lt;1&gt;</name>') && all.includes('creator="SkyGuardian 2.0.0"'));
    assert.ok(all.includes('<sat>28</sat>') && all.includes('<gpxtpx:speed>2.00</gpxtpx:speed>') && all.includes('<gpxtpx:course>0.0</gpxtpx:course>'));
    assert.ok(all.includes('<sg:hacc>4.0</sg:hacc>') && all.includes('<sg:satsl5>9</sg:satsl5>') && all.includes('<sg:pressure>1000.00</sg:pressure>'));
    assert.ok(all.includes('<ele>100.0</ele>') && all.includes(new Date(T0).toISOString()));
    const none = C.toGpx(C.process(pts, { settings: Object.assign({}, RAW, { extras: { acc: false, sats: false, speed: false, course: false, pressure: false } }) }), {});
    assert.ok(!none.includes('<extensions>') && !none.includes('<sat>'));
});

ok('recupero di un percorso interrotto dal sistema (file nativo)', () => {
    const lines = ['S,1800000000000,1,{"profile":"bike","intervalS":2}', 'T,1800000001000,38.1,13.36,4,5,0.3,100,143,5,1000,20,6,90',
                   'P,1800000002000', 'R,1800000005000', 'T,1800000006000,38.1001,13.36,4,5,,101,144,5,,20,6,'];
    const r = C.parseRecovered(lines);
    assert.strictEqual(r.startedAt, 1800000000000); assert.ok(r.background); assert.strictEqual(r.settings.profile, 'bike');
    assert.strictEqual(r.points.length, 2); assert.deepStrictEqual(r.pauses, [[1800000002000, 1800000005000]]);
    const p = C.fromArray(r.points[1]);
    assert.ok(Number.isNaN(p.speedAcc) && Number.isNaN(p.p) && Number.isNaN(p.course) && p.sats === 20);
});

ok('formati: durata, passo, km/h, conversione dei punti', () => {
    assert.strictEqual(C.fmtDuration(3723000), '1:02:03');
    assert.strictEqual(C.fmtPace(1000 / 330), '5:30 min/km');
    assert.strictEqual(C.kmh(5), '18,0');
    const a = [T0, 38, 13, 3, 1.5, null, 660, 703, 4, 940.1, 25, 7, 181.5];
    assert.deepStrictEqual(C.toArray(C.fromArray(a)), a);
    assert.deepStrictEqual(C.speedSigma({ speedAcc: 0.4 }), { sigma: 0.4, estimated: false });
});

ok('curve di livello: decodifica Terrarium, intervallo per zoom, marching squares', () => {
    assert.strictEqual(C.terrariumElevation(128, 0, 0), 0);
    assert.strictEqual(C.terrariumElevation(130, 147, 128), 659.5);
    assert.strictEqual(C.contourInterval(15), 10); assert.strictEqual(C.contourInterval(14), 10);
    assert.strictEqual(C.contourInterval(13), 20); assert.strictEqual(C.contourInterval(12), 50); assert.strictEqual(C.contourInterval(8), 200);
    // piano inclinato da 600 a 690 m da sinistra a destra: curve verticali a 610, 620, …, 690
    const w = 10, h = 5, g = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = 600 + x * 10 + 0.5;
    const segs = C.contourSegments(g, w, h, 10);
    const levels = [...new Set(segs.map(s => s[4]))].sort((a, b) => a - b);
    assert.deepStrictEqual(levels, [610, 620, 630, 640, 650, 660, 670, 680, 690]);
    segs.forEach(([x1, y1, x2, y2, L]) => { near(x1, (L - 600.5) / 10, 1e-9); near(x2, (L - 600.5) / 10, 1e-9); assert.strictEqual(Math.abs(y2 - y1), 1); });
    assert.strictEqual(segs.length, 9 * (h - 1), 'una curva continua per livello');
    // cupola: curve chiuse attorno alla cima
    const n = 21, dome = new Float32Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) dome[y * n + x] = 700 - ((x - 10) ** 2 + (y - 10) ** 2) * 0.5;
    const ring = C.contourSegments(dome, n, n, 10).filter(s => s[4] === 680);
    assert.ok(ring.length > 8 && ring.every(([x1, y1, , , L]) => Math.abs(Math.hypot(x1 - 10, y1 - 10) - Math.sqrt(40)) < 0.5), 'curva a 680 m: cerchio di raggio √40');
});

// Battiti simulati: [ora, elapsed, uptime, visti, usati, gps, schermo, senza restrizioni, risparmio] (formato 2.2)
function beatsFrom(t0, t1, opts) {
    const o = Object.assign({ every: 5000, sleepFrom: null, sleepTo: null, vis: 12, used: 9, unr: 1, saver: 2, screen: 0 }, opts);
    const out = []; let el = 1e6, up = 1e6;
    for (let t = t0; t <= t1; t += o.every) {
        const asleep = o.sleepFrom !== null && t > o.sleepFrom && t <= o.sleepTo;
        el += o.every; up += asleep ? 200 : o.every;   // nel sonno profondo uptime quasi fermo
        out.push([t, el, up, o.vis, o.used, 1, o.screen, o.unr, o.saver]);
    }
    return out;
}

ok('app sospesa: battiti mancanti o processore addormentato (indipendente dal GPS)', () => {
    const B = C.fromBeat;
    assert.deepStrictEqual(C.suspendedIntervals(beatsFrom(T0, T0 + 300000).map(B), { startedAt: T0, end: T0 + 300000 }), [], 'battiti regolari: mai sospesa');
    const missing = beatsFrom(T0, T0 + 100000).concat(beatsFrom(T0 + 220000, T0 + 300000)).map(B);
    assert.deepStrictEqual(C.suspendedIntervals(missing, { startedAt: T0, end: T0 + 300000 }), [[T0 + 105000, T0 + 220000]], 'app congelata: battiti assenti');
    const sleep = beatsFrom(T0, T0 + 300000, { sleepFrom: T0 + 100000, sleepTo: T0 + 200000 }).map(B);
    const s1 = C.suspendedIntervals(sleep, { startedAt: T0, end: T0 + 300000 });
    assert.strictEqual(s1.length, 1); near(s1[0][0], T0 + 100000, 1); near(s1[0][1], T0 + 200000, 1);
    const tail = C.suspendedIntervals(beatsFrom(T0, T0 + 100000).map(B), { startedAt: T0, end: T0 + 300000 });
    assert.deepStrictEqual(tail, [[T0 + 105000, T0 + 300000]], 'sospesa fino alla fine');
    const paused = C.suspendedIntervals(missing, { startedAt: T0, end: T0 + 300000, pauses: [[T0 + 100500, T0 + 219000]] });
    assert.deepStrictEqual(paused, [[T0 + 219000, T0 + 220000]].filter(([a, b]) => b - a >= 1000), 'la pausa manuale non è sospensione');
    assert.strictEqual(C.suspendedIntervals([], {}), null, 'senza battiti: non classificabile');
});

ok('buchi GPS classificati: giallo (app sospesa) e rosso (senza segnale, con satelliti)', () => {
    const pts = walk(100, 5).concat(walk(100, 5, { from: 200 }), walk(100, 5, { from: 400 }));   // buchi 100-200 s e 300-400 s
    // 100-200 s: app attiva (battiti), 0 satelliti usati -> senza segnale; 300-400 s: battiti assenti -> app sospesa
    const beats = beatsFrom(T0, T0 + 200000).map((b, i) => (b[0] > T0 + 100000 && b[0] < T0 + 200000) ? Object.assign(b.slice(), { 3: 7, 4: 0 }) : b)
        .concat(beatsFrom(T0 + 400000, T0 + 499000));
    const { st } = run(pts, RAW, { now: T0 + 499000, beats });
    assert.ok(st.classified);
    assert.strictEqual(st.noSignal.length, 1); assert.strictEqual(st.suspended.length, 1);
    near(st.noSignalTime, 101000, 6000, 'senza segnale'); near(st.suspendedTime, 101000, 6000, 'app sospesa');
    assert.deepStrictEqual(st.noSignalSats, { used: 0, visible: 7, gpsOff: false });
    assert.deepStrictEqual(st.conditions, { unrestricted: true, saver: 2, screenOffPct: 100 });
    const old = run(pts, RAW, { now: T0 + 499000 }).st;
    assert.ok(!old.classified && old.gapTime > 0, 'percorsi senza battiti: buchi non classificati');
});

// Battiti 2.3: stato GNSS per ogni battito tramite f(t) -> { vis, used, gnssAge, fixAge, run, gps }
function beats23(t0, t1, f) {
    const out = []; let el = 1e6, up = 1e6;
    for (let t = t0; t <= t1; t += 5000) {
        el += 5000; up += 5000;
        const g = Object.assign({ vis: 30, used: 20, gnssAge: 800, fixAge: 900, run: 1, gps: 1 }, f(t));
        out.push([t, el, up, g.vis, g.used, g.gps, 0, 0, 1, g.gnssAge, g.fixAge, g.run, 1]);
    }
    return out;
}

ok('2.3: GPS fermato dal sistema con l\'app attiva = giallo, non «senza segnale»', () => {
    const pts = walk(100, 5).concat(walk(100, 5, { from: 300 }));   // buco 100-300 s, battiti regolari
    const hole = t => t > T0 + 100000 && t < T0 + 300000;
    const cases = [
        ['motore GNSS fermato', t => hole(t) ? { run: 0, used: 0, gnssAge: t - T0 - 100000, fixAge: t - T0 - 100000 } : {}, 'blocked'],
        ['satelliti muti (dati vecchi)', t => hole(t) ? { gnssAge: t - T0 - 100000, fixAge: t - T0 - 100000 } : {}, 'blocked'],
        ['satelliti agganciati, fix trattenuti', t => hole(t) ? { fixAge: t - T0 - 100000 } : {}, 'held'],
        ['posizione disattivata', t => hole(t) ? { gps: 0, fixAge: t - T0 - 100000 } : {}, 'gpsoff'],
    ];
    for (const [name, f, cause] of cases) {
        const { st } = run(pts, RAW, { now: T0 + 399000, beats: beats23(T0, T0 + 399000, f) });
        assert.ok(st.classified && !st.legacy, name);
        near(st.suspendedTime, 200000, 8000, name + ': fermato dal sistema');
        assert.ok(st.noSignalTime < 8000, name + ': niente rosso');
        assert.ok(st.causeTime[cause] > 180000, name + ': causa ' + cause);
    }
});

ok('2.3: senza segnale vero (GNSS vivo, pochi satelliti) o fix imprecisi = rosso', () => {
    const pts = walk(100, 5).concat(walk(100, 5, { from: 300 }));
    const hole = t => t > T0 + 100000 && t < T0 + 300000;
    const noSig = run(pts, RAW, { now: T0 + 399000, beats: beats23(T0, T0 + 399000, t => hole(t) ? { vis: 9, used: 0, fixAge: t - T0 - 100000 } : {}) }).st;
    near(noSig.noSignalTime, 200000, 8000, 'senza segnale'); assert.ok(noSig.suspendedTime < 8000, 'niente giallo');
    // fix che arrivano ma scartati dal filtro di precisione
    const bad = walk(100, 5).concat(walk(200, 5, { from: 100 }).map(p => Object.assign(p, { hAcc: 200 })), walk(100, 5, { from: 300 }));
    const weak = run(bad, RAW, { now: T0 + 399000, beats: beats23(T0, T0 + 399000, () => ({})) }).st;
    assert.ok(weak.causeTime.weak > 150000 && weak.suspendedTime < 8000, 'fix imprecisi: rosso');
});

ok('esito della tabella: dati 2.2 marcati come incompleti', () => {
    const pts = walk(100, 5).concat(walk(100, 5, { from: 300 }));
    const st = run(pts, RAW, { now: T0 + 399000, beats: beatsFrom(T0, T0 + 399000) }).st;
    assert.ok(st.legacy, 'battiti 2.2 = classificazione incompleta');
});

ok('recupero con i battiti e intervalli', () => {
    const r = C.parseRecovered(['S,1800000000000,1,{}', 'H,1800000005000,100,90,12,9,1,0,1,2', 'T,1800000006000,38.1,13.36,4,5,0.3,100,143,5,1000,20,6,90']);
    assert.deepStrictEqual(r.beats, [[1800000005000, 100, 90, 12, 9, 1, 0, 1, 2]]);
    assert.deepStrictEqual(C.subtractIntervals([[0, 10000]], [[2000, 3000]]), [[0, 2000], [3000, 10000]]);
    assert.deepStrictEqual(C.intersectIntervals([[0, 10000]], [[5000, 20000]]), [[5000, 10000]]);
});

console.log(`\n${n} test superati`);
