# SkyGuardian

`index.html` è l'unica sorgente della pagina: viene pubblicata da Vercel e usata anche per creare l'APK. La build Android genera `android-app/www/index.html` partendo da questo file, sostituendo le CDN con copie locali delle librerie. I moduli `snapshot.js` e `tilestore.js` sono condivisi; i controlli e la modalità snapshot vengono attivati solo nell'app Capacitor.

## Deploy web

Vercel continua a pubblicare la cartella principale come sito statico. Le configurazioni, dipendenze e risorse generate per Android si trovano in `android-app/` e sono escluse dal deploy tramite `.vercelignore`.

## Build APK

Il workflow GitHub Actions `.github/workflows/build-apk.yml` compila l'APK debug automaticamente a ogni push su `main`; è anche avviabile manualmente dalla scheda **Actions**. Alla fine scarica l'artefatto **SkyGuardian-debug-apk**.

Per creare l'APK in locale servono Node.js 18+, Java 17 e Android SDK:

```sh
cd android-app
npm ci
npm test
npm run build
npx cap add android   # solo la prima volta
npx cap sync android
node scripts/harden-manifest.js
cd android
./gradlew assembleDebug
```

`npm test` verifica la logica degli snapshot, il manifest Android e che i file dell'app siano generati dalla sorgente principale. `npm run test:e2e` è un test browser opzionale e richiede Playwright e Chromium.

### Icona Android

Il manifest Android usa `@mipmap/ic_launcher` e `@mipmap/ic_launcher_round` (`android-app/android/app/src/main/AndroidManifest.xml`). Le risorse launcher si trovano in `android-app/android/app/src/main/res/`: le versioni adattive da Android 8 in poi sono definite da `mipmap-anydpi-v26/ic_launcher.xml` e `ic_launcher_round.xml`, che combinano un foreground con lo sfondo `@color/ic_launcher_background`.

Per personalizzare l'icona, sostituisci le immagini PNG `ic_launcher_foreground.png` nelle cartelle `mipmap-*` e, per i dispositivi/versioni che usano le icone legacy, anche `ic_launcher.png` e `ic_launcher_round.png`:

| Cartella | Icona legacy/quadrata e round | Foreground adattiva |
| --- | ---: | ---: |
| `mipmap-mdpi` | 48 × 48 px | 108 × 108 px |
| `mipmap-hdpi` | 72 × 72 px | 162 × 162 px |
| `mipmap-xhdpi` | 96 × 96 px | 216 × 216 px |
| `mipmap-xxhdpi` | 144 × 144 px | 324 × 324 px |
| `mipmap-xxxhdpi` | 192 × 192 px | 432 × 432 px |

Usa PNG RGBA quadrati. Per l'icona adattiva il foreground dovrebbe avere trasparenza e il simbolo importante va mantenuto nella zona centrale sicura (circa 72 × 72 dp su una tela da 108 × 108 dp); Android applica maschere diverse (cerchio, squircle, ecc.), quindi evita dettagli vicino ai bordi. Lo sfondo si può cambiare in `res/values/ic_launcher_background.xml`. Aggiorna tutte le densità: non è sufficiente sostituire una sola immagine.

### Archivio web negli snapshot Android

Durante la cattura, l'app ricarica gli iframe dei pannelli aperti e il plugin nativo `OfflineWebCache` intercetta le richieste GET dei frame e salva le risposte nell'area privata dell'app, in una cartella distinta per ID snapshot. Il limite è 48 MiB per snapshot e 12 MiB per singola risorsa. In consultazione la WebView usa `LOAD_CACHE_ONLY` e il plugin serve le risorse archiviate per quello snapshot: le risposte non vengono condivise o sovrascritte dagli snapshot successivi. Eliminazione, scadenza e **Cancella tutti i dati** rimuovono anche i relativi file.

Gli snapshot creati da versioni precedenti non contengono l'archivio privato e continuano a usare la vecchia cache WebView condivisa.

La cattura è best-effort, non un salvataggio completo del sito. Sono archiviate solo richieste GET completate durante la cattura; POST, risposte oltre i limiti, risorse con `Cache-Control: no-store`, contenuti caricati successivamente, richieste senza un referrer associabile, autenticazioni/cookie dinamici e servizi che cambiano origine possono mancare. Risorse web mancanti vengono bloccate durante la consultazione, invece di essere prese dalla cache condivisa o dalla rete; il banner mostra un **Web cache fault** con il numero e alcuni dettagli delle risorse mancanti. I dati dei siti terzi potrebbero quindi apparire incompleti o non interattivi.

L'archivio privato viene mantenuto per i 24h dello snapshot. La dimensione mostrata nella lista distingue i dati strutturati dai MiB web archiviati. Questa funzione è disponibile nell'app Android; la versione web pubblica non può intercettare le risposte cross-origin degli iframe.
