/*
 * SkyGuardian - Effemeridi 3D
 *
 * Sfera celeste completa (griglia azimutale) vista dall'esterno e ruotabile a mano, oppure
 * vista "dall'interno" guidata da giroscopio/bussola sopra l'immagine della fotocamera.
 * Livelli: Sole (posizione, traiettoria), ora d'oro, ora blu, crepuscoli civile/nautico/astronomico,
 * Luna (posizione, traiettoria), sorgere/tramonto e posizione della Via Lattea.
 *
 * - SkyEphemeris.astro: calcoli puri, senza DOM (testabili con Node: scripts/test-ephemeris.js)
 * - SkyEphemeris.createView(opts): vista Three.js + barra livelli + cursore temporale + elenco eventi
 *
 * Convenzioni: altezza/azimut in gradi, azimut da Nord in senso orario (E = 90°).
 * Spazio 3D: x = Est, y = Zenit, z = Sud (il Nord è -z). Orari nel fuso del dispositivo.
 */
(function (root) {
    'use strict';

    const DEG = Math.PI / 180;
    const MIN = 60000, HOUR = 3600000, DAY = 86400000;

    // =====================================================================
    // ASTRONOMIA (nessuna dipendenza dal DOM)
    // =====================================================================
    const norm360 = x => ((x % 360) + 360) % 360;
    const clamp1 = x => Math.max(-1, Math.min(1, x));

    function julianDay(ms) { return ms / DAY + 2440587.5; }

    // Tempo siderale medio di Greenwich (gradi)
    function gmstDeg(ms) { return norm360(280.46061837 + 360.98564736629 * (julianDay(ms) - 2451545.0)); }

    // Equatoriali (AR, Dec in gradi) -> orizzontali { alt, az } per l'osservatore
    function equToHor(raDeg, decDeg, ms, lat, lon) {
        const H = (gmstDeg(ms) + lon - raDeg) * DEG;
        const phi = lat * DEG, dec = decDeg * DEG;
        const alt = Math.asin(clamp1(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)));
        const east = -Math.sin(H) * Math.cos(dec);
        const north = Math.sin(dec) * Math.cos(phi) - Math.cos(dec) * Math.sin(phi) * Math.cos(H);
        return { alt: alt / DEG, az: norm360(Math.atan2(east, north) / DEG) };
    }

    // Galattiche (l, b) -> equatoriali J2000 (AR, Dec in gradi)
    const NGP_RA = 192.85948 * DEG, NGP_DEC = 27.12825 * DEG, L_NCP = 122.93192 * DEG;
    function galToEqu(lDeg, bDeg) {
        const l = lDeg * DEG, b = bDeg * DEG;
        const dec = Math.asin(clamp1(Math.sin(b) * Math.sin(NGP_DEC) + Math.cos(b) * Math.cos(NGP_DEC) * Math.cos(L_NCP - l)));
        const y = Math.cos(b) * Math.sin(L_NCP - l);
        const x = Math.sin(b) * Math.cos(NGP_DEC) - Math.cos(b) * Math.sin(NGP_DEC) * Math.cos(L_NCP - l);
        return { ra: norm360((NGP_RA + Math.atan2(y, x)) / DEG), dec: dec / DEG };
    }
    const GALACTIC_CENTER = galToEqu(0, 0);   // ≈ AR 266.4°, Dec -28.9° (Sagittario)

    // Altezza/azimut -> vettore 3D [x=Est, y=Zenit, z=Sud]
    function horToVec(alt, az, r) {
        r = r || 1;
        const a = alt * DEG, A = az * DEG;
        return [r * Math.cos(a) * Math.sin(A), r * Math.sin(a), -r * Math.cos(a) * Math.cos(A)];
    }
    // Vettore 3D -> { alt, az }
    function vecToHor(x, y, z) {
        const r = Math.hypot(x, y, z) || 1;
        return { alt: Math.asin(clamp1(y / r)) / DEG, az: norm360(Math.atan2(x, -z) / DEG) };
    }

    const sunAltAz = (SunCalc, ms, lat, lon) => {
        const p = SunCalc.getPosition(new Date(ms), lat, lon);
        return { alt: p.altitude / DEG, az: norm360(p.azimuth / DEG + 180) };
    };
    const moonAltAz = (SunCalc, ms, lat, lon) => {
        const p = SunCalc.getMoonPosition(new Date(ms), lat, lon);
        return { alt: p.altitude / DEG, az: norm360(p.azimuth / DEG + 180), dist: p.distance };
    };
    const gcAltAz = (ms, lat, lon) => equToHor(GALACTIC_CENTER.ra, GALACTIC_CENTER.dec, ms, lat, lon);

    // Istanti in cui altFn(t) attraversa la soglia nell'intervallo [t0, t1] (campionamento + bisezione)
    function findCrossings(altFn, t0, t1, threshold, stepMs) {
        stepMs = stepMs || 5 * MIN;
        const out = [];
        let ta = t0, fa = altFn(ta) - threshold;
        while (ta < t1) {
            const tb = Math.min(t1, ta + stepMs);
            const fb = altFn(tb) - threshold;
            if ((fa < 0) !== (fb < 0)) {
                let lo = ta, hi = tb, flo = fa;
                while (hi - lo > 2000) {
                    const mid = (lo + hi) / 2, fm = altFn(mid) - threshold;
                    if ((fm < 0) === (flo < 0)) { lo = mid; flo = fm; } else hi = mid;
                }
                out.push({ t: Math.round((lo + hi) / 2), rising: fa < 0 });
            }
            ta = tb; fa = fb;
        }
        return out;
    }

    // Massimo di altFn nell'intervallo (campionamento + sezione aurea)
    function findMaximum(altFn, t0, t1, stepMs) {
        stepMs = stepMs || 10 * MIN;
        let best = t0, bestV = -Infinity;
        for (let t = t0; t <= t1; t += stepMs) { const v = altFn(t); if (v > bestV) { bestV = v; best = t; } }
        let a = Math.max(t0, best - stepMs), b = Math.min(t1, best + stepMs);
        const g = (Math.sqrt(5) - 1) / 2;
        for (let i = 0; i < 30 && b - a > 1000; i++) {
            const c = b - g * (b - a), d = a + g * (b - a);
            if (altFn(c) > altFn(d)) b = d; else a = c;
        }
        const t = Math.round((a + b) / 2);
        return { t, alt: altFn(t) };
    }

    // Mezzanotte locale (fuso del dispositivo) del giorno "YYYY-MM-DD" e della mezzanotte successiva
    function localDayRange(dateStr) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
        const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date();
        const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
        return { start, end };
    }
    function localDateStr(ms) {
        const d = new Date(ms);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    // Soglie del Sole (gradi). L'alba/tramonto usa -0.833° (rifrazione + semidiametro).
    const SUN_LEVELS = [
        { alt: 6, rise: "Fine dell'ora d'oro", set: "Inizio dell'ora d'oro" },
        { alt: -0.833, rise: 'Alba', set: 'Tramonto' },
        { alt: -4, rise: "Fine dell'ora blu · inizio ora d'oro", set: "Fine dell'ora d'oro · inizio ora blu" },
        { alt: -6, rise: 'Inizio crepuscolo civile · ora blu', set: 'Fine ora blu · crepuscolo civile' },
        { alt: -12, rise: 'Inizio crepuscolo nautico', set: 'Fine crepuscolo nautico' },
        { alt: -18, rise: 'Inizio crepuscolo astronomico', set: 'Fine crepuscolo astronomico · notte' },
    ];
    // Settori all'orizzonte: tra le direzioni del Sole alle due soglie di ogni fase
    const TWILIGHT_BANDS = {
        golden: [6, -4],
        blue: [-4, -6],
        civil: [-0.833, -6],
        nautical: [-6, -12],
        astro: [-12, -18],
    };

    // Fase del giorno in base all'altezza del Sole
    function sunPhase(alt) {
        if (alt >= 6) return { key: 'day', label: 'GIORNO' };
        if (alt >= -4) return { key: 'golden', label: "ORA D'ORO" };
        if (alt >= -6) return { key: 'blue', label: 'ORA BLU' };
        if (alt >= -12) return { key: 'nautical', label: 'CREPUSCOLO NAUTICO' };
        if (alt >= -18) return { key: 'astro', label: 'CREPUSCOLO ASTRONOMICO' };
        return { key: 'night', label: 'NOTTE' };
    }

    // Tutti gli eventi del giorno locale, ordinati, più gli incroci per soglia (per i settori dei crepuscoli)
    function dayEvents(SunCalc, dateStr, lat, lon) {
        const { start, end } = localDayRange(dateStr);
        const sunAlt = t => sunAltAz(SunCalc, t, lat, lon).alt;
        const moonAlt = t => moonAltAz(SunCalc, t, lat, lon).alt;
        const gcAlt = t => gcAltAz(t, lat, lon).alt;
        const events = [];
        const sunLevels = {};

        SUN_LEVELS.forEach(level => {
            const rec = { rise: null, set: null };
            findCrossings(sunAlt, start, end, level.alt).forEach(c => {
                const az = sunAltAz(SunCalc, c.t, lat, lon).az;
                const key = c.rising ? 'rise' : 'set';
                if (!rec[key]) rec[key] = { t: c.t, az };
                events.push({ t: c.t, az, body: 'sun', level: level.alt, rising: c.rising, label: c.rising ? level.rise : level.set });
            });
            sunLevels[level.alt] = rec;
        });

        const noon = findMaximum(sunAlt, start, end);
        events.push({ t: noon.t, az: sunAltAz(SunCalc, noon.t, lat, lon).az, body: 'sun', culmination: true,
                      label: `Mezzogiorno solare · ${noon.alt.toFixed(1)}°` });

        findCrossings(moonAlt, start, end, 0.133).forEach(c => {
            events.push({ t: c.t, az: moonAltAz(SunCalc, c.t, lat, lon).az, body: 'moon', rising: c.rising,
                          label: c.rising ? 'Sorge la Luna' : 'Tramonta la Luna' });
        });

        const gcCross = findCrossings(gcAlt, start, end, 0, 10 * MIN);
        gcCross.forEach(c => {
            events.push({ t: c.t, az: gcAltAz(c.t, lat, lon).az, body: 'mw', rising: c.rising,
                          label: c.rising ? 'Sorge il centro della Via Lattea' : 'Tramonta il centro della Via Lattea' });
        });
        const gcTop = findMaximum(gcAlt, start, end, 15 * MIN);
        if (gcTop.alt > 0) {
            events.push({ t: gcTop.t, az: gcAltAz(gcTop.t, lat, lon).az, body: 'mw', culmination: true,
                          label: `Centro Via Lattea alla massima altezza · ${gcTop.alt.toFixed(1)}°` });
        }

        events.sort((a, b) => a.t - b.t);
        return { start, end, events, sunLevels, gcCrossings: gcCross.map(c => ({ t: c.t, rising: c.rising, az: gcAltAz(c.t, lat, lon).az })) };
    }

    // Traiettoria campionata: [{ t, alt, az }]
    function samplePath(fn, t0, t1, stepMs) {
        const out = [];
        for (let t = t0; t <= t1 + 1; t += stepMs) out.push(Object.assign({ t }, fn(t)));
        return out;
    }

    // Punti della Via Lattea (coordinate galattiche, generatore deterministico)
    function milkyWayPoints(n) {
        let seed = 20261105;
        const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
            t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
        const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
        const pts = [];
        for (let i = 0; i < n; i++) {
            let l = rnd() < 0.45 ? gauss() * 38 : rnd() * 360 - 180;    // più densa verso il centro galattico
            l = ((l + 180) % 360 + 360) % 360 - 180;
            const bulge = Math.exp(-Math.pow(l / 22, 2));
            const b = gauss() * (2.2 + 5.5 * bulge);
            pts.push({ l: norm360(l), b, glow: 0.35 + 0.65 * Math.max(bulge, rnd() * 0.5) });
        }
        return pts;
    }

    // Formattazioni
    const CARDINALS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
    const cardinal = az => CARDINALS[Math.round(norm360(az) / 22.5) % 16];
    function formatDms(value, pos, neg) {
        const v = Math.abs(value);
        const d = Math.floor(v), m = Math.floor((v - d) * 60);
        return `${d}° ${String(m).padStart(2, '0')}′ ${value >= 0 ? pos : neg}`;
    }
    function formatCoords(lat, lon) { return `${formatDms(lat, 'N', 'S')}  ${formatDms(lon, 'E', 'O')}`; }
    function gmtLabel(ms) {
        const off = -new Date(ms).getTimezoneOffset();
        const h = Math.trunc(off / 60), m = Math.abs(off % 60);
        return `GMT${off >= 0 ? '+' : '-'}${Math.abs(h)}${m ? ':' + String(m).padStart(2, '0') : ''}`;
    }
    const hhmm = ms => new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

    const astro = { DEG, norm360, julianDay, gmstDeg, equToHor, galToEqu, GALACTIC_CENTER, horToVec, vecToHor,
                    sunAltAz, moonAltAz, gcAltAz, findCrossings, findMaximum, localDayRange, localDateStr, dayEvents,
                    samplePath, milkyWayPoints, sunPhase, SUN_LEVELS, TWILIGHT_BANDS, cardinal, formatCoords, gmtLabel,
                    skyColor, hhmm };

    // =====================================================================
    // LIVELLI
    // =====================================================================
    const ICONS = {
        sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
        path: '<path d="M3 18c2.5-8 15.5-8 18 0"/><circle cx="12" cy="9" r="2.2" fill="currentColor" stroke="none"/>',
        glass: '<path d="M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9"/>',
        tw1: '<path d="M3 15h18M7 15a5 5 0 0 1 10 0"/><path d="M8 19h8"/>',
        tw2: '<path d="M3 13h18M7 13a5 5 0 0 1 10 0"/><path d="M8 17h8M10 20.5h4"/>',
        tw3: '<path d="M3 11h18M7 11a5 5 0 0 1 10 0"/><path d="M7 15h10M9 18h6M11 21h2"/>',
        moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
        moonPath: '<path d="M3 19c2.5-8 15.5-8 18 0"/><path d="M14.5 6.6a3.4 3.4 0 1 1-3.6-3.3 2.7 2.7 0 0 0 3.6 3.3z" fill="currentColor" stroke="none"/>',
        riseSet: '<path d="M7 20V7M4 10l3-3 3 3M17 4v13M14 14l3 3 3-3"/>',
        eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    };
    const LAYERS = [
        { id: 'sunPos', name: 'Posizione del Sole', short: 'Sole', icon: 'sun', color: '#facc15' },
        { id: 'sunPath', name: 'Traiettoria del Sole', short: 'Percorso', icon: 'path', color: '#f97316' },
        { id: 'golden', name: "Ora d'oro", short: 'Oro', icon: 'glass', color: '#f59e0b' },
        { id: 'blue', name: 'Ora blu', short: 'Blu', icon: 'glass', color: '#38bdf8' },
        { id: 'civil', name: 'Crepuscolo civile (alba e tramonto)', short: 'Civile', icon: 'tw1', color: '#60a5fa' },
        { id: 'nautical', name: 'Crepuscolo nautico', short: 'Nautico', icon: 'tw2', color: '#3b82f6' },
        { id: 'astro', name: 'Crepuscolo astronomico', short: 'Astro', icon: 'tw3', color: '#818cf8' },
        { id: 'moonPos', name: 'Posizione della Luna', short: 'Luna', icon: 'moon', color: '#4ade80' },
        { id: 'moonPath', name: 'Traiettoria della Luna', short: 'Percorso', icon: 'moonPath', color: '#22c55e' },
        { id: 'mwRiseSet', name: 'Sorgere e tramonto della Via Lattea', short: 'VL ↑↓', icon: 'riseSet', color: '#c084fc' },
        { id: 'milkyWay', name: 'Via Lattea (posizione attuale)', short: 'Via Lattea', icon: 'eye', color: '#a855f7' },
    ];
    const LAYER_BY_ID = Object.fromEntries(LAYERS.map(l => [l.id, l]));

    const EVENT_COLORS = { 6: '#f59e0b', '-0.833': '#fde047', '-4': '#38bdf8', '-6': '#60a5fa', '-12': '#3b82f6', '-18': '#818cf8' };
    function eventColor(ev) {
        if (ev.body === 'moon') return '#4ade80';
        if (ev.body === 'mw') return '#c084fc';
        if (ev.culmination) return '#facc15';
        return EVENT_COLORS[String(ev.level)] || '#facc15';
    }
    function eventLayer(ev) {
        if (ev.body === 'moon') return 'moonPath';
        if (ev.body === 'mw') return 'mwRiseSet';
        return ({ 6: 'golden', '-0.833': 'civil', '-4': 'blue', '-6': 'civil', '-12': 'nautical', '-18': 'astro' })[String(ev.level)] || 'sunPath';
    }

    // Colori della barra del tempo in base all'altezza del Sole
    function skyColor(alt) {
        if (alt >= 6) return [59, 130, 246];
        if (alt >= -0.833) return [234, 128, 52];
        if (alt >= -4) return [214, 82, 60];
        if (alt >= -6) return [49, 72, 196];
        if (alt >= -12) return [30, 44, 128];
        if (alt >= -18) return [22, 26, 76];
        return [10, 12, 30];
    }

    // =====================================================================
    // VISTA
    // =====================================================================
    function createView(opts) {
        const THREE = opts.THREE, SunCalc = opts.SunCalc, el = opts.elements;
        const onChange = opts.onChange || function () {};

        const state = {
            lat: 38.1157, lon: 13.3615, source: 'panel',
            t: Date.now(), scale: '24h',
            layers: Object.fromEntries(LAYERS.map(l => [l.id, true])),
            yaw: 0.35, pitch: 0.38, dist: 4.0,
            mode: 'manual', active: true,
        };
        let day = null;                 // risultato di dayEvents per il giorno corrente
        let dayKey = '';

        // ---------- Three.js ----------
        const renderer = new THREE.WebGLRenderer({ canvas: el.canvas, antialias: true, alpha: true, preserveDrawingBuffer: false });
        renderer.setClearColor(0x000000, 0);
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(36, 1, 0.01, 100);

        const groups = {};
        function group(name) { const g = new THREE.Group(); g.name = name; scene.add(g); groups[name] = g; return g; }
        const gGrid = group('grid'), gHorizon = group('horizon'), gDisk = group('disk'), gObserver = group('observer');
        LAYERS.forEach(l => group(l.id));

        const textures = new Map();
        function labelTexture(text, color, bold) {
            const key = text + '|' + color + '|' + (bold ? 1 : 0);
            if (textures.has(key)) return textures.get(key);
            const c = document.createElement('canvas');
            const ctx = c.getContext('2d');
            const font = `${bold ? '700' : '600'} 44px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
            ctx.font = font;
            const w = Math.ceil(ctx.measureText(text).width) + 20;
            c.width = w; c.height = 64;
            ctx.font = font;
            ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(2,6,23,0.95)';
            ctx.shadowBlur = 8;
            ctx.fillStyle = color;
            ctx.fillText(text, 10, 33);
            const tex = new THREE.CanvasTexture(c);
            tex.minFilter = THREE.LinearFilter;
            const out = { tex, aspect: w / 64 };
            textures.set(key, out);
            return out;
        }
        // px = altezza dell'etichetta sullo schermo (in pixel CSS), indipendente da zoom e dimensione del riquadro
        function makeLabel(text, color, px, bold) {
            const { tex, aspect } = labelTexture(text, color, bold);
            const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
            const s = new THREE.Sprite(mat);
            s.userData.px = px;
            s.userData.aspect = aspect;
            s.scale.set(0.05 * aspect, 0.05, 1);
            s.renderOrder = 20;
            return s;
        }
        let lastLabelScale = 0;
        function updateLabelScale(worldPerPx) {
            if (Math.abs(worldPerPx - lastLabelScale) < 1e-9 && !labelsDirty) return;
            lastLabelScale = worldPerPx; labelsDirty = false;
            scene.traverse(o => {
                if (o.isSprite && o.userData.px) {
                    const h = o.userData.px * 1.45 * worldPerPx;   // la texture ha margini: il testo è ~70% dell'altezza
                    o.scale.set(h * o.userData.aspect, h, 1);
                }
            });
        }
        let labelsDirty = true;
        let glowTex = null;
        function glowTexture() {
            if (glowTex) return glowTex;
            const c = document.createElement('canvas'); c.width = c.height = 64;
            const ctx = c.getContext('2d');
            const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
            g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(255,255,255,0.45)'); g.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
            glowTex = new THREE.CanvasTexture(c);
            return glowTex;
        }
        const v3 = (alt, az, r) => { const a = horToVec(alt, az, r); return new THREE.Vector3(a[0], a[1], a[2]); };
        function disposeGroup(g) {
            while (g.children.length) {
                const ch = g.children.pop();
                ch.traverse(o => {
                    if (o.geometry) o.geometry.dispose();
                    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
                });
            }
        }
        function lineFrom(points, color, opacity) {
            const geo = new THREE.BufferGeometry().setFromPoints(points);
            return new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
        }
        function dot(pos, color, r, opacity) {
            const m = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10),
                new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity: opacity === undefined ? 1 : opacity }));
            m.position.copy(pos);
            return m;
        }
        function tube(points, color, radius, opacity) {
            if (points.length < 2) return null;
            const curve = new THREE.CatmullRomCurve3(points);
            const geo = new THREE.TubeGeometry(curve, Math.max(8, points.length * 3), radius, 6, false);
            const solid = opacity >= 1;
            return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: !solid, opacity, depthWrite: solid }));
        }

        // ---------- Elementi fissi: griglia azimutale, orizzonte, osservatore ----------
        (function buildStatic() {
            const above = new THREE.LineBasicMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.32, depthWrite: false });
            const below = new THREE.LineBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.16, depthWrite: false });
            for (let alt = -75; alt <= 75; alt += 15) {
                if (alt === 0) continue;
                const pts = [];
                for (let az = 0; az <= 360; az += 3) pts.push(v3(alt, az));
                gGrid.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), alt > 0 ? above : below));
            }
            for (let az = 0; az < 360; az += 15) {
                const up = [], down = [];
                for (let alt = 0; alt <= 90; alt += 3) up.push(v3(alt, az));
                for (let alt = 0; alt >= -90; alt -= 3) down.push(v3(alt, az));
                gGrid.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(up), above));
                gGrid.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(down), below));
            }
            [30, 60].forEach(alt => {
                const s = makeLabel(`${alt}°`, '#94a3b8', 10);
                s.position.copy(v3(alt + 2, 183, 1.0));
                gGrid.add(s);
            });

            // Disco dell'orizzonte (semitrasparente: separa cielo visibile e sottosuolo)
            const disk = new THREE.Mesh(new THREE.CircleGeometry(1, 96).rotateX(-Math.PI / 2),
                new THREE.MeshBasicMaterial({ color: 0x0b1222, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
            gDisk.add(disk);

            // Anello dell'orizzonte con tacche e punti cardinali
            const ring = new THREE.Mesh(new THREE.RingGeometry(1.0, 1.045, 160).rotateX(-Math.PI / 2),
                new THREE.MeshBasicMaterial({ color: 0xcbd5e1, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }));
            gHorizon.add(ring);
            const ticks = [];
            for (let az = 0; az < 360; az += 5) {
                const len = az % 45 === 0 ? 0.075 : (az % 15 === 0 ? 0.05 : 0.028);
                ticks.push(v3(0, az, 1.045), v3(0, az, 1.045 - len));
            }
            gHorizon.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(ticks),
                new THREE.LineBasicMaterial({ color: 0x334155, transparent: true, opacity: 0.9 })));
            const cards = [['N', 0, '#f87171'], ['NE', 45], ['E', 90], ['SE', 135], ['S', 180], ['SO', 225], ['O', 270], ['NO', 315]];
            cards.forEach(([txt, az, col]) => {
                const main = txt.length === 1;
                const s = makeLabel(txt, col || (main ? '#e2e8f0' : '#94a3b8'), main ? 15 : 11, main);
                s.position.copy(v3(0, az, 1.13));
                gHorizon.add(s);
            });

            gObserver.add(dot(new THREE.Vector3(0, 0, 0), 0xf8fafc, 0.022));
        })();

        // ---------- Via Lattea (fissa in coordinate equatoriali, ruotata a ogni istante) ----------
        const gMilky = groups.milkyWay;
        const mwInner = new THREE.Group();
        mwInner.matrixAutoUpdate = false;
        gMilky.add(mwInner);
        (function buildMilkyWay() {
            const eqVec = (ra, dec, r) => new THREE.Vector3(r * Math.cos(dec * DEG) * Math.cos(ra * DEG), r * Math.cos(dec * DEG) * Math.sin(ra * DEG), r * Math.sin(dec * DEG));
            const pts = milkyWayPoints(3200);
            const pos = new Float32Array(pts.length * 3), col = new Float32Array(pts.length * 3);
            pts.forEach((p, i) => {
                const e = galToEqu(p.l, p.b);
                const v = eqVec(e.ra, e.dec, 0.995);
                pos.set([v.x, v.y, v.z], i * 3);
                const w = p.glow;
                col.set([(0.55 + 0.4 * w) * w, (0.38 + 0.45 * w) * w, (0.95) * w], i * 3);
            });
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
            geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
            mwInner.add(new THREE.Points(geo, new THREE.PointsMaterial({
                size: 0.05, map: glowTexture(), vertexColors: true, transparent: true, depthWrite: false,
                blending: THREE.AdditiveBlending, opacity: 0.55, sizeAttenuation: true })));
            for (let l = -170; l <= 180; l += 10) {
                const e = galToEqu(norm360(l), 0);
                const near = Math.exp(-Math.pow(l / 30, 2));
                mwInner.add(dot(eqVec(e.ra, e.dec, 1.0), 0xa855f7, 0.011 + 0.026 * near, 0.85));
            }
            const gc = eqVec(GALACTIC_CENTER.ra, GALACTIC_CENTER.dec, 1.0);
            const lbl = makeLabel('Via Lattea', '#d8b4fe', 12, true);
            lbl.position.copy(gc.clone().multiplyScalar(1.09));
            mwInner.add(lbl);
        })();
        const eqBasis = { x: new THREE.Vector3(), y: new THREE.Vector3(), z: new THREE.Vector3() };
        function updateMilkyWay() {
            const a = equToHor(0, 0, state.t, state.lat, state.lon);
            const b = equToHor(90, 0, state.t, state.lat, state.lon);
            const c = equToHor(0, 90, state.t, state.lat, state.lon);
            eqBasis.x.fromArray(horToVec(a.alt, a.az));
            eqBasis.y.fromArray(horToVec(b.alt, b.az));
            eqBasis.z.fromArray(horToVec(c.alt, c.az));
            mwInner.matrix.makeBasis(eqBasis.x, eqBasis.y, eqBasis.z);
            mwInner.matrixWorldNeedsUpdate = true;
        }

        // ---------- Sole e Luna (posizione attuale) ----------
        const sunMarker = new THREE.Group();
        sunMarker.add(dot(new THREE.Vector3(), 0xfbbf24, 0.05));
        const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xfacc15, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.8 }));
        sunGlow.scale.set(0.3, 0.3, 1);
        sunMarker.add(sunGlow);
        const sunLabel = makeLabel('Sole', '#fde68a', 13, true);
        sunMarker.add(sunLabel);
        groups.sunPos.add(sunMarker);
        let sunRay = null;

        const moonMarker = new THREE.Group();
        moonMarker.add(dot(new THREE.Vector3(), 0xbbf7d0, 0.042));
        let moonLabel = null;
        groups.moonPos.add(moonMarker);
        let moonRay = null;

        function placeBody(marker, labelSprite, alt, az) {
            const p = v3(alt, az, 1.0);
            marker.position.copy(p);
            if (labelSprite) labelSprite.position.set(0, 0.085, 0);
            return p;
        }
        function updateBodies() {
            const s = sunAltAz(SunCalc, state.t, state.lat, state.lon);
            const sp = placeBody(sunMarker, sunLabel, s.alt, s.az);
            if (sunRay) { groups.sunPos.remove(sunRay); sunRay.geometry.dispose(); sunRay.material.dispose(); }
            sunRay = lineFrom([new THREE.Vector3(), sp], 0xfacc15, 0.55);
            groups.sunPos.add(sunRay);

            const m = moonAltAz(SunCalc, state.t, state.lat, state.lon);
            const illum = SunCalc.getMoonIllumination(new Date(state.t));
            const pct = Math.round(illum.fraction * 100);
            if (!moonLabel || moonLabel.userData.pct !== pct) {
                if (moonLabel) { moonMarker.remove(moonLabel); moonLabel.material.dispose(); }
                moonLabel = makeLabel(`Luna ${pct}%`, '#86efac', 12, true);
                labelsDirty = true;
                moonLabel.userData.pct = pct;
                moonMarker.add(moonLabel);
            }
            const mp = placeBody(moonMarker, moonLabel, m.alt, m.az);
            if (moonRay) { groups.moonPos.remove(moonRay); moonRay.geometry.dispose(); moonRay.material.dispose(); }
            moonRay = lineFrom([new THREE.Vector3(), mp], 0x4ade80, 0.5);
            groups.moonPos.add(moonRay);
            return { sun: s, moon: m, illum: pct };
        }

        // ---------- Traiettorie (per il giorno selezionato) ----------
        function buildPath(g, sampler, color, labelColor) {
            disposeGroup(g);
            const samples = samplePath(sampler, day.start, day.end, 10 * MIN);
            // spezza in tratti sopra/sotto l'orizzonte: sopra è pieno (opaco), sotto è più tenue
            const runs = [];
            let cur = [samples[0]];
            for (let i = 1; i < samples.length; i++) {
                const p = samples[i], prev = samples[i - 1];
                cur.push(p);
                if ((p.alt >= 0) !== (prev.alt >= 0)) { runs.push({ pts: cur, above: prev.alt >= 0 }); cur = [prev, p]; }
            }
            runs.push({ pts: cur, above: samples[samples.length - 1].alt >= 0 });
            runs.forEach(r => {
                const t = tube(r.pts.map(p => v3(p.alt, p.az, 1.0)), color, 0.0085, r.above ? 1 : 0.38);
                if (t) g.add(t);
            });
            // pallini e numeri delle ore
            const h0 = new Date(day.start);
            for (let h = 0; h < 24; h++) {
                const t = new Date(h0.getFullYear(), h0.getMonth(), h0.getDate(), h).getTime();
                if (t >= day.end) break;
                const p = sampler(t);
                const pos = v3(p.alt, p.az, 1.0);
                g.add(dot(pos, color, 0.016, p.alt >= 0 ? 1 : 0.55));
                const s = makeLabel(String(new Date(t).getHours()), labelColor, 10, true);
                s.position.copy(v3(Math.min(88, p.alt + 4.2), p.az, 1.0));
                if (p.alt < 0) s.material.opacity = 0.6;
                g.add(s);
            }
        }

        // ---------- Settori di crepuscolo all'orizzonte ----------
        function buildTwilight() {
            Object.keys(TWILIGHT_BANDS).forEach(id => {
                const g = groups[id];
                disposeGroup(g);
                const color = new THREE.Color(LAYER_BY_ID[id].color);
                const [a1, a2] = TWILIGHT_BANDS[id];
                ['rise', 'set'].forEach(kind => {
                    const e1 = day.sunLevels[a1] && day.sunLevels[a1][kind];
                    const e2 = day.sunLevels[a2] && day.sunLevels[a2][kind];
                    [e1, e2].forEach(e => {
                        if (!e) return;
                        const end = v3(0, e.az, 1.0);
                        g.add(lineFrom([new THREE.Vector3(0, 0.002, 0), end.clone().setY(0.002)], color, 0.95));
                        g.add(dot(end, color, 0.014));
                    });
                    if (e1 && e2) {
                        // spicchio tra le due direzioni
                        let d = norm360(e2.az - e1.az);
                        if (d > 180) d -= 360;
                        const steps = Math.max(2, Math.ceil(Math.abs(d) / 1.5));
                        const verts = [];
                        for (let i = 0; i < steps; i++) {
                            const azA = e1.az + d * i / steps, azB = e1.az + d * (i + 1) / steps;
                            verts.push(0, 0.001, 0, ...horToVec(0, azA, 0.995), ...horToVec(0, azB, 0.995));
                        }
                        const geo = new THREE.BufferGeometry();
                        geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
                        g.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false })));
                    }
                });
            });
        }

        // ---------- Sorgere/tramonto della Via Lattea ----------
        function buildMwRiseSet() {
            const g = groups.mwRiseSet;
            disposeGroup(g);
            day.gcCrossings.forEach(c => {
                const end = v3(0, c.az, 1.0);
                g.add(lineFrom([new THREE.Vector3(0, 0.003, 0), end.clone().setY(0.003)], 0xc084fc, 0.95));
                g.add(dot(end, 0xc084fc, 0.02));
                const s = makeLabel(`VL ${c.rising ? '↑' : '↓'} ${hhmm(c.t)}`, '#e9d5ff', 11, true);
                s.position.copy(v3(6, c.az, 1.04));
                g.add(s);
            });
        }

        // ---------- Visibilità livelli ----------
        function applyLayers() {
            LAYERS.forEach(l => { groups[l.id].visible = !!state.layers[l.id]; });
            renderLayerBar();
            requestRender();
        }

        // ---------- Camera / render ----------
        let rafPending = false;
        function requestRender() {
            if (rafPending || !state.active) return;
            rafPending = true;
            requestAnimationFrame(renderFrame);
        }
        const tmpQ = new THREE.Quaternion();
        function renderFrame() {
            rafPending = false;
            if (!state.active) return;
            resizeIfNeeded();
            if (state.mode === 'camera') {
                if (sensor.has) {
                    camera.quaternion.slerp(sensor.q, sensor.first ? 1 : 0.25);
                    sensor.first = false;
                }
                updatePointingReadout();
                updateLabelScale(2 * Math.tan(camera.fov * DEG / 2) / Math.max(1, lastH));
                requestRender();   // in modalità fotocamera il ciclo è continuo
            } else {
                // in un riquadro verticale allontana la camera così la sfera entra anche in larghezza
                const dist = state.dist / Math.min(1, camera.aspect);
                const cp = Math.cos(state.pitch);
                camera.position.set(dist * cp * Math.sin(state.yaw), dist * Math.sin(state.pitch), dist * cp * Math.cos(state.yaw));
                camera.up.set(0, 1, 0);
                camera.lookAt(0, 0, 0);
                updateLabelScale(2 * dist * Math.tan(camera.fov * DEG / 2) / Math.max(1, lastH));
            }
            renderer.render(scene, camera);
        }
        let lastW = 0, lastH = 0;
        function resizeIfNeeded() {
            const w = el.viewer.clientWidth, h = el.viewer.clientHeight;
            if (!w || !h || (w === lastW && h === lastH)) return;
            lastW = w; lastH = h;
            renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
            renderer.setSize(w, h, false);
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
            drawTimeline();
        }
        const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { requestRender(); drawTimeline(); }) : null;
        if (ro) { ro.observe(el.viewer); ro.observe(el.timeline); }

        // ---------- Rotazione a mano (trascinamento, pizzico, rotella) ----------
        const pointers = new Map();
        let pinchStart = 0, pinchDist0 = 0;
        el.canvas.addEventListener('pointerdown', e => {
            if (state.mode !== 'manual') return;
            el.canvas.setPointerCapture(e.pointerId);
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pointers.size === 2) {
                const [a, b] = [...pointers.values()];
                pinchStart = Math.hypot(a.x - b.x, a.y - b.y); pinchDist0 = state.dist;
            }
        });
        el.canvas.addEventListener('pointermove', e => {
            if (state.mode !== 'manual' || !pointers.has(e.pointerId)) return;
            const prev = pointers.get(e.pointerId);
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pointers.size === 1) {
                const k = 3.2 / Math.max(240, el.viewer.clientWidth);
                state.yaw -= (e.clientX - prev.x) * k * 1.6;
                state.pitch = Math.max(-1.45, Math.min(1.5605, state.pitch + (e.clientY - prev.y) * k * 1.6));
            } else if (pointers.size === 2 && pinchStart) {
                const [a, b] = [...pointers.values()];
                const d = Math.hypot(a.x - b.x, a.y - b.y);
                state.dist = Math.max(1.7, Math.min(7, pinchDist0 * pinchStart / Math.max(20, d)));
            }
            requestRender();
        });
        const endPointer = e => { pointers.delete(e.pointerId); if (pointers.size < 2) pinchStart = 0; };
        el.canvas.addEventListener('pointerup', endPointer);
        el.canvas.addEventListener('pointercancel', endPointer);
        el.canvas.addEventListener('wheel', e => {
            if (state.mode !== 'manual') return;
            e.preventDefault();
            state.dist = Math.max(1.7, Math.min(7, state.dist * (1 + e.deltaY * 0.0012)));
            requestRender();
        }, { passive: false });
        el.canvas.addEventListener('dblclick', () => resetView());

        function resetView() { state.yaw = 0.35; state.pitch = 0.38; state.dist = 4.0; requestRender(); }
        function topView() { state.yaw = 0; state.pitch = 1.5605; state.dist = 3.6; requestRender(); }

        // ---------- Modalità fotocamera (giroscopio + bussola) ----------
        const sensor = { q: new THREE.Quaternion(), has: false, first: true, absolute: false, handler: null, stream: null, timer: null };
        const zee = new THREE.Vector3(0, 0, 1);
        const euler = new THREE.Euler();
        const q0 = new THREE.Quaternion();
        const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));   // -90° su X: dal "telefono in piano" al "telefono in verticale"
        function screenAngle() {
            return ((screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle : (window.orientation || 0)) * DEG;
        }
        function onOrientation(e) {
            if (e.alpha === null || e.beta === null) return;
            let alpha = e.alpha;
            if (e.type === 'deviceorientation' && typeof e.webkitCompassHeading === 'number') {   // iOS
                alpha = 360 - e.webkitCompassHeading;
                sensor.absolute = true;
            } else if (e.type === 'deviceorientationabsolute' || e.absolute) {
                sensor.absolute = true;
            }
            euler.set(e.beta * DEG, alpha * DEG, -e.gamma * DEG, 'YXZ');
            sensor.q.setFromEuler(euler).multiply(q1).multiply(q0.setFromAxisAngle(zee, -screenAngle()));
            sensor.has = true;
        }
        function cameraSupported() {
            return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && typeof DeviceOrientationEvent !== 'undefined'
                && window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
        }
        async function startCameraMode() {
            if (!cameraSupported()) { say('📷 La modalità fotocamera richiede un telefono o tablet con giroscopio e bussola.'); return false; }
            // iOS (e alcuni Chromium): il permesso ai sensori va chiesto dentro il gesto dell'utente.
            // Un rifiuto non blocca: se poi i dati non arrivano davvero, lo si segnala sotto.
            let sensorDenied = false;
            if (typeof DeviceOrientationEvent.requestPermission === 'function') {
                try { sensorDenied = (await DeviceOrientationEvent.requestPermission()) !== 'granted'; }
                catch (err) { sensorDenied = true; }
            }
            state.mode = 'camera';
            sensor.has = false; sensor.first = true; sensor.absolute = false;
            sensor.handler = onOrientation;
            if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', sensor.handler);
            else window.addEventListener('deviceorientation', sensor.handler);
            el.viewer.classList.add('eph-camera');
            gDisk.visible = false; gObserver.visible = false;
            camera.position.set(0, 0, 0);
            camera.fov = 62; camera.updateProjectionMatrix();
            say('📷 Avvio fotocamera…');
            try {
                sensor.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
                if (state.mode !== 'camera') { stopStream(); return false; }
                el.video.srcObject = sensor.stream;
                el.video.classList.remove('hidden');
                await el.video.play().catch(() => {});
                say('📷 Inquadra il cielo: Sole, Luna e Via Lattea seguono il movimento del telefono.');
            } catch (err) {
                say('📷 Fotocamera non disponibile o permesso negato: uso solo i sensori di movimento.');
            }
            clearTimeout(sensor.timer);
            sensor.timer = setTimeout(() => {
                if (state.mode !== 'camera') return;
                if (!sensor.has) say(sensorDenied ? '🧭 Permesso ai sensori di movimento negato: consentilo nelle impostazioni del browser.' : '🧭 Nessun dato dai sensori di orientamento su questo dispositivo.');
                else if (!sensor.absolute) say('🧭 Bussola non disponibile: la direzione del Nord potrebbe non essere allineata.');
            }, 2500);
            renderModeButtons();
            requestRender();
            return true;
        }
        function stopStream() {
            if (sensor.stream) { sensor.stream.getTracks().forEach(t => t.stop()); sensor.stream = null; }
            el.video.srcObject = null;
            el.video.classList.add('hidden');
        }
        function stopCameraMode(silent) {
            if (state.mode !== 'camera') return;
            state.mode = 'manual';
            clearTimeout(sensor.timer);
            if (sensor.handler) {
                window.removeEventListener('deviceorientationabsolute', sensor.handler);
                window.removeEventListener('deviceorientation', sensor.handler);
                sensor.handler = null;
            }
            stopStream();
            el.viewer.classList.remove('eph-camera');
            gDisk.visible = true; gObserver.visible = true;
            camera.fov = 36; camera.updateProjectionMatrix();
            camera.quaternion.identity();
            if (el.pointing) el.pointing.textContent = '';
            if (!silent) say('');
            renderModeButtons();
            requestRender();
        }
        const fwd = new THREE.Vector3();
        let lastPointing = '';
        function updatePointingReadout() {
            if (!el.pointing) return;
            camera.getWorldDirection(fwd);
            const h = vecToHor(fwd.x, fwd.y, fwd.z);
            const txt = `Inquadri: ${Math.round(h.az)}° ${cardinal(h.az)} · ${h.alt >= 0 ? '+' : ''}${Math.round(h.alt)}°`;
            if (txt !== lastPointing) { el.pointing.textContent = txt; lastPointing = txt; }
        }
        function renderModeButtons() {
            const camOk = cameraSupported();
            el.modeButtons.forEach(b => {
                const on = b.dataset.ephMode === state.mode;
                b.classList.toggle('bg-blue-600', on);
                b.classList.toggle('text-white', on);
                b.classList.toggle('text-slate-300', !on);
                b.setAttribute('aria-pressed', on ? 'true' : 'false');
                if (b.dataset.ephMode === 'camera') {
                    b.disabled = !camOk;
                    b.title = camOk ? 'Muovi il telefono per esplorare il cielo con la fotocamera' : 'Disponibile su telefono o tablet con giroscopio e bussola';
                }
            });
            if (el.viewTools) el.viewTools.classList.toggle('hidden', state.mode !== 'manual');
        }
        el.modeButtons.forEach(b => b.addEventListener('click', () => {
            if (b.dataset.ephMode === 'camera') { if (state.mode !== 'camera') startCameraMode(); }
            else stopCameraMode();
        }));

        // ---------- Barra dei livelli ----------
        function renderLayerBar() {
            if (!el.layerBar.children.length) {
                LAYERS.forEach(l => {
                    const b = document.createElement('button');
                    b.type = 'button';
                    b.dataset.layer = l.id;
                    b.title = l.name;
                    b.setAttribute('aria-label', l.name);
                    b.className = 'eph-layer-btn';
                    b.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[l.icon]}</svg><span>${l.short}</span>`;
                    b.addEventListener('click', () => {
                        state.layers[l.id] = !state.layers[l.id];
                        applyLayers();
                        say(`${l.name}: ${state.layers[l.id] ? 'visibile' : 'nascosto'}`, 1800);
                        renderEvents();
                        onChange();
                    });
                    el.layerBar.appendChild(b);
                });
            }
            Array.from(el.layerBar.children).forEach(b => {
                const l = LAYER_BY_ID[b.dataset.layer];
                const on = !!state.layers[l.id];
                b.style.setProperty('--eph-color', l.color);
                b.classList.toggle('is-on', on);
                b.setAttribute('aria-pressed', on ? 'true' : 'false');
            });
        }

        // ---------- Messaggi ----------
        let sayTimer = null;
        function say(msg, ms) {
            if (!el.status) return;
            clearTimeout(sayTimer);
            el.status.textContent = msg || '';
            if (ms) sayTimer = setTimeout(() => { el.status.textContent = ''; }, ms);
        }

        // ---------- Tempo ----------
        function timeRange() {
            const d = new Date(state.t);
            if (state.scale === '1h') {
                const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
                return { t0: s, t1: s + HOUR };
            }
            if (state.scale === '365d') {
                return { t0: new Date(d.getFullYear(), 0, 1).getTime(), t1: new Date(d.getFullYear() + 1, 0, 1).getTime() };
            }
            return { t0: day.start, t1: day.end };
        }
        function minutesOfDay(ms) { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); }
        // in modalità 365d: stesso orario, giorno diverso
        function atDayIndex(year, idx, minutes) {
            return new Date(year, 0, 1 + idx, Math.floor(minutes / 60), minutes % 60).getTime();
        }

        function ensureDay() {
            const key = `${localDateStr(state.t)}|${state.lat.toFixed(4)}|${state.lon.toFixed(4)}`;
            if (key === dayKey) return false;
            dayKey = key;
            day = dayEvents(SunCalc, localDateStr(state.t), state.lat, state.lon);
            buildPath(groups.sunPath, t => sunAltAz(SunCalc, t, state.lat, state.lon), 0xf97316, '#fdba74');
            buildPath(groups.moonPath, t => moonAltAz(SunCalc, t, state.lat, state.lon), 0x22c55e, '#86efac');
            buildTwilight();
            buildMwRiseSet();
            timelineCache = null;
            labelsDirty = true;
            renderEvents();
            return true;
        }

        function setTime(t, quiet) {
            state.t = Math.round(t / 1000) * 1000;
            ensureDay();
            updateMilkyWay();
            const pos = updateBodies();
            renderHeader();
            renderReadout(pos);
            highlightEvents();
            drawTimeline();
            requestRender();
            if (!quiet) onChange();
        }

        // ---------- Testata (località e coordinate) ----------
        function renderHeader() {
            if (el.place) el.place.textContent = state.source === 'device' ? `Posizione del dispositivo (${gmtLabel(state.t)})` : `Località del Pannello di Controllo (${gmtLabel(state.t)})`;
            if (el.coords) el.coords.textContent = formatCoords(state.lat, state.lon);
            if (el.deviceBtn) el.deviceBtn.classList.toggle('hidden', state.source === 'device');
            if (el.panelBtn) el.panelBtn.classList.toggle('hidden', state.source !== 'device');
            const d = new Date(state.t);
            if (el.scaleBtn) el.scaleBtn.textContent = state.scale;
            if (el.yearLabel) el.yearLabel.textContent = d.getFullYear();
            if (el.dateLabel) el.dateLabel.textContent = d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
            if (el.timeLabel) el.timeLabel.textContent = hhmm(state.t);
            if (el.dateInput) el.dateInput.value = localDateStr(state.t);
            if (el.timeInput) el.timeInput.value = hhmm(state.t);
        }
        function fmtBody(p) { return `${p.alt >= 0 ? '+' : ''}${p.alt.toFixed(1)}° · ${Math.round(p.az)}° ${cardinal(p.az)}`; }
        function renderReadout(pos) {
            if (!el.readout) return;
            const phase = sunPhase(pos.sun.alt);
            el.readout.innerHTML =
                `<span style="color:#fde68a">☀ ${fmtBody(pos.sun)}</span>` +
                `<span style="color:#86efac">☾ ${fmtBody(pos.moon)} · ${pos.illum}%</span>` +
                `<span class="text-slate-300">${phase.label.toLowerCase()}</span>`;
        }

        // ---------- Elenco eventi ----------
        function renderEvents() {
            if (!el.events || !day) return;
            const title = new Date(day.start).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
            const rows = day.events.map((ev, i) => {
                const layer = eventLayer(ev);
                const dim = state.layers[layer] ? '' : ' opacity-40';
                return `<button type="button" data-ev="${i}" class="eph-event w-full text-left flex items-center gap-2 px-2 py-1.5 rounded border border-transparent hover:bg-slate-700/60 transition${dim}">
                    <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${eventColor(ev)}"></span>
                    <span class="font-mono text-slate-200 w-11 shrink-0">${hhmm(ev.t)}</span>
                    <span class="flex-1 text-slate-300">${ev.label}</span>
                    <span class="text-[11px] text-slate-500 shrink-0">${Math.round(ev.az)}° ${cardinal(ev.az)}</span>
                </button>`;
            }).join('');
            el.events.innerHTML = `<div class="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Eventi di ${title}</div>` +
                (rows || '<p class="text-xs text-slate-500 italic">Nessun evento in questo giorno.</p>');
            el.events.querySelectorAll('[data-ev]').forEach(b => b.addEventListener('click', () => {
                const ev = day.events[Number(b.dataset.ev)];
                if (state.scale === '365d') state.scale = '24h';
                setTime(ev.t);
            }));
            highlightEvents();
        }
        function eventTolerance() { return state.scale === '1h' ? 2 * MIN : state.scale === '365d' ? 0 : 12 * MIN; }
        function highlightEvents() {
            if (!el.events || !day) return;
            const tol = eventTolerance();
            let first = null;
            el.events.querySelectorAll('[data-ev]').forEach(b => {
                const ev = day.events[Number(b.dataset.ev)];
                const on = tol > 0 && Math.abs(ev.t - state.t) <= tol;
                b.classList.toggle('eph-event-on', on);
                if (on && !first) first = ev;
            });
            if (el.nearEvent) el.nearEvent.textContent = first ? `${hhmm(first.t)} · ${first.label}` : '';
        }

        // ---------- Barra del tempo (canvas) ----------
        let timelineCache = null;
        function timelineSize() {
            const c = el.timeline;
            const w = Math.max(200, c.clientWidth), h = Math.max(60, c.clientHeight);
            const dpr = Math.min(window.devicePixelRatio || 1, 3);
            if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
                c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); timelineCache = null;
            }
            return { w, h, dpr };
        }
        const TL = { top: 16, bottom: 16 };
        function altToY(alt, h) { const mid = TL.top + (h - TL.top - TL.bottom) / 2; return mid - (alt / 90) * (h - TL.top - TL.bottom) / 2; }
        function buildTimelineCache(w, h, dpr) {
            const { t0, t1 } = timeRange();
            const key = `${state.scale}|${t0}|${w}|${h}|${dayKey}|${state.scale === '365d' ? minutesOfDay(state.t) : ''}`;
            if (timelineCache && timelineCache.key === key) return timelineCache;
            const off = document.createElement('canvas');
            off.width = Math.round(w * dpr); off.height = Math.round(h * dpr);
            const ctx = off.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            const bandTop = TL.top, bandH = h - TL.top - TL.bottom;
            const year = new Date(t0).getFullYear();
            const nDays = Math.round((t1 - t0) / DAY);
            const mins = minutesOfDay(state.t);
            const timeAt = x => state.scale === '365d'
                ? atDayIndex(year, Math.min(nDays - 1, Math.floor(x / w * nDays)), mins)
                : t0 + (x / w) * (t1 - t0);
            const step = 2;
            const sun = [], moon = [], gc = [];
            for (let x = 0; x <= w; x += step) {
                const t = timeAt(x);
                const s = sunAltAz(SunCalc, t, state.lat, state.lon).alt;
                const c = skyColor(s);
                ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
                ctx.fillRect(x, bandTop, step + 0.5, bandH);
                sun.push([x, s]);
                moon.push([x, moonAltAz(SunCalc, t, state.lat, state.lon).alt]);
                gc.push([x, gcAltAz(t, state.lat, state.lon).alt]);
            }
            // orizzonte
            ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(0, altToY(0, h)); ctx.lineTo(w, altToY(0, h)); ctx.stroke();
            const curve = (pts, color, width, dash) => {
                ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || []);
                ctx.beginPath();
                pts.forEach(([x, a], i) => { const y = altToY(a, h); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
                ctx.stroke(); ctx.setLineDash([]);
            };
            curve(gc, 'rgba(216,180,254,0.75)', 1.2, [3, 3]);
            curve(moon, '#4ade80', 1.8);
            curve(sun, '#fde047', 2);
            // etichette asse
            ctx.fillStyle = '#94a3b8'; ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
            if (state.scale === '365d') {
                for (let m = 0; m < 12; m++) {
                    const x = (Math.round((new Date(year, m, 1).getTime() - t0) / DAY) + 0.5) / nDays * w;
                    ctx.fillText(new Date(year, m, 1).toLocaleDateString('it-IT', { month: 'short' }), Math.min(w - 12, x + 10), h - TL.bottom + 3);
                }
            } else {
                const stepMs = state.scale === '1h' ? 10 * MIN : 3 * HOUR;
                for (let t = t0; t <= t1; t += stepMs) {
                    const x = (t - t0) / (t1 - t0) * w;
                    const d = new Date(t);
                    const lbl = state.scale === '1h' ? hhmm(t) : String(d.getHours());
                    ctx.fillText(lbl, Math.max(8, Math.min(w - 10, x)), h - TL.bottom + 3);
                    ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(x, bandTop, 1, bandH); ctx.fillStyle = '#94a3b8';
                }
                // marcatori degli eventi del giorno
                if (day) day.events.forEach(ev => {
                    if (ev.t < t0 || ev.t > t1) return;
                    const x = (ev.t - t0) / (t1 - t0) * w;
                    ctx.fillStyle = eventColor(ev);
                    ctx.fillRect(x - 1, bandTop, 2, 5);
                });
            }
            timelineCache = { key, canvas: off, timeAt, t0, t1, nDays, year };
            return timelineCache;
        }
        function cursorX(w, cache) {
            if (state.scale === '365d') {
                const idx = Math.round((new Date(new Date(state.t).getFullYear(), new Date(state.t).getMonth(), new Date(state.t).getDate()).getTime() - cache.t0) / DAY);
                return (idx + 0.5) / cache.nDays * w;
            }
            return (state.t - cache.t0) / (cache.t1 - cache.t0) * w;
        }
        function drawTimeline() {
            if (!el.timeline || !day || !state.active) return;
            const { w, h, dpr } = timelineSize();
            const cache = buildTimelineCache(w, h, dpr);
            const ctx = el.timeline.getContext('2d');
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, el.timeline.width, el.timeline.height);
            ctx.drawImage(cache.canvas, 0, 0);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            const x = Math.max(1, Math.min(w - 1, cursorX(w, cache)));
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(x - 1, TL.top - 4, 2, h - TL.top - TL.bottom + 8);
            const s = sunAltAz(SunCalc, state.t, state.lat, state.lon).alt;
            const m = moonAltAz(SunCalc, state.t, state.lat, state.lon).alt;
            [[m, '#4ade80'], [s, '#fde047']].forEach(([a, col]) => {
                ctx.beginPath(); ctx.arc(x, altToY(a, h), 5, 0, 2 * Math.PI);
                ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = '#0f172a'; ctx.stroke();
            });
            ctx.font = '700 10px system-ui, sans-serif'; ctx.textBaseline = 'top'; ctx.fillStyle = '#e2e8f0';
            const label = state.scale === '365d' ? new Date(state.t).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }) : sunPhase(s).label;
            const lw = ctx.measureText(label).width;
            ctx.textAlign = 'left';
            ctx.fillText(label, Math.max(2, Math.min(w - lw - 2, x - lw / 2)), 2);
        }
        // trascinamento sulla barra (un aggiornamento per fotogramma)
        let dragging = false, pendingX = null, dragRaf = 0;
        function timelinePointer(e) {
            const r = el.timeline.getBoundingClientRect();
            pendingX = Math.max(0, Math.min(r.width, e.clientX - r.left));
            if (dragRaf) return;
            dragRaf = requestAnimationFrame(() => {
                dragRaf = 0;
                const cache = timelineCache || buildTimelineCache(r.width, r.height, Math.min(window.devicePixelRatio || 1, 3));
                let t = cache.timeAt(pendingX);
                if (state.scale !== '365d') t = Math.round(t / MIN) * MIN;
                setTime(Math.min(cache.t1 - MIN, t));
            });
        }
        el.timeline.addEventListener('pointerdown', e => { dragging = true; el.timeline.setPointerCapture(e.pointerId); timelinePointer(e); });
        el.timeline.addEventListener('pointermove', e => { if (dragging) timelinePointer(e); });
        el.timeline.addEventListener('pointerup', () => { dragging = false; });
        el.timeline.addEventListener('pointercancel', () => { dragging = false; });

        // ---------- Comandi del tempo ----------
        const SCALES = ['24h', '1h', '365d'];
        if (el.scaleBtn) el.scaleBtn.addEventListener('click', () => {
            state.scale = SCALES[(SCALES.indexOf(state.scale) + 1) % SCALES.length];
            timelineCache = null;
            say(state.scale === '24h' ? 'Cursore: le 24 ore del giorno' : state.scale === '1h' ? "Cursore: un'ora, al minuto" : 'Cursore: i 365 giorni dell\'anno alla stessa ora', 2200);
            setTime(state.t);
        });
        function shift(sign) {
            const d = new Date(state.t);
            if (state.scale === '1h') setTime(state.t + sign * HOUR);
            else if (state.scale === '365d') setTime(new Date(d.getFullYear() + sign, d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()).getTime());
            else setTime(new Date(d.getFullYear(), d.getMonth(), d.getDate() + sign, d.getHours(), d.getMinutes()).getTime());
        }
        if (el.prevBtn) el.prevBtn.addEventListener('click', () => shift(-1));
        if (el.nextBtn) el.nextBtn.addEventListener('click', () => shift(1));
        if (el.dateInput) el.dateInput.addEventListener('change', () => {
            const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(el.dateInput.value);
            if (!m) return;
            const mins = minutesOfDay(state.t);
            setTime(new Date(+m[1], +m[2] - 1, +m[3], Math.floor(mins / 60), mins % 60).getTime());
        });
        if (el.timeInput) el.timeInput.addEventListener('change', () => {
            const m = /^(\d{2}):(\d{2})/.exec(el.timeInput.value);
            if (!m) return;
            const d = new Date(state.t);
            setTime(new Date(d.getFullYear(), d.getMonth(), d.getDate(), +m[1], +m[2]).getTime());
        });
        if (el.resetViewBtn) el.resetViewBtn.addEventListener('click', resetView);
        if (el.topViewBtn) el.topViewBtn.addEventListener('click', topView);

        // ---------- API ----------
        function setLocation(lat, lon, source) {
            state.lat = lat; state.lon = lon; state.source = source || 'panel';
            dayKey = '';
            setTime(state.t, true);
        }
        // Data del pannello + ora corrente (o un istante preciso)
        function setDate(dateStr, timeMs) {
            if (typeof timeMs === 'number') { setTime(timeMs, true); return; }
            const now = new Date();
            const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
            const t = m ? new Date(+m[1], +m[2] - 1, +m[3], now.getHours(), now.getMinutes()).getTime() : now.getTime();
            setTime(t, true);
        }
        function setActive(on) {
            state.active = !!on;
            if (!on) stopCameraMode(true);
            else { lastW = 0; requestRender(); drawTimeline(); }
        }
        function getState() {
            return { layers: Object.assign({}, state.layers), scale: state.scale, t: state.t, yaw: state.yaw, pitch: state.pitch, dist: state.dist };
        }
        function applyState(s) {
            if (!s) return;
            if (s.layers) LAYERS.forEach(l => { if (typeof s.layers[l.id] === 'boolean') state.layers[l.id] = s.layers[l.id]; });
            if (SCALES.includes(s.scale)) state.scale = s.scale;
            ['yaw', 'pitch', 'dist'].forEach(k => { if (isFinite(s[k])) state[k] = s[k]; });
            applyLayers();
            if (isFinite(s.t)) setTime(s.t, true);
        }

        renderModeButtons();
        applyLayers();
        return { setLocation, setDate, setTime, setActive, getState, applyState, resetView, topView,
                 get source() { return state.source; }, get mode() { return state.mode; } };
    }

    const api = { astro, LAYERS, createView };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.SkyEphemeris = api;
})(typeof window !== 'undefined' ? window : globalThis);
