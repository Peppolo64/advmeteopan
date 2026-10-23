"""
Test end-to-end opzionale: esegue la pagina REALE (www/index.html) in Chromium con
- librerie finte (scripts/e2e/stubs.js) al posto di SunCalc / satellite.js / Leaflet / Tailwind
- rete simulata (Open-Meteo, Nominatim, CelesTrak, tile): nessuna richiesta esce davvero.

Uso:  python3 scripts/e2e/e2e.py      (serve il pacchetto Python "playwright" + Chromium)
"""
import base64, http.server, json, os, socketserver, sys, threading, time
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
WWW = os.path.join(ROOT, 'www')
STUBS = open(os.path.join(os.path.dirname(__file__), 'stubs.js'), encoding='utf-8').read()
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==')

OPEN_METEO = {
    'elevation': 14,
    'daily': {k: [v] * 17 for k, v in {
        'weathercode': 3, 'temperature_2m_max': 25, 'temperature_2m_min': 17, 'apparent_temperature_max': 26,
        'apparent_temperature_min': 16, 'windspeed_10m_max': 20, 'windgusts_10m_max': 35,
        'wind_direction_10m_dominant': 180, 'precipitation_probability_max': 10, 'uv_index_max': 5}.items()},
    'hourly': {'time': [], **{k: [] for k in ['relative_humidity_2m', 'surface_pressure', 'temperature_2m',
                                                'apparent_temperature', 'weathercode', 'precipitation',
                                                'windspeed_10m', 'winddirection_10m']}},
}
TLE = ''.join(f'SAT-{i}\n1 {25544+i:05d}U 98067A   26294.50000000  .00010000  00000-0  18000-3 0  9990\n'
              f'2 {25544+i:05d}  51.6400 100.0000 0005000  90.0000 270.0000 15.50000000400000\n' for i in range(5))


class Quiet(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=WWW, **k)
    def log_message(self, *a): pass


results = []
def check(name, cond, extra=''):
    results.append((name, bool(cond)))
    print(('ok   - ' if cond else 'FAIL - ') + name + (f'  [{extra}]' if (extra and not cond) else ''))


def main():
    srv = socketserver.TCPServer(('127.0.0.1', 0), Quiet)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{port}/index.html'

    state = {'external_online': True, 'external_log': [], 'dialog': 'accept', 'city': 'Palermo'}
    errors = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={'width': 1000, 'height': 1400})
        # conta i setInterval attivi (prova "nessun timer in secondo piano")
        ctx.add_init_script("""
            window.__intervals = new Set();
            const si = window.setInterval.bind(window), ci = window.clearInterval.bind(window);
            window.setInterval = (f, t, ...a) => { const id = si(f, t, ...a); window.__intervals.add(id); return id; };
            window.clearInterval = (id) => { window.__intervals.delete(id); return ci(id); };
        """)
        ctx.add_init_script(STUBS)

        def handler(route):
            url = route.request.url
            if url.startswith(f'http://127.0.0.1:{port}/'):
                if '/vendor/' in url:
                    return route.fulfill(status=200, content_type='text/plain', body='')   # librerie sostituite dagli stub
                return route.continue_()
            state['external_log'].append(url)
            if not state['external_online']:
                return route.abort('internetdisconnected')
            cors = {'access-control-allow-origin': '*'}
            if 'api.open-meteo.com/v1/forecast' in url:
                return route.fulfill(status=200, content_type='application/json', body=json.dumps(OPEN_METEO), headers=cors)
            if 'api.open-meteo.com/v1/elevation' in url:
                return route.fulfill(status=200, content_type='application/json', body='{"elevation":[14]}', headers=cors)
            if 'nominatim' in url:
                return route.fulfill(status=200, content_type='application/json', headers=cors,
                                     body=json.dumps({'name': state['city'], 'address': {'city': state['city'], 'state': 'Sicilia'}}))
            if 'celestrak' in url:
                return route.fulfill(status=200, content_type='text/plain', body=TLE, headers=cors)
            if 'tile.openstreetmap.org' in url or 'arcgisonline' in url:
                return route.fulfill(status=200, content_type='image/png', body=PNG, headers=cors)
            return route.fulfill(status=200, content_type='text/html', body='<html><body>sito esterno</body></html>')

        ctx.route('**/*', handler)
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('dialog', lambda d: d.accept() if state['dialog'] == 'accept' else d.dismiss())

        def open_section(sid):
            page.evaluate("id => { document.getElementById(id).open = true; }", sid)
            page.wait_for_timeout(250)

        def status():
            return page.inner_text('#snapshotStatus')

        def snaps():
            return page.evaluate("() => SkySnapshot.list()")

        def idb_snap_ids():
            return page.evaluate("""() => new Promise((res, rej) => {
                const r = indexedDB.open('skyguardian-tiles', 1);
                r.onsuccess = () => {
                    const ids = [], q = r.result.transaction('tiles').objectStore('tiles').index('snap').openKeyCursor(null, 'nextunique');
                    q.onsuccess = () => { const c = q.result; if (c) { ids.push(c.key); c.continue(); } else res(ids); };
                };
                r.onerror = () => rej(r.error);
            })""")

        def idb_count(snap_id):
            return page.evaluate("""(sid) => new Promise((res) => {
                const r = indexedDB.open('skyguardian-tiles', 1);
                r.onsuccess = () => {
                    const q = r.result.transaction('tiles').objectStore('tiles').index('snap').count(IDBKeyRange.only(sid));
                    q.onsuccess = () => res(q.result);
                };
            })""", snap_id)

        # ------------------------------------------------------------ 1. avvio
        page.goto(base)
        page.wait_for_timeout(500)
        check('la pagina parte senza errori JS', not errors, errors)
        check('pulsante "Cattura Snapshot Offline di 24h" presente', 'Cattura Snapshot Offline di 24h' in page.inner_text('#snapshotBtn'))
        check('nessuna sezione "Snapshot offline" separata', page.query_selector('#sectionSnapshots') is None)
        check('timer di pulizia attivo con app in primo piano', page.evaluate('window.__intervals.size') == 1)

        # ------------------------------------------------------------ 2. cattura: solo pannelli aperti
        page.click('#snapshotBtn')
        page.wait_for_timeout(200)
        check('senza pannelli aperti non salva nulla', len(snaps()) == 0 and 'Nessun pannello aperto' in status(), status())

        for sid in ['sectionOpenMeteo', 'sectionCommerciali', 'sectionSoleLuna', 'sectionSimulatore', 'sectionSatellites', 'sectionMeteoblue']:
            open_section(sid)
        page.click("button[onclick=\"loadSatelliteGroup('stations')\"]")
        page.wait_for_timeout(700)
        page.click('#snapshotBtn')
        page.wait_for_timeout(1500)
        s = snaps()
        check('uno snapshot salvato', len(s) == 1, status())
        snap = s[0] if s else {'sections': {}}
        secs = snap['sections']
        check('contiene SOLO i pannelli aperti', set(secs) == {'sectionOpenMeteo', 'sectionCommerciali', 'sectionSoleLuna',
                                                                  'sectionSimulatore', 'sectionSatellites', 'sectionMeteoblue'}, sorted(secs))
        check('Calendario lunare (chiuso) non incluso', 'lunarCalendarPanel' not in secs)
        check('Open-Meteo: dati già scaricati salvati', secs.get('sectionOpenMeteo', {}).get('data', {}).get('elevation') == 14)
        check('Satelliti: solo la categoria caricata (stations)', list(secs.get('sectionSatellites', {}).get('tle', {})) == ['stations'])
        check('comune da Nominatim (Palermo) nell\'etichetta', snap.get('cityName') == 'Palermo')
        tiles = secs.get('sectionSimulatore', {}).get('tiles', {})
        check('tile mappa salvate, al massimo 150', 0 < tiles.get('saved', 0) <= 150, tiles)
        check('tile presenti in IndexedDB', idb_count(snap['id']) == tiles.get('saved'), idb_count(snap['id']))
        check('iframe (Meteoblue) salvato solo come "aperto"', secs.get('sectionMeteoblue') == {})
        label = page.inner_text('#snapshotList')
        check('pulsante "Consulta lo snapshot offline [Palermo, gg/mm hh:mm]"',
              'Consulta lo snapshot offline' in label and '[Palermo, ' in label, label)

        # ------------------------------------------------------------ 3. nuova sessione offline: nessun fallback automatico
        state['external_online'] = False
        page.reload()
        page.wait_for_timeout(500)
        check('lo snapshot sopravvive alla riapertura dell\'app', len(snaps()) == 1)
        open_section('sectionOpenMeteo')
        page.wait_for_timeout(700)
        om = page.inner_text('#openMeteoData')
        check('offline: NESSUN fallback automatico (errore + suggerimento)', 'Rete non raggiungibile' in om and 'Consulta lo snapshot offline' in om, om)

        # ------------------------------------------------------------ 4. consulta lo snapshot
        state['external_log'].clear()
        page.click("#snapshotList button[onclick^='consultSnapshot']")
        page.wait_for_timeout(1200)
        opened = page.evaluate("ids => ids.map(i => [i, document.getElementById(i).open])",
                               ['sectionOpenMeteo', 'sectionCommerciali', 'sectionSoleLuna', 'sectionSimulatore', 'sectionSatellites', 'sectionMeteoblue', 'lunarCalendarPanel'])
        check('riapre gli stessi pannelli dello scatto, chiude gli altri',
              dict(opened) == {'sectionOpenMeteo': True, 'sectionCommerciali': True, 'sectionSoleLuna': True, 'sectionSimulatore': True,
                               'sectionSatellites': True, 'sectionMeteoblue': True, 'lunarCalendarPanel': False}, opened)
        om = page.inner_text('#openMeteoData')
        check('Open-Meteo mostrato dai dati salvati', 'Rete non raggiungibile' not in om and len(om.strip()) > 20, om)
        check('banner "Stai consultando lo snapshot" visibile', 'Stai consultando lo snapshot' in page.inner_text('#snapshotModeBanner'))
        check('coordinate ripristinate', page.input_value('#latInput') == '38.11570')
        check('iframe sostituiti da segnaposto "Contenuto online"', page.inner_text('#sectionMeteoblue').count('Contenuto online') >= 1)
        check('Sole e Luna calcolato senza rete', len(page.inner_text('#astroData').strip()) > 10)
        sat = page.inner_text('#satelliteStatus')
        check('Satelliti: TLE letti dallo snapshot', 'snapshot' in sat.lower() or 'passagg' in sat.lower(), sat)
        page.click("button[onclick=\"loadSatelliteGroup('starlink')\"]")
        page.wait_for_timeout(500)
        check('Satelliti: categoria non salvata -> avviso chiaro', 'non è inclusa nello snapshot' in page.inner_text('#satelliteStatus'), page.inner_text('#satelliteStatus'))
        page.evaluate("document.getElementById('lunarCalendarPanel').open = true")
        page.wait_for_timeout(300)
        check('pannello non incluso -> avviso', 'non era aperto quando è stato catturato' in page.inner_text('#lunarCalendarPanel'))

        # mappa: tile lette da IndexedDB
        tile = page.evaluate("""async () => {
            const sec = SkySnapshot.get(activeSnapshotId).sections.sectionSimulatore;
            const plan = SkyTiles.planTiles({north:38.1200,south:38.1110,east:13.3700,west:13.3530}, sec.view.zoom);
            const t = plan.tiles[0];
            const layer = simOsmLayer;
            return await new Promise(res => {
                const img = layer.createTile({z:t.z, x:t.x, y:t.y}, () => setTimeout(() => res({src: img.src, mn: simMap.minZoom, mx: simMap.maxZoom}), 50));
            });
        }""")
        check('mappa: le tile arrivano da IndexedDB (blob:)', tile['src'].startswith('blob:'), tile)
        check('mappa: zoom limitato ai livelli salvati', tile['mn'] is not None and tile['mx'] is not None and tile['mn'] <= tile['mx'], tile)

        offline_calls = [u for u in state['external_log'] if 'localhost' not in u]
        check('in modalità snapshot nessuna richiesta di rete (tranne gli iframe neutralizzati)',
              not [u for u in offline_calls if any(h in u for h in ('open-meteo', 'nominatim', 'celestrak', 'tile.openstreetmap', 'arcgisonline'))], offline_calls)

        page.click('#snapshotBtn')
        page.wait_for_timeout(200)
        check('in modalità snapshot non si può catturarne un altro', 'esci dallo snapshot' in status().lower(), status())

        # ------------------------------------------------------------ 5. esci
        state['external_online'] = True
        page.click('#snapshotModeBanner button')
        page.wait_for_timeout(1200)
        check('esci: banner nascosto', page.evaluate("document.getElementById('snapshotModeBanner').classList.contains('hidden')"))
        check('esci: segnaposto rimossi e iframe di nuovo visibili',
              page.evaluate("document.querySelectorAll('.snap-ph').length") == 0 and page.evaluate("document.querySelectorAll('iframe.hidden').length") == 0)
        check('esci: Open-Meteo di nuovo live', 'Rete non raggiungibile' not in page.inner_text('#openMeteoData'))
        check('esci: avviso "non incluso" rimosso', page.evaluate("document.querySelectorAll('.snap-notice').length") == 0)

        # ------------------------------------------------------------ 6. massimo 5 + sostituzione del più vecchio
        for _ in range(4):
            page.click('#snapshotBtn'); page.wait_for_timeout(900)
        check('4 + 1 = 5 snapshot', len(snaps()) == 5, status())
        oldest = min(snaps(), key=lambda x: x['createdAt'])['id']
        page.click('#snapshotBtn'); page.wait_for_timeout(1200)
        ids = [x['id'] for x in snaps()]
        check('al sesto: conferma e sostituzione del più vecchio (restano 5)', len(ids) == 5 and oldest not in ids, status())
        check('le tile del più vecchio sono state cancellate', idb_count(oldest) == 0)
        page.wait_for_timeout(300)
        check('IndexedDB contiene solo tile di snapshot esistenti', set(idb_snap_ids()) <= set(ids), idb_snap_ids())

        state['dialog'] = 'dismiss'
        before = [x['id'] for x in snaps()]
        page.click('#snapshotBtn'); page.wait_for_timeout(600)
        check('conferma rifiutata: nulla cambia', [x['id'] for x in snaps()] == before and 'annullata' in status().lower(), status())
        state['dialog'] = 'accept'

        # ------------------------------------------------------------ 7. scadenza 24h
        page.evaluate("""() => {
            const k = 'skyguardian.snapshots.v2', o = JSON.parse(localStorage.getItem(k));
            const first = Object.keys(o)[0]; o[first].expiresAt = Date.now() - 1000; localStorage.setItem(k, JSON.stringify(o));
        }""")
        n_before = len(before)
        page.evaluate("housekeepSnapshots()")
        page.wait_for_timeout(500)
        check('snapshot scaduto cancellato automaticamente', len(snaps()) == n_before - 1)
        ids = [x['id'] for x in snaps()]
        check('anche le sue tile sono sparite', set(idb_snap_ids()) <= set(ids))

        # tile orfane ripulite al riavvio
        page.evaluate("""() => new Promise(res => {
            const r = indexedDB.open('skyguardian-tiles', 1);
            r.onsuccess = () => { const t = r.result.transaction('tiles', 'readwrite');
                t.objectStore('tiles').put({k: 'orfano|osm|1|0|0', snap: 'orfano', blob: new Blob(['x'])}); t.oncomplete = () => res(); };
        })""")
        page.reload(); page.wait_for_timeout(700)
        check('tile orfane ripulite all\'avvio', 'orfano' not in idb_snap_ids(), idb_snap_ids())

        # ------------------------------------------------------------ 8. app in secondo piano / chiusa: nessun timer
        page.evaluate("""() => {
            Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
            document.dispatchEvent(new Event('visibilitychange'));
        }""")
        check('app in secondo piano: nessun timer attivo', page.evaluate('window.__intervals.size') == 0)
        page.evaluate("""() => {
            Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
            document.dispatchEvent(new Event('visibilitychange'));
        }""")
        check('di nuovo in primo piano: il timer riparte (uno solo)', page.evaluate('window.__intervals.size') == 1)

        # ------------------------------------------------------------ 9. sicurezza
        check('tutti gli iframe hanno l\'attributo sandbox', page.evaluate("[...document.querySelectorAll('iframe')].every(f => f.hasAttribute('sandbox'))"))
        check('nessun iframe può navigare la pagina principale (no allow-top-navigation)',
              page.evaluate("[...document.querySelectorAll('iframe')].every(f => !f.getAttribute('sandbox').includes('top-navigation'))"))

        state['city'] = '<img src=x onerror=window.__xss=1>Evil'
        page.reload(); page.wait_for_timeout(500)
        open_section('sectionCommerciali'); page.wait_for_timeout(600)
        lbl = page.inner_text('#detectedCityLabel')
        check('nome comune malevolo (Nominatim) mostrato come testo, non eseguito',
              page.evaluate('window.__xss') is None and '<img' in lbl and page.evaluate("document.querySelectorAll('#detectedCityLabel img').length") == 0, lbl)
        state['city'] = 'Palermo'

        # ------------------------------------------------------------ 10. cancella tutti i dati
        page.reload(); page.wait_for_timeout(400)
        open_section('sectionOpenMeteo'); page.wait_for_timeout(500)
        page.click('#snapshotBtn'); page.wait_for_timeout(900)
        check('prima della cancellazione c\'è almeno uno snapshot', len(snaps()) >= 1)
        page.evaluate("localStorage.setItem('altro', '1'); sessionStorage.setItem('x', '1')")
        page.click('#wipeBtn')
        page.wait_for_timeout(2500)
        check('cancella tutto: nessuno snapshot', len(snaps()) == 0)
        check('cancella tutto: localStorage e sessionStorage vuoti', page.evaluate('localStorage.length') == 0 and page.evaluate('sessionStorage.length') == 0)
        check('cancella tutto: nessuna tile in IndexedDB', idb_snap_ids() == [], idb_snap_ids())
        check('cancella tutto: la pagina riparte funzionante', 'Cattura Snapshot Offline di 24h' in page.inner_text('#snapshotBtn'))

        check('nessun errore JS durante tutto il test', not errors, errors)
        browser.close()

    srv.shutdown()
    failed = [n for n, ok in results if not ok]
    print(f'\n{len(results) - len(failed)}/{len(results)} controlli superati')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
