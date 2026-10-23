// Copia le librerie JS/CSS da node_modules a www/vendor (niente più CDN: l'app funziona offline).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const nm = path.join(root, 'node_modules');
const out = path.join(root, 'www', 'vendor');

function firstExisting(candidates) {
  for (const c of candidates) {
    const p = path.join(nm, c);
    if (fs.existsSync(p)) return p;
  }
  throw new Error('File non trovato in node_modules: ' + candidates.join(' | ') + ' (hai eseguito "npm install"?)');
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'leaflet'), { recursive: true });

fs.copyFileSync(firstExisting(['suncalc/suncalc.js']), path.join(out, 'suncalc.js'));
fs.copyFileSync(firstExisting(['satellite.js/dist/satellite.min.js', 'satellite.js/dist/satellite.js']), path.join(out, 'satellite.min.js'));
fs.copyFileSync(firstExisting(['leaflet/dist/leaflet.js']), path.join(out, 'leaflet', 'leaflet.js'));
fs.copyFileSync(firstExisting(['leaflet/dist/leaflet.css']), path.join(out, 'leaflet', 'leaflet.css'));
fs.cpSync(firstExisting(['leaflet/dist/images']), path.join(out, 'leaflet', 'images'), { recursive: true });

console.log('Librerie copiate in www/vendor');
