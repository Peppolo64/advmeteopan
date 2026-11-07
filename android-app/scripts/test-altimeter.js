// Test dei calcoli di Posizione e Altitudine (nessun DOM, nessun sensore)
const assert = require('assert');
const path = require('path');
const www = path.join(__dirname, '..', 'www');
global.window = global;
require(path.join(www, 'geoid.js'));
const { calc: C } = require(path.join(www, 'altimeter.js'));

let n = 0;
function ok(name, fn) { fn(); n++; console.log('ok -', name); }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} atteso ${b} ± ${tol}, ottenuto ${a}`);

ok('atmosfera standard (ISA): valori di riferimento', () => {
    near(C.isaAltitude(1013.25, 1013.25), 0, 1e-9);
    near(C.pressureAt(1000, 1013.25), 898.75, 0.05, 'pressione ISA a 1000 m');
    near(C.pressureAt(3000, 1013.25), 701.1, 0.2, 'pressione ISA a 3000 m');
    near(C.isaAltitude(C.pressureAt(660, 1021.3), 1021.3), 660, 1e-6, 'andata e ritorno');
    near(C.qnhFrom(C.pressureAt(1850, 1009.8), 1850), 1009.8, 1e-9, 'QNH ricostruito');
    near(C.metersPerHpa(1013.25, 1013.25), 8.32, 0.02, 'm/hPa al livello del mare (R·T/g·p)');
    near(C.metersPerHpa(C.pressureAt(1000, 1013.25), 1013.25), 9.17, 0.1, 'm/hPa a 1000 m');
});

ok('correzione di temperatura: aria calda = quota vera più alta dell\'indicata', () => {
    const p = C.pressureAt(1000, 1013.25);
    near(C.baroAltitude(p, 1013.25, 0, null, 8.5).h, 1000, 0.5, 'temperatura ISA a 1000 m (8,5 °C): nessuna correzione');
    const warm = C.baroAltitude(p, 1013.25, 0, null, 23.5);   // +15 °C rispetto all'ISA
    assert.ok(warm.h > 1045 && warm.h < 1060, 'circa +5%: ' + warm.h);
    const cold = C.baroAltitude(p, 1013.25, 0, null, -6.5);
    assert.ok(cold.h < 955 && cold.h > 940, 'circa -5%: ' + cold.h);
    // QNH di una stazione METAR a 21 m: alla quota della stazione la temperatura non conta
    near(C.baroAltitude(C.pressureAt(21, 1018), 1018, 21, 30, null).h, 21, 0.01, 'quota della stazione');
});

ok('geoide EGM96: valori noti e coerenza tra griglia regionale e globale', () => {
    near(C.geoidUndulation(global.SkyGeoid, 0, 0), 17.16, 0.3, 'N(0,0)');
    near(C.geoidUndulation(global.SkyGeoid, 38.1157, 13.3615), 43.3, 0.3, 'N Palermo');
    near(C.geoidUndulation(global.SkyGeoid, 41.9, 12.5), 48.5, 0.3, 'N Roma');
    // sui nodi comuni le due griglie coincidono (stessa sorgente); fuori dall'area regionale l'incertezza è maggiore
    const onlyGlobal = { regional: { lat0: 0, lon0: 0, step: 1, nlat: 1, nlon: 1, dm: '' }, global: global.SkyGeoid.global };
    for (const [la, lo] of [[44, 10], [46, 12], [38, 14], [40, -10]]) near(C.geoidUndulation(global.SkyGeoid, la, lo), C.geoidUndulation(onlyGlobal, la, lo), 1e-9, `nodo ${la},${lo}`);
    assert.strictEqual(C.geoidSigma(global.SkyGeoid, 38.1, 13.4), 1.0);
    assert.strictEqual(C.geoidSigma(global.SkyGeoid, 27.99, 86.93), 3.0);
    near(C.geoidUndulation(global.SkyGeoid, 90, 0), 13.6, 0.1, 'polo Nord');
    near(C.geoidUndulation(global.SkyGeoid, -90, 0), -29.5, 0.1, 'polo Sud');
});

// Fix simulati: rumore deterministico
const noise = i => Math.sin(i * 12.9898) * 0.5 + Math.sin(i * 78.233) * 0.5;   // ~[-1, 1]
function fixes(lat, lon, hEll, k, opts) {
    const o = Object.assign({ hAcc: 4, vAcc: 6, every: 1000 }, opts);
    return Array.from({ length: k }, (_, i) => ({ lat: lat + noise(i) * 2e-5, lon: lon + noise(i + 7) * 2e-5, alt: hEll + noise(i + 3) * 5,
        hAcc: o.hAcc, vAcc: o.vAcc, t: 1e12 + i * o.every, ageMs: 100, satsUsed: 28, satsVisible: 41, satsL5: 9 }));
}

ok('media delle coordinate: pesata, robusta ai fix pessimi', () => {
    const fx = fixes(37.882734, 13.377292, 700, 30);
    fx.push({ lat: 37.9, lon: 13.4, hAcc: 150, t: 1e12 + 31000, ageMs: 10 });   // fix pessimo: scartato
    const p = C.averagePosition(fx);
    near(p.lat, 37.882734, 2e-5); near(p.lon, 13.377292, 2e-5);
    assert.strictEqual(p.n, 30);
    assert.ok(p.sigma < 4 && p.sigma >= 2, 'precisione media ' + p.sigma);
});

ok('quota GPS: ellissoide - geoide (browser) oppure quota nativa s.l.m. (Android 14+)', () => {
    const N = C.geoidUndulation(global.SkyGeoid, 37.8827, 13.3773);
    const g = C.gpsAltitude(fixes(37.8827, 13.3773, 660 + N, 30), N);
    near(g.h, 660, 2, 'quota s.l.m.');
    assert.ok(!g.nativeMsl && g.sigma > 3 && g.sigma < 6, 'σ ' + g.sigma);
    const nat = fixes(37.8827, 13.3773, 999, 60).map((f, i) => Object.assign(f, { msl: 660 + noise(i) * 4, mslAcc: 0.6 }));
    const g2 = C.gpsAltitude(nat, null);
    near(g2.h, 660, 1.5);
    assert.ok(g2.nativeMsl && g2.satsL5 === 9);
    assert.strictEqual(C.gpsAltitude(fixes(1, 1, 100, 5).map(f => Object.assign(f, { alt: undefined })), 40), null, 'senza quota: niente stima');
});

ok('media pesata: il metodo più preciso pesa di più; margine allargato se non concordano', () => {
    const r = C.combine([{ id: 'a', h: 660, sigma: 3 }, { id: 'b', h: 668, sigma: 9 }]);
    near(r.h, 660.8, 0.1); near(r.sigma, 2.85, 0.05);
    near(r.weights.find(w => w.id === 'a').w, 0.9, 0.001);
    assert.strictEqual(r.agreement, 'buono');
    const bad = C.combine([{ id: 'a', h: 600, sigma: 3 }, { id: 'b', h: 660, sigma: 3 }]);
    assert.ok(bad.inflation > 5 && bad.sigma > 15 && bad.agreement === 'scarso', JSON.stringify(bad));
    assert.strictEqual(C.combine([]), null);
});

ok('barometro con più QNH: l\'errore del sensore conta una sola volta', () => {
    const pr = { p: C.pressureAt(660, 1016), sigmaMean: 0.02 };
    const a = C.baroEstimate(pr, { qnh: 1016, sigma: 0.4, refElev: 0, topTempC: 15 - 0.0065 * 660 }, 1.0);
    const b = C.baroEstimate(pr, { qnh: 1016.6, sigma: 0.8, refElev: 0, topTempC: 15 - 0.0065 * 660 }, 1.0);
    near(a.h, 660, 1);
    const c = C.combineBaro([a, b]);
    assert.ok(c.sigma >= a.sensorPart && c.sigma < Math.min(a.sigma, b.sigma) + 0.01, 'σ combinata ' + c.sigma);
    near(a.sensorPart, 8.9, 0.2, '±1 hPa ≈ ±8,9 m a 660 m');
});

ok('METAR più vicino e incertezza del QNH', () => {
    const now = 1.8e12;
    const list = [{ icao: 'LICJ', lat: 38.18, lon: 13.10, elev: 21, altim: 1017, temp: 19, obsTime: now / 1000 - 1200 },
                  { icao: 'LICT', lat: 37.91, lon: 12.49, elev: 7, altim: 1018, temp: 20, obsTime: now / 1000 - 600 },
                  { icao: 'OLD', lat: 37.9, lon: 13.38, elev: 0, altim: 1000, obsTime: now / 1000 - 5 * 3600 }];
    const r = C.nearestMetar(list, 37.8827, 13.3773, now);
    assert.deepStrictEqual(r.map(m => m.icao), ['LICJ', 'LICT'], 'il METAR vecchio è escluso');
    near(r[0].distKm, 40.5, 1.5);
    near(C.metarQnhSigma(r[0]), Math.hypot(0.35, 0.5 / 3, 0.405), 0.01);
});

ok('mappa QNH degli snapshot: interpolazione nello spazio e nel tempo', () => {
    const n = 3, times = [0, 3600000, 7200000].map(t => 1.8e12 + t);
    const g = { fetchedAt: times[0], lat0: 37, lon0: 13, dLat: 0.5, dLon: 0.5, n, times, p: [], t: [], elev: [] };
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        g.p.push(times.map((_, k) => 1010 + i + 2 * j + 0.5 * k)); g.t.push(times.map(() => 20 - i)); g.elev.push(100 * i);
    }
    const v = C.interpolateQnhGrid(g, 37.25, 13.75, times[0] + 5400000);   // i=0.5, j=1.5, k=1.5
    near(v.qnh, 1010 + 0.5 + 3 + 0.75, 1e-9);
    near(v.temp, 19.5, 1e-9); near(v.elev, 50, 1e-9);
    near(v.outsideKm, 0, 1e-6);
    assert.ok(v.sigma > 0.8 && v.sigma < 0.9);
    assert.ok(C.interpolateQnhGrid(g, 38.5, 13.5, times[0]).outsideKm > 50, 'fuori dalla griglia: distanza segnalata');
    assert.strictEqual(C.interpolateQnhGrid(g, 37.2, 13.2, times[0] + 10 * 3600000), null, 'oltre la previsione: niente valore');
});

ok('simulazione: Ficuzza a 660 m, GPS + barometro (METAR e modello) + terreno', () => {
    const N = C.geoidUndulation(global.SkyGeoid, 37.8827, 13.3773);
    const g = C.gpsAltitude(fixes(37.8827, 13.3773, 663 + N, 30), N);   // GPS 3 m in alto
    const pr = { p: C.pressureAt(660, 1016.2) + 0.4, sigmaMean: 0.02 };  // barometro con +0,4 hPa di errore
    const t = 15 - 0.0065 * 660;
    const baro = C.combineBaro([C.baroEstimate(pr, { qnh: 1016, sigma: 0.45, refElev: 21, refTempC: 15 - 0.0065 * 21 }, 1),
                                C.baroEstimate(pr, { qnh: 1016.3, sigma: 0.8, refElev: 0, topTempC: t }, 1)]);
    const r = C.combine([{ id: 'gps', h: g.h, sigma: g.sigma }, { id: 'baro', h: baro.h, sigma: baro.sigma }, { id: 'dem', h: 657, sigma: 5.5 }]);
    assert.ok(Math.abs(r.h - 660) < r.sigma * 1.5 && r.sigma < 5, `${r.h.toFixed(1)} ± ${r.sigma.toFixed(1)}`);
    assert.ok(r.agreement === 'buono', r.agreement);
});

ok('formati delle coordinate', () => {
    assert.strictEqual(C.dms(38.1157, 'N', 'S'), '38° 06′ 56.52″ N');
    assert.strictEqual(C.dms(-13.3615, 'E', 'O'), '13° 21′ 41.40″ O');
    assert.strictEqual(C.dms(37.99999999, 'N', 'S'), '38° 00′ 00.00″ N');
    assert.strictEqual(C.fmtCoordsDec(37.8827341, 13.3772919), '37.882734, 13.377292');
    assert.strictEqual(C.roundSigma(0.4), 1); assert.strictEqual(C.roundSigma(4.2), 5); assert.strictEqual(C.roundSigma(10.1), 12);
});

console.log(`\n${n} test superati`);
