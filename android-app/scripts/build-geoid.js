// Genera ../geoid.js: ondulazione del geoide EGM96 (N, metri) per convertire la quota GPS del browser
// (sopra l'ellissoide WGS84) in quota sul livello del mare.
// Fonte: griglia EGM96 15' dell'NGA (WW15MGH), letta come dati dal pacchetto egm96-universal (MIT):
// il codice del pacchetto non viene eseguito, si estrae solo la stringa base64 della griglia.
//
// Uso: node scripts/build-geoid.js <egm96-universal/dist/egm96-universal.cjs.js>
const fs = require('fs');
const path = require('path');

const src = process.argv[2];
if (!src) { console.error('Uso: node scripts/build-geoid.js <egm96-universal.cjs.js>'); process.exit(1); }
const m = /var data = "([A-Za-z0-9+/=]+)"/.exec(fs.readFileSync(src, 'utf8'));
if (!m) throw new Error('Griglia EGM96 non trovata nel file');
const raw = Buffer.from(m[1], 'base64');
const ROWS = 721, COLS = 1440, STEP = 0.25;            // da +90 a -90 di latitudine, da 0 a 359,75 di longitudine
if (raw.length < ROWS * COLS * 2) throw new Error('Griglia EGM96 incompleta: ' + raw.length + ' byte');
const at = (r, c) => raw.readInt16BE((r * COLS + ((c % COLS) + COLS) % COLS) * 2) / 100;   // metri

function undulation(lat, lon) {
  const y = (90 - lat) / STEP, x = (((lon % 360) + 360) % 360) / STEP;
  const r0 = Math.min(ROWS - 2, Math.floor(y)), c0 = Math.floor(x);
  const fy = y - r0, fx = x - c0;
  const top = at(r0, c0) * (1 - fx) + at(r0, c0 + 1) * fx;
  const bot = at(r0 + 1, c0) * (1 - fx) + at(r0 + 1, c0 + 1) * fx;
  return top * (1 - fy) + bot * fy;
}

// Griglie in decimetri (Int16): globale a 2° e area Europa-Mediterraneo a 0,25° (risoluzione nativa)
function grid(lat0, lat1, lon0, lon1, step) {
  const nlat = Math.round((lat1 - lat0) / step) + 1, nlon = Math.round((lon1 - lon0) / step) + 1;
  const data = new Int16Array(nlat * nlon);
  for (let i = 0; i < nlat; i++) for (let j = 0; j < nlon; j++) data[i * nlon + j] = Math.round(undulation(lat0 + i * step, lon0 + j * step) * 10);
  return { lat0, lon0, step, nlat, nlon, dm: Buffer.from(data.buffer).toString('base64') };
}
const out = {
  model: 'EGM96 (NGA): ondulazione N del geoide in decimetri, little-endian',
  global: grid(-90, 90, -180, 180, 2),
  regional: grid(30, 60, -15, 45, 0.25),
};
const OUT = path.resolve(__dirname, '..', '..', 'geoid.js');
const js = `/* SkyGuardian - geoide EGM96 per la quota GPS del browser (generato da android-app/scripts/build-geoid.js). */\nwindow.SkyGeoid = ${JSON.stringify(out)};\n`;
fs.writeFileSync(OUT, js);
console.log(`geoid.js: ${(js.length / 1024).toFixed(0)} KB; N(Palermo) = ${undulation(38.1157, 13.3615).toFixed(2)} m, N(Etna) = ${undulation(37.75, 15.0).toFixed(2)} m, N(Roma) = ${undulation(41.9, 12.5).toFixed(2)} m, N(0,0) = ${undulation(0, 0).toFixed(2)} m`);
