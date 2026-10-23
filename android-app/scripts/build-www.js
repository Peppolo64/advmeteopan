const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '..');
const sourcePath = path.join(repoRoot, 'index.html');
const outputPath = path.join(appRoot, 'www', 'index.html');

function replaceOnce(html, from, to) {
  const first = html.indexOf(from);
  if (first === -1 || html.indexOf(from, first + from.length) !== -1) {
    throw new Error(`Sorgente HTML inatteso: attesa una sola occorrenza di ${from}`);
  }
  return html.slice(0, first) + to + html.slice(first + from.length);
}

let html = fs.readFileSync(sourcePath, 'utf8');
const replacements = [
  [
    '<script src="https://cdn.tailwindcss.com"></script>',
    '<link rel="stylesheet" href="vendor/tailwind.css">',
  ],
  [
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/suncalc/1.9.0/suncalc.min.js"></script>',
    '<script src="vendor/suncalc.js"></script>',
  ],
  [
    '<script src="https://cdn.jsdelivr.net/npm/satellite.js@5.0.0/dist/satellite.min.js"></script>',
    '<script src="vendor/satellite.min.js"></script>',
  ],
  [
    '<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="">',
    '<link rel="stylesheet" href="vendor/leaflet/leaflet.css">',
  ],
  [
    '<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>',
    '<script src="vendor/leaflet/leaflet.js"></script>',
  ],
];

for (const [from, to] of replacements) html = replaceOnce(html, from, to);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, html);
for (const name of ['snapshot.js', 'tilestore.js']) {
  fs.copyFileSync(path.join(repoRoot, name), path.join(appRoot, 'www', name));
}
console.log('www/index.html generato da index.html; supporto snapshot copiato.');
