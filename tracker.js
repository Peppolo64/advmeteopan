/*
 * SkyGuardian - GPS Tracking
 *
 * Velocità GPS istantanea (± errore), percorso con velocità media, distanza, tempi, velocità massima,
 * dislivello, grafico della velocità in tempo reale, traccia su mappa ed esportazione GPX.
 * - App Android: plugin nativo Tracker. Con «Esegui in background» il percorso continua ad app chiusa
 *   (servizio in primo piano con notifica); senza, il GPS si ferma quando l'app va in secondo piano.
 * - Sito: GPS del browser; se la pagina va in secondo piano il browser sospende il GPS.
 * I periodi senza punti (app chiusa) valgono velocità zero nel grafico e non aggiungono distanza:
 * per questo la velocità media su tutto il percorso ne risulta abbassata.
 *
 * SkyTracker.calc: calcoli puri (scripts/test-tracker.js) · SkyTracker.createPanel(opts): interfaccia
 */
(function (root) {
    'use strict';

    const GAP_MS = 10000;          // più di 10 s senza punti = periodo senza GPS (app chiusa)
    const MOVING = 0.5;            // m/s: sotto questa velocità si è fermi
    const MAX_ACC = 35;            // m: fix meno precisi esclusi da distanza e velocità
    const ISA_H = 44330.77, ISA_K = 1 / 5.25588;

    function distanceM(a, b) {
        const R = 6371008.8, r = Math.PI / 180;
        const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    }
    const num = v => (v === null || v === undefined || Number.isNaN(+v)) ? NaN : +v;
    // [t, lat, lon, hAcc, speed, speedAcc, mslAlt, ellAlt, vAcc, pressure]
    const fromArray = a => ({ t: num(a[0]), lat: num(a[1]), lon: num(a[2]), hAcc: num(a[3]), speed: num(a[4]), speedAcc: num(a[5]),
                              msl: num(a[6]), alt: num(a[7]), vAcc: num(a[8]), p: num(a[9]) });
    const toArray = p => [p.t, p.lat, p.lon, p.hAcc, p.speed, p.speedAcc, p.msl, p.alt, p.vAcc, p.p].map(v => Number.isFinite(v) ? v : null);

    // Errore della velocità: nativo (Doppler) se disponibile, altrimenti stima dalla precisione di posizione
    function speedSigma(p) {
        if (Number.isFinite(p.speedAcc) && p.speedAcc > 0) return { sigma: p.speedAcc, estimated: false };
        return { sigma: Math.max(0.3, (Number.isFinite(p.hAcc) ? p.hAcc : 20) / 12), estimated: true };
    }
    function altitudeOf(p, geoidN) {
        if (Number.isFinite(p.msl)) return p.msl;
        if (Number.isFinite(p.alt) && Number.isFinite(geoidN)) return p.alt - geoidN;
        return NaN;
    }

    // Statistiche del percorso. startedAt/now: estremi del tempo totale (contano anche i buchi).
    function stats(points, opts) {
        opts = opts || {};
        const geoidN = opts.geoidN;
        const pts = points.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.t));
        const startedAt = opts.startedAt || (pts[0] ? pts[0].t : 0);
        const end = opts.now || (pts.length ? pts[pts.length - 1].t : startedAt);
        const out = { distance: 0, elapsed: Math.max(0, end - startedAt), moving: 0, max: 0, gain: 0, loss: 0, gaps: [], gapTime: 0, n: pts.length };
        if (startedAt && pts.length && pts[0].t - startedAt > GAP_MS) out.gaps.push({ from: startedAt, to: pts[0].t });
        let prev = null;
        const speeds = [];
        // dislivello: barometro (variazioni relative, molto più stabili) oppure quota GNSS con isteresi
        const useBaro = pts.filter(p => Number.isFinite(p.p)).length > pts.length * 0.8 && pts.length > 1;
        let ref = NaN;
        const threshold = useBaro ? 1.5 : 5;
        for (const p of pts) {
            const good = !Number.isFinite(p.hAcc) || p.hAcc <= MAX_ACC;
            if (prev) {
                const dt = p.t - prev.t;
                if (dt > GAP_MS) out.gaps.push({ from: prev.t, to: p.t });
                else if (dt > 0 && good) {
                    const d = distanceM(prev, p);
                    const v = Number.isFinite(p.speed) ? p.speed : d / (dt / 1000);
                    if (v >= MOVING) { out.distance += d; out.moving += dt; }
                }
            }
            if (good) {
                const v = Number.isFinite(p.speed) ? p.speed : NaN;
                if (Number.isFinite(v) && (!Number.isFinite(p.speedAcc) || p.speedAcc < 2.5)) speeds.push(v);
                const h = useBaro ? (Number.isFinite(p.p) ? ISA_H * (1 - Math.pow(p.p / 1013.25, ISA_K)) : NaN) : altitudeOf(p, geoidN);
                if (Number.isFinite(h)) {
                    if (!Number.isFinite(ref)) ref = h;
                    else if (h - ref >= threshold) { out.gain += h - ref; ref = h; }
                    else if (ref - h >= threshold) { out.loss += ref - h; ref = h; }
                }
                prev = p;
            }
        }
        if (prev && end - prev.t > GAP_MS) out.gaps.push({ from: prev.t, to: end });
        // velocità massima: mediana mobile su 3 punti (niente picchi isolati)
        for (let i = 1; i < speeds.length - 1; i++) out.max = Math.max(out.max, [speeds[i - 1], speeds[i], speeds[i + 1]].sort((a, b) => a - b)[1]);
        if (speeds.length && speeds.length < 3) out.max = Math.max(...speeds);
        out.gapTime = out.gaps.reduce((s, g) => s + (g.to - g.from), 0);
        out.avg = out.elapsed > 0 ? out.distance / (out.elapsed / 1000) : 0;
        out.avgMoving = out.moving > 0 ? out.distance / (out.moving / 1000) : 0;
        out.useBaro = useBaro;
        const last = pts[pts.length - 1];
        out.altitude = last ? altitudeOf(last, geoidN) : NaN;
        return out;
    }

    // Serie per il grafico: velocità (km/h) nel tempo, zero nei periodi senza punti
    function speedSeries(points, opts) {
        opts = opts || {};
        const s = [];
        let prev = null;
        const startedAt = opts.startedAt || (points[0] && points[0].t);
        if (points.length && points[0].t - startedAt > GAP_MS) s.push([startedAt, 0, true], [points[0].t - 1000, 0, true]);
        for (const p of points) {
            if (prev && p.t - prev.t > GAP_MS) s.push([prev.t + 1000, 0, true], [p.t - 1000, 0, true]);
            const v = Number.isFinite(p.speed) ? p.speed : (prev && p.t > prev.t ? distanceM(prev, p) / ((p.t - prev.t) / 1000) : 0);
            s.push([p.t, v * 3.6, false]);
            prev = p;
        }
        if (prev && opts.now && opts.now - prev.t > GAP_MS) s.push([prev.t + 1000, 0, true], [opts.now, 0, true]);
        return s;
    }

    function toGpx(points, opts) {
        opts = opts || {};
        const esc = x => String(x).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
        const segs = [[]];
        let prev = null;
        for (const p of points) {
            if (prev && p.t - prev.t > GAP_MS) segs.push([]);
            segs[segs.length - 1].push(p);
            prev = p;
        }
        const pt = p => {
            const h = altitudeOf(p, opts.geoidN);
            return `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">${Number.isFinite(h) ? `<ele>${h.toFixed(1)}</ele>` : ''}<time>${new Date(p.t).toISOString()}</time>${Number.isFinite(p.speed) ? `<extensions><speed>${p.speed.toFixed(2)}</speed></extensions>` : ''}</trkpt>`;
        };
        return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="SkyGuardian" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(opts.name || 'Percorso')}</name><time>${new Date(points[0] ? points[0].t : Date.now()).toISOString()}</time></metadata>
  <trk><name>${esc(opts.name || 'Percorso')}</name>
${segs.filter(s => s.length).map(s => `    <trkseg>\n${s.map(pt).join('\n')}\n    </trkseg>`).join('\n')}
  </trk>
</gpx>
`;
    }

    const fmtDuration = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
    const fmtPace = mps => { if (!(mps > 0.3)) return '—'; const sPerKm = 1000 / mps; return `${Math.floor(sPerKm / 60)}:${String(Math.round(sPerKm % 60)).padStart(2, '0')} min/km`; };
    const kmh = (mps, d) => (mps * 3.6).toLocaleString('it-IT', { minimumFractionDigits: d === undefined ? 1 : d, maximumFractionDigits: d === undefined ? 1 : d });

    const calc = { GAP_MS, MOVING, distanceM, fromArray, toArray, speedSigma, altitudeOf, stats, speedSeries, toGpx, fmtDuration, fmtPace, kmh };

    // =====================================================================
    // PANNELLO
    // =====================================================================
    const STORE_KEY = 'skyguardian.track.last';

    function createPanel(opts) {
        const el = opts.elements, plugin = opts.plugin || null;
        const geoidAt = opts.geoidAt || (() => NaN);
        const state = { open: false, tracking: false, background: false, startedAt: 0, points: [], live: null, watchId: null,
                        previewId: null, handles: [], map: null, layers: null, renderPending: false, geoidN: NaN, saved: false };

        function chip(text, color) {
            const c = { emerald: 'border-emerald-700 text-emerald-200 bg-emerald-950/40', amber: 'border-amber-700 text-amber-200 bg-amber-950/40',
                        slate: 'border-slate-600 text-slate-300 bg-slate-800/60', red: 'border-red-700 text-red-200 bg-red-950/40' }[color];
            return `<span class="inline-block text-[11px] px-2 py-0.5 rounded-full border ${c}">${text}</span>`;
        }
        function renderCaps() {
            const chips = [];
            if (plugin) chips.push(chip('📱 App Android: GPS nativo con velocità Doppler', 'emerald'));
            else chips.push(chip('🌍 Browser: GPS del dispositivo', 'slate'));
            if (state.tracking) chips.push(state.background ? chip('🔔 In background con notifica', 'emerald') : chip(plugin ? '⏸ Si ferma se chiudi l\'app' : '⏸ Si ferma se lasci la pagina', 'amber'));
            el.caps.innerHTML = chips.join('');
            el.bgBox.disabled = !plugin || state.tracking;
            el.bgLabel.title = plugin ? 'Continua a registrare ad app chiusa (notifica visibile)' : 'Disponibile solo nell\'app Android';
            el.bgNote.textContent = plugin
                ? (el.bgBox.checked ? 'Il percorso continua anche ad app chiusa o a schermo spento, con una notifica e il tasto Ferma.' : 'Senza background: se chiudi l\'app il GPS si ferma e quel periodo vale velocità zero (abbassa la media).')
                : 'Nel browser il GPS si ferma se la pagina va in secondo piano: quel periodo vale velocità zero.';
        }

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
            state.handles = state.handles.filter(h => { if (h.kind === kind || !kind) { try { h.remove(); } catch (e) { /* ignora */ } return false; } return true; });
        }
        function fromBrowser(pos) {
            const c = pos.coords;
            return { t: pos.timestamp, lat: c.latitude, lon: c.longitude, hAcc: c.accuracy, speed: c.speed === null ? NaN : c.speed, speedAcc: NaN,
                     msl: NaN, alt: c.altitude === null ? NaN : c.altitude, vAcc: c.altitudeAccuracy === null ? NaN : c.altitudeAccuracy, p: NaN };
        }
        function geoErr(err) { say(err.code === 1 ? '📍 Permesso di posizione negato.' : '📍 Posizione non disponibile (prova all\'aperto).'); }
        function onLive(p) {
            if (!Number.isFinite(state.geoidN) && Number.isFinite(p.lat)) state.geoidN = geoidAt(p.lat, p.lon);
            state.live = p;
            scheduleRender();
        }

        // ---------- percorso ----------
        async function startTrack() {
            const background = !!(plugin && el.bgBox.checked);
            stopPreview();
            state.points = []; state.saved = false; state.background = background;
            if (plugin) {
                try {
                    await attachTrackListeners();
                    const r = await plugin.start({ background });
                    state.startedAt = r.startedAt || Date.now();
                    if (background && r.notifications === false) say('Notifiche negate: il percorso continua in background ma la notifica non è visibile.', 6000);
                } catch (e) { removeHandle(); say('📍 ' + (e.message || e)); startPreview(); return; }
            } else {
                if (!navigator.geolocation) { say('Geolocalizzazione non disponibile su questo browser.'); return; }
                state.startedAt = Date.now();
                state.watchId = navigator.geolocation.watchPosition(pos => onPoint(fromBrowser(pos)), geoErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
            }
            state.tracking = true;
            renderButtons(); renderCaps(); scheduleRender();
            state.ticker = setInterval(scheduleRender, 1000);
        }
        async function attachTrackListeners() {
            removeHandle();
            const a = await plugin.addListener('point', e => onPoint(fromArray(e.p))); a.kind = 'point';
            const b = await plugin.addListener('stopped', () => finishTrack(true)); b.kind = 'stopped';
            state.handles.push(a, b);
        }
        function onPoint(p) {
            if (!state.tracking) return;
            if (state.points.length && p.t <= state.points[state.points.length - 1].t) return;
            state.points.push(p);
            onLive(p);
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
            state.endedAt = Date.now();
            save();
            renderButtons(); renderCaps(); render();
            if (state.open && document.visibilityState !== 'hidden') startPreview();
        }
        // punti registrati dal servizio mentre la pagina era sospesa
        async function syncPoints() {
            if (!plugin) return;
            const r = await plugin.getPoints({ from: state.points.length });
            (r.points || []).map(fromArray).forEach(p => {
                if (!state.points.length || p.t > state.points[state.points.length - 1].t) state.points.push(p);
            });
        }
        function save() {
            try {
                localStorage.setItem(STORE_KEY, JSON.stringify({ startedAt: state.startedAt, endedAt: state.endedAt, background: state.background, points: state.points.map(toArray) }));
                state.saved = true;
            } catch (e) { /* spazio esaurito: il percorso resta solo in memoria */ }
        }
        function restoreLast() {
            try {
                const d = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
                if (d && d.points && d.points.length) {
                    state.points = d.points.map(fromArray); state.startedAt = d.startedAt; state.endedAt = d.endedAt; state.background = d.background; state.saved = true;
                }
            } catch (e) { /* ignora */ }
        }

        el.startBtn.addEventListener('click', () => { if (state.tracking) finishTrack(false); else startTrack(); });
        el.bgBox.addEventListener('change', renderCaps);
        el.gpxBtn.addEventListener('click', exportGpx);

        async function exportGpx() {
            if (!state.points.length) return;
            const d = new Date(state.startedAt || state.points[0].t);
            const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
            const name = `skyguardian-${stamp}.gpx`;
            const gpx = toGpx(state.points, { name: `SkyGuardian ${d.toLocaleString('it-IT')}`, geoidN: state.geoidN });
            if (plugin) {
                try { await plugin.exportGpx({ name, gpx }); } catch (e) { say('GPX: ' + (e.message || e)); }
                return;
            }
            const url = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
            const a = document.createElement('a');
            a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
        }

        // ---------- interfaccia ----------
        let sayTimer = null;
        function say(msg, ms) { el.status.textContent = msg || ''; clearTimeout(sayTimer); if (ms) sayTimer = setTimeout(() => { el.status.textContent = ''; }, ms); }
        function renderButtons() {
            el.startBtn.textContent = state.tracking ? '⏹ Ferma percorso' : '▶ Avvia Percorso';
            el.startBtn.classList.toggle('bg-emerald-600', !state.tracking);
            el.startBtn.classList.toggle('bg-red-600', state.tracking);
            el.gpxBtn.disabled = state.tracking || !state.points.length;
        }
        function scheduleRender() {
            if (state.renderPending) return;
            state.renderPending = true;
            requestAnimationFrame(() => { state.renderPending = false; render(); });
        }
        function render() {
            // velocità istantanea
            const p = state.live;
            const fresh = p && Date.now() - p.t < 5000;
            if (fresh && Number.isFinite(p.speed)) {
                const sg = speedSigma(p);
                el.speed.textContent = kmh(p.speed);
                el.speedErr.textContent = `± ${kmh(sg.sigma)} km/h${sg.estimated ? ' (stimato)' : ''}`;
            } else {
                el.speed.textContent = '—';
                el.speedErr.textContent = fresh ? 'velocità non fornita dal GPS' : (state.open ? 'in attesa del segnale GPS…' : '');
            }
            el.fixInfo.textContent = fresh ? `precisione posizione ±${Number.isFinite(p.hAcc) ? Math.round(p.hAcc) : '?'} m` : '';
            // statistiche
            // fine del percorso: il più tardo tra l'orologio del telefono e l'ultimo punto (ora GPS)
            const lastT = state.points.length ? state.points[state.points.length - 1].t : 0;
            const now = Math.max(lastT, state.tracking ? Date.now() : (state.endedAt || lastT));
            const st = stats(state.points, { startedAt: state.startedAt, now, geoidN: state.geoidN });
            const cell = (k, v, sub) => `<div class="bg-slate-900/60 border border-slate-700 rounded-lg p-2"><div class="text-[10px] uppercase tracking-wide text-slate-400">${k}</div><div class="text-lg font-bold text-white leading-tight">${v}</div>${sub ? `<div class="text-[10px] text-slate-500">${sub}</div>` : ''}</div>`;
            el.stats.innerHTML = state.points.length || state.tracking ? [
                cell('Velocità media', `${kmh(st.avg)} km/h`, `su tutto il percorso · ${fmtPace(st.avg)}`),
                cell('Media in movimento', `${kmh(st.avgMoving)} km/h`, fmtPace(st.avgMoving)),
                cell('Distanza', `${(st.distance / 1000).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} km`),
                cell('Durata', fmtDuration(st.elapsed), `in movimento ${fmtDuration(st.moving)}`),
                cell('Velocità massima', `${kmh(st.max)} km/h`),
                cell('Quota', Number.isFinite(st.altitude) ? `${Math.round(st.altitude)} m` : '—', 's.l.m. (GPS)'),
                cell('Salita', `${Math.round(st.gain)} m`, st.useBaro ? 'dal barometro' : 'dal GPS'),
                cell('Discesa', `${Math.round(st.loss)} m`, st.useBaro ? 'dal barometro' : 'dal GPS'),
            ].join('') : '';
            el.gapNote.textContent = st.gapTime > 0
                ? `⚠️ ${fmtDuration(st.gapTime)} senza GPS (${st.gaps.length} ${st.gaps.length === 1 ? 'interruzione' : 'interruzioni'}, app chiusa o in secondo piano): nel grafico vale velocità zero e abbassa la media.`
                : '';
            el.trackInfo.textContent = state.tracking ? `Percorso in corso · ${state.points.length} punti` : (state.points.length ? `Ultimo percorso: ${new Date(state.startedAt).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${state.points.length} punti` : '');
            el.chartBox.classList.toggle('hidden', !state.points.length && !state.tracking);
            el.mapBox.classList.toggle('hidden', !state.points.length);
            drawChart(st, now);
            drawMap();
            renderButtons();
        }

        function drawChart(st, now) {
            const c = el.chart;
            const w = c.clientWidth, h = c.clientHeight;
            if (!w || !h) return;
            const dpr = Math.min(window.devicePixelRatio || 1, 3);
            if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
            const ctx = c.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);
            const t0 = state.startedAt || (state.points[0] && state.points[0].t) || now, t1 = Math.max(now, t0 + 60000);
            const series = speedSeries(state.points, { startedAt: t0, now: state.tracking ? now : null });
            const vmax = Math.max(10, ...series.map(s => s[1])) * 1.15;
            const L = 34, B = 18, T = 8;
            const X = t => L + (t - t0) / (t1 - t0) * (w - L - 6), Y = v => T + (1 - v / vmax) * (h - T - B);
            // assi e griglia
            ctx.font = '10px system-ui, sans-serif'; ctx.fillStyle = '#94a3b8'; ctx.strokeStyle = 'rgba(148,163,184,0.18)'; ctx.lineWidth = 1;
            const step = vmax > 60 ? 20 : vmax > 25 ? 10 : 5;
            for (let v = 0; v <= vmax; v += step) { ctx.beginPath(); ctx.moveTo(L, Y(v)); ctx.lineTo(w - 6, Y(v)); ctx.stroke(); ctx.textAlign = 'right'; ctx.fillText(String(v), L - 4, Y(v) + 3); }
            ctx.textAlign = 'center';
            for (let k = 0; k <= 4; k++) { const t = t0 + (t1 - t0) * k / 4; ctx.fillText(fmtDuration(t - t0).replace(/^0:/, ''), Math.min(w - 16, Math.max(L + 10, X(t))), h - 4); }
            // periodi senza GPS
            ctx.fillStyle = 'rgba(239,68,68,0.16)';
            st.gaps.forEach(g => ctx.fillRect(X(g.from), T, Math.max(1, X(g.to) - X(g.from)), h - T - B));
            // velocità
            ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 1.8; ctx.beginPath();
            series.forEach(([t, v], i) => { const x = X(t), y = Y(v); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
            ctx.stroke();
            // media
            if (st.avg > 0) {
                ctx.setLineDash([5, 4]); ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 1.2;
                ctx.beginPath(); ctx.moveTo(L, Y(st.avg * 3.6)); ctx.lineTo(w - 6, Y(st.avg * 3.6)); ctx.stroke(); ctx.setLineDash([]);
                ctx.fillStyle = '#fbbf24'; ctx.textAlign = 'left'; ctx.fillText(`media ${kmh(st.avg)}`, L + 4, Y(st.avg * 3.6) - 3);
            }
            ctx.fillStyle = '#64748b'; ctx.textAlign = 'left'; ctx.fillText('km/h', 2, h - 4);
        }

        function drawMap() {
            if (!state.points.length || !root.L || el.mapBox.classList.contains('hidden')) return;
            const L = root.L;
            if (!state.map) {
                state.map = L.map(el.map, { zoomControl: true, attributionControl: true });
                L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(state.map);
                state.layers = L.layerGroup().addTo(state.map);
                state.fitted = 0;
            }
            if (state.drawnCount === state.points.length && state.drawnTracking === state.tracking) return;
            state.drawnCount = state.points.length; state.drawnTracking = state.tracking;
            state.layers.clearLayers();
            const segs = [[]];
            let prev = null;
            state.points.forEach(p => {
                if (prev && p.t - prev.t > GAP_MS) { L.polyline([[prev.lat, prev.lon], [p.lat, p.lon]], { color: '#ef4444', weight: 2, dashArray: '4 6' }).addTo(state.layers); segs.push([]); }
                segs[segs.length - 1].push([p.lat, p.lon]); prev = p;
            });
            segs.filter(s => s.length > 1).forEach(s => L.polyline(s, { color: '#38bdf8', weight: 4 }).addTo(state.layers));
            const first = state.points[0], last = state.points[state.points.length - 1];
            L.circleMarker([first.lat, first.lon], { radius: 6, color: '#22c55e', fillOpacity: 1 }).addTo(state.layers);
            L.circleMarker([last.lat, last.lon], { radius: 6, color: state.tracking ? '#f8fafc' : '#ef4444', fillOpacity: 1 }).addTo(state.layers);
            state.map.invalidateSize();
            const all = state.points.map(p => [p.lat, p.lon]);
            if (!state.fitted || !state.tracking || state.points.length - state.fitted > 30) {
                if (all.length > 1) state.map.fitBounds(all, { padding: [20, 20], maxZoom: 17 }); else state.map.setView(all[0], 16);
                state.fitted = state.points.length;
            }
        }

        // ---------- ciclo di vita ----------
        async function init() {
            restoreLast();
            if (plugin) {
                try {
                    const s = await plugin.status();
                    if (s.active) {   // percorso ancora in corso (ad es. pagina ricaricata con il servizio attivo)
                        state.tracking = true; state.background = s.background; state.startedAt = s.startedAt; state.points = []; state.saved = false;
                        await attachTrackListeners();
                        await syncPoints();
                        state.ticker = setInterval(scheduleRender, 1000);
                    }
                } catch (e) { /* plugin non pronto */ }
            }
            renderButtons(); renderCaps(); render();
        }
        function setOpen(open) {
            state.open = open;
            if (open && document.visibilityState !== 'hidden') { startPreview(); render(); setTimeout(() => { if (state.map) state.map.invalidateSize(); render(); }, 150); }
            else stopPreview();
        }
        async function onVisibility(visible) {
            if (!visible) { stopPreview(); return; }
            if (state.tracking && plugin) { try { await syncPoints(); } catch (e) { /* ignora */ } }
            if (state.open) startPreview();
            render();
        }
        window.addEventListener('resize', scheduleRender);
        init();
        return { setOpen, onVisibility, get tracking() { return state.tracking; }, get points() { return state.points; } };
    }

    const api = { calc, createPanel };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.SkyTracker = api;
})(typeof window !== 'undefined' ? window : globalThis);
