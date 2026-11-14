/*
 * SkyGuardian - GPS Tracking
 *
 * Velocità GPS istantanea (± errore) e registrazione del percorso con impostazioni avanzate (intervallo,
 * distanza minima, precisione minima, errore di velocità ammesso, velocità minima e massima plausibile,
 * attesa del primo fix preciso, pausa automatica, fonte della quota, dati extra nel GPX, tracciamento
 * GNSS completo, profili pronti), Pausa/Riprendi/Ferma, grafico in tempo reale, mappa, archivio dei
 * percorsi ed esportazione GPX.
 * - App Android: plugin nativo Tracker; con «Esegui in background» un servizio in primo piano con
 *   notifica continua ad app chiusa. Senza, il GPS si ferma con l'app.
 * - Sito: GPS del browser; si ferma quando la pagina va in secondo piano.
 * I dati grezzi sono sempre conservati: i filtri si applicano al calcolo e all'esportazione.
 * I periodi senza punti (app chiusa) valgono velocità zero e abbassano la media; le pause no.
 *
 * SkyTracker.calc: calcoli puri (scripts/test-tracker.js) · SkyTracker.createPanel(opts): interfaccia
 */
(function (root) {
    'use strict';

    const GAP_MS = 10000;            // senza punti oltre 10 s (o 3 intervalli) = periodo senza GPS
    const ISA_H = 44330.77, ISA_K = 1 / 5.25588;

    // ---------------------------------------------------------------- impostazioni e profili
    const DEFAULTS = {
        profile: 'walk', intervalS: 1, minDistanceM: 0, maxHAcc: 25, maxSpeedAccKmh: 5, minSpeedKmh: 1.5, maxSpeedKmh: 40,
        warmupAcc: 15, autoPause: true, autoPauseKmh: 1.0, autoPauseS: 20, elevation: 'combined',
        extras: { acc: true, sats: true, speed: true, course: true, pressure: true }, fullGnss: false, keepAwake: true,
    };
    const PROFILES = {
        walk: { label: 'Camminata / escursione', intervalS: 2, minDistanceM: 2, maxHAcc: 20, maxSpeedAccKmh: 3, minSpeedKmh: 1.2, maxSpeedKmh: 25, warmupAcc: 15, autoPause: true, autoPauseKmh: 1.0, autoPauseS: 30, elevation: 'combined', fullGnss: false },
        run: { label: 'Corsa', intervalS: 1, minDistanceM: 2, maxHAcc: 15, maxSpeedAccKmh: 3, minSpeedKmh: 3, maxSpeedKmh: 35, warmupAcc: 12, autoPause: true, autoPauseKmh: 2.5, autoPauseS: 10, elevation: 'combined', fullGnss: false },
        bike: { label: 'Bicicletta', intervalS: 1, minDistanceM: 3, maxHAcc: 20, maxSpeedAccKmh: 4, minSpeedKmh: 4, maxSpeedKmh: 90, warmupAcc: 15, autoPause: true, autoPauseKmh: 3, autoPauseS: 10, elevation: 'combined', fullGnss: false },
        car: { label: 'Auto / moto', intervalS: 1, minDistanceM: 5, maxHAcc: 30, maxSpeedAccKmh: 6, minSpeedKmh: 5, maxSpeedKmh: 250, warmupAcc: 20, autoPause: false, autoPauseKmh: 3, autoPauseS: 30, elevation: 'gps', fullGnss: false },
        survey: { label: 'Rilievo di precisione', intervalS: 1, minDistanceM: 0, maxHAcc: 8, maxSpeedAccKmh: 1.5, minSpeedKmh: 0.5, maxSpeedKmh: 20, warmupAcc: 5, autoPause: false, autoPauseKmh: 0.5, autoPauseS: 60, elevation: 'combined', fullGnss: true },
        battery: { label: 'Risparmio batteria', intervalS: 10, minDistanceM: 10, maxHAcc: 40, maxSpeedAccKmh: 8, minSpeedKmh: 1.5, maxSpeedKmh: 150, warmupAcc: 30, autoPause: true, autoPauseKmh: 1.5, autoPauseS: 60, elevation: 'gps', fullGnss: false },
    };
    function settingsFor(profile, base) {
        const p = PROFILES[profile];
        return Object.assign({}, DEFAULTS, base || {}, p ? Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'label')) : {}, { profile: p ? profile : 'custom' });
    }
    function normalizeSettings(s) {
        const o = Object.assign({}, DEFAULTS, s || {});
        o.extras = Object.assign({}, DEFAULTS.extras, (s && s.extras) || {});
        const clamp = (v, a, b, d) => Number.isFinite(+v) ? Math.max(a, Math.min(b, +v)) : d;
        o.intervalS = clamp(o.intervalS, 1, 120, 1); o.minDistanceM = clamp(o.minDistanceM, 0, 500, 0);
        o.maxHAcc = clamp(o.maxHAcc, 2, 500, 25); o.maxSpeedAccKmh = clamp(o.maxSpeedAccKmh, 0.2, 100, 5);
        o.minSpeedKmh = clamp(o.minSpeedKmh, 0, 50, 1.5); o.maxSpeedKmh = clamp(o.maxSpeedKmh, 2, 2000, 40);
        o.warmupAcc = clamp(o.warmupAcc, 2, 500, 15); o.autoPauseKmh = clamp(o.autoPauseKmh, 0, 50, 1); o.autoPauseS = clamp(o.autoPauseS, 3, 3600, 20);
        if (!['gps', 'baro', 'combined'].includes(o.elevation)) o.elevation = 'combined';
        o.autoPause = !!o.autoPause; o.fullGnss = !!o.fullGnss; o.keepAwake = o.keepAwake !== false;
        return o;
    }

    // ---------------------------------------------------------------- punti
    function distanceM(a, b) {
        const R = 6371008.8, r = Math.PI / 180;
        const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    }
    const num = v => (v === null || v === undefined || v === '' || Number.isNaN(+v)) ? NaN : +v;
    // [t, lat, lon, hAcc, speed, speedAcc, mslAlt, ellAlt, vAcc, pressure, sats, satsL5, course]
    const fromArray = a => ({ t: num(a[0]), lat: num(a[1]), lon: num(a[2]), hAcc: num(a[3]), speed: num(a[4]), speedAcc: num(a[5]),
                              msl: num(a[6]), alt: num(a[7]), vAcc: num(a[8]), p: num(a[9]), sats: num(a[10]), satsL5: num(a[11]), course: num(a[12]) });
    const toArray = p => [p.t, p.lat, p.lon, p.hAcc, p.speed, p.speedAcc, p.msl, p.alt, p.vAcc, p.p, p.sats, p.satsL5, p.course].map(v => Number.isFinite(v) ? v : null);

    function speedSigma(p) {
        if (Number.isFinite(p.speedAcc) && p.speedAcc > 0) return { sigma: p.speedAcc, estimated: false };
        return { sigma: Math.max(0.3, (Number.isFinite(p.hAcc) ? p.hAcc : 20) / 12), estimated: true };
    }
    function gpsAltitude(p, geoidN) {
        if (Number.isFinite(p.msl)) return p.msl;
        if (Number.isFinite(p.alt) && Number.isFinite(geoidN)) return p.alt - geoidN;
        return NaN;
    }
    const baroRel = p => Number.isFinite(p.p) ? ISA_H * (1 - Math.pow(p.p / 1013.25, ISA_K)) : NaN;
    const inPause = (t, pauses) => pauses.some(([a, b]) => t >= a && (!b || t <= b));

    // ---------------------------------------------------------------- filtri, segmenti, pausa automatica
    function process(raw, opts) {
        opts = opts || {};
        const S = normalizeSettings(opts.settings);
        const pauses = (opts.pauses || []).map(([a, b]) => [a, b || 0]);
        const geoidN = opts.geoidN;
        const rejected = { warmup: 0, accuracy: 0, interval: 0, distance: 0, jump: 0, speedAcc: 0 };
        const gapMs = Math.max(GAP_MS, 3 * S.intervalS * 1000);
        const kept = [];
        let warm = false, last = null;
        for (const r of raw) {
            if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon) || !Number.isFinite(r.t) || inPause(r.t, pauses)) continue;
            const acc = Number.isFinite(r.hAcc) ? r.hAcc : 30;
            if (!warm) { if (acc <= S.warmupAcc) warm = true; else { rejected.warmup++; continue; } }
            if (acc > S.maxHAcc) { rejected.accuracy++; continue; }
            const p = Object.assign({}, r);
            if (Number.isFinite(p.speedAcc) && p.speedAcc * 3.6 > S.maxSpeedAccKmh) { p.speed = NaN; rejected.speedAcc++; }
            const newSeg = !last || r.t - last.t > gapMs || pauses.some(([a]) => a > last.t && a <= r.t);
            if (!newSeg) {
                if (r.t - last.t < S.intervalS * 1000 - 300) { rejected.interval++; continue; }
                const d = distanceM(last, p);
                if (d / ((r.t - last.t) / 1000) * 3.6 > S.maxSpeedKmh) { rejected.jump++; continue; }
                if (d < S.minDistanceM) { rejected.distance++; continue; }
            }
            p.newSeg = newSeg;
            kept.push(p);
            last = p;
        }
        // velocità di ogni punto: Doppler o dalla posizione
        kept.forEach((p, i) => {
            const prev = kept[i - 1];
            p.v = Number.isFinite(p.speed) ? p.speed : (prev && !p.newSeg ? distanceM(prev, p) / Math.max(0.5, (p.t - prev.t) / 1000) : 0);
        });
        // pausa automatica: velocità sotto soglia per almeno autoPauseS secondi
        const autoPauses = [];
        if (S.autoPause) {
            let slowFrom = null, lastSlow = null;
            const flush = endT => {
                if (slowFrom !== null && lastSlow - slowFrom >= S.autoPauseS * 1000) autoPauses.push([slowFrom, endT === undefined ? lastSlow : endT]);
                slowFrom = null; lastSlow = null;
            };
            kept.forEach(p => {
                if (p.newSeg) flush();
                if (p.v * 3.6 < S.autoPauseKmh) { if (slowFrom === null) slowFrom = p.t; lastSlow = p.t; }
                else flush(p.t);
            });
            flush();
        }
        kept.forEach(p => { p.auto = autoPauses.some(([a, b]) => p.t > a && p.t < b); });
        // quota: GPS, barometro tarato sul GPS del primo minuto, o combinata (barometro tarato su tutto il percorso)
        const gpsH = kept.map(p => gpsAltitude(p, geoidN));
        const baroH = kept.map(baroRel);
        const hasBaro = baroH.filter(Number.isFinite).length > kept.length * 0.8 && kept.length > 1;
        let source = 'gps';
        if (S.elevation !== 'gps' && hasBaro) {
            const pairs = kept.map((p, i) => [gpsH[i] - baroH[i], p.t]).filter(([d]) => Number.isFinite(d));
            const use = S.elevation === 'baro' ? pairs.filter(([, t]) => t - kept[0].t <= 60000) : pairs;
            if (use.length) {
                const off = use.map(([d]) => d).sort((a, b) => a - b)[use.length >> 1];
                kept.forEach((p, i) => { p.ele = Number.isFinite(baroH[i]) ? baroH[i] + off : gpsH[i]; });
                source = S.elevation;
            }
        }
        if (source === 'gps') kept.forEach((p, i) => { p.ele = gpsH[i]; });
        return { points: kept, rejected, autoPauses, pauses, settings: S, elevationSource: source, gapMs };
    }

    // ---------------------------------------------------------------- statistiche
    function stats(proc, opts) {
        opts = opts || {};
        const S = proc.settings, pts = proc.points;
        const startedAt = opts.startedAt || (pts[0] ? pts[0].t : 0);
        const end = Math.max(opts.now || 0, pts.length ? pts[pts.length - 1].t : startedAt);
        const pauseTime = proc.pauses.reduce((s, [a, b]) => s + Math.max(0, Math.min(b || end, end) - Math.max(a, startedAt)), 0);
        const out = { distance: 0, elapsed: Math.max(0, end - startedAt - pauseTime), total: Math.max(0, end - startedAt), pauseTime,
                      moving: 0, max: 0, gain: 0, loss: 0, gaps: [], gapTime: 0, n: pts.length, autoPauseTime: 0 };
        // periodi senza GPS (non in pausa)
        const holes = [];
        const firstT = pts.length ? pts[0].t : end;
        if (firstT - startedAt > proc.gapMs) holes.push([startedAt, firstT]);
        for (let i = 1; i < pts.length; i++) if (pts[i].newSeg) holes.push([pts[i - 1].t, pts[i].t]);
        if (pts.length && end - pts[pts.length - 1].t > proc.gapMs && opts.live) holes.push([pts[pts.length - 1].t, end]);
        holes.forEach(([a, b]) => {
            let free = b - a;
            proc.pauses.forEach(([pa, pb]) => { free -= Math.max(0, Math.min(b, pb || end) - Math.max(a, pa)); });
            if (free > proc.gapMs) { out.gaps.push({ from: a, to: b }); out.gapTime += free; }
        });
        const speeds = [];
        let ref = NaN;
        const threshold = proc.elevationSource === 'gps' ? 5 : 1.5;
        for (let i = 0; i < pts.length; i++) {
            const p = pts[i], prev = pts[i - 1];
            if (prev && !p.newSeg && !p.auto) {
                const d = distanceM(prev, p);
                if (p.v * 3.6 >= S.minSpeedKmh) { out.distance += d; out.moving += p.t - prev.t; }
            }
            if (Number.isFinite(p.speed) && !p.auto) speeds.push(p.speed);
            if (Number.isFinite(p.ele)) {
                if (!Number.isFinite(ref)) ref = p.ele;
                else if (p.ele - ref >= threshold) { out.gain += p.ele - ref; ref = p.ele; }
                else if (ref - p.ele >= threshold) { out.loss += ref - p.ele; ref = p.ele; }
            }
        }
        out.autoPauseTime = proc.autoPauses.reduce((s, [a, b]) => s + (b - a), 0);
        for (let i = 1; i < speeds.length - 1; i++) out.max = Math.max(out.max, [speeds[i - 1], speeds[i], speeds[i + 1]].sort((a, b) => a - b)[1]);
        if (speeds.length && speeds.length < 3) out.max = Math.max(...speeds);
        out.avg = out.elapsed > 0 ? out.distance / (out.elapsed / 1000) : 0;
        out.avgMoving = out.moving > 0 ? out.distance / (out.moving / 1000) : 0;
        const lastP = pts[pts.length - 1];
        out.altitude = lastP ? lastP.ele : NaN;
        out.elevationSource = proc.elevationSource;
        return out;
    }

    // Serie per il grafico: [t, km/h, tipo] con tipo '' (dato), 'gap' (senza GPS: zero), 'pause' (in pausa: zero)
    function speedSeries(proc, opts) {
        opts = opts || {};
        const s = [], pts = proc.points;
        const startedAt = opts.startedAt || (pts[0] && pts[0].t);
        const zero = (a, b, kind) => { if (b - a > 2000) s.push([a + 1000, 0, kind], [b - 1000, 0, kind]); };
        const kindBetween = (a, b) => proc.pauses.some(([pa, pb]) => pa < b && (pb || Infinity) > a) ? 'pause' : 'gap';
        if (pts.length && pts[0].t - startedAt > proc.gapMs) zero(startedAt, pts[0].t, kindBetween(startedAt, pts[0].t));
        pts.forEach((p, i) => {
            if (i && p.newSeg) zero(pts[i - 1].t, p.t, kindBetween(pts[i - 1].t, p.t));
            s.push([p.t, p.auto ? 0 : p.v * 3.6, p.auto ? 'auto' : '']);
        });
        if (pts.length && opts.now && opts.now - pts[pts.length - 1].t > proc.gapMs) zero(pts[pts.length - 1].t, opts.now, opts.paused ? 'pause' : 'gap');
        return s;
    }

    function toGpx(proc, opts) {
        opts = opts || {};
        const S = proc.settings, X = S.extras;
        const esc = x => String(x).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
        const segs = [];
        proc.points.forEach(p => { if (p.newSeg || !segs.length) segs.push([]); segs[segs.length - 1].push(p); });
        const pt = p => {
            const tpx = [], sg = [];
            if (X.speed && Number.isFinite(p.speed)) tpx.push(`<gpxtpx:speed>${p.speed.toFixed(2)}</gpxtpx:speed>`);
            if (X.course && Number.isFinite(p.course)) tpx.push(`<gpxtpx:course>${p.course.toFixed(1)}</gpxtpx:course>`);
            if (X.acc && Number.isFinite(p.hAcc)) sg.push(`<sg:hacc>${p.hAcc.toFixed(1)}</sg:hacc>`);
            if (X.acc && Number.isFinite(p.vAcc)) sg.push(`<sg:vacc>${p.vAcc.toFixed(1)}</sg:vacc>`);
            if (X.acc && Number.isFinite(p.speedAcc)) sg.push(`<sg:speedacc>${p.speedAcc.toFixed(2)}</sg:speedacc>`);
            if (X.sats && Number.isFinite(p.satsL5)) sg.push(`<sg:satsl5>${p.satsL5}</sg:satsl5>`);
            if (X.pressure && Number.isFinite(p.p)) sg.push(`<sg:pressure>${p.p.toFixed(2)}</sg:pressure>`);
            const ext = tpx.length || sg.length ? `<extensions>${tpx.length ? `<gpxtpx:TrackPointExtension>${tpx.join('')}</gpxtpx:TrackPointExtension>` : ''}${sg.join('')}</extensions>` : '';
            return `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">${Number.isFinite(p.ele) ? `<ele>${p.ele.toFixed(1)}</ele>` : ''}<time>${new Date(p.t).toISOString()}</time>${X.sats && Number.isFinite(p.sats) ? `<sat>${p.sats}</sat>` : ''}${ext}</trkpt>`;
        };
        const first = proc.points[0];
        return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="SkyGuardian${opts.version ? ' ' + esc(opts.version) : ''}" xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v2" xmlns:sg="https://skyguardian.app/gpx/1">
  <metadata><name>${esc(opts.name || 'Percorso')}</name><time>${new Date(first ? first.t : Date.now()).toISOString()}</time>
    <desc>${esc(`Profilo ${S.profile}; intervallo ${S.intervalS} s; distanza minima ${S.minDistanceM} m; precisione massima ${S.maxHAcc} m; quota ${proc.elevationSource}`)}</desc></metadata>
  <trk><name>${esc(opts.name || 'Percorso')}</name>
${segs.map(s => `    <trkseg>\n${s.map(pt).join('\n')}\n    </trkseg>`).join('\n')}
  </trk>
</gpx>
`;
    }

    // File di recupero nativo (TrackStore): righe S,/T,/P,/R,
    function parseRecovered(lines) {
        let startedAt = 0, background = false, settings = {};
        const points = [], pauses = [];
        (lines || []).forEach(l => {
            const parts = l.split(',');
            if (parts[0] === 'S') { startedAt = +parts[1]; background = parts[2] === '1'; try { settings = JSON.parse(parts.slice(3).join(',')); } catch (e) { /* ignora */ } }
            else if (parts[0] === 'T') points.push(parts.slice(1).map(v => v === '' ? null : +v));
            else if (parts[0] === 'P') pauses.push([+parts[1], 0]);
            else if (parts[0] === 'R' && pauses.length) pauses[pauses.length - 1][1] = +parts[1];
        });
        return { startedAt, background, settings, points, pauses };
    }

    const fmtDuration = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
    const fmtPace = mps => { if (!(mps > 0.3)) return '—'; const sPerKm = 1000 / mps; return `${Math.floor(sPerKm / 60)}:${String(Math.round(sPerKm % 60)).padStart(2, '0')} min/km`; };
    const kmh = (mps, d) => (mps * 3.6).toLocaleString('it-IT', { minimumFractionDigits: d === undefined ? 1 : d, maximumFractionDigits: d === undefined ? 1 : d });

    // ---------------------------------------------------------------- curve di livello
    // Quote dai tile "Terrarium" (PNG: quota = R*256 + G + B/256 - 32768)
    const terrariumElevation = (r, g, b) => r * 256 + g + b / 256 - 32768;
    const contourInterval = z => z >= 14 ? 10 : z >= 13 ? 20 : z >= 12 ? 50 : z >= 10 ? 100 : 200;
    // Marching squares su una griglia w×h di quote: segmenti [x1,y1,x2,y2,quota] per ogni curva multipla di step
    function contourSegments(grid, w, h, step) {
        const out = [];
        for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
            const a = grid[y * w + x], b = grid[y * w + x + 1], c = grid[(y + 1) * w + x + 1], d = grid[(y + 1) * w + x];
            const lo = Math.min(a, b, c, d), hi = Math.max(a, b, c, d);
            for (let L = Math.ceil(lo / step) * step; L <= hi; L += step) {
                if (L === lo && L === hi) continue;
                const idx = (a >= L ? 8 : 0) | (b >= L ? 4 : 0) | (c >= L ? 2 : 0) | (d >= L ? 1 : 0);
                if (idx === 0 || idx === 15) continue;
                const t = (p, q) => (p === q ? 0.5 : (L - p) / (q - p));
                const top = [x + t(a, b), y], right = [x + 1, y + t(b, c)], bottom = [x + t(d, c), y + 1], left = [x, y + t(a, d)];
                const seg = (p1, p2) => out.push([p1[0], p1[1], p2[0], p2[1], L]);
                switch (idx) {
                    case 1: case 14: seg(left, bottom); break;
                    case 2: case 13: seg(bottom, right); break;
                    case 3: case 12: seg(left, right); break;
                    case 4: case 11: seg(top, right); break;
                    case 6: case 9: seg(top, bottom); break;
                    case 7: case 8: seg(left, top); break;
                    case 5: seg(left, top); seg(bottom, right); break;
                    case 10: seg(top, right); seg(left, bottom); break;
                }
            }
        }
        return out;
    }

    const calc = { GAP_MS, DEFAULTS, PROFILES, terrariumElevation, contourInterval, contourSegments, settingsFor, normalizeSettings, distanceM, fromArray, toArray, speedSigma, gpsAltitude,
                   process, stats, speedSeries, toGpx, parseRecovered, fmtDuration, fmtPace, kmh };

    // =====================================================================
    // ARCHIVIO (IndexedDB)
    // =====================================================================
    function openArchive() {
        return new Promise((resolve, reject) => {
            if (!root.indexedDB) { reject(new Error('IndexedDB non disponibile')); return; }
            const r = root.indexedDB.open('skyguardian-tracks', 1);
            r.onupgradeneeded = () => { r.result.createObjectStore('tracks', { keyPath: 'id' }); };
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
        });
    }
    async function archiveOp(mode, fn) {
        const db = await openArchive();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('tracks', mode), st = tx.objectStore('tracks');
            const req = fn(st);
            tx.oncomplete = () => { db.close(); resolve(req && req.result); };
            tx.onerror = () => { db.close(); reject(tx.error); };
        });
    }
    const archive = {
        list: () => archiveOp('readonly', st => st.getAll()).then(a => (a || []).map(({ points, ...rest }) => rest).sort((x, y) => y.startedAt - x.startedAt)),
        get: id => archiveOp('readonly', st => st.get(id)),
        put: rec => archiveOp('readwrite', st => st.put(rec)),
        remove: id => archiveOp('readwrite', st => st.delete(id)),
    };

    // =====================================================================
    // PANNELLO
    // =====================================================================
    const SETTINGS_KEY = 'skyguardian.track.settings';
    const LEGACY_KEY = 'skyguardian.track.last';

    function createPanel(opts) {
        const el = opts.elements, plugin = opts.plugin || null;
        const geoidAt = opts.geoidAt || (() => NaN);
        const version = opts.version || '';
        const state = { open: false, tracking: false, paused: false, background: false, startedAt: 0, endedAt: 0, raw: [], pauses: [],
                        live: null, watchId: null, previewId: null, handles: [], map: null, layers: null, renderPending: false,
                        geoidN: NaN, viewing: null, settings: loadSettings(), power: null, archive: [] };

        function loadSettings() { try { return normalizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null') || settingsFor('walk')); } catch (e) { return settingsFor('walk'); } }
        function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch (e) { /* ignora */ } }
        const esc = s => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

        function chip(text, color) {
            const c = { emerald: 'border-emerald-700 text-emerald-200 bg-emerald-950/40', amber: 'border-amber-700 text-amber-200 bg-amber-950/40',
                        slate: 'border-slate-600 text-slate-300 bg-slate-800/60', red: 'border-red-700 text-red-200 bg-red-950/40' }[color];
            return `<span class="inline-block text-[11px] px-2 py-0.5 rounded-full border ${c}">${text}</span>`;
        }

        // ---------- switch «Esegui in background» e controllo batteria ----------
        function bgOn() { return !!(plugin && el.bgSwitch.getAttribute('aria-checked') === 'true'); }
        function setBg(on) {
            el.bgSwitch.setAttribute('aria-checked', on ? 'true' : 'false');
            el.bgSwitch.classList.toggle('bg-blue-600', on); el.bgSwitch.classList.toggle('bg-slate-600', !on);
            el.bgKnob.classList.toggle('translate-x-5', on);
            try { localStorage.setItem('skyguardian.track.bg', on ? '1' : '0'); } catch (e) { /* ignora */ }
            renderCaps();
            if (on) refreshPower();
        }
        el.bgSwitch.addEventListener('click', () => { if (!plugin || state.tracking) return; setBg(!bgOn()); });
        async function refreshPower() {
            if (!plugin) return;
            try { state.power = await plugin.powerStatus(); } catch (e) { state.power = null; }
            renderPower();
        }
        function renderPower() {
            if (!plugin || !bgOn() || !state.power) { el.power.innerHTML = ''; return; }
            const P = state.power;
            const row = (ok, text, btn) => `<div class="flex items-start gap-2"><span>${ok ? '✅' : '⚠️'}</span><div class="flex-1">${text}</div>${!ok && btn ? btn : ''}</div>`;
            const btn = (id, t) => `<button type="button" data-pw="${id}" class="shrink-0 text-[11px] px-2 py-0.5 rounded border border-slate-500 text-slate-100 hover:bg-slate-700">${t}</button>`;
            const samsung = /samsung/i.test(P.manufacturer || '');
            el.power.innerHTML = `<div class="bg-slate-900/60 border border-slate-700 rounded-lg p-3 space-y-1.5 text-[12px] text-slate-300">
                <div class="text-[11px] uppercase tracking-wide text-slate-400">Per registrare senza interruzioni</div>
                ${row(P.ignoringBatteryOptimizations, 'Esenzione dall\'ottimizzazione batteria' + (P.ignoringBatteryOptimizations ? '' : ': senza, Android può sospendere il GPS'), btn('exempt', 'Consenti'))}
                ${row(!P.backgroundRestricted, samsung ? '«Consenti attività in background» nella scheda dell\'app (Batteria: <b>Senza restrizioni</b>)' : 'Attività in background consentita', btn('settings', 'Apri impostazioni'))}
                ${row(P.notifications, 'Notifiche (per vedere «SkyGuardian sta registrando» con Pausa e Ferma)', btn('settings', 'Apri impostazioni'))}
                ${P.powerSaveMode ? `<div class="flex items-start gap-2"><span>🔋</span><div>Risparmio energetico attivo${samsung ? ': con il risparmio <b>Massimo</b> SkyGuardian deve essere tra le app consentite (come hai già fatto)' : ''}. Il servizio con notifica e il processore sveglio continuano a registrare.</div></div>` : ''}
                ${P.fullGnssSupported ? '' : '<div class="text-[11px] text-slate-500">Tracciamento GNSS completo non disponibile (serve Android 12+).</div>'}
            </div>`;
            el.power.querySelectorAll('[data-pw]').forEach(b => b.addEventListener('click', async () => {
                try { if (b.dataset.pw === 'exempt') await plugin.requestBatteryExemption(); else await plugin.openAppSettings(); } catch (e) { say(e.message || String(e)); }
            }));
        }

        function renderCaps() {
            const chips = [];
            chips.push(plugin ? chip('📱 App Android: GPS nativo con velocità Doppler', 'emerald') : chip('🌍 Browser: GPS del dispositivo', 'slate'));
            if (version) chips.push(chip(`v${esc(version)}`, 'slate'));
            if (state.tracking) chips.push(state.paused ? chip('⏸ In pausa · GPS spento', 'slate') : state.background ? chip('🔔 Registra anche ad app chiusa', 'emerald') : chip(plugin ? '⚠️ Si ferma se chiudi l\'app' : '⚠️ Si ferma se lasci la pagina', 'amber'));
            el.caps.innerHTML = chips.join('');
            el.bgSwitch.disabled = !plugin || state.tracking;
            el.bgSwitch.classList.toggle('opacity-40', !plugin || state.tracking);
            el.bgNote.textContent = plugin
                ? (bgOn() ? 'Registra anche ad app chiusa e a schermo spento: notifica «SkyGuardian sta registrando» con Pausa e Ferma, processore tenuto sveglio. Ferma chiude tutto.' : 'Spento: se chiudi l\'app il GPS si ferma; quel periodo vale velocità zero e abbassa la media.')
                : 'Disponibile solo nell\'app Android. Nel browser il GPS si ferma se la pagina va in secondo piano.';
            renderPower();
        }

        // ---------- impostazioni avanzate ----------
        const FIELDS = [
            ['intervalS', 'Intervallo tra i punti', 's', 'Ogni quanti secondi registrare un punto (1 = massimo dettaglio).', 1, 120, 1],
            ['minDistanceM', 'Distanza minima tra i punti', 'm', 'Un nuovo punto solo dopo questi metri (0 = nessun limite).', 0, 500, 1],
            ['maxHAcc', 'Precisione minima del punto', 'm', 'Scarta i punti con errore di posizione maggiore.', 2, 500, 1],
            ['warmupAcc', 'Precisione per iniziare', 'm', 'Ignora i primi fix finché l\'errore non scende sotto questo valore.', 2, 500, 1],
            ['maxSpeedAccKmh', 'Errore di velocità ammesso', 'km/h', 'Oltre questo errore la velocità del punto non viene usata.', 0.2, 100, 0.1],
            ['minSpeedKmh', 'Velocità minima (in movimento)', 'km/h', 'Sotto questa velocità sei fermo: niente distanza né tempo in movimento.', 0, 50, 0.1],
            ['maxSpeedKmh', 'Velocità massima plausibile', 'km/h', 'Scarta i salti di posizione più veloci di così (errori GPS).', 2, 2000, 1],
            ['autoPauseKmh', 'Pausa automatica: sotto', 'km/h', 'Velocità sotto la quale scatta la pausa automatica.', 0, 50, 0.1],
            ['autoPauseS', 'Pausa automatica: dopo', 's', 'Secondi di fila sotto la soglia prima della pausa automatica.', 3, 3600, 1],
        ];
        function renderSettings() {
            const S = state.settings, dis = state.tracking ? 'disabled' : '';
            el.profile.innerHTML = Object.entries(PROFILES).map(([k, p]) => `<option value="${k}" ${S.profile === k ? 'selected' : ''}>${p.label}</option>`).join('')
                + `<option value="custom" ${S.profile === 'custom' ? 'selected' : ''}>Personalizzato</option>`;
            el.profile.disabled = state.tracking;
            const input = ([k, label, unit, help, min, max, step]) => `<label class="block bg-slate-900/50 border border-slate-700 rounded-lg p-2">
                <div class="flex items-center justify-between gap-2"><span class="text-[12px] text-slate-200">${label}</span>
                <span class="flex items-center gap-1"><input data-k="${k}" type="number" min="${min}" max="${max}" step="${step}" value="${S[k]}" ${dis} class="w-20 px-1.5 py-0.5 text-right text-sm bg-slate-700 border border-slate-600 rounded text-white disabled:opacity-50"><span class="text-[11px] text-slate-400 w-9">${unit}</span></span></div>
                <div class="text-[10px] text-slate-500 mt-0.5">${help}</div></label>`;
            const check = (k, label, help, extra) => `<label class="flex items-start gap-2 bg-slate-900/50 border border-slate-700 rounded-lg p-2">
                <input data-c="${k}" type="checkbox" ${(extra ? S.extras[k] : S[k]) ? 'checked' : ''} ${dis} ${extra ? 'data-extra="1"' : ''} class="mt-0.5 w-4 h-4 accent-blue-500"><span><span class="text-[12px] text-slate-200">${label}</span><br><span class="text-[10px] text-slate-500">${help}</span></span></label>`;
            el.settings.innerHTML = `
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">${FIELDS.map(input).join('')}</div>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
                    ${check('autoPause', 'Pausa automatica', 'Si ferma da sola quando sei fermo e riparte quando ti muovi (nuovo segmento GPX).')}
                    ${check('fullGnss', 'Tracciamento GNSS completo', 'Il chip GNSS non fa pause per risparmiare: più preciso, consuma di più (Android 12+, solo app). La frequenza L1/L5 la sceglie il telefono.')}
                    ${check('keepAwake', 'Processore sempre sveglio in background', 'Evita che il GPS si addormenti a schermo spento (solo app, solo durante la registrazione).')}
                    <label class="block bg-slate-900/50 border border-slate-700 rounded-lg p-2"><span class="text-[12px] text-slate-200">Fonte della quota</span>
                        <select data-k="elevation" ${dis} class="mt-1 w-full px-1.5 py-1 text-sm bg-slate-700 border border-slate-600 rounded text-white disabled:opacity-50">
                            <option value="combined" ${S.elevation === 'combined' ? 'selected' : ''}>Combinata: barometro tarato sul GPS di tutto il percorso</option>
                            <option value="baro" ${S.elevation === 'baro' ? 'selected' : ''}>Barometro tarato sul GPS del primo minuto</option>
                            <option value="gps" ${S.elevation === 'gps' ? 'selected' : ''}>Solo GPS</option>
                        </select><span class="text-[10px] text-slate-500">Il barometro (solo app) misura salite e discese molto meglio del GPS.</span></label>
                </div>
                <div class="mt-2 bg-slate-900/50 border border-slate-700 rounded-lg p-2">
                    <div class="text-[12px] text-slate-200 mb-1">Dati extra nel GPX</div>
                    <div class="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-slate-300">
                        ${[['acc', 'precisione'], ['sats', 'satelliti'], ['speed', 'velocità'], ['course', 'direzione'], ['pressure', 'pressione']].map(([k, l]) => `<label class="flex items-center gap-1"><input data-c="${k}" data-extra="1" type="checkbox" ${S.extras[k] ? 'checked' : ''} ${dis} class="w-4 h-4 accent-blue-500">${l}</label>`).join('')}
                    </div>
                    <div class="text-[10px] text-slate-500 mt-1">Velocità e direzione nel formato Garmin (letto da Strava, OsmAnd, Garmin); satelliti nel campo standard GPX.</div>
                </div>`;
            el.settings.querySelectorAll('[data-k]').forEach(i => i.addEventListener('change', () => {
                state.settings = normalizeSettings(Object.assign({}, state.settings, { [i.dataset.k]: i.tagName === 'SELECT' ? i.value : +i.value, profile: 'custom' }));
                saveSettings(); renderSettings(); recompute();
            }));
            el.settings.querySelectorAll('[data-c]').forEach(i => i.addEventListener('change', () => {
                const S2 = Object.assign({}, state.settings, { profile: 'custom' });
                if (i.dataset.extra) S2.extras = Object.assign({}, S2.extras, { [i.dataset.c]: i.checked }); else S2[i.dataset.c] = i.checked;
                state.settings = normalizeSettings(S2); saveSettings(); renderSettings(); recompute();
            }));
        }
        el.profile.addEventListener('change', () => {
            if (el.profile.value === 'custom') { state.settings.profile = 'custom'; saveSettings(); return; }
            state.settings = normalizeSettings(settingsFor(el.profile.value, state.settings));
            saveSettings(); renderSettings(); recompute();
            say(`Profilo «${PROFILES[el.profile.value].label}» applicato: puoi ritoccare i valori.`, 3000);
        });

        // ---------- velocità istantanea (anche senza percorso, solo a pannello aperto) ----------
        async function startPreview() {
            if (state.tracking || state.previewOn) return;
            state.previewOn = true;
            if (plugin) {
                try {
                    const h = await plugin.addListener('fix', e => onLive(fromArray(e.p))); h.kind = 'fix';
                    state.handles.push(h);
                    const r = await plugin.startPreview();
                    if (!r.gps) say('GPS spento: attivalo nelle impostazioni di Android.');
                } catch (e) { say('📍 ' + (e.message || e)); state.previewOn = false; }
            } else if (navigator.geolocation) {
                state.previewId = navigator.geolocation.watchPosition(pos => onLive(fromBrowser(pos)), geoErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
            }
        }
        function stopPreview() {
            if (!state.previewOn) return;
            state.previewOn = false;
            if (plugin) { plugin.stopPreview().catch(() => {}); removeHandle('fix'); }
            if (state.previewId !== null) { navigator.geolocation.clearWatch(state.previewId); state.previewId = null; }
        }
        function removeHandle(kind) {
            state.handles = state.handles.filter(h => { if (!kind || h.kind === kind) { try { h.remove(); } catch (e) { /* ignora */ } return false; } return true; });
        }
        function fromBrowser(pos) {
            const c = pos.coords;
            return { t: pos.timestamp, lat: c.latitude, lon: c.longitude, hAcc: c.accuracy, speed: c.speed === null ? NaN : c.speed, speedAcc: NaN,
                     msl: NaN, alt: c.altitude === null ? NaN : c.altitude, vAcc: c.altitudeAccuracy === null ? NaN : c.altitudeAccuracy, p: NaN,
                     sats: NaN, satsL5: NaN, course: c.heading === null ? NaN : c.heading };
        }
        function geoErr(err) { say(err.code === 1 ? '📍 Permesso di posizione negato.' : '📍 Posizione non disponibile (prova all\'aperto).'); }
        function onLive(p) {
            if (!Number.isFinite(state.geoidN) && Number.isFinite(p.lat)) state.geoidN = geoidAt(p.lat, p.lon);
            state.live = p;
            scheduleRender();
        }

        // ---------- percorso: Avvia / Pausa / Riprendi / Ferma ----------
        async function startTrack() {
            const background = bgOn();
            stopPreview();
            state.raw = []; state.pauses = []; state.viewing = null; state.paused = false; state.background = background; state.endedAt = 0;
            state.trackSettings = normalizeSettings(state.settings);
            if (plugin) {
                try {
                    await attachTrackListeners();
                    const r = await plugin.start({ background, settings: state.trackSettings });
                    state.startedAt = r.startedAt || Date.now();
                    if (background) { state.power = r; renderPower(); if (r.notifications === false) say('Notifiche negate: la registrazione continua ma la notifica non è visibile.', 6000); }
                } catch (e) { removeHandle(); say('📍 ' + (e.message || e)); startPreview(); return; }
            } else {
                if (!navigator.geolocation) { say('Geolocalizzazione non disponibile su questo browser.'); return; }
                state.startedAt = Date.now();
                startBrowserWatch();
            }
            state.tracking = true;
            renderAll();
            state.ticker = setInterval(scheduleRender, 1000);
        }
        function startBrowserWatch() {
            state.watchId = navigator.geolocation.watchPosition(pos => onPoint(fromBrowser(pos)), geoErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
        }
        async function attachTrackListeners() {
            removeHandle();
            const add = async (ev, fn) => { const h = await plugin.addListener(ev, fn); h.kind = ev; state.handles.push(h); };
            await add('point', e => onPoint(fromArray(e.p)));
            await add('stopped', () => finishTrack(true));
            await add('paused', () => { if (state.tracking && !state.paused) { state.paused = true; state.pauses.push([Date.now(), 0]); renderAll(); } });
            await add('resumed', () => { if (state.tracking && state.paused) { state.paused = false; closePause(Date.now()); renderAll(); } });
        }
        function closePause(t) { const l = state.pauses[state.pauses.length - 1]; if (l && !l[1]) l[1] = t; }
        function onPoint(p) {
            if (!state.tracking || state.paused) return;
            if (state.raw.length && p.t <= state.raw[state.raw.length - 1].t) return;
            state.raw.push(p);
            onLive(p);
        }
        async function pauseTrack() {
            if (!state.tracking || state.paused) return;
            state.paused = true; state.pauses.push([Date.now(), 0]);
            if (plugin) await plugin.pause().catch(e => say(e.message || String(e)));
            else if (state.watchId !== null) { navigator.geolocation.clearWatch(state.watchId); state.watchId = null; }
            renderAll();
        }
        async function resumeTrack() {
            if (!state.tracking || !state.paused) return;
            state.paused = false; closePause(Date.now());
            if (plugin) await plugin.resume().catch(e => say(e.message || String(e)));
            else startBrowserWatch();
            renderAll();
        }
        async function finishTrack(fromNotification) {
            if (!state.tracking) return;
            state.tracking = false;
            clearInterval(state.ticker);
            if (plugin) {
                try { await syncPoints(); } catch (e) { /* ignora */ }
                if (!fromNotification) await plugin.stop().catch(() => {});
                removeHandle();
            }
            if (state.watchId !== null) { navigator.geolocation.clearWatch(state.watchId); state.watchId = null; }
            if (state.paused) closePause(Date.now());
            state.paused = false;
            state.endedAt = Date.now();
            await saveToArchive({ startedAt: state.startedAt, endedAt: state.endedAt, background: state.background, settings: state.trackSettings, raw: state.raw, pauses: state.pauses });
            renderAll();
            if (state.open && document.visibilityState !== 'hidden') startPreview();
        }
        async function syncPoints() {
            if (!plugin) return;
            const r = await plugin.getPoints({ from: state.raw.length });
            (r.points || []).map(fromArray).forEach(p => { if (!state.raw.length || p.t > state.raw[state.raw.length - 1].t) state.raw.push(p); });
            if (Array.isArray(r.pauses)) state.pauses = r.pauses.map(([a, b]) => [+a, +b || 0]);
            if (typeof r.paused === 'boolean') state.paused = r.paused;
        }

        // ---------- archivio ----------
        function summaryOf(rec) {
            const proc = process(rec.raw, { settings: rec.settings, pauses: rec.pauses, geoidN: state.geoidN });
            const st = stats(proc, { startedAt: rec.startedAt, now: rec.endedAt });
            return { distance: st.distance, elapsed: st.elapsed, avg: st.avg, points: proc.points.length };
        }
        async function saveToArchive(t, nameSuffix) {
            if (!t.raw.length) { say('Percorso senza punti: non salvato.', 4000); return null; }
            const d = new Date(t.startedAt);
            const rec = { id: 't' + t.startedAt, name: `Percorso ${d.toLocaleDateString('it-IT')} ${d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}${nameSuffix || ''}`,
                          startedAt: t.startedAt, endedAt: t.endedAt, background: !!t.background, settings: normalizeSettings(t.settings), pauses: t.pauses,
                          points: t.raw.map(toArray), version };
            rec.summary = summaryOf({ raw: t.raw, settings: rec.settings, pauses: rec.pauses, startedAt: rec.startedAt, endedAt: rec.endedAt });
            try { await archive.put(rec); state.viewing = rec.id; await refreshArchive(); say(`💾 Salvato nell'archivio: ${rec.name}`, 4000); }
            catch (e) { say('Archivio non disponibile: ' + (e.message || e) + '. Esporta il GPX per non perdere il percorso.'); }
            return rec;
        }
        async function refreshArchive() {
            try { state.archive = await archive.list(); } catch (e) { state.archive = []; }
            renderArchive();
        }
        function renderArchive() {
            if (!state.archive.length) { el.archive.innerHTML = '<p class="text-[12px] text-slate-500 italic">Nessun percorso salvato.</p>'; return; }
            el.archive.innerHTML = state.archive.map(r => {
                const s = r.summary || {};
                const on = state.viewing === r.id && !state.tracking;
                return `<div class="flex flex-wrap items-center gap-2 p-2 rounded-lg border ${on ? 'border-blue-500 bg-blue-950/30' : 'border-slate-700 bg-slate-900/40'}">
                    <div class="flex-1 min-w-[10rem]"><div class="text-sm text-white">${esc(r.name)}</div>
                    <div class="text-[11px] text-slate-400">${((s.distance || 0) / 1000).toLocaleString('it-IT', { maximumFractionDigits: 2 })} km · ${fmtDuration(s.elapsed || 0)} · media ${kmh(s.avg || 0)} km/h${r.background ? ' · background' : ''}${r.settings ? ' · ' + esc((PROFILES[r.settings.profile] || { label: 'personalizzato' }).label.toLowerCase()) : ''}</div></div>
                    <button type="button" data-a="open" data-id="${r.id}" class="text-[11px] px-2 py-1 rounded border border-slate-600 text-slate-100 hover:bg-slate-700">👁 Apri</button>
                    <button type="button" data-a="gpx" data-id="${r.id}" class="text-[11px] px-2 py-1 rounded border border-slate-600 text-slate-100 hover:bg-slate-700">⬇️ GPX</button>
                    <button type="button" data-a="del" data-id="${r.id}" class="text-[11px] px-2 py-1 rounded border border-red-800 text-red-200 hover:bg-red-950">🗑 Elimina</button>
                </div>`;
            }).join('');
            el.archive.querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', () => archiveAction(b.dataset.a, b.dataset.id)));
        }
        async function archiveAction(a, id) {
            const rec = await archive.get(id).catch(() => null);
            if (!rec) return;
            if (a === 'del') {
                if (!confirm(`Eliminare «${rec.name}»? L'operazione non si può annullare.`)) return;
                await archive.remove(id);
                if (state.viewing === id) { state.viewing = null; if (!state.tracking) { state.raw = []; state.pauses = []; } }
                await refreshArchive(); render(); return;
            }
            if (a === 'gpx') { exportGpx(rec); return; }
            if (a === 'open' && !state.tracking) {
                state.viewing = id; state.raw = rec.points.map(fromArray); state.pauses = rec.pauses || []; state.startedAt = rec.startedAt; state.endedAt = rec.endedAt;
                state.background = rec.background; state.trackSettings = normalizeSettings(rec.settings);
                state.drawnCount = -1;
                renderArchive(); render();
            }
        }
        async function exportGpx(rec) {
            const raw = rec.points.map(fromArray);
            const d = new Date(rec.startedAt);
            const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
            const name = `skyguardian-${stamp}.gpx`;
            const proc = process(raw, { settings: rec.settings, pauses: rec.pauses, geoidN: Number.isFinite(state.geoidN) ? state.geoidN : (raw[0] ? geoidAt(raw[0].lat, raw[0].lon) : NaN) });
            const gpx = toGpx(proc, { name: rec.name, version });
            if (plugin) { try { await plugin.exportGpx({ name, gpx }); } catch (e) { say('GPX: ' + (e.message || e)); } return; }
            const url = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
            const link = document.createElement('a');
            link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
        }
        // percorso rimasto a metà (app chiusa dal sistema) e vecchio «ultimo percorso»
        async function recoverInterrupted() {
            if (plugin) {
                try {
                    const r = await plugin.recover();
                    if (r.found) {
                        const t = parseRecovered(r.lines);
                        if (t.points.length) {
                            await saveToArchive({ startedAt: t.startedAt, endedAt: t.points[t.points.length - 1][0], background: t.background, settings: t.settings, raw: t.points.map(fromArray), pauses: t.pauses }, ' (recuperato)');
                            say('⚠️ Il sistema aveva chiuso l\'app durante un percorso: i punti registrati fino a quel momento sono stati recuperati nell\'archivio.', 8000);
                        }
                        await plugin.discardRecovered();
                    }
                } catch (e) { /* plugin non pronto */ }
            }
            try {
                const d = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null');
                if (d && d.points && d.points.length) {
                    await saveToArchive({ startedAt: d.startedAt, endedAt: d.endedAt, background: d.background, settings: settingsFor('walk'), raw: d.points.map(fromArray), pauses: [] });
                    localStorage.removeItem(LEGACY_KEY);
                }
            } catch (e) { /* ignora */ }
        }

        // ---------- interfaccia ----------
        let sayTimer = null;
        function say(msg, ms) { el.status.textContent = msg || ''; clearTimeout(sayTimer); if (ms) sayTimer = setTimeout(() => { el.status.textContent = ''; }, ms); }
        function renderButtons() {
            el.startBtn.classList.toggle('hidden', state.tracking);
            el.pauseBtn.classList.toggle('hidden', !state.tracking);
            el.stopBtn.classList.toggle('hidden', !state.tracking);
            el.pauseBtn.textContent = state.paused ? '▶ Riprendi' : '⏸ Pausa';
        }
        function renderAll() { renderButtons(); renderCaps(); renderSettings(); renderArchive(); render(); }
        el.startBtn.addEventListener('click', startTrack);
        el.pauseBtn.addEventListener('click', () => state.paused ? resumeTrack() : pauseTrack());
        el.stopBtn.addEventListener('click', () => finishTrack(false));

        function scheduleRender() {
            if (state.renderPending) return;
            state.renderPending = true;
            requestAnimationFrame(() => { state.renderPending = false; render(); });
        }
        function recompute() { state.drawnCount = -1; scheduleRender(); }
        function currentProc() {
            return process(state.raw, { settings: state.trackSettings || state.settings, pauses: state.pauses, geoidN: state.geoidN });
        }
        function render() {
            const p = state.live;
            const fresh = p && Date.now() - p.t < 5000 && !(state.tracking && state.paused);
            if (fresh && Number.isFinite(p.speed)) {
                const sg = speedSigma(p);
                el.speed.textContent = kmh(p.speed);
                el.speedErr.textContent = `± ${kmh(sg.sigma)} km/h${sg.estimated ? ' (stimato)' : ''}`;
            } else {
                el.speed.textContent = '—';
                el.speedErr.textContent = state.tracking && state.paused ? 'in pausa · GPS spento' : fresh ? 'velocità non fornita dal GPS' : (state.open ? 'in attesa del segnale GPS…' : '');
            }
            el.fixInfo.textContent = fresh ? `precisione posizione ±${Number.isFinite(p.hAcc) ? Math.round(p.hAcc) : '?'} m${Number.isFinite(p.sats) ? ` · ${p.sats} satelliti${p.satsL5 ? `, ${p.satsL5} su L5` : ''}` : ''}` : '';
            const has = state.raw.length || state.tracking;
            const lastT = state.raw.length ? state.raw[state.raw.length - 1].t : 0;
            const now = Math.max(lastT, state.tracking ? Date.now() : (state.endedAt || lastT));
            const proc = currentProc();
            const st = stats(proc, { startedAt: state.startedAt, now, live: state.tracking && !state.paused });
            const cell = (k, v, sub) => `<div class="bg-slate-900/60 border border-slate-700 rounded-lg p-2"><div class="text-[10px] uppercase tracking-wide text-slate-400">${k}</div><div class="text-lg font-bold text-white leading-tight">${v}</div>${sub ? `<div class="text-[10px] text-slate-500">${sub}</div>` : ''}</div>`;
            const eleSrc = { gps: 'dal GPS', baro: 'dal barometro', combined: 'barometro + GPS' }[st.elevationSource];
            el.stats.innerHTML = has ? [
                cell('Velocità media', `${kmh(st.avg)} km/h`, `escluse le pause · ${fmtPace(st.avg)}`),
                cell('Media in movimento', `${kmh(st.avgMoving)} km/h`, fmtPace(st.avgMoving)),
                cell('Distanza', `${(st.distance / 1000).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} km`, `${proc.points.length} punti validi`),
                cell('Durata', fmtDuration(st.elapsed), `in movimento ${fmtDuration(st.moving)}${st.pauseTime ? ` · pause ${fmtDuration(st.pauseTime)}` : ''}`),
                cell('Velocità massima', `${kmh(st.max)} km/h`),
                cell('Quota', Number.isFinite(st.altitude) ? `${Math.round(st.altitude)} m` : '—', `s.l.m. · ${eleSrc}`),
                cell('Salita', `${Math.round(st.gain)} m`, eleSrc),
                cell('Discesa', `${Math.round(st.loss)} m`, eleSrc),
            ].join('') : '';
            const rj = proc.rejected, rjTot = Object.values(rj).reduce((a, b) => a + b, 0);
            el.filterNote.textContent = has && (rjTot || proc.autoPauses.length)
                ? `Filtri: ${[rj.warmup && `${rj.warmup} in attesa di precisione`, rj.accuracy && `${rj.accuracy} poco precisi`, rj.interval && `${rj.interval} per intervallo`, rj.distance && `${rj.distance} per distanza minima`, rj.jump && `${rj.jump} salti impossibili`, rj.speedAcc && `${rj.speedAcc} velocità incerte`].filter(Boolean).join(', ') || 'nessun punto scartato'}${proc.autoPauses.length ? ` · pausa automatica ${fmtDuration(st.autoPauseTime)}` : ''}. I dati grezzi restano salvati: cambiando le impostazioni il calcolo si aggiorna.`
                : '';
            el.gapNote.textContent = st.gapTime > 0
                ? `⚠️ ${fmtDuration(st.gapTime)} senza GPS (${st.gaps.length} ${st.gaps.length === 1 ? 'interruzione' : 'interruzioni'}, app chiusa o sospesa dal sistema): nel grafico vale velocità zero e abbassa la media.`
                : '';
            const viewingRec = state.viewing && state.archive.find(r => r.id === state.viewing);
            el.trackInfo.textContent = state.tracking ? `${state.paused ? 'In pausa' : 'Registrazione in corso'} · ${state.raw.length} punti grezzi` : (viewingRec ? `Visualizzi: ${viewingRec.name}` : '');
            el.chartBox.classList.toggle('hidden', !has);
            el.mapBox.classList.toggle('hidden', !state.raw.length);
            drawChart(proc, st, now);
            drawMap(proc);
            renderButtons();
        }

        // Modalità del grafico: 'speed' | 'alt' | 'both'
        try { state.chartMode = localStorage.getItem('skyguardian.track.chart') || 'both'; } catch (e) { state.chartMode = 'both'; }
        if (el.chartModes) el.chartModes.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
            state.chartMode = b.dataset.mode;
            try { localStorage.setItem('skyguardian.track.chart', state.chartMode); } catch (e) { /* ignora */ }
            render();
        }));
        function drawChart(proc, st, now) {
            const c = el.chart;
            const w = c.clientWidth, h = c.clientHeight;
            if (!w || !h) return;
            const mode = state.chartMode, showV = mode !== 'alt', showA = mode !== 'speed';
            if (el.chartModes) el.chartModes.querySelectorAll('[data-mode]').forEach(b => {
                const on = b.dataset.mode === mode;
                b.classList.toggle('bg-blue-600', on); b.classList.toggle('text-white', on); b.classList.toggle('text-slate-300', !on);
            });
            if (el.chartLegend) el.chartLegend.innerHTML = [
                showV && '<span class="text-sky-400">━</span> velocità', showV && '<span class="text-amber-400">┅</span> media',
                showA && '<span class="text-emerald-400">━</span> altitudine', '<span class="text-red-400">■</span> senza GPS', '<span class="text-slate-400">■</span> pausa'].filter(Boolean).join(' · ');
            const dpr = Math.min(window.devicePixelRatio || 1, 3);
            if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
            const ctx = c.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);
            const t0 = state.startedAt || (proc.points[0] && proc.points[0].t) || now, t1 = Math.max(now, t0 + 60000);
            const series = speedSeries(proc, { startedAt: t0, now: state.tracking ? now : null, paused: state.paused });
            const vmax = Math.max(10, ...series.map(s => s[1])) * 1.15;
            const eles = proc.points.map(p => p.ele).filter(Number.isFinite);
            let amin = eles.length ? Math.min(...eles) : 0, amax = eles.length ? Math.max(...eles) : 100;
            const span = Math.max(20, amax - amin);
            amin = Math.floor((amin - span * 0.1) / 5) * 5; amax = Math.ceil((amax + span * 0.1) / 5) * 5;
            const L = showV ? 34 : 6, R = showA ? 40 : 6, B = 18, T = 8;
            const X = t => L + (t - t0) / (t1 - t0) * (w - L - R);
            const Yv = v => T + (1 - v / vmax) * (h - T - B), Ya = a => T + (1 - (a - amin) / (amax - amin)) * (h - T - B);
            ctx.font = '10px system-ui, sans-serif'; ctx.lineWidth = 1;
            // griglia e assi
            const gridLine = y => { ctx.strokeStyle = 'rgba(148,163,184,0.18)'; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - R, y); ctx.stroke(); };
            if (showV) {
                const step = vmax > 60 ? 20 : vmax > 25 ? 10 : 5;
                ctx.fillStyle = '#7dd3fc'; ctx.textAlign = 'right';
                for (let v = 0; v <= vmax; v += step) { gridLine(Yv(v)); ctx.fillText(String(v), L - 4, Yv(v) + 3); }
            }
            if (showA) {
                const rng = amax - amin, aStep = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find(s => rng / s <= 6) || 1000;
                ctx.fillStyle = '#6ee7b7'; ctx.textAlign = 'left';
                for (let a = Math.ceil(amin / aStep) * aStep; a <= amax; a += aStep) { if (!showV) gridLine(Ya(a)); ctx.fillText(String(a), w - R + 4, Ya(a) + 3); }
            }
            ctx.fillStyle = '#94a3b8'; ctx.textAlign = 'center';
            for (let k = 0; k <= 4; k++) { const t = t0 + (t1 - t0) * k / 4; ctx.fillText(fmtDuration(t - t0).replace(/^0:/, ''), Math.min(w - R - 10, Math.max(L + 10, X(t))), h - 4); }
            // pause, pausa automatica, periodi senza GPS
            const band = (a, b, color) => { ctx.fillStyle = color; ctx.fillRect(X(a), T, Math.max(1, X(b) - X(a)), h - T - B); };
            proc.pauses.forEach(([a, b]) => band(a, b || now, 'rgba(148,163,184,0.22)'));
            proc.autoPauses.forEach(([a, b]) => band(a, b, 'rgba(148,163,184,0.10)'));
            st.gaps.forEach(g => band(g.from, g.to, 'rgba(239,68,68,0.16)'));
            // altitudine (area tenue + linea), interrotta nei buchi
            if (showA && eles.length) {
                const segs = [];
                proc.points.forEach(p => { if (!Number.isFinite(p.ele)) return; if (p.newSeg || !segs.length) segs.push([]); segs[segs.length - 1].push(p); });
                segs.forEach(sg => {
                    if (!showV && sg.length > 1) {
                        ctx.fillStyle = 'rgba(52,211,153,0.15)'; ctx.beginPath();
                        ctx.moveTo(X(sg[0].t), h - B); sg.forEach(p => ctx.lineTo(X(p.t), Ya(p.ele))); ctx.lineTo(X(sg[sg.length - 1].t), h - B); ctx.closePath(); ctx.fill();
                    }
                    ctx.strokeStyle = '#34d399'; ctx.lineWidth = 1.8; ctx.beginPath();
                    sg.forEach((p, i) => { if (i) ctx.lineTo(X(p.t), Ya(p.ele)); else ctx.moveTo(X(p.t), Ya(p.ele)); });
                    ctx.stroke();
                });
            }
            // velocità e media
            if (showV) {
                ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 1.8; ctx.beginPath();
                series.forEach(([t, v], i) => { const x = X(t), y = Yv(v); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
                ctx.stroke();
                if (st.avg > 0) {
                    ctx.setLineDash([5, 4]); ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 1.2;
                    ctx.beginPath(); ctx.moveTo(L, Yv(st.avg * 3.6)); ctx.lineTo(w - R, Yv(st.avg * 3.6)); ctx.stroke(); ctx.setLineDash([]);
                    ctx.fillStyle = '#fbbf24'; ctx.textAlign = 'left'; ctx.fillText(`media ${kmh(st.avg)}`, L + 4, Yv(st.avg * 3.6) - 3);
                }
            }
            ctx.textAlign = 'left';
            if (showV) { ctx.fillStyle = '#7dd3fc'; ctx.fillText('km/h', 2, h - 4); }
            if (showA) { ctx.fillStyle = '#6ee7b7'; ctx.textAlign = 'right'; ctx.fillText('m', w - 2, h - 4); }
        }

        function drawMap(proc) {
            if (!state.raw.length || !root.L || el.mapBox.classList.contains('hidden')) return;
            const L = root.L, pts = proc.points;
            if (!state.map) {
                state.map = L.map(el.map, { zoomControl: true, attributionControl: true, maxZoom: 18 });
                const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
                const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, subdomains: 'abc', attribution: '© OpenTopoMap (CC-BY-SA), © OpenStreetMap' });
                const contours = contourLayer(L);
                osm.addTo(state.map); contours.addTo(state.map);
                L.control.layers({ 'Stradale': osm, 'Topografica': topo }, { 'Curve di livello': contours }, { collapsed: true }).addTo(state.map);
                const legend = L.control({ position: 'topleft' });
                legend.onAdd = () => { const d = L.DomUtil.create('div'); d.style.cssText = 'background:rgba(15,23,42,.75);color:#e2e8f0;font:11px system-ui;padding:2px 6px;border-radius:4px'; state.contourLegend = d; return d; };
                legend.addTo(state.map);
                const updLegend = () => {
                    if (!state.contourLegend) return;
                    const on = state.map.hasLayer(contours), iv = contourInterval(Math.min(15, Math.round(state.map.getZoom())));
                    state.contourLegend.textContent = on ? `Curve di livello ogni ${iv} m (marcate ogni ${iv * 5} m)` : '';
                    state.contourLegend.style.display = on ? '' : 'none';
                };
                state.map.on('zoomend overlayadd overlayremove', updLegend);
                state.updLegend = updLegend;
                state.layers = L.layerGroup().addTo(state.map);
                state.fitted = 0;
            }
            const key = `${pts.length}|${state.tracking}|${state.viewing}|${JSON.stringify(state.trackSettings || state.settings)}`;
            if (state.drawnKey === key && state.drawnCount !== -1) return;
            state.drawnKey = key; state.drawnCount = pts.length;
            state.layers.clearLayers();
            if (!pts.length) return;
            const segs = [];
            pts.forEach((p, i) => {
                if (p.newSeg || !segs.length) {
                    if (i) L.polyline([[pts[i - 1].lat, pts[i - 1].lon], [p.lat, p.lon]], { color: '#ef4444', weight: 2, dashArray: '4 6' }).addTo(state.layers);
                    segs.push([]);
                }
                segs[segs.length - 1].push([p.lat, p.lon]);
            });
            segs.filter(s => s.length > 1).forEach(s => L.polyline(s, { color: '#38bdf8', weight: 4 }).addTo(state.layers));
            const first = pts[0], last = pts[pts.length - 1];
            L.circleMarker([first.lat, first.lon], { radius: 6, color: '#22c55e', fillOpacity: 1 }).addTo(state.layers);
            L.circleMarker([last.lat, last.lon], { radius: 6, color: state.tracking ? '#f8fafc' : '#ef4444', fillOpacity: 1 }).addTo(state.layers);
            state.map.invalidateSize();
            if (state.updLegend) setTimeout(state.updLegend, 0);
            const all = pts.map(p => [p.lat, p.lon]);
            if (!state.tracking || !state.fitted || pts.length - state.fitted > 30) {
                if (all.length > 1) state.map.fitBounds(all, { padding: [20, 20], maxZoom: 17 }); else state.map.setView(all[0], 16);
                state.fitted = pts.length;
            }
        }

        // Curve di livello calcolate dai tile di quota Terrarium (DEM SRTM/Copernicus, AWS Open Data)
        function contourLayer(L) {
            const Layer = L.GridLayer.extend({
                createTile(coords, done) {
                    const tile = document.createElement('canvas');
                    const size = this.getTileSize();
                    tile.width = size.x; tile.height = size.y;
                    const img = new Image();
                    img.crossOrigin = 'anonymous';
                    img.onload = () => {
                        try { drawContours(tile, img, coords.z); } catch (e) { /* tile non leggibile */ }
                        done(null, tile);
                    };
                    img.onerror = () => done(null, tile);
                    img.src = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${coords.z}/${coords.x}/${coords.y}.png`;
                    return tile;
                },
            });
            return new Layer({ maxNativeZoom: 15, maxZoom: 18, opacity: 0.9, attribution: 'Curve: DEM Terrarium (AWS)' });
        }
        function drawContours(tile, img, z) {
            const S = 256, step = 2, n = S / step + 1;
            const cv = document.createElement('canvas'); cv.width = S; cv.height = S;
            const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
            const d = cx.getImageData(0, 0, S, S).data;
            const raw = new Float32Array(S * S);
            for (let i = 0; i < S * S; i++) raw[i] = terrariumElevation(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
            // griglia ogni 2 px, leggermente smussata (media 3×3) per curve meno seghettate
            const g = new Float32Array(n * n);
            for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
                const px = Math.min(S - 1, x * step), py = Math.min(S - 1, y * step);
                let sum = 0, k = 0;
                for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                    const qx = px + dx, qy = py + dy;
                    if (qx >= 0 && qy >= 0 && qx < S && qy < S) { sum += raw[qy * S + qx]; k++; }
                }
                g[y * n + x] = sum / k;
            }
            const iv = contourInterval(z);
            const segs = contourSegments(g, n, n, iv);
            const ctx = tile.getContext('2d');
            const scale = tile.width / S * step;
            ctx.lineCap = 'round';
            [[false, 'rgba(146,64,14,0.55)', 0.8], [true, 'rgba(120,53,15,0.9)', 1.6]].forEach(([major, color, lw]) => {
                ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.beginPath();
                segs.forEach(([x1, y1, x2, y2, Lv]) => {
                    if ((Math.round(Lv / iv) % 5 === 0) !== major) return;
                    ctx.moveTo(x1 * scale, y1 * scale); ctx.lineTo(x2 * scale, y2 * scale);
                });
                ctx.stroke();
            });
        }

        // ---------- ciclo di vita ----------
        async function init() {
            let bgPref = false;
            try { bgPref = localStorage.getItem('skyguardian.track.bg') === '1'; } catch (e) { /* ignora */ }
            setBg(!!plugin && bgPref);
            await recoverInterrupted();
            if (plugin) {
                try {
                    const s = await plugin.status();
                    state.power = s;
                    if (s.active) {   // percorso ancora in corso (pagina ricaricata con il servizio attivo)
                        state.tracking = true; state.background = s.background; state.startedAt = s.startedAt; state.raw = []; state.paused = !!s.paused;
                        try { state.trackSettings = normalizeSettings(JSON.parse(s.settings || '{}')); } catch (e) { state.trackSettings = state.settings; }
                        await attachTrackListeners();
                        await syncPoints();
                        state.ticker = setInterval(scheduleRender, 1000);
                    }
                } catch (e) { /* plugin non pronto */ }
            }
            await refreshArchive();
            renderAll();
        }
        function setOpen(open) {
            state.open = open;
            if (open && document.visibilityState !== 'hidden') { startPreview(); refreshPower(); render(); setTimeout(() => { if (state.map) state.map.invalidateSize(); recompute(); }, 150); }
            else stopPreview();
        }
        async function onVisibility(visible) {
            if (!visible) { stopPreview(); return; }
            if (state.tracking && plugin) { try { await syncPoints(); } catch (e) { /* ignora */ } }
            if (state.open) { startPreview(); refreshPower(); }
            renderAll();
        }
        window.addEventListener('resize', scheduleRender);
        renderSettings();
        init();
        return { setOpen, onVisibility, get tracking() { return state.tracking; }, get points() { return state.raw; } };
    }

    const api = { calc, createPanel, archive };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.SkyTracker = api;
})(typeof window !== 'undefined' ? window : globalThis);
