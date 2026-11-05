const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const repoRoot = path.resolve(root, '..');
const result = spawnSync(process.execPath, [path.join(__dirname, 'build-www.js')], { encoding: 'utf8' });
assert.strictEqual(result.status, 0, result.stderr || result.stdout);

const html = fs.readFileSync(path.join(root, 'www', 'index.html'), 'utf8');
for (const localPath of [
  'vendor/tailwind.css',
  'vendor/suncalc.js',
  'vendor/satellite.min.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/leaflet.js',
  'snapshot.js',
  'tilestore.js',
  'ephemeris.js',
  'vendor/three.min.js',
]) {
  assert(html.includes(localPath) || fs.existsSync(path.join(root, 'www', localPath)), `asset mancante: ${localPath}`);
}
assert(!html.includes('https://cdn.tailwindcss.com'), 'Tailwind deve essere locale nell’app');
assert(!html.includes('cdn.jsdelivr.net/npm/three@'), 'Three.js deve essere locale nell’app (offline)');
assert(html.includes('html:not(.native-app) #snapshotControls'), 'i controlli snapshot devono essere nascosti sul sito');
assert(html.includes('if (isNativeApp) initSnapshots();'), 'la manutenzione degli snapshot deve essere limitata all’app');

const bootstrap = html.match(/<script>\s*(const isNativeApp = [\s\S]*?)<\/script>/);
assert(bootstrap, 'rilevamento Capacitor mancante');
function hasNativeClass(capacitor) {
  const classes = [];
  vm.runInNewContext(bootstrap[1], {
    window: { Capacitor: capacitor },
    document: { documentElement: { classList: { add: (name) => classes.push(name) } } },
  });
  return classes.includes('native-app');
}
assert.strictEqual(hasNativeClass(undefined), false, 'il sito non deve attivare la modalità nativa');
assert.strictEqual(
  hasNativeClass({ isNativePlatform: () => true }),
  true,
  'Capacitor deve attivare la modalità nativa'
);
assert(
  bootstrap[1].includes('window.Capacitor.Plugins.OfflineWebCache'),
  'il plugin nativo deve essere ottenuto dal registro plugin del bridge Capacitor'
);
assert(
  !bootstrap[1].includes("window.Capacitor.registerPlugin('OfflineWebCache')"),
  'l’HTML statico non deve invocare registerPlugin non esposto dal bridge Android'
);
const nativeCachePluginProxy = { setSnapshotMode() {} };
const bootstrapPlugin = vm.runInNewContext(
  `${bootstrap[1]}; offlineWebCache;`,
  {
    window: {
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: { OfflineWebCache: nativeCachePluginProxy },
      },
    },
    document: { documentElement: { classList: { add() {} } } },
  }
);
assert.strictEqual(
  bootstrapPlugin,
  nativeCachePluginProxy,
  'il bootstrap Android deve rendere disponibile OfflineWebCache al codice snapshot'
);

const iframeLocationTracker = html.match(/function rememberSnapshotIframeLocation\(event\) \{[\s\S]*?\n        \}/);
assert(iframeLocationTracker, 'rilevamento URL corrente degli iframe mancante');
const trackedFrame = {
  contentWindow: {},
  dataset: {},
};
const trackedIframeLocation = 'https://meteo.example/previsioni/domani';
vm.runInNewContext(
  `${iframeLocationTracker[0]}; rememberSnapshotIframeLocation({ data: { type: 'skyguardian-frame-location', href: '${trackedIframeLocation}' }, source: frameWindow, origin: 'https://meteo.example' });`,
  { URL, frameWindow: trackedFrame.contentWindow, document: { querySelectorAll: () => [trackedFrame] } }
);
assert.strictEqual(
  trackedFrame.dataset.snapshotCurrentSrc,
  trackedIframeLocation,
  'il frame deve conservare l’URL della pagina cross-origin attualmente visualizzata'
);

const refreshFunction = html.match(/function refreshAllOpenSections\(\) \{[\s\S]*?\n        \}/);
assert(refreshFunction, 'aggiornamento delle sezioni aperte mancante');
const refreshedSections = [];
vm.runInNewContext(`${refreshFunction[0]}; refreshAllOpenSections();`, {
  isSectionOpen: () => true,
  loadedSections: {},
  handleSectionToggle: (sectionId) => refreshedSections.push(sectionId),
  handleSimulatoreToggle: () => refreshedSections.push('sectionSimulatore'),
});
assert(
  refreshedSections.includes('sectionSimulatore'),
  'Aggiorna deve aggiornare anche il simulatore sole/luna aperto'
);

const collectIframes = html.match(/function collectSnapshotIframes\(sectionId\) \{[\s\S]*?\n        \}/);
assert(collectIframes, 'cattura URL iframe per snapshot mancante');
const savedFrames = vm.runInNewContext(
  `${collectIframes[0]}; collectSnapshotIframes('sectionCommerciali');`,
  {
    URL,
    document: {
      baseURI: 'https://app.example/',
      getElementById: () => ({
        querySelectorAll: () => [
          {
            dataset: { snapshotCurrentSrc: 'https://meteo.example/previsioni/domani' },
            getAttribute: () => 'https://meteo.example/page',
          },
          { dataset: {}, getAttribute: () => 'about:blank' },
          { dataset: {}, getAttribute: () => '' },
          { dataset: {}, getAttribute: () => 'javascript:alert(1)' },
        ],
      }),
    },
  }
);
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(savedFrames)),
  [{ index: 0, src: 'https://meteo.example/previsioni/domani' }],
  'lo snapshot deve preferire l’URL corrente del frame al suo src iniziale e conservare solo URL HTTP(S)'
);

const snapshotFrameUrls = html.match(/function snapshotFrameUrls\(sections\) \{[\s\S]*?\n        \}/);
assert(snapshotFrameUrls, 'raccolta URL iframe per archivio snapshot mancante');
const frameUrls = vm.runInNewContext(
  `${snapshotFrameUrls[0]}; snapshotFrameUrls({ first: { frames: [{ src: 'https://meteo.example/page' }] }, second: { frames: [{ src: 'https://radar.example/map' }] } });`
);
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(frameUrls)),
  ['https://meteo.example/page', 'https://radar.example/map'],
  'il plugin deve ricevere gli URL iframe di tutte le sezioni catturate'
);

const applySnapshotIframes = html.match(/function applySnapshotIframes\(sectionId, snapshotSection\) \{[\s\S]*?\n        \}/);
assert(applySnapshotIframes, 'applicazione iframe durante la consultazione snapshot mancante');
const setIframeSrc = html.match(/function setIframeSrc\(frame, src\) \{[\s\S]*?\n        \}/);
assert(setIframeSrc, 'aggiornamento URL iframe deve invalidare il percorso precedentemente tracciato');
const frameClasses = new Set();
const iframe = {
  dataset: {},
  attributes: { src: 'https://meteo.example/page' },
  classList: {
    add: (name) => frameClasses.add(name),
    remove: (name) => frameClasses.delete(name),
  },
  getAttribute(name) { return this.attributes[name] || ''; },
  setAttribute(name, value) { this.attributes[name] = value; },
  after(node) { this.nextElementSibling = node; },
};
const placeholderClasses = new Set(['snap-ph']);
const placeholder = {
  classList: {
    contains: (name) => placeholderClasses.has(name),
    add: (name) => placeholderClasses.add(name),
    remove: (name) => placeholderClasses.delete(name),
  },
  innerHTML: '',
};
vm.runInNewContext(
  `${setIframeSrc[0]}; ${applySnapshotIframes[0]}; applySnapshotIframes('sectionCommerciali', { frames: [{ index: 0, src: 'https://meteo.example/page' }] });`,
  {
    URL,
    snapshotWebCacheAvailable: false,
    document: {
      getElementById: () => ({ querySelectorAll: () => [iframe] }),
      createElement: () => placeholder,
    },
  }
);
assert.strictEqual(iframe.attributes.src, 'about:blank', 'senza plugin iframe deve essere disabilitato evitando richieste live');
assert(frameClasses.has('hidden'), 'senza plugin l’iframe deve essere nascosto, non interrompere lo snapshot');
assert(placeholder.innerHTML.includes('non include il supporto'), 'il pannello iframe deve spiegare perché non è disponibile');

const nativeCachePlugin = fs.readFileSync(
  path.join(root, 'android', 'app', 'src', 'main', 'java', 'it', 'skyguardian', 'app', 'OfflineWebCachePlugin.java'),
  'utf8'
);
assert(nativeCachePlugin.includes('WebSettings.LOAD_CACHE_ONLY'), 'gli snapshot Android devono leggere solo dalla cache WebView');
assert(nativeCachePlugin.includes('WebSettings.LOAD_DEFAULT'), 'uscire dallo snapshot deve ripristinare la cache normale');
assert(nativeCachePlugin.includes('webView.clearCache(true)'), 'la pulizia dati deve poter svuotare la cache WebView');
assert(nativeCachePlugin.includes('beginSnapshotCapture'), 'il plugin deve esporre la cattura dell’archivio web');
assert(nativeCachePlugin.includes('getSnapshotFaults'), 'il plugin deve esporre i web cache fault');
const nativeArchive = fs.readFileSync(
  path.join(root, 'android', 'app', 'src', 'main', 'java', 'it', 'skyguardian', 'app', 'SnapshotWebArchive.java'),
  'utf8'
);
assert(nativeArchive.includes('snapshot-web'), 'le risposte web devono essere salvate nello storage privato dell’app');
assert(nativeArchive.includes('MAX_SNAPSHOT_BYTES'), 'l’archivio per snapshot deve avere un limite di spazio');
assert(nativeArchive.includes('risorsa non archiviata'), 'un cache miss deve essere registrato e segnalato');
assert(nativeArchive.includes('deleteRecursively(directory(id))'), 'la rimozione dello snapshot deve eliminare il suo archivio web');
assert(nativeCachePlugin.includes('archive.intercept(request)'), 'il client Capacitor deve intercettare richieste iframe per replay');
assert(nativeCachePlugin.includes('WebViewCompat.addDocumentStartJavaScript'), 'Android deve tracciare l’URL attuale nei frame cross-origin');
assert(nativeCachePlugin.includes('WebViewFeature.DOCUMENT_START_SCRIPT'), 'il tracciamento deve dipendere dal supporto WebView agli script document-start');
assert(html.includes('Web cache fault'), 'la UI deve mostrare un avviso quando una risorsa web non è archiviata');
assert(html.includes('beginSnapshotCapture({ snapshotId, urls })'), 'la cattura deve archiviare le pagine iframe aperte');
const apkWorkflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'build-apk.yml'), 'utf8');
assert(
  apkWorkflow.includes('run: ./android/gradlew -p android assembleDebug --no-daemon'),
  'il workflow APK deve richiamare il wrapper e indicare android/ come root Gradle'
);
assert(
  apkWorkflow.includes('run: ./android/gradlew -p android :wear:assembleDebug --no-daemon'),
  'il workflow APK deve compilare anche il modulo Wear OS'
);
assert(/^\s*push:\s*$/m.test(apkWorkflow), 'il workflow deve generare gli APK a ogni push, non solo su main');
assert(apkWorkflow.includes('name: SkyGuardian-Android-apk'), 'l’APK telefono deve essere pubblicato come artefatto separato');
assert(apkWorkflow.includes('name: SkyGuardian-WearOS-apk'), 'l’APK Wear OS deve essere pubblicato come artefatto separato');
assert(apkWorkflow.includes('android/app/build/outputs/apk/debug/app-debug.apk'), 'il workflow deve caricare l’APK telefono');
assert(apkWorkflow.includes('android/wear/build/outputs/apk/debug/wear-debug.apk'), 'il workflow deve caricare l’APK watch');
assert(apkWorkflow.includes('node scripts/build-wear.js'), 'il workflow deve generare gli asset Wear OS prima della build');
const wearManifest = fs.readFileSync(
  path.join(root, 'android', 'wear', 'src', 'main', 'AndroidManifest.xml'),
  'utf8'
);
assert(wearManifest.includes('android.hardware.type.watch'), 'il manifest Wear OS deve dichiarare il supporto watch');
assert(wearManifest.includes('android.permission.INTERNET'), 'l’app watch deve poter caricare dati meteo');
assert(wearManifest.includes('it.skyguardian.app.MainActivity'), 'Wear OS deve riusare l’attività Capacitor con gli snapshot offline');
assert(wearManifest.includes('android:allowBackup="false"'), 'i dati snapshot sul watch non devono essere inclusi nei backup');
const wearGradle = fs.readFileSync(path.join(root, 'android', 'wear', 'build.gradle'), 'utf8');
assert(wearGradle.includes("java.srcDirs += '../app/src/main/java'"), 'Wear OS deve riutilizzare i plugin nativi dell’app Android');
assert(
  html.includes('html.wear-app .max-w-7xl > #sectionCommerciali'),
  'la UI watch deve nascondere i pannelli non richiesti'
);
assert(html.includes('html.wear-app #snapshotControls'), 'gli snapshot devono avere un layout ottimizzato per il watch');
assert(html.includes('id="sectionOpenMeteo"'), 'la UI watch deve includere Open-Meteo');
assert(html.includes('id="sectionSoleLuna"'), 'la UI watch deve includere Sole e Luna');
const wearBuilder = fs.readFileSync(path.join(__dirname, 'build-wear.js'), 'utf8');
assert(
  wearBuilder.includes('wear-app')
    && wearBuilder.includes('sectionOpenMeteo')
    && wearBuilder.includes('sectionSoleLuna')
    && wearBuilder.includes('it.skyguardian.wear'),
  'il generatore deve attivare il layout watch senza cambiare l’APK Android'
);
const mainActivity = fs.readFileSync(
  path.join(root, 'android', 'app', 'src', 'main', 'java', 'it', 'skyguardian', 'app', 'MainActivity.java'),
  'utf8'
);
assert(mainActivity.includes('registerPlugin(OfflineWebCachePlugin.class)'), 'il plugin cache deve essere registrato da Capacitor');

assert.strictEqual(
  fs.readFileSync(path.join(root, 'www', 'snapshot.js'), 'utf8'),
  fs.readFileSync(path.join(repoRoot, 'snapshot.js'), 'utf8'),
  'il supporto snapshot deve provenire dalla repository principale'
);
assert.strictEqual(
  fs.readFileSync(path.join(root, 'www', 'tilestore.js'), 'utf8'),
  fs.readFileSync(path.join(repoRoot, 'tilestore.js'), 'utf8'),
  'il supporto tile deve provenire dalla repository principale'
);
console.log('ok - build Android usa l’HTML, i moduli snapshot e l’archivio web per-snapshot');
