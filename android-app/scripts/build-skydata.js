// Genera ../skydata.js (dati della Mappa Stellare) da:
//  - HYG Database v4.1 (CC BY-SA 4.0, https://github.com/astronexus/HYG-Database): stelle fino a mag 8
//  - d3-celestial (BSD-3-Clause, https://github.com/ofrohn/d3-celestial): costellazioni, confini, Via Lattea, Messier
//
// Uso: node scripts/build-skydata.js <hygdata_v41.csv> <cartella data di d3-celestial>
// Il file prodotto è un normale script che definisce window.SkyStarData (caricato solo all'apertura del pannello).
const fs = require('fs');
const path = require('path');

const [hygPath, d3Dir] = process.argv.slice(2);
if (!hygPath || !d3Dir) {
  console.error('Uso: node scripts/build-skydata.js <hygdata_v41.csv> <d3-celestial/data>');
  process.exit(1);
}
const OUT = path.resolve(__dirname, '..', '..', 'skydata.js');
const MAG_LIMIT = 8.0;

// ---------------------------------------------------------------- CSV
function parseCsvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const GREEK = { Alp: 'α', Bet: 'β', Gam: 'γ', Del: 'δ', Eps: 'ε', Zet: 'ζ', Eta: 'η', The: 'θ', Iot: 'ι', Kap: 'κ', Lam: 'λ',
  Mu: 'μ', Nu: 'ν', Xi: 'ξ', Omi: 'ο', Pi: 'π', Rho: 'ρ', Sig: 'σ', Tau: 'τ', Ups: 'υ', Phi: 'φ', Chi: 'χ', Psi: 'ψ', Ome: 'ω' };
function bayerToGreek(b) {
  if (!b) return '';
  const m = /^([A-Za-z]+)(?:-?(\d+))?$/.exec(b);
  if (!m || !GREEK[m[1]]) return b;
  const sup = m[2] ? String(m[2]).replace(/\d/g, d => '⁰¹²³⁴⁵⁶⁷⁸⁹'[d]) : '';
  return GREEK[m[1]] + sup;
}

// Nomi italiani curati (dove l'uso italiano differisce dal nome IAU)
const IT_STAR_NAMES = {
  Sirius: 'Sirio', Canopus: 'Canopo', Arcturus: 'Arturo', Procyon: 'Procione', Castor: 'Castore', Pollux: 'Polluce',
  Regulus: 'Regolo', Polaris: 'Polare', Alcyone: 'Alcione', Electra: 'Elettra', Atlas: 'Atlante', Taygeta: 'Taigeta',
  Celaeno: 'Celeno', 'Rigil Kentaurus': 'Alfa Centauri', 'Kaus Australis': 'Kaus Australe', 'Kaus Borealis': 'Kaus Boreale', 'Kaus Media': 'Kaus Medio',
};

// ---------------------------------------------------------------- Stelle (HYG)
const lines = fs.readFileSync(hygPath, 'utf8').split(/\r?\n/);
const head = parseCsvLine(lines[0]);
const col = Object.fromEntries(head.map((h, i) => [h, i]));
const stars = [];
for (let i = 1; i < lines.length; i++) {
  if (!lines[i]) continue;
  const r = parseCsvLine(lines[i]);
  const id = r[col.id];
  if (id === '0') continue;                       // il Sole
  const mag = parseFloat(r[col.mag]);
  if (!(mag <= MAG_LIMIT)) continue;
  const ra = parseFloat(r[col.ra]) * 15, dec = parseFloat(r[col.dec]);
  if (!isFinite(ra) || !isFinite(dec)) continue;
  const dist = parseFloat(r[col.dist]);           // parsec; 100000 = sconosciuta
  stars.push({
    ra, dec, mag,
    bv: isFinite(parseFloat(r[col.ci])) ? parseFloat(r[col.ci]) : 0.6,
    hip: parseInt(r[col.hip], 10) || 0,
    hd: parseInt(r[col.hd], 10) || 0,
    ly: (isFinite(dist) && dist > 0 && dist < 99999) ? dist * 3.26156 : 0,
    sp: (r[col.spect] || '').trim().slice(0, 12),
    proper: (r[col.proper] || '').trim(),
    bayer: bayerToGreek((r[col.bayer] || '').trim()),
    bayerRaw: (r[col.bayer] || '').trim(),
    flam: (r[col.flam] || '').trim(),
    con: (r[col.con] || '').trim(),
    v: (r[col.var] || '').trim(),
  });
}
stars.sort((a, b) => a.mag - b.mag);

// ---------------------------------------------------------------- Costellazioni (d3-celestial)
const readJson = f => JSON.parse(fs.readFileSync(path.join(d3Dir, f), 'utf8'));
const lon2ra = lon => ((lon % 360) + 360) % 360;
const r3 = x => Math.round(x * 1000) / 1000;
const clean = s => String(s || '').replace(/[ -‏ ]/g, ' ').replace(/\s+/g, ' ').trim();

const consMeta = readJson('constellations.json').features;
const consLines = Object.fromEntries(readJson('constellations.lines.json').features.map(f => [f.id, f.geometry.coordinates]));
const CON_IDS = consMeta.map(f => f.id);
const constellations = consMeta.map(f => ({
  id: f.id,
  it: clean(f.properties.it || f.properties.name),
  la: clean(f.properties.la || f.properties.name),
  gen: clean(f.properties.gen),
  rank: +f.properties.rank || 3,
  ra: r3(lon2ra(f.geometry.coordinates[0])), dec: r3(f.geometry.coordinates[1]),
  lines: (consLines[f.id] || []).map(seg => seg.map(([lon, lat]) => [r3(lon2ra(lon)), r3(lat)])),
}));
const conIndex = Object.fromEntries(CON_IDS.map((id, i) => [id, i]));

const borders = readJson('constellations.borders.json').features
  .flatMap(f => f.geometry.coordinates.map(seg => seg.map(([lon, lat]) => [r3(lon2ra(lon)), r3(lat)])));

// ---------------------------------------------------------------- Via Lattea: rasterizzata in punti (livello 1-5)
const mwFeatures = readJson('mw.json').features;
function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inFeature(lon, lat, f) {
  let inside = false;
  for (const poly of f.geometry.coordinates) for (const ring of poly) if (inRing(lon, lat, ring)) inside = !inside;
  return inside;
}
const mw = [];
const STEP = 0.8;
for (let dec = -90 + STEP / 2; dec < 90; dec += STEP) {
  const dRa = STEP / Math.max(0.05, Math.cos(dec * Math.PI / 180));
  for (let ra = 0; ra < 360; ra += dRa) {
    const lon = ra > 180 ? ra - 360 : ra;
    let level = 0;
    for (const f of mwFeatures) if (inFeature(lon, dec, f)) level++;
    if (level) mw.push(Math.round(ra * 10), Math.round(dec * 10), level);
  }
}

// ---------------------------------------------------------------- Messier
const IT_MESSIER = {
  M1: 'Nebulosa del Granchio', M6: 'Ammasso della Farfalla', M7: 'Ammasso di Tolomeo', M8: 'Nebulosa Laguna',
  M11: 'Ammasso dell\'Anatra Selvatica', M13: 'Grande Ammasso di Ercole', M16: 'Nebulosa Aquila', M17: 'Nebulosa Omega',
  M20: 'Nebulosa Trifida', M24: 'Nube stellare del Sagittario', M27: 'Nebulosa Manubrio', M31: 'Galassia di Andromeda',
  M33: 'Galassia del Triangolo', M42: 'Nebulosa di Orione', M44: 'Presepe', M45: 'Pleiadi', M51: 'Galassia Vortice',
  M57: 'Nebulosa Anello', M63: 'Galassia Girasole', M64: 'Galassia Occhio Nero', M73: 'Asterismo di 4 stelle',
  M76: 'Piccola Nebulosa Manubrio', M77: 'Cetus A', M81: 'Galassia di Bode', M82: 'Galassia Sigaro',
  M83: 'Galassia Girandola del Sud', M87: 'Virgo A', M94: 'Galassia Occhio di Gatto', M97: 'Nebulosa Civetta',
  M101: 'Galassia Girandola', M102: 'Galassia Fuso', M104: 'Galassia Sombrero',
};
const messier = readJson('messier.json').features.map(f => ({
  id: f.id, ngc: clean(f.properties.desig), it: IT_MESSIER[f.id] || '', type: f.properties.type,
  mag: f.properties.mag === '' ? null : +f.properties.mag, dim: clean(f.properties.dim),
  ra: r3(lon2ra(f.geometry.coordinates[0])), dec: r3(f.geometry.coordinates[1]),
}));

// ---------------------------------------------------------------- Pianeti: elementi kepleriani JPL (1800-2050) da d3-celestial
const planetsSrc = readJson('planets.json');
const IT_PLANETS = { mer: 'Mercurio', ven: 'Venere', ter: 'Terra', mar: 'Marte', jup: 'Giove', sat: 'Saturno', ura: 'Urano', nep: 'Nettuno' };
const planets = Object.keys(IT_PLANETS).map(id => {
  const e = planetsSrc[id].elements[0];
  return { id, it: IT_PLANETS[id], sym: planetsSrc[id].sym, el: [e.a, e.e, e.i, e.L, e.W, e.N], rate: [e.da, e.de, e.di, e.dL, e.dW, e.dN] };
});

// ---------------------------------------------------------------- Codifica compatta
const n = stars.length;
const b64 = arr => Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');
const ra = new Float32Array(n), dec = new Float32Array(n), mag = new Int16Array(n), bv = new Int16Array(n);
const hip = new Uint32Array(n), hd = new Uint32Array(n), ly = new Uint16Array(n), con = new Uint8Array(n);
const spect = [], names = {};
stars.forEach((s, i) => {
  ra[i] = s.ra; dec[i] = s.dec; mag[i] = Math.round(s.mag * 100); bv[i] = Math.round(s.bv * 1000);
  // distanza: decimi di anno luce sotto i 1000 al, poi 10000 + decine di anni luce
  hip[i] = s.hip; hd[i] = s.hd;
  ly[i] = !s.ly ? 0 : s.ly < 999.9 ? Math.max(1, Math.round(s.ly * 10)) : Math.min(65535, 10000 + Math.round(s.ly / 10)); con[i] = s.con in conIndex ? conIndex[s.con] : 255;
  spect.push(s.sp.replace(/\|/g, ''));
  if (s.proper || s.bayer || s.flam || s.v) {
    const e = {};
    if (s.proper) e.n = s.proper;
    if (s.proper && IT_STAR_NAMES[s.proper]) e.it = IT_STAR_NAMES[s.proper];
    if (s.bayer) e.b = s.bayer;
    if (s.flam) e.f = s.flam;
    if (s.v && s.v !== s.bayerRaw && !/^[A-Z][a-z]{1,2}(\d)?$/.test(s.v) && s.v !== s.flam) e.v = s.v;   // niente doppioni della sigla Bayer
    names[i] = e;
  }
});

const data = {
  version: 1,
  magLimit: MAG_LIMIT,
  credits: 'Stelle: HYG Database v4.1 (CC BY-SA 4.0, D. Nash / astronexus). Costellazioni, Via Lattea e Messier: d3-celestial (BSD-3-Clause, O. Frohn).',
  stars: { n, ra: b64(ra), dec: b64(dec), mag: b64(mag), bv: b64(bv), hip: b64(hip), hd: b64(hd), ly: b64(ly), con: b64(con), spect: spect.join('|'), names },
  constellations, borders, mw, messier, planets,
};
const js = `/* SkyGuardian - dati della Mappa Stellare (generato da android-app/scripts/build-skydata.js: non modificare a mano).\n * ${data.credits}\n * Questo file di dati è distribuito con licenza CC BY-SA 4.0. */\nwindow.SkyStarData = ${JSON.stringify(data)};\n`;
fs.writeFileSync(OUT, js);
console.log(`skydata.js: ${n} stelle, ${Object.keys(names).length} con nome/sigla, ${constellations.length} costellazioni, ${borders.length} confini, ${mw.length / 3} punti Via Lattea, ${messier.length} Messier, ${(js.length / 1024).toFixed(0)} KB`);
