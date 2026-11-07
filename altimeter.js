/*
 * SkyGuardian - Posizione e Altitudine
 *
 * Una misura raccoglie per 10/30/60 s i campioni GNSS (e del barometro, solo nell'app Android) e
 * calcola le coordinate mediate e l'altitudine con tutti i metodi disponibili:
 *  - GPS: quota GNSS convertita sul livello del mare (Android 14+ nativo, altrimenti geoide EGM96)
 *  - barometro tarato sul QNH del METAR più vicino e/o del modello meteo (con correzione di temperatura)
 *  - barometro tarato sulla mappa QNH salvata negli snapshot (offline, previsione oraria)
 *  - quota del terreno da modello digitale (Copernicus GLO-90 via Open-Meteo, solo online)
 * L'altitudine complessiva è la media pesata con l'inverso delle varianze; il margine di errore si
 * allarga se i metodi non sono d'accordo tra loro (chi quadro).
 *
 * - SkyAltimeter.calc: calcoli puri, testabili con Node (scripts/test-altimeter.js)
 * - SkyAltimeter.createPanel(opts): interfaccia del pannello
 */
(function (root) {
    'use strict';

    // =====================================================================
    // FISICA E STATISTICA
    // =====================================================================
    const ISA_H = 44330.77, ISA_EXP = 5.25588, ISA_K = 1 / ISA_EXP;
    const isaAltitude = (p, qnh) => ISA_H * (1 - Math.pow(p / qnh, ISA_K));     // quota ISA (m) da pressione e QNH (hPa)
    const pressureAt = (h, qnh) => qnh * Math.pow(1 - h / ISA_H, ISA_EXP);     // pressione attesa a quota h
    const qnhFrom = (p, h) => p / Math.pow(1 - h / ISA_H, ISA_EXP);            // QNH che rende la quota h
    const metersPerHpa = (p, qnh) => Math.abs(isaAltitude(p - 0.5, qnh) - isaAltitude(p + 0.5, qnh));

    // Quota barometrica con correzione di temperatura sulla colonna d'aria tra il livello di riferimento
    // del QNH (stazione METAR o livello del mare) e il punto di misura. refTempC: temperatura al livello di
    // riferimento; topTempC: temperatura nel punto di misura. Senza temperature resta la quota ISA.
    function baroAltitude(p, qnh, refElev, refTempC, topTempC) {
        refElev = refElev || 0;
        const hIsa = isaAltitude(p, qnh), d = hIsa - refElev;
        const tmIsa = 288.15 - 0.0065 * (refElev + hIsa) / 2;
        let tmAct = null;
        if (isFinite(refTempC) && refTempC !== null) tmAct = refTempC + 273.15 - 0.0065 * d / 2;
        else if (isFinite(topTempC) && topTempC !== null) tmAct = topTempC + 273.15 + 0.0065 * d / 2;
        const factor = tmAct ? tmAct / tmIsa : 1;
        return { h: refElev + d * factor, hIsa, factor, corrected: !!tmAct, column: d };
    }

    const median = a => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
    const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
    const std = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); };
    const hypot = (...a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0));
    function distanceKm(lat1, lon1, lat2, lon2) {
        const R = 6371.0088, r = Math.PI / 180;
        const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    // Geoide EGM96 (window.SkyGeoid, da geoid.js): ondulazione N in metri.
    // Griglia a risoluzione nativa (0,25°) su Europa-Mediterraneo, griglia rada (2°) altrove.
    const inRegional = (G, lat, lon) => lat >= G.regional.lat0 && lat <= G.regional.lat0 + (G.regional.nlat - 1) * G.regional.step &&
                                         lon >= G.regional.lon0 && lon <= G.regional.lon0 + (G.regional.nlon - 1) * G.regional.step;
    const geoidSigma = (G, lat, lon) => (G && inRegional(G, lat, lon)) ? 1.0 : 3.0;
    function geoidUndulation(G, lat, lon) {
        if (!G) return null;
        const pick = (lat >= G.regional.lat0 && lat <= G.regional.lat0 + (G.regional.nlat - 1) * G.regional.step &&
                      lon >= G.regional.lon0 && lon <= G.regional.lon0 + (G.regional.nlon - 1) * G.regional.step) ? G.regional : G.global;
        if (!pick._data) pick._data = decodeInt16(pick.dm);
        const y = (lat - pick.lat0) / pick.step, x = (lon - pick.lon0) / pick.step;
        const i0 = Math.max(0, Math.min(pick.nlat - 2, Math.floor(y))), j0 = Math.max(0, Math.min(pick.nlon - 2, Math.floor(x)));
        const fy = Math.max(0, Math.min(1, y - i0)), fx = Math.max(0, Math.min(1, x - j0));
        const v = (i, j) => pick._data[i * pick.nlon + j] / 10;
        return (v(i0, j0) * (1 - fx) + v(i0, j0 + 1) * fx) * (1 - fy) + (v(i0 + 1, j0) * (1 - fx) + v(i0 + 1, j0 + 1) * fx) * fy;
    }
    function decodeInt16(b64) {
        let bytes;
        if (typeof atob === 'function') { const s = atob(b64); bytes = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i); }
        else bytes = new Uint8Array(Buffer.from(b64, 'base64'));
        return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    }

    // Campioni GNSS validi: scarta i fix vecchi e quelli molto meno precisi della mediana
    function cleanFixes(fixes) {
        const fresh = fixes.filter(f => isFinite(f.lat) && isFinite(f.lon) && (!(f.ageMs > 5000)));
        if (!fresh.length) return [];
        const accs = fresh.map(f => f.hAcc).filter(isFinite);
        const med = accs.length ? median(accs) : 20;
        return fresh.filter(f => !isFinite(f.hAcc) || f.hAcc <= Math.max(3 * med, 8));
    }
    // Errori GNSS correlati nel tempo: i campioni indipendenti sono circa uno ogni ~10-15 s
    const effectiveSamples = (spanMs, every) => Math.max(1, spanMs / every);

    function averagePosition(fixes) {
        const fx = cleanFixes(fixes);
        if (!fx.length) return null;
        let sw = 0, la = 0, lo = 0;
        fx.forEach(f => { const w = 1 / Math.max(1, f.hAcc || 20) ** 2; sw += w; la += w * f.lat; lo += w * f.lon; });
        const lat = la / sw, lon = lo / sw;
        const medAcc = median(fx.map(f => f.hAcc || 20));
        const span = fx.length > 1 ? fx[fx.length - 1].t - fx[0].t : 0;
        const sigma = medAcc * Math.max(0.5, 1 / Math.sqrt(effectiveSamples(span, 10000)));
        const scatter = std(fx.map(f => distanceKm(lat, lon, f.lat, f.lon) * 1000));
        return { lat, lon, sigma, medAcc, n: fx.length, spanS: span / 1000, scatter, bestAcc: Math.min(...fx.map(f => f.hAcc || 99)) };
    }

    // Quota GPS sul livello del mare. msl nativo (Android 14+) se c'è, altrimenti ellissoide - N (EGM96)
    function gpsAltitude(fixes, geoidN, geoidSig) {
        const fx = cleanFixes(fixes).filter(f => isFinite(f.msl) || isFinite(f.alt));
        if (!fx.length) return null;
        const nativeMsl = fx.every(f => isFinite(f.msl));
        if (!nativeMsl && !isFinite(geoidN)) return null;
        const vals = fx.map(f => nativeMsl ? f.msl : f.alt - geoidN);
        const vAcc = fx.map(f => isFinite(f.vAcc) && f.vAcc > 0 ? f.vAcc : 1.5 * (f.hAcc || 20));
        let sw = 0, sh = 0;
        vals.forEach((h, i) => { const w = 1 / vAcc[i] ** 2; sw += w; sh += w * h; });
        const medV = median(vAcc);
        const span = fx.length > 1 ? fx[fx.length - 1].t - fx[0].t : 0;
        const geoidSigma = nativeMsl ? (median(fx.map(f => isFinite(f.mslAcc) ? f.mslAcc : 0.5)) || 0.5) : (geoidSig || 1.0);
        const sigma = hypot(medV * Math.max(0.6, 1 / Math.sqrt(effectiveSamples(span, 15000))), geoidSigma);
        return { h: sh / sw, sigma, medV, n: fx.length, scatter: std(vals), nativeMsl, geoidN: nativeMsl ? null : geoidN, geoidSigma,
                 satsUsed: median(fx.map(f => f.satsUsed || 0)), satsL5: median(fx.map(f => f.satsL5 || 0)), satsVisible: median(fx.map(f => f.satsVisible || 0)) };
    }

    function averagePressure(samples) {
        if (!samples.length) return null;
        const v = samples.map(s => s.hPa);
        return { p: mean(v), n: v.length, std: std(v), sigmaMean: std(v) / Math.sqrt(Math.max(1, v.length / 5)) };
    }

    // Una stima barometrica per ogni sorgente di QNH. sensorSigma = errore assoluto del sensore (hPa).
    function baroEstimate(pr, src, sensorSigma) {
        const b = baroAltitude(pr.p, src.qnh, src.refElev || 0, src.refTempC, src.topTempC);
        const k = metersPerHpa(pr.p, src.qnh);
        const tempSigma = Math.abs(b.column) * (b.corrected ? 0.015 : 0.04);
        const qnhPart = hypot(k * src.sigma, tempSigma);
        const sensorPart = hypot(k * sensorSigma, k * pr.sigmaMean);
        return { h: b.h, hIsa: b.hIsa, factor: b.factor, corrected: b.corrected, k, qnhPart, sensorPart, sigma: hypot(qnhPart, sensorPart) };
    }
    // Più tarature dello stesso sensore: si combina la parte QNH, l'errore del sensore resta uno solo
    function combineBaro(list) {
        if (!list.length) return null;
        let sw = 0, sh = 0;
        list.forEach(e => { const w = 1 / e.qnhPart ** 2; sw += w; sh += w * e.h; });
        return { h: sh / sw, sigma: hypot(1 / Math.sqrt(sw), list[0].sensorPart) };
    }

    // Media pesata (inverso delle varianze) con allargamento dell'incertezza se le stime non concordano
    function combine(estimates) {
        const est = estimates.filter(e => e && isFinite(e.h) && isFinite(e.sigma) && e.sigma > 0);
        if (!est.length) return null;
        let sw = 0, sh = 0;
        est.forEach(e => { const w = 1 / e.sigma ** 2; sw += w; sh += w * e.h; });
        const h = sh / sw;
        let sigma = 1 / Math.sqrt(sw);
        const chi2 = est.reduce((s, e) => s + ((e.h - h) / e.sigma) ** 2, 0);
        const dof = est.length - 1;
        const inflation = dof > 0 ? Math.max(1, Math.sqrt(chi2 / dof)) : 1;
        sigma *= inflation;
        const weights = est.map(e => ({ id: e.id, w: (1 / e.sigma ** 2) / sw }));
        const agreement = dof === 0 ? 'singola' : chi2 / dof < 1.5 ? 'buono' : chi2 / dof < 4 ? 'discreto' : 'scarso';
        return { h, sigma, chi2, dof, inflation, weights, agreement, n: est.length };
    }

    // Pendenza del terreno dai 4 punti vicini (m/m)
    function demSlope(center, north, south, east, west, stepM) {
        if (![center, north, south, east, west].every(isFinite)) return null;
        return Math.hypot((north - south) / (2 * stepM), (east - west) / (2 * stepM));
    }

    // METAR: il più vicino con QNH recente (entro 3 ore)
    function nearestMetar(list, lat, lon, nowMs) {
        const ok = (list || []).filter(m => isFinite(m.altim) && isFinite(m.lat) && isFinite(m.lon) && isFinite(m.obsTime) && nowMs / 1000 - m.obsTime < 3 * 3600)
            .map(m => Object.assign({}, m, { distKm: distanceKm(lat, lon, m.lat, m.lon), ageH: Math.max(0, (nowMs / 1000 - m.obsTime) / 3600) }))
            .sort((a, b) => a.distKm - b.distKm);
        return ok;
    }
    const metarQnhSigma = m => hypot(0.35, 0.5 * m.ageH, m.distKm / 100);   // arrotondamento + deriva oraria + distanza

    // Mappa QNH degli snapshot: interpolazione bilineare nello spazio e lineare nel tempo
    function interpolateQnhGrid(g, lat, lon, ms) {
        if (!g || !g.times || !g.times.length) return null;
        const t0 = g.times[0], t1 = g.times[g.times.length - 1];
        if (ms < t0 - 1800000 || ms > t1 + 1800000) return null;
        const fi = (lat - g.lat0) / g.dLat, fj = (lon - g.lon0) / g.dLon;
        const ci = Math.max(0, Math.min(g.n - 1, fi)), cj = Math.max(0, Math.min(g.n - 1, fj));
        const outsideKm = distanceKm(lat, lon, g.lat0 + ci * g.dLat, g.lon0 + cj * g.dLon);
        const i0 = Math.min(g.n - 2, Math.floor(ci)), j0 = Math.min(g.n - 2, Math.floor(cj));
        const wi = ci - i0, wj = cj - j0;
        const k = Math.max(0, Math.min(g.times.length - 1, (ms - t0) / 3600000));
        const k0 = Math.min(g.times.length - 2, Math.floor(k)), wk = k - k0;
        const at = (arr, i, j) => { const s = arr[i * g.n + j]; return s[k0] * (1 - wk) + s[k0 + 1] * wk; };
        const bil = arr => (at(arr, i0, j0) * (1 - wj) + at(arr, i0, j0 + 1) * wj) * (1 - wi) + (at(arr, i0 + 1, j0) * (1 - wj) + at(arr, i0 + 1, j0 + 1) * wj) * wi;
        const leadH = Math.max(0, (ms - g.fetchedAt) / 3600000);
        const e = (i, j) => g.elev ? g.elev[i * g.n + j] : 0;
        const elev = (e(i0, j0) * (1 - wj) + e(i0, j0 + 1) * wj) * (1 - wi) + (e(i0 + 1, j0) * (1 - wj) + e(i0 + 1, j0 + 1) * wj) * wi;
        // temperatura del modello alla quota del terreno della griglia (elev), non al livello del mare
        return { qnh: bil(g.p), temp: g.t ? bil(g.t) : null, elev, leadH, outsideKm,
                 sigma: hypot(0.8, 0.6 * leadH / 24, outsideKm / 50), fetchedAt: g.fetchedAt };
    }

    // Formattazioni
    function dms(v, pos, neg) {
        const a = Math.abs(v), d = Math.floor(a), mFull = (a - d) * 60, m = Math.floor(mFull);
        let s = (mFull - m) * 60;
        let dd = d, mm = m;
        if (s >= 59.995) { s = 0; mm += 1; if (mm === 60) { mm = 0; dd += 1; } }
        return `${dd}° ${String(mm).padStart(2, '0')}′ ${s.toFixed(2).padStart(5, '0')}″ ${v >= 0 ? pos : neg}`;
    }
    const fmtCoordsDms = (lat, lon) => `${dms(lat, 'N', 'S')}  ${dms(lon, 'E', 'O')}`;
    const fmtCoordsDec = (lat, lon) => `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
    const roundSigma = s => s < 1 ? 1 : s < 10 ? Math.ceil(s) : Math.ceil(s / 2) * 2;

    const calc = { isaAltitude, pressureAt, qnhFrom, metersPerHpa, baroAltitude, median, std, distanceKm, geoidUndulation, geoidSigma,
                   cleanFixes, averagePosition, gpsAltitude, averagePressure, baroEstimate, combineBaro, combine, demSlope,
                   nearestMetar, metarQnhSigma, interpolateQnhGrid, dms, fmtCoordsDms, fmtCoordsDec, roundSigma };

    // =====================================================================
    // DATI ONLINE
    // =====================================================================
    async function fetchJson(url, ms) {
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), ms || 8000) : null;
        try {
            const r = await fetch(url, ctrl ? { signal: ctrl.signal } : {});
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return await r.json();
        } finally { if (timer) clearTimeout(timer); }
    }
    function metarUrl(lat, lon, radiusDeg) {
        const r = radiusDeg || 1.5;
        return `https://aviationweather.gov/api/data/metar?bbox=${(lat - r).toFixed(2)},${(lon - r * 1.3).toFixed(2)},${(lat + r).toFixed(2)},${(lon + r * 1.3).toFixed(2)}&format=json`;
    }
    // Nell'app il METAR passa dal plugin nativo (nessun blocco CORS); sul sito si prova direttamente
    async function fetchMetars(lat, lon, plugin, radiusDeg) {
        const url = metarUrl(lat, lon, radiusDeg);
        let list;
        if (plugin) {
            const r = await plugin.fetchMetar({ url });
            if (r.status >= 400) throw new Error('HTTP ' + r.status);
            list = JSON.parse(r.body || '[]');
        } else list = await fetchJson(url);
        return (Array.isArray(list) ? list : []).map(m => ({ icao: m.icaoId, name: m.name, lat: +m.lat, lon: +m.lon, elev: +m.elev,
            altim: +m.altim, temp: m.temp === null || m.temp === undefined ? null : +m.temp, obsTime: +m.obsTime, raw: m.rawOb }));
    }
    async function fetchModel(lat, lon) {
        const d = await fetchJson(`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=pressure_msl,surface_pressure,temperature_2m&timeformat=unixtime`);
        return { qnh: d.current.pressure_msl, surface: d.current.surface_pressure, temp: d.current.temperature_2m, time: d.current.time * 1000, modelElev: d.elevation };
    }
    const DEM_STEP_M = 60;
    async function fetchDem(lat, lon) {
        const dLat = DEM_STEP_M / 111320, dLon = DEM_STEP_M / (111320 * Math.cos(lat * Math.PI / 180));
        const lats = [lat, lat + dLat, lat - dLat, lat, lat], lons = [lon, lon, lon, lon + dLon, lon - dLon];
        const d = await fetchJson(`https://api.open-meteo.com/v1/elevation?latitude=${lats.map(x => x.toFixed(6)).join(',')}&longitude=${lons.map(x => x.toFixed(6)).join(',')}`);
        const e = d.elevation;
        return { h: e[0], slope: demSlope(e[0], e[1], e[2], e[3], e[4], DEM_STEP_M) };
    }
    // Mappa QNH per gli snapshot: griglia 9x9 su un raggio di 100 km, previsione oraria 48 h (+ METAR della zona)
    async function fetchQnhGrid(lat, lon, plugin) {
        const n = 9, radiusKm = 100, stepKm = 2 * radiusKm / (n - 1);
        const dLat = stepKm / 111.32, dLon = stepKm / (111.32 * Math.cos(lat * Math.PI / 180));
        const lat0 = lat - radiusKm / 111.32, lon0 = lon - radiusKm / (111.32 * Math.cos(lat * Math.PI / 180));
        const lats = [], lons = [];
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { lats.push((lat0 + i * dLat).toFixed(3)); lons.push((lon0 + j * dLon).toFixed(3)); }
        const d = await fetchJson(`https://api.open-meteo.com/v1/forecast?latitude=${lats.join(',')}&longitude=${lons.join(',')}&hourly=pressure_msl,temperature_2m&forecast_days=3&timeformat=unixtime`, 20000);
        const arr = Array.isArray(d) ? d : [d];
        const now = Date.now();
        const times = arr[0].hourly.time.map(x => x * 1000);
        const from = Math.max(0, times.findIndex(x => x >= now - 3600000)), to = Math.min(times.length, from + 50);
        const grid = { fetchedAt: now, lat0, lon0, dLat, dLon, n, radiusKm, times: times.slice(from, to),
            p: arr.map(a => a.hourly.pressure_msl.slice(from, to).map(x => Math.round(x * 10) / 10)),
            t: arr.map(a => a.hourly.temperature_2m.slice(from, to).map(x => Math.round(x * 10) / 10)),
            elev: arr.map(a => a.elevation) };
        let metars = [];
        try { metars = await fetchMetars(lat, lon, plugin, 1.0); } catch (e) { /* facoltativo */ }
        return { grid, metars };
    }

    // =====================================================================
    // PANNELLO
    // =====================================================================
    function createPanel(opts) {
        const el = opts.elements;
        const plugin = opts.plugin || null;              // plugin nativo Altimeter (solo app Android)
        const geoid = () => root.SkyGeoid || null;
        const snapshotGrids = opts.snapshotGrids || (() => []);
        const fallbackPosition = opts.fallbackPosition || (() => null);
        const state = { duration: 30, running: false, caps: null, fixes: [], pressures: [], t0: 0, timer: null, handles: [], watchId: null, online: null, last: null };

        const esc = s => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
        const fmt = (x, d) => isFinite(x) ? Number(x).toFixed(d === undefined ? 1 : d) : '—';
        const hhmm = ms => new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
        const dayTime = ms => new Date(ms).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

        async function init() {
            if (plugin) {
                try { state.caps = await plugin.capabilities(); } catch (e) { state.caps = null; }
            }
            renderCaps();
        }
        function renderCaps() {
            const c = state.caps;
            const online = navigator.onLine !== false;
            const chips = [];
            chips.push(online ? chip('🌐 Online', 'emerald') : chip('📴 Offline', 'amber'));
            if (plugin && c) {
                chips.push(chip(`📱 ${esc(c.model || 'Android')}`, 'slate'));
                chips.push(c.barometer ? chip(`🧭 Barometro: ${esc(c.barometerName || 'sì')}`, 'emerald') : chip('Barometro assente', 'amber'));
                chips.push(c.mslAltitude ? chip('🛰️ Quota GNSS s.l.m. nativa (Android 14+)', 'emerald') : chip('🛰️ Quota GNSS con geoide EGM96', 'slate'));
                if (c.gps && !c.gpsEnabled) chips.push(chip('⚠️ GPS disattivato nelle impostazioni', 'red'));
            } else {
                chips.push(chip('🌍 Browser: GPS del dispositivo', 'slate'));
                chips.push(chip('Barometro solo nell\'app Android', 'amber'));
            }
            el.caps.innerHTML = chips.join('');
        }
        function chip(text, color) {
            const c = { emerald: 'border-emerald-700 text-emerald-200 bg-emerald-950/40', amber: 'border-amber-700 text-amber-200 bg-amber-950/40',
                        red: 'border-red-700 text-red-200 bg-red-950/40', slate: 'border-slate-600 text-slate-300 bg-slate-800/60' }[color];
            return `<span class="inline-block text-[11px] px-2 py-0.5 rounded-full border ${c}">${text}</span>`;
        }

        el.durationButtons.forEach(b => b.addEventListener('click', () => { if (state.running) return; state.duration = +b.dataset.altDur; renderDuration(); }));
        function renderDuration() {
            el.durationButtons.forEach(b => {
                const on = +b.dataset.altDur === state.duration;
                b.classList.toggle('bg-blue-600', on); b.classList.toggle('text-white', on); b.classList.toggle('text-slate-300', !on);
            });
        }
        el.startBtn.addEventListener('click', () => { if (state.running) finish('manual'); else start(); });

        // ---------- Misura ----------
        async function start() {
            state.running = true; state.fixes = []; state.pressures = []; state.t0 = Date.now(); state.sources = {};
            state.online = navigator.onLine !== false;
            el.startBtn.textContent = '⏹ Ferma e calcola';
            el.startBtn.classList.replace('bg-blue-600', 'bg-amber-600');
            el.result.innerHTML = '';
            renderCaps();
            el.live.classList.remove('hidden');
            let ok = false;
            if (plugin) ok = await startNative();
            if (!ok && !plugin) ok = startBrowser();
            if (!ok) { state.running = false; resetButton(); el.live.innerHTML = `<p class="text-red-300 text-sm">${esc(state.error || 'Impossibile avviare la misura.')}</p>`; return; }
            state.timer = setInterval(tick, 250);
            tick();
        }
        async function startNative() {
            try {
                state.handles.push(await plugin.addListener('location', f => { if (state.running) state.fixes.push(Object.assign({ tRecv: Date.now() }, f)); }));
                state.handles.push(await plugin.addListener('pressure', p => { if (state.running) state.pressures.push(p); }));
                state.handles.push(await plugin.addListener('stopped', () => { if (state.running) finish('pause'); }));
                const r = await plugin.start();
                if (!r.gps) state.warnGps = 'GPS spento: attivalo nelle impostazioni di Android per avere coordinate e quota GNSS.';
                return true;
            } catch (e) {
                state.error = e && e.message ? e.message : String(e);
                removeHandles();
                return false;
            }
        }
        function startBrowser() {
            if (!navigator.geolocation) { state.error = 'Geolocalizzazione non disponibile su questo browser.'; return false; }
            state.watchId = navigator.geolocation.watchPosition(pos => {
                if (!state.running) return;
                const c = pos.coords;
                state.fixes.push({ lat: c.latitude, lon: c.longitude, hAcc: c.accuracy, alt: c.altitude === null ? undefined : c.altitude,
                                   vAcc: c.altitudeAccuracy === null ? undefined : c.altitudeAccuracy, t: pos.timestamp, ageMs: Math.max(0, Date.now() - pos.timestamp) });
            }, err => { state.geoError = err.code === 1 ? 'Permesso di posizione negato.' : 'Posizione non disponibile (prova all\'aperto).'; },
            { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
            return true;
        }
        function removeHandles() { state.handles.forEach(h => { try { h.remove(); } catch (e) { /* ignora */ } }); state.handles = []; }
        function stopSensors() {
            clearInterval(state.timer); state.timer = null;
            if (plugin) { plugin.stop().catch(() => {}); removeHandles(); }
            if (state.watchId !== null) { navigator.geolocation.clearWatch(state.watchId); state.watchId = null; }
        }
        function resetButton() {
            el.startBtn.textContent = '📍 CALCOLA COORDINATE E ALTITUDINE';
            el.startBtn.classList.replace('bg-amber-600', 'bg-blue-600');
        }

        // Le fonti online partono appena c'è una posizione (o subito con le coordinate del pannello)
        function startOnlineSources(lat, lon) {
            if (state.sources.started || !state.online) return;
            state.sources.started = true;
            state.sources.metar = fetchMetars(lat, lon, plugin).then(list => ({ ok: true, list }), e => ({ ok: false, error: e.message || String(e) }));
            state.sources.model = fetchModel(lat, lon).then(v => ({ ok: true, v }), e => ({ ok: false, error: e.message || String(e) }));
        }
        function tick() {
            const el2 = el.live;
            const elapsed = (Date.now() - state.t0) / 1000;
            const fx = state.fixes[state.fixes.length - 1];
            if (fx) startOnlineSources(fx.lat, fx.lon);
            else if (elapsed > 4) { const fb = fallbackPosition(); if (fb) startOnlineSources(fb.lat, fb.lon); }
            const pr = state.pressures[state.pressures.length - 1];
            const pct = Math.min(100, elapsed / state.duration * 100);
            el2.innerHTML = `
                <div class="h-2 bg-slate-700 rounded-full overflow-hidden"><div class="h-full bg-blue-500 transition-all" style="width:${pct}%"></div></div>
                <div class="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] text-slate-300">
                    <div>⏱️ ${Math.floor(elapsed)} / ${state.duration} s</div>
                    <div>🛰️ Fix GNSS: <b class="text-white">${state.fixes.length}</b>${fx && isFinite(fx.hAcc) ? ` · ±${fmt(fx.hAcc, 0)} m` : ''}</div>
                    <div>${fx && fx.satsUsed !== undefined ? `Satelliti usati: <b class="text-white">${fx.satsUsed}</b>/${fx.satsVisible}${fx.satsL5 ? ` · L5: ${fx.satsL5}` : ''}` : (fx ? '' : (state.geoError || state.warnGps || 'In attesa del primo fix… (meglio all\'aperto)'))}</div>
                    <div>${pr ? `🧭 ${fmt(pr.hPa, 2)} hPa (${state.pressures.length} letture)` : (plugin && state.caps && state.caps.barometer ? '🧭 Avvio barometro…' : '')}</div>
                </div>`;
            if (elapsed >= state.duration) finish('time');
        }

        async function finish(reason) {
            if (!state.running) return;
            state.running = false;
            stopSensors();
            resetButton();
            if (reason === 'pause') {
                el.live.innerHTML = '<p class="text-amber-300 text-sm">⏸ Misura interrotta: l\'app è andata in secondo piano e i sensori sono stati spenti. Premi di nuovo il pulsante.</p>';
                return;
            }
            el.live.innerHTML = '<p class="text-slate-300 text-sm">Calcolo in corso…</p>';
            try { await compute(); } catch (e) { console.error('Altitudine:', e); el.result.innerHTML = `<p class="text-red-300 text-sm">Errore nel calcolo: ${esc(e.message)}</p>`; }
            el.live.classList.add('hidden');
        }

        async function compute() {
            const now = Date.now();
            const pos = averagePosition(state.fixes);
            const where = pos || fallbackPosition();
            const N = where ? geoidUndulation(geoid(), where.lat, where.lon) : null;
            const gps = gpsAltitude(state.fixes, N, where ? geoidSigma(geoid(), where.lat, where.lon) : 3);
            const pres = averagePressure(state.pressures);
            if (where) startOnlineSources(where.lat, where.lon);
            const wait = p => p ? Promise.race([p, new Promise(r => setTimeout(() => r({ ok: false, error: 'tempo scaduto' }), 9000))]) : Promise.resolve(null);
            const [metarRes, modelRes] = await Promise.all([wait(state.sources.metar), wait(state.sources.model)]);
            let demRes = null;
            if (state.online && pos) demRes = await wait(fetchDem(pos.lat, pos.lon).then(v => ({ ok: true, v }), e => ({ ok: false, error: e.message })));

            // --- Sorgenti di QNH ---
            const qnhSources = [];
            const metars = metarRes && metarRes.ok && where ? nearestMetar(metarRes.list, where.lat, where.lon, now) : [];
            const metar = metars[0] || null;
            if (metar) qnhSources.push({ id: 'metar', label: `METAR ${metar.icao}`, qnh: metar.altim, sigma: metarQnhSigma(metar), refElev: metar.elev || 0, refTempC: metar.temp, info: metar });
            const model = modelRes && modelRes.ok ? modelRes.v : null;
            if (model && isFinite(model.qnh)) qnhSources.push({ id: 'model', label: 'Modello Open-Meteo', qnh: model.qnh, sigma: 0.8, refElev: 0, topTempC: model.temp, info: model });
            let snapGrid = null;
            if (!qnhSources.length && where) {
                // offline (o fonti online non raggiungibili): mappa QNH degli snapshot
                snapshotGrids().forEach(g => {
                    const v = interpolateQnhGrid(g.grid, where.lat, where.lon, now);
                    if (v && (!snapGrid || v.sigma < snapGrid.sigma)) snapGrid = Object.assign(v, { label: g.label });
                });
                if (snapGrid) {
                    const hApprox = gps ? gps.h : (pres ? isaAltitude(pres.p, snapGrid.qnh) : snapGrid.elev);
                    qnhSources.push({ id: 'snapshot', label: 'Mappa QNH dello snapshot', qnh: snapGrid.qnh, sigma: snapGrid.sigma, refElev: 0,
                        topTempC: isFinite(snapGrid.temp) ? snapGrid.temp - 0.0065 * (hApprox - snapGrid.elev) : null, info: snapGrid });
                }
            }

            // --- Stime di quota ---
            const SENSOR_SIGMA = 1.0;   // errore assoluto tipico di un barometro da telefono non calibrato (hPa)
            const rows = [];
            if (gps) rows.push({ id: 'gps', label: 'GPS / GNSS', h: gps.h, sigma: gps.sigma, used: true, detail: gpsDetail(gps) });
            const baroList = pres ? qnhSources.map(s => Object.assign(baroEstimate(pres, s, SENSOR_SIGMA), { src: s })) : [];
            const baroComb = combineBaro(baroList);
            baroList.forEach(b => rows.push({ id: 'baro-' + b.src.id, label: `Barometro tarato su ${b.src.label}`, h: b.h, sigma: b.sigma, used: false, sub: true, detail: baroDetail(b, pres) }));
            if (baroComb) rows.push({ id: 'baro', label: baroList.length > 1 ? 'Barometro (tarature combinate)' : 'Barometro', h: baroComb.h, sigma: baroComb.sigma, used: true,
                detail: baroList.length > 1 ? 'Stesso sensore: si combina la taratura del QNH, l\'errore del barometro (±1 hPa) conta una volta sola.' : 'Errore del sensore ±1 hPa incluso.' });
            const dem = demRes && demRes.ok ? demRes.v : null;
            if (dem && isFinite(dem.h) && pos) {
                const sigma = hypot(5, (dem.slope || 0) * pos.sigma);
                rows.push({ id: 'dem', label: 'Quota del terreno (modello digitale)', h: dem.h, sigma, used: true,
                    detail: `Copernicus DEM GLO-90 (celle da 90 m) alle coordinate mediate. Pendenza ${fmt((dem.slope || 0) * 100, 0)}%: con ±${fmt(pos.sigma, 0)} m di errore di posizione vale ±${fmt((dem.slope || 0) * pos.sigma, 1)} m. È la quota del suolo: se sei su un edificio o un traliccio la tua quota è maggiore.` });
            }
            // QNH ricostruito dal GPS (non indipendente: non entra nella media)
            let qnhGps = null;
            if (pres && gps) {
                const k = metersPerHpa(pres.p, 1013.25);
                qnhGps = { qnh: qnhFrom(pres.p, gps.h), sigma: hypot(gps.sigma / k, SENSOR_SIGMA) };
                if (!qnhSources.length) rows.push({ id: 'baro-gps', label: 'Barometro tarato sul GPS', h: gps.h, sigma: gps.sigma, used: false, sub: true,
                    detail: `QNH ricostruito ${fmt(qnhGps.qnh)} hPa: coincide con la quota GPS per costruzione, quindi non aggiunge informazione e non entra nella media. Serve a seguire le variazioni di quota col barometro.` });
            }
            const final = combine(rows.filter(r => r.used));
            if (final) rows.forEach(r => { const w = final.weights.find(x => x.id === r.id); r.weight = w ? w.w : 0; });

            const qnhBest = qnhSources.length
                ? qnhSources.slice().sort((a, b) => a.sigma - b.sigma)[0]
                : (qnhGps ? { id: 'gps', label: 'ricostruito dal GPS', qnh: qnhGps.qnh, sigma: qnhGps.sigma } : null);
            state.last = { now, pos, gps, pres, final, rows, qnhSources, qnhBest, qnhGps, metars, metarRes, modelRes, demRes, dem, snapGrid, N };
            render(state.last);
        }

        function gpsDetail(g) {
            const parts = [`${g.n} fix in media · scarto tra i fix ${fmt(g.scatter, 1)} m · precisione verticale dichiarata ±${fmt(g.medV, 1)} m`];
            if (g.satsUsed) parts.push(`${g.satsUsed} satelliti usati su ${g.satsVisible} visibili${g.satsL5 ? `, ${g.satsL5} in doppia frequenza L5/E5a` : ''}`);
            parts.push(g.nativeMsl ? `Quota sul livello del mare calcolata da Android (modello del geoide del sistema, ±${fmt(g.geoidSigma, 1)} m)` :
                `Quota ellissoidica WGS84 − geoide EGM96 (N = ${fmt(g.geoidN, 1)} m, ±${fmt(g.geoidSigma, 0)} m)`);
            return parts.join('. ') + '.';
        }
        function baroDetail(b, pres) {
            const s = b.src;
            const t = b.corrected ? `correzione di temperatura ×${fmt(b.factor, 3)} (quota ISA ${fmt(b.hIsa, 1)} m)` : 'senza temperatura: quota ISA standard (±4% sul dislivello)';
            return `QNH ${fmt(s.qnh)} hPa ±${fmt(s.sigma, 1)} · pressione misurata ${fmt(pres.p, 2)} hPa · ${fmt(b.k, 1)} m/hPa · ${t}.`;
        }

        // ---------- Risultato ----------
        function render(r) {
            const offline = !r.qnhSources.some(s => s.id !== 'snapshot') && !r.dem;
            const html = [];
            // Riepilogo
            if (r.final) {
                const s1 = roundSigma(r.final.sigma);
                html.push(`<div class="bg-slate-900/70 border border-slate-600 rounded-lg p-4 text-center">
                    <div class="text-xs uppercase tracking-wide text-slate-400">Altitudine complessiva</div>
                    <div class="text-4xl font-bold text-white mt-1">${Math.round(r.final.h)} m <span class="text-2xl text-slate-300">± ${s1} m</span></div>
                    <div class="text-[11px] text-slate-400 mt-1">sul livello del mare · intervallo al 68%; al 95% ± ${roundSigma(2 * r.final.sigma)} m · ${r.final.n} ${r.final.n === 1 ? 'metodo' : 'metodi'}, accordo ${r.final.agreement}${r.final.inflation > 1.05 ? ` (margine allargato ×${fmt(r.final.inflation, 1)} perché i metodi non concordano del tutto)` : ''}</div>
                    ${offline ? '<div class="mt-2 text-[11px] text-amber-300">📴 Calcolato offline: solo sensori del dispositivo' + (r.snapGrid ? ' e mappa QNH dello snapshot' : '') + '.</div>' : ''}
                </div>`);
            } else {
                html.push(`<div class="bg-red-950/40 border border-red-700 rounded-lg p-3 text-sm text-red-200">Nessuna altitudine calcolabile: ${esc(state.geoError || 'nessun fix GNSS con quota e nessun QNH disponibile')}. Prova all'aperto, con il GPS attivo, e una durata più lunga.</div>`);
            }
            // Coordinate
            if (r.pos) {
                html.push(`<div class="bg-slate-900/50 border border-slate-700 rounded-lg p-3">
                    <div class="flex items-center justify-between gap-2"><div class="text-xs uppercase tracking-wide text-slate-400">Coordinate (WGS84)</div>
                    <button type="button" data-alt-copy class="text-[11px] px-2 py-0.5 rounded border border-slate-600 text-slate-200 hover:bg-slate-700">📋 Copia</button></div>
                    <div class="mt-1 font-mono text-white text-sm sm:text-base">${fmtCoordsDms(r.pos.lat, r.pos.lon)}</div>
                    <div class="font-mono text-slate-200 text-sm">${fmtCoordsDec(r.pos.lat, r.pos.lon)}</div>
                    <div class="text-[11px] text-slate-400 mt-1">Precisione stimata ±${fmt(r.pos.sigma, 1)} m (media pesata di ${r.pos.n} fix in ${fmt(r.pos.spanS, 0)} s; fix migliore ±${fmt(r.pos.bestAcc, 1)} m; dispersione ${fmt(r.pos.scatter, 1)} m)${r.gps && r.gps.satsUsed ? ` · ${r.gps.satsUsed} satelliti${r.gps.satsL5 ? `, ${r.gps.satsL5} su L5` : ''}` : ''}.</div>
                </div>`);
            } else {
                html.push(`<div class="bg-slate-900/50 border border-slate-700 rounded-lg p-3 text-sm text-amber-200">Coordinate non disponibili: nessun fix GNSS valido${state.geoError ? ' (' + esc(state.geoError) + ')' : ''}.</div>`);
            }
            // Metodi
            const rowsHtml = r.rows.map(x => `<tr class="border-t border-slate-700/70 ${x.sub ? 'text-slate-400' : ''}">
                    <td class="py-1.5 pr-2 align-top ${x.sub ? 'pl-3' : 'font-semibold text-slate-100'}">${x.sub ? '↳ ' : ''}${esc(x.label)}<div class="text-[11px] font-normal text-slate-400 leading-snug">${x.detail || ''}</div></td>
                    <td class="py-1.5 px-2 align-top font-mono whitespace-nowrap ${x.used ? 'text-white' : ''}">${fmt(x.h, 1)} m<br><span class="text-[11px]">± ${fmt(x.sigma, 1)} m</span></td>
                    <td class="py-1.5 pl-2 align-top text-right whitespace-nowrap">${x.used ? `<b class="text-blue-300">${Math.round((x.weight || 0) * 100)}%</b>` : '<span class="text-[11px]">non in media</span>'}</td>
                </tr>`).join('');
            const missing = [];
            if (!r.gps) missing.push('GPS: nessuna quota GNSS (fix assente o browser senza altitudine)');
            if (!r.pres) missing.push(plugin ? (state.caps && state.caps.barometer ? 'Barometro: nessuna lettura' : 'Barometro: sensore assente') : 'Barometro: non accessibile dal browser, solo nell\'app Android');
            if (r.pres && !r.qnhSources.length) missing.push('Taratura barometrica: nessun QNH (offline e nessuna mappa QNH degli snapshot per questa zona/ora)');
            if (!r.dem) missing.push(state.online ? `Quota del terreno: ${r.demRes ? esc(r.demRes.error || 'non disponibile') : 'posizione non disponibile'}` : 'Quota del terreno: richiede internet');
            html.push(`<div class="bg-slate-900/50 border border-slate-700 rounded-lg p-3">
                <div class="text-xs uppercase tracking-wide text-slate-400 mb-1">Altitudine per metodo</div>
                <table class="w-full text-sm"><thead><tr class="text-[11px] text-slate-500"><th class="text-left font-normal">Metodo</th><th class="text-left font-normal px-2">Quota</th><th class="text-right font-normal">Peso</th></tr></thead><tbody>${rowsHtml}</tbody></table>
                ${missing.length ? `<ul class="mt-2 text-[11px] text-slate-500 list-disc pl-4">${missing.map(m => `<li>${m}</li>`).join('')}</ul>` : ''}
            </div>`);
            // QNH e pressione
            const q = [];
            if (r.metars && r.metars.length) {
                const m = r.metars[0];
                q.push(`<div><b class="text-slate-100">METAR ${esc(m.icao)}</b> ${esc(m.name || '')} · a ${fmt(m.distKm, 0)} km · osservato alle ${hhmm(m.obsTime * 1000)} (${fmt(m.ageH * 60, 0)} min fa) · stazione a ${fmt(m.elev, 0)} m<br>
                    QNH <b class="text-white">${fmt(m.altim, 1)} hPa</b> ±${fmt(metarQnhSigma(m), 1)} · temperatura ${m.temp === null ? '—' : fmt(m.temp, 0) + ' °C'}<br><span class="font-mono text-[10px] text-slate-500">${esc(m.raw || '')}</span></div>`);
                if (r.metars.length > 1) q.push(`<div class="text-[11px] text-slate-500">Altri METAR: ${r.metars.slice(1, 4).map(x => `${esc(x.icao)} ${fmt(x.altim, 0)} hPa (${fmt(x.distKm, 0)} km)`).join(' · ')}</div>`);
            } else if (state.online) {
                q.push(`<div class="text-[11px] text-slate-400">METAR: ${r.metarRes && !r.metarRes.ok ? (plugin ? 'non raggiungibile (' + esc(r.metarRes.error) + ')' : 'il browser non permette di leggere aviationweather.gov da questa pagina; nell\'app Android il METAR viene scaricato direttamente') : 'nessuna stazione con QNH recente entro ~150 km'}.</div>`);
            }
            const model = r.modelRes && r.modelRes.ok ? r.modelRes.v : null;
            if (model) q.push(`<div><b class="text-slate-100">Modello Open-Meteo</b> alle coordinate ${r.pos ? fmtCoordsDec(r.pos.lat, r.pos.lon) : ''} · valore delle ${hhmm(model.time)}<br>
                QNH (pressione al livello del mare) <b class="text-white">${fmt(model.qnh, 1)} hPa</b> ±0.8 · pressione al suolo del modello ${fmt(model.surface, 1)} hPa (quota del modello ${fmt(model.modelElev, 0)} m) · temperatura ${fmt(model.temp, 1)} °C</div>`);
            if (r.snapGrid) q.push(`<div><b class="text-slate-100">Mappa QNH dello snapshot</b> (${esc(r.snapGrid.label)}) · scaricata il ${dayTime(r.snapGrid.fetchedAt)}, previsione a ${fmt(r.snapGrid.leadH, 0)} h<br>
                QNH interpolato <b class="text-white">${fmt(r.snapGrid.qnh, 1)} hPa</b> ±${fmt(r.snapGrid.sigma, 1)}${r.snapGrid.outsideKm > 1 ? ` · fuori dalla mappa di ${fmt(r.snapGrid.outsideKm, 0)} km` : ''}</div>`);
            if (r.qnhGps) q.push(`<div><b class="text-slate-100">QNH ricostruito dal GPS</b>: ${fmt(r.qnhGps.qnh, 1)} hPa ±${fmt(r.qnhGps.sigma, 1)} <span class="text-[11px] text-slate-400">(pressione misurata riportata al livello del mare con la quota GPS)</span></div>`);
            if (!q.length) q.push('<div class="text-[11px] text-slate-400">Nessun QNH disponibile: sei offline e non c\'è una mappa QNH degli snapshot per questa zona e quest\'ora.</div>');
            const p = [];
            if (r.pres) p.push(`<div>Pressione misurata dal barometro: <b class="text-white">${fmt(r.pres.p, 2)} hPa</b> (${r.pres.n} letture, dispersione ±${fmt(r.pres.std, 2)} hPa)</div>`);
            if (r.final && r.qnhBest) {
                const pExp = pressureAt(r.final.h, r.qnhBest.qnh);
                p.push(`<div>Pressione calcolata in questo punto (QNH ${esc(r.qnhBest.label)} ${fmt(r.qnhBest.qnh, 1)} hPa a ${Math.round(r.final.h)} m): <b class="text-white">${fmt(pExp, 1)} hPa</b>${r.pres ? ` · scarto del sensore ${(r.pres.p - pExp >= 0 ? '+' : '') + fmt(r.pres.p - pExp, 1)} hPa` : ''}</div>`);
            }
            html.push(`<div class="bg-slate-900/50 border border-slate-700 rounded-lg p-3 space-y-2 text-sm text-slate-300">
                <div class="text-xs uppercase tracking-wide text-slate-400">QNH e pressione</div>${q.join('')}${p.length ? '<div class="border-t border-slate-700 pt-2 space-y-1">' + p.join('') + '</div>' : ''}</div>`);
            // Come è stato calcolato
            html.push(`<details class="bg-slate-900/40 border border-slate-700 rounded-lg p-3 text-[11px] text-slate-400"><summary class="cursor-pointer text-slate-300">Come è stato calcolato</summary>
                <ul class="list-disc pl-4 mt-2 space-y-1">
                    <li>Ogni metodo dà una quota con la sua incertezza (σ). L'altitudine complessiva è la media pesata con pesi 1/σ²: il metodo più preciso pesa di più. L'incertezza finale è 1/√(Σ 1/σ²), allargata se i metodi si discostano più del previsto.</li>
                    <li>GPS: media pesata dei fix (pesi 1/precisione²) dopo aver scartato quelli molto peggiori della mediana. Gli errori GNSS sono correlati nel tempo, quindi la media riduce l'errore solo in parte (circa un campione indipendente ogni 15 s).${plugin ? ' L\'S24 Ultra usa GPS, Galileo, GLONASS, BeiDou e la doppia frequenza L1/L5 quando disponibile; con la connessione dati Android scarica gli aiuti A-GNSS per un fix più rapido.' : ''}</li>
                    <li>Barometro: quota ISA dal rapporto tra pressione misurata e QNH, corretta per la temperatura reale della colonna d'aria. L'errore assoluto tipico di un barometro da telefono (±1 hPa ≈ ±8 m) è incluso.</li>
                    <li>QNH: METAR (misurato in aeroporto, arrotondato all'hPa, peggiora con distanza e minuti trascorsi) e modello meteo alle tue coordinate. Offline si usa la mappa QNH degli snapshot (previsione oraria su 100 km) con errore crescente nel tempo.</li>
                    <li>Quota del terreno: modello digitale Copernicus GLO-90, ±5 m più l'effetto della pendenza sull'errore di posizione.</li>
                </ul></details>`);
            el.result.innerHTML = html.join('');
            const copy = el.result.querySelector('[data-alt-copy]');
            if (copy && r.pos) copy.addEventListener('click', () => {
                const txt = `${fmtCoordsDms(r.pos.lat, r.pos.lon)}\n${fmtCoordsDec(r.pos.lat, r.pos.lon)}${r.final ? `\nAltitudine ${Math.round(r.final.h)} m ± ${roundSigma(r.final.sigma)} m` : ''}`;
                (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => { copy.textContent = '✅ Copiato'; }, () => { copy.textContent = 'Copia non riuscita'; });
            });
            renderCaps();
        }

        function abort() { if (state.running) finish('pause'); }
        renderDuration();
        init();
        return { abort, get running() { return state.running; }, get last() { return state.last; }, refreshCaps: renderCaps };
    }

    const api = { calc, createPanel, fetchQnhGrid, fetchMetars };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.SkyAltimeter = api;
})(typeof window !== 'undefined' ? window : globalThis);
