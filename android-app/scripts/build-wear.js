const fs = require('fs');
const path = require('path');

const androidRoot = path.resolve(__dirname, '..', 'android');
const appAssets = path.join(androidRoot, 'app', 'src', 'main', 'assets');
const wearAssets = path.join(androidRoot, 'wear', 'src', 'main', 'assets');
const appIndex = path.join(appAssets, 'public', 'index.html');
const wearConfig = path.join(wearAssets, 'capacitor.config.json');

function replaceOnce(html, from, to) {
  const first = html.indexOf(from);
  if (first === -1 || html.indexOf(from, first + from.length) !== -1) {
    throw new Error(`Sorgente Wear OS inatteso: attesa una sola occorrenza di ${from}`);
  }
  return html.slice(0, first) + to + html.slice(first + from.length);
}

if (!fs.existsSync(appIndex) || !fs.existsSync(path.join(appAssets, 'capacitor.config.json'))) {
  throw new Error('Asset Capacitor assenti: eseguire prima npx cap sync android.');
}

fs.cpSync(appAssets, wearAssets, { recursive: true, force: true });

let html = fs.readFileSync(appIndex, 'utf8');
html = replaceOnce(html, '<html lang="it" class="dark">', '<html lang="it" class="dark wear-app">');
html = replaceOnce(
  html,
  '<details id="sectionOpenMeteo" class="',
  '<details id="sectionOpenMeteo" open class="'
);
html = replaceOnce(
  html,
  '<details id="sectionSoleLuna" class="',
  '<details id="sectionSoleLuna" open class="'
);
fs.writeFileSync(path.join(wearAssets, 'public', 'index.html'), html);

const config = JSON.parse(fs.readFileSync(wearConfig, 'utf8'));
config.appId = 'it.skyguardian.wear';
fs.writeFileSync(wearConfig, `${JSON.stringify(config, null, 2)}\n`);
console.log('Asset Wear OS generati con Open-Meteo e Sole e Luna aperti; snapshot Capacitor condivisi.');
