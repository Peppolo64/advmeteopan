# SkyGuardian

`index.html` è l'unica sorgente della pagina: viene pubblicata da Vercel e usata anche per creare l'APK. La build Android genera `android-app/www/index.html` partendo da questo file, sostituendo le CDN con copie locali delle librerie. I moduli `snapshot.js` e `tilestore.js` sono condivisi; i controlli e la modalità snapshot vengono attivati solo nell'app Capacitor.

## Effemeridi 3D

Pannello in fondo alla dashboard (`ephemeris.js`, grafica con Three.js 0.149). Mostra la sfera celeste completa con griglia azimutale per le coordinate del Pannello di Controllo, oppure per la posizione del dispositivo (tasto «Usa coordinate dispositivo», vale solo per questo pannello fino al prossimo «Aggiorna»).

- **Livelli** (barra a destra): posizione e traiettoria del Sole, ora d'oro, ora blu, crepuscoli civile/nautico/astronomico (spicchi all'orizzonte), posizione e traiettoria della Luna, sorgere/tramonto e posizione della Via Lattea.
- **Cursore del tempo**: 24 ore, 1 ora o 365 giorni (tasto `24h`). Parte dalla data del pannello all'ora corrente; data e ora si cambiano toccandole. Gli eventi vicini al cursore si evidenziano nell'elenco.
- **A mano**: trascina per ruotare, pizzica o usa la rotella per lo zoom, ⊙ per la vista dall'alto.
- **Fotocamera**: vista dall'interno della sfera sopra l'immagine della fotocamera, guidata da giroscopio e bussola (telefoni e tablet, sito su HTTPS e app Android).

Tutto è calcolato in locale (SunCalc + formule standard per la Via Lattea): funziona offline e entra negli snapshot. Sul sito Three.js viene scaricato dal CDN solo all'apertura del pannello; nell'app è incluso in `www/vendor`.

## Mappa Stellare

Pannello dopo le Effemeridi (`starmap.js` + dati `skydata.js`, grafica Three.js): il cielo visto dall'osservatore come in un planetario, per le coordinate del Pannello di Controllo o del dispositivo.

- **Contenuti**: 41.487 stelle fino a magnitudine 8 (zoomando compaiono le più deboli), figure, nomi italiani e confini delle costellazioni, Via Lattea, 110 oggetti Messier, Sole, Luna con la fase, pianeti da Mercurio a Nettuno, griglie azimutale ed equatoriale, eclittica e meridiano, suolo, atmosfera diurna e modalità notte (rossa). Tutto si attiva dalla barra a destra.
- **Dettagli**: toccando un oggetto si apre la scheda (nome, sigle, costellazione, magnitudine, colore, tipo spettrale, distanza, coordinate, altezza/azimut, orari di sorgere/culminazione/tramonto) con il tasto «Centra». La ricerca trova stelle, costellazioni, pianeti e Messier.
- **Navigazione**: a mano (trascina, pizzica/rotella o +/− per lo zoom) oppure con giroscopio e bussola, senza fotocamera.
- **Tempo**: cursore 24 ore o 365 giorni, data e ora modificabili, scorrimento ▶ a 1 min/s, 10 min/s o 1 h/s.

Dati: stelle dal catalogo HYG v4.1 (CC BY-SA 4.0, D. Nash / astronexus), costellazioni, Via Lattea e Messier da d3-celestial (BSD-3-Clause, O. Frohn), pianeti con gli elementi orbitali JPL. Il file `skydata.js` è generato e distribuito con licenza CC BY-SA 4.0; si rigenera con:

```bash
node android-app/scripts/build-skydata.js hygdata_v41.csv d3-celestial/data
```

## Schermo intero

Mappa Stellare ed Effemeridi hanno il tasto ⛶: il riquadro occupa tutto lo schermo insieme alla barra dei livelli e al cursore del tempo. Si esce con ✕, con Esc o con il tasto Indietro (anche nell'app Android).

## Deploy web

Vercel continua a pubblicare la cartella principale come sito statico. Le configurazioni, dipendenze e risorse generate per Android si trovano in `android-app/` e sono escluse dal deploy tramite `.vercelignore`.

## Build APK

Il workflow GitHub Actions `.github/workflows/build-apk.yml` compila entrambi gli APK debug a ogni push su qualsiasi branch; è anche avviabile manualmente dalla scheda **Actions**. Pubblica due artefatti distinti: **SkyGuardian-Android-apk** (`app-debug.apk`) e **SkyGuardian-WearOS-apk** (`wear-debug.apk`).

Per creare l'APK in locale servono Node.js 18+, Java 17 e Android SDK:

```sh
cd android-app
npm ci
npm test
npx cap add android   # solo la prima volta
npm run sync
cd android
./gradlew :app:assembleDebug :wear:assembleDebug
```

`npm test` verifica la logica degli snapshot, il manifest Android e che i file dell'app siano generati dalla sorgente principale. `npm run test:e2e` è un test browser opzionale e richiede Playwright e Chromium.

### Wear OS

`android/wear` è una build autonoma della dashboard Capacitor per smartwatch Wear OS (Android 11/API 30 o successivo). Sul watch il **Pannello di Controllo** mantiene tutti i controlli disponibili nell'app Android; **Open-Meteo** e **Sole e Luna** sono aperti all'avvio, disposti in colonna e ottimizzati per il display circolare. Gli altri pannelli sono nascosti soltanto nella versione watch: l'APK Android del telefono non viene modificato.

La cattura e la consultazione degli snapshot offline usano gli stessi moduli JavaScript e il plugin nativo `OfflineWebCache` dell'app Android. Lo snapshot salva i dati dei pannelli aperti: sul watch Open-Meteo e Sole e Luna sono aperti per impostazione predefinita. Il dato Open-Meteo viene conservato per la consultazione offline e Sole e Luna viene ricalcolato localmente da coordinate e data.

Per compilare soltanto l'APK Wear OS, da `android-app/` eseguire:

```sh
npm run sync
cd android
./gradlew :wear:assembleDebug
```

Il file generato è `android-app/android/wear/build/outputs/apk/debug/wear-debug.apk`. Per installarlo sul watch si può usare ADB tramite Wi-Fi/debug wireless oppure l'installazione di app da Galaxy Wearable.

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

Durante la navigazione, il plugin nativo `OfflineWebCache` traccia l'URL corrente dei frame (incluse le navigazioni SPA) anche quando il sito è cross-origin. Alla cattura, l'app ricarica gli iframe dei pannelli aperti partendo da quegli URL e intercetta le richieste GET dei frame, salvando le risposte nell'area privata dell'app, in una cartella distinta per ID snapshot. Il limite è 48 MiB per snapshot e 12 MiB per singola risorsa. In consultazione la WebView usa `LOAD_CACHE_ONLY` e il plugin serve le risorse archiviate per quello snapshot: le risposte non vengono condivise o sovrascritte dagli snapshot successivi. Eliminazione, scadenza e **Cancella tutti i dati** rimuovono anche i relativi file.

Il plugin è registrato in `MainActivity` e il bundle statico lo richiama tramite il bridge Android `Capacitor.Plugins.OfflineWebCache`. Per una build locale, eseguire `npm run sync` prima di Gradle; il workflow GitHub sincronizza automaticamente il progetto Android prima di compilare l'APK.

Gli snapshot creati da versioni precedenti non contengono l'archivio privato e continuano a usare la vecchia cache WebView condivisa.

Se il plugin Android non è presente o non riesce ad attivarsi, lo snapshot dei dati locali continua a caricarsi; vengono disattivati solo gli iframe e il relativo pannello spiega il motivo.

La cattura è best-effort, non un salvataggio completo del sito. Sono archiviate solo richieste GET completate durante la cattura; POST, risposte oltre i limiti, risorse con `Cache-Control: no-store`, contenuti caricati successivamente, richieste senza un referrer associabile, autenticazioni/cookie dinamici e servizi che cambiano origine possono mancare. Risorse web mancanti vengono bloccate durante la consultazione, invece di essere prese dalla cache condivisa o dalla rete; il banner mostra un **Web cache fault** con il numero e alcuni dettagli delle risorse mancanti. I dati dei siti terzi potrebbero quindi apparire incompleti o non interattivi.

L'archivio privato viene mantenuto per le 48h dello snapshot. La dimensione mostrata nella lista distingue i dati strutturati dai MiB web archiviati. Questa funzione è disponibile nell'app Android; la versione web pubblica non può intercettare le risposte cross-origin degli iframe.
