// Test dei calcoli della Mappa Stellare (nessun DOM, nessun Three.js)
process.env.TZ = 'Europe/Rome';
const assert = require('assert');
const path = require('path');
const SunCalc = require('suncalc');
const www = path.join(__dirname, '..', 'www');
global.window = global;
require(path.join(www, 'ephemeris.js'));
const { astro: M } = require(path.join(www, 'starmap.js'));
require(path.join(www, 'skydata.js'));
const DATA = global.SkyStarData;
const E = global.SkyEphemeris.astro;

let n = 0;
function ok(name, fn) { fn(); n++; console.log('ok -', name); }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} atteso ${b} ± ${tol}, ottenuto ${a}`);
const PALERMO = { lat: 38.1157, lon: 13.3615 };

ok('catalogo stellare: ~41.000 stelle fino a mag 8, ordinate per magnitudine', () => {
    const S = M.decodeStars(DATA);
    assert.ok(S.n > 40000 && S.n < 45000, 'numero stelle ' + S.n);
    for (let i = 1; i < S.n; i++) assert.ok(S.mag[i] >= S.mag[i - 1], 'ordinate');
    assert.ok(S.mag[S.n - 1] <= 8.0);
    assert.strictEqual(S.names[0].it, 'Sirio');
    near(S.mag[0], -1.44, 0.05, 'magnitudine di Sirio');
    near(S.ly[0], 8.6, 0.3, 'distanza di Sirio (anni luce)');
    const vega = Object.keys(S.names).find(k => S.names[k].n === 'Vega');
    near(S.ly[vega], 25, 1, 'distanza di Vega');
    assert.strictEqual(DATA.constellations[S.con[vega]].it, 'Lira');
    assert.ok(/^A0/.test(S.spect[vega]), 'Vega è di tipo A0: ' + S.spect[vega]);
    for (let i = 0; i < S.n; i += 997) near(Math.hypot(S.vec[i * 3], S.vec[i * 3 + 1], S.vec[i * 3 + 2]), 1, 1e-6, 'vettore unitario');
});

ok('costellazioni, Messier, Via Lattea e pianeti presenti nei dati', () => {
    assert.strictEqual(DATA.constellations.length, 89);   // 88 + Serpens divisa in due parti
    assert.ok(DATA.constellations.find(c => c.id === 'UMa').it === 'Orsa Maggiore');
    assert.ok(DATA.constellations.every(c => c.lines.length > 0), 'ogni costellazione ha la sua figura');
    assert.strictEqual(DATA.messier.length, 110);
    assert.ok(DATA.mw.length / 3 > 5000, 'punti della Via Lattea');
    assert.deepStrictEqual(DATA.planets.map(p => p.id), ['mer', 'ven', 'ter', 'mar', 'jup', 'sat', 'ura', 'nep']);
});

ok('precessione: identità al 2000, la Polare sale di ~0,11° di declinazione fino al 2026', () => {
    const P0 = M.precessionMatrix(Date.UTC(2000, 0, 1, 12));
    [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => near(P0[i], v, 1e-6));
    const P = M.precessionMatrix(Date.UTC(2026, 10, 5));
    const RPt = M.mul3(P, M.transpose3(P));
    [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => near(RPt[i], v, 1e-12, 'ortogonale'));
    const pol = M.vecToEq(M.apply3(P, M.eqVec(37.95456, 89.26411)));
    near(pol.dec, 89.378, 0.02, 'declinazione della Polare nel 2026');
});

ok('catena completa pianeti -> precessione -> orizzonte: il Sole coincide con SunCalc', () => {
    for (const ms of [Date.UTC(2026, 10, 5, 8), Date.UTC(2026, 5, 21, 17, 30), Date.UTC(2027, 2, 1, 7)]) {
        const sunJ2000 = M.eqVec(M.sunGeo(DATA.planets, ms).ra, M.sunGeo(DATA.planets, ms).dec);
        const h = M.apply3(M.j2000ToHorMatrix(ms, PALERMO.lat, PALERMO.lon), sunJ2000);
        const hor = E.vecToHor(...h);
        const s = E.sunAltAz(SunCalc, ms, PALERMO.lat, PALERMO.lon);
        // SunCalc include la rifrazione (fino a ~0,2° vicino all'orizzonte) e usa un tempo siderale semplificato
        near(hor.alt, s.alt, 0.35, 'altezza ' + new Date(ms).toISOString());
        near(((hor.az - s.az + 540) % 360) - 180, 0, 0.8, 'azimut ' + new Date(ms).toISOString());
    }
});

ok('geometria dei pianeti: opposizioni e congiunzioni reali', () => {
    const elong = (id, y, m, d) => M.planetGeo(DATA.planets, id, Date.UTC(y, m - 1, d, 12));
    assert.ok(elong('jup', 2026, 1, 10).elong > 176, 'Giove in opposizione il 10/1/2026');
    near(elong('jup', 2026, 1, 10).mag, -2.7, 0.3, 'magnitudine di Giove all\'opposizione');
    assert.ok(elong('sat', 2026, 10, 4).elong > 176, 'Saturno in opposizione il 4/10/2026');
    assert.ok(elong('mar', 2027, 2, 19).elong > 172, 'Marte in opposizione il 19/2/2027');
    near(elong('mar', 2027, 2, 19).mag, -1.2, 0.4, 'magnitudine di Marte all\'opposizione');
    const v = elong('ven', 2026, 10, 24);
    assert.ok(v.elong < 9 && v.dist < 0.3, `Venere in congiunzione inferiore il 24/10/2026 (elong ${v.elong.toFixed(1)}°, ${v.dist.toFixed(2)} UA)`);
    // Mercurio e Venere non si allontanano mai troppo dal Sole
    for (let d = 0; d < 365; d += 5) {
        const t = Date.UTC(2026, 0, 1) + d * 86400000;
        assert.ok(M.planetGeo(DATA.planets, 'mer', t).elong < 28.5, 'Mercurio entro 28°');
        assert.ok(M.planetGeo(DATA.planets, 'ven', t).elong < 47.5, 'Venere entro 47°');
    }
});

ok('magnitudine limite: notte, crepuscolo, giorno e zoom', () => {
    near(M.limitingMagnitude(60, -30, true), 6.2, 0.01, 'notte, campo 60°');
    assert.ok(M.limitingMagnitude(10, -30, true) > 7.5, 'zoom: stelle più deboli');
    assert.strictEqual(M.limitingMagnitude(60, 20, true), -1.5, 'di giorno solo gli astri più brillanti');
    const tw = M.limitingMagnitude(60, -9, true);
    assert.ok(tw > 1 && tw < 4.5, 'crepuscolo nautico intermedio: ' + tw);
    near(M.limitingMagnitude(60, 20, false), 6.2, 0.01, 'senza atmosfera il giorno non conta');
});

ok('colori, classi spettrali, ricerca e formattazioni', () => {
    assert.strictEqual(M.colorName(-0.23), 'azzurra'); assert.strictEqual(M.colorName(0.0), 'bianco-azzurra'); assert.strictEqual(M.colorName(0.65), 'gialla'); assert.strictEqual(M.colorName(1.8), 'rossa');
    assert.strictEqual(M.spectDescription('A0Va'), 'stella bianca, sequenza principale');
    assert.strictEqual(M.spectDescription('M1-M2Ia-Iab'), 'stella rossa, supergigante');
    assert.strictEqual(M.spectDescription('K1.5IIIFe-0.5'), 'stella arancione, gigante');
    assert.strictEqual(M.spectDescription('G2V'), 'stella gialla (come il Sole), sequenza principale');
    assert.strictEqual(M.spectDescription('F7:Ib-IIv SB'), 'stella bianco-gialla, supergigante');   // la Polare
    assert.strictEqual(M.spectDescription('F5IV-V'), 'stella bianco-gialla, subgigante');
    assert.strictEqual(M.spectDescription('B8Ia'), 'stella blu-bianca calda, supergigante');
    assert.strictEqual(M.normalize('  Orsa   Maggióre '), 'orsa maggiore');
    assert.strictEqual(M.formatRa(279.2347), '18h 36m 56s');
    assert.strictEqual(M.formatDec(38.7837), '+38° 47′');
    assert.strictEqual(M.formatDec(-16.716), '−16° 43′');
});

console.log(`\n${n} test superati`);
