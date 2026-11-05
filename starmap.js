/*
 * SkyGuardian - Mappa Stellare
 *
 * Cielo visto dall'osservatore (camera al centro della sfera, Three.js), come un planetario:
 * 41.000 stelle fino a mag 8, costellazioni (figure, nomi, confini), Via Lattea, oggetti Messier,
 * Sole, Luna (con fase) e pianeti, griglie azimutale/equatoriale, eclittica e meridiano, suolo,
 * atmosfera diurna, modalità notte. Rotazione a mano o con giroscopio/bussola, zoom, ricerca,
 * scheda dettagliata dell'oggetto toccato, cursore del tempo 24h/365d con scorrimento ▶.
 *
 * - SkyStarMap.astro: calcoli puri (precessione, pianeti, colori, decodifica dati) testabili con Node
 * - SkyStarMap.createView(opts): vista
 * Dati: skydata.js (window.SkyStarData), generato da android-app/scripts/build-skydata.js.
 */
(function (root) {
    'use strict';

    const E = root.SkyEphemeris || (typeof require === 'function' ? require('./ephemeris.js') : null);
    const A = E.astro;
    const DEG = Math.PI / 180, MIN = 60000, HOUR = 3600000, DAY = 86400000;
    const OBLIQUITY = 23.43928 * DEG;

    // =====================================================================
    // ASTRONOMIA
    // =====================================================================
    // Matrici 3x3 come array di 9 elementi (riga per riga)
    function mul3(a, b) {
        const r = new Array(9);
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
            r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
        return r;
    }
    const apply3 = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
    const transpose3 = m => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
    const eqVec = (raDeg, decDeg) => {
        const a = raDeg * DEG, d = decDeg * DEG;
        return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
    };
    const vecToEq = v => ({ ra: A.norm360(Math.atan2(v[1], v[0]) / DEG), dec: Math.asin(Math.max(-1, Math.min(1, v[2]))) / DEG });

    // Precessione J2000 -> equinozio medio della data (IAU 1976, Meeus cap. 21)
    function precessionMatrix(ms) {
        const T = (A.julianDay(ms) - 2451545.0) / 36525;
        const as = DEG / 3600;
        const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T * T * T) * as;
        const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T * T * T) * as;
        const theta = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T * T * T) * as;
        const Rz = a => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];
        const Ry = t => [Math.cos(t), 0, -Math.sin(t), 0, 1, 0, Math.sin(t), 0, Math.cos(t)];
        return mul3(Rz(z), mul3(Ry(theta), Rz(zeta)));
    }

    // Equatoriali della data -> orizzontali (x=Est, y=Zenit, z=Sud): colonne = immagini degli assi
    function eqToHorMatrix(ms, lat, lon) {
        const cols = [[0, 0], [90, 0], [0, 90]].map(([ra, dec]) => {
            const h = A.equToHor(ra, dec, ms, lat, lon);
            return A.horToVec(h.alt, h.az);
        });
        return [cols[0][0], cols[1][0], cols[2][0], cols[0][1], cols[1][1], cols[2][1], cols[0][2], cols[1][2], cols[2][2]];
    }
    // J2000 -> orizzontali
    function j2000ToHorMatrix(ms, lat, lon) { return mul3(eqToHorMatrix(ms, lat, lon), precessionMatrix(ms)); }

    // Posizione eliocentrica eclittica J2000 (UA) dagli elementi kepleriani JPL
    function helio(p, ms) {
        const T = (A.julianDay(ms) - 2451545.0) / 36525;
        const [a0, e0, i0, L0, W0, N0] = p.el, [da, de, di, dL, dW, dN] = p.rate;
        const a = a0 + da * T, e = e0 + de * T, i = (i0 + di * T) * DEG;
        const L = L0 + dL * T, W = W0 + dW * T, N = (N0 + dN * T) * DEG;
        const w = (W - N0 - dN * T) * DEG;
        let M = A.norm360(L - W) * DEG;
        if (M > Math.PI) M -= 2 * Math.PI;
        let Ek = M + e * Math.sin(M);
        for (let k = 0; k < 8; k++) Ek -= (Ek - e * Math.sin(Ek) - M) / (1 - e * Math.cos(Ek));
        const xp = a * (Math.cos(Ek) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(Ek);
        const cw = Math.cos(w), sw = Math.sin(w), cN = Math.cos(N), sN = Math.sin(N), ci = Math.cos(i), si = Math.sin(i);
        return [
            (cw * cN - sw * sN * ci) * xp + (-sw * cN - cw * sN * ci) * yp,
            (cw * sN + sw * cN * ci) * xp + (-sw * sN + cw * cN * ci) * yp,
            (sw * si) * xp + (cw * si) * yp,
        ];
    }
    const eclToEq = v => [v[0], v[1] * Math.cos(OBLIQUITY) - v[2] * Math.sin(OBLIQUITY), v[1] * Math.sin(OBLIQUITY) + v[2] * Math.cos(OBLIQUITY)];
    const MAG_FORMULA = {
        mer: a => -0.42 + 0.0380 * a - 0.000273 * a * a + 0.000002 * a * a * a,
        ven: a => -4.40 + 0.0009 * a + 0.000239 * a * a - 0.00000065 * a * a * a,
        mar: a => -1.52 + 0.016 * a,
        jup: a => -9.40 + 0.005 * a,
        sat: a => -8.88 + 0.044 * a,
        ura: () => -7.19,
        nep: () => -6.87,
    };
    // Pianeta geocentrico: AR/Dec J2000, distanza (UA), magnitudine, elongazione dal Sole, fase illuminata
    function planetGeo(planets, id, ms) {
        const earth = planets.find(p => p.id === 'ter');
        const pl = planets.find(p => p.id === id);
        const E3 = helio(earth, ms), P3 = helio(pl, ms);
        const g = [P3[0] - E3[0], P3[1] - E3[1], P3[2] - E3[2]];
        const delta = Math.hypot(...g), r = Math.hypot(...P3), R = Math.hypot(...E3);
        const eq = eclToEq(g).map(x => x / delta);
        const phaseAng = Math.acos(Math.max(-1, Math.min(1, (r * r + delta * delta - R * R) / (2 * r * delta)))) / DEG;
        const elong = Math.acos(Math.max(-1, Math.min(1, (R * R + delta * delta - r * r) / (2 * R * delta)))) / DEG;
        const mag = MAG_FORMULA[id] ? MAG_FORMULA[id](phaseAng) + 5 * Math.log10(r * delta) : null;
        return Object.assign(vecToEq(eq), { vec: eq, dist: delta, r, mag, elong, phase: (1 + Math.cos(phaseAng * DEG)) / 2 });
    }
    // Sole geocentrico dagli stessi elementi (per i test)
    function sunGeo(planets, ms) {
        const e = helio(planets.find(p => p.id === 'ter'), ms).map(x => -x);
        const d = Math.hypot(...e);
        return vecToEq(eclToEq(e).map(x => x / d));
    }

    // Colore approssimato della stella dall'indice B-V
    const BV_TABLE = [[-0.4, [0.61, 0.71, 1.0]], [0.0, [0.79, 0.85, 1.0]], [0.4, [1.0, 0.98, 0.95]], [0.8, [1.0, 0.9, 0.74]],
                      [1.2, [1.0, 0.8, 0.58]], [1.6, [1.0, 0.7, 0.45]], [2.2, [1.0, 0.58, 0.33]]];
    function starColor(bv) {
        if (bv <= BV_TABLE[0][0]) return BV_TABLE[0][1];
        for (let i = 1; i < BV_TABLE.length; i++) {
            if (bv <= BV_TABLE[i][0]) {
                const [b0, c0] = BV_TABLE[i - 1], [b1, c1] = BV_TABLE[i];
                const k = (bv - b0) / (b1 - b0);
                return c0.map((c, j) => c + (c1[j] - c) * k);
            }
        }
        return BV_TABLE[BV_TABLE.length - 1][1];
    }
    function colorName(bv) {
        if (bv < -0.1) return 'azzurra'; if (bv < 0.15) return 'bianco-azzurra'; if (bv < 0.5) return 'bianca';
        if (bv < 0.85) return 'gialla'; if (bv < 1.4) return 'arancione'; return 'rossa';
    }
    const SPECT_CLASS = { O: 'stella blu molto calda', B: 'stella blu-bianca calda', A: 'stella bianca', F: 'stella bianco-gialla',
                          G: 'stella gialla (come il Sole)', K: 'stella arancione', M: 'stella rossa', C: 'stella al carbonio', S: 'stella di tipo S',
                          W: 'stella di Wolf-Rayet', D: 'nana bianca' };
    const LUM_CLASS = [['VII', 'nana bianca'], ['VI', 'subnana'], ['IV', 'subgigante'], ['V', 'sequenza principale'],
                       ['III', 'gigante'], ['II', 'gigante brillante'], ['Ia', 'supergigante'], ['Ib', 'supergigante'], ['I', 'supergigante']];
    function spectDescription(sp) {
        if (!sp) return '';
        const cls = SPECT_CLASS[sp[0]] || '';
        // la prima classe di luminosità che compare nella sigla (es. "F7Ib-IIv" -> Ib, supergigante)
        let lum = null, at = Infinity;
        LUM_CLASS.forEach(([k, label]) => {
            const m = new RegExp(`${k}(?![IV])`).exec(sp.slice(1));
            if (m && (m.index < at || (m.index === at && k.length > lum.k.length))) { at = m.index; lum = { k, label }; }
        });
        return [cls, lum ? lum.label : ''].filter(Boolean).join(', ');
    }

    // Decodifica di skydata.js
    function b64ToBytes(s) {
        if (typeof atob === 'function') {
            const bin = atob(s), out = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
            return out;
        }
        return new Uint8Array(Buffer.from(s, 'base64'));
    }
    function decodeStars(data) {
        const s = data.stars;
        const typed = (key, T) => { const b = b64ToBytes(s[key]); return new T(b.buffer, b.byteOffset, b.byteLength / T.BYTES_PER_ELEMENT); };
        const ra = typed('ra', Float32Array), dec = typed('dec', Float32Array);
        const mag100 = typed('mag', Int16Array), bv1000 = typed('bv', Int16Array);
        const out = { n: s.n, ra, dec, mag: new Float32Array(s.n), bv: new Float32Array(s.n),
                      hip: typed('hip', Uint32Array), hd: typed('hd', Uint32Array), ly: new Float32Array(s.n), con: typed('con', Uint8Array),
                      spect: s.spect.split('|'), names: s.names, vec: new Float32Array(s.n * 3) };
        const ly = typed('ly', Uint16Array);
        for (let i = 0; i < s.n; i++) {
            out.mag[i] = mag100[i] / 100; out.bv[i] = bv1000[i] / 1000;
            out.ly[i] = !ly[i] ? 0 : ly[i] < 10000 ? ly[i] / 10 : (ly[i] - 10000) * 10;
            const v = eqVec(ra[i], dec[i]);
            out.vec[i * 3] = v[0]; out.vec[i * 3 + 1] = v[1]; out.vec[i * 3 + 2] = v[2];
        }
        return out;
    }

    // Magnitudine limite in base al campo visivo e alla luce del Sole (atmosfera)
    function limitingMagnitude(fovDeg, sunAlt, atmosphere) {
        const zoom = 6.2 + 2.3 * Math.log10(60 / Math.max(0.5, fovDeg));
        let lim = Math.max(4.8, Math.min(8.4, zoom));
        if (atmosphere) {
            if (sunAlt > -0.5) lim = Math.min(lim, -1.5);
            else if (sunAlt > -18) {
                const k = (-sunAlt - 0.5) / 17.5;          // 0 al tramonto, 1 a fine crepuscolo astronomico
                lim = Math.min(lim, -1.5 + (lim + 1.5) * Math.pow(k, 0.9));
            }
        }
        return lim;
    }

    const normalize = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
    const formatRa = ra => { const h = A.norm360(ra) / 15; const hh = Math.floor(h), mm = Math.floor((h - hh) * 60), ss = Math.round(((h - hh) * 60 - mm) * 60);
        return `${hh}h ${String(mm).padStart(2, '0')}m ${String(Math.min(59, ss)).padStart(2, '0')}s`; };
    const formatDec = dec => { const v = Math.abs(dec), d = Math.floor(v), m = Math.round((v - d) * 60);
        return `${dec < 0 ? '−' : '+'}${d}° ${String(Math.min(59, m)).padStart(2, '0')}′`; };

    const astro = { mul3, apply3, transpose3, eqVec, vecToEq, precessionMatrix, eqToHorMatrix, j2000ToHorMatrix, helio, planetGeo, sunGeo,
                    starColor, colorName, spectDescription, decodeStars, limitingMagnitude, normalize, formatRa, formatDec };

    // =====================================================================
    // LIVELLI (barra a destra)
    // =====================================================================
    const ICONS = {
        stars: '<path d="M12 3l2.2 5.6 6 .5-4.6 3.9 1.5 5.9L12 15.7 6.9 18.9l1.5-5.9L3.8 9.1l6-.5z"/>',
        starNames: '<path d="M4 7h11M4 12h16M4 17h8"/><circle cx="19" cy="7" r="1.6" fill="currentColor" stroke="none"/>',
        conLines: '<path d="M4 18l5-7 5 3 6-9"/><circle cx="4" cy="18" r="1.6" fill="currentColor"/><circle cx="9" cy="11" r="1.6" fill="currentColor"/><circle cx="14" cy="14" r="1.6" fill="currentColor"/><circle cx="20" cy="5" r="1.6" fill="currentColor"/>',
        conNames: '<path d="M3 18L7.5 6 12 18M4.7 14h5.6M14 18V9h3.5a2.3 2.3 0 0 1 0 4.5H14h4a2.3 2.3 0 0 1 0 4.5H14"/>',
        borders: '<path d="M4 4h16v16H4z" stroke-dasharray="3 2.5"/>',
        sunMoon: '<circle cx="8" cy="9" r="3.5"/><path d="M8 2.5v1.5M8 14v1.5M1.5 9H3M13 9h1.5"/><path d="M20 15.5a5 5 0 1 1-6-5.4 4 4 0 0 0 6 5.4z" fill="currentColor" stroke="none"/>',
        planets: '<circle cx="12" cy="12" r="4.5"/><ellipse cx="12" cy="12" rx="10" ry="3.2" transform="rotate(-20 12 12)"/>',
        messier: '<ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(-30 12 12)"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>',
        milkyWay: '<path d="M2 16c6-7 14-9 20-10" stroke-width="3.2" opacity="0.55"/><circle cx="7" cy="12" r="1" fill="currentColor"/><circle cx="15" cy="8.5" r="1" fill="currentColor"/>',
        azGrid: '<path d="M2 19h20M4 19a8 8 0 0 1 16 0M7.5 19a4.5 8 0 0 1 9 0M12 11v8"/>',
        eqGrid: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
        ecliptic: '<path d="M2 15c6-5 14-7 20-7" stroke-dasharray="3 2"/><path d="M12 2v20" opacity="0.6"/><circle cx="15" cy="9.5" r="2.2" fill="currentColor"/>',
        ground: '<path d="M2 18l6-7 4 4 3-3 7 6z" fill="currentColor" fill-opacity="0.35"/>',
        atmosphere: '<path d="M3 16a9 9 0 0 1 18 0"/><path d="M12 3v2M5.6 5.6L7 7M18.4 5.6L17 7"/><path d="M2 20h20"/>',
        night: '<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.6" fill="currentColor"/>',
    };
    const LAYERS = [
        { id: 'stars', name: 'Stelle', short: 'Stelle', color: '#f8fafc', on: true },
        { id: 'starNames', name: 'Nomi delle stelle', short: 'Nomi', color: '#e2e8f0', on: true },
        { id: 'conLines', name: 'Figure delle costellazioni', short: 'Figure', color: '#60a5fa', on: true },
        { id: 'conNames', name: 'Nomi delle costellazioni', short: 'Costell.', color: '#7dd3fc', on: true },
        { id: 'borders', name: 'Confini delle costellazioni', short: 'Confini', color: '#c08457', on: false },
        { id: 'sunMoon', name: 'Sole e Luna', short: 'Sole·Luna', color: '#facc15', on: true },
        { id: 'planets', name: 'Pianeti', short: 'Pianeti', color: '#fb923c', on: true },
        { id: 'messier', name: 'Oggetti Messier', short: 'Messier', color: '#f472b6', on: true },
        { id: 'milkyWay', name: 'Via Lattea', short: 'Via Lattea', color: '#c4b5fd', on: true },
        { id: 'azGrid', name: 'Griglia azimutale', short: 'Gr. Az.', color: '#a3e635', on: false },
        { id: 'eqGrid', name: 'Griglia equatoriale', short: 'Gr. Eq.', color: '#38bdf8', on: false },
        { id: 'ecliptic', name: 'Eclittica e meridiano', short: 'Eclittica', color: '#fbbf24', on: false },
        { id: 'ground', name: 'Suolo e orizzonte', short: 'Suolo', color: '#86efac', on: true },
        { id: 'atmosphere', name: 'Atmosfera (cielo diurno)', short: 'Atmosf.', color: '#93c5fd', on: true },
        { id: 'night', name: 'Modalità notte (rossa)', short: 'Notte', color: '#f87171', on: false },
    ];
    const LAYER_BY_ID = Object.fromEntries(LAYERS.map(l => [l.id, l]));
    const MESSIER_TYPES = { oc: 'Ammasso aperto', gc: 'Ammasso globulare', pn: 'Nebulosa planetaria', e: 'Galassia ellittica',
                            s: 'Galassia a spirale', i: 'Galassia irregolare', rn: 'Nebulosa a riflessione', snr: 'Resto di supernova',
                            sfr: 'Nebulosa a emissione', pos: 'Asterismo / stella doppia' };
    const PLANET_COLORS = { mer: '#cbd5e1', ven: '#fef3c7', mar: '#f87171', jup: '#fde68a', sat: '#fcd34d', ura: '#99f6e4', nep: '#93c5fd' };

    // =====================================================================
    // VISTA
    // =====================================================================
    function createView(opts) {
        const THREE = opts.THREE, SunCalc = opts.SunCalc, el = opts.elements, data = opts.data;
        const onChange = opts.onChange || function () {};
        const S = decodeStars(data);
        const CONS = data.constellations;
        const PLANETS = data.planets;

        const state = {
            lat: 38.1157, lon: 13.3615, source: 'panel',
            t: Date.now(), scale: '24h',
            layers: Object.fromEntries(LAYERS.map(l => [l.id, l.on])),
            az: 180, alt: 30, fov: 70,
            mode: 'manual', active: true,
            playing: false, speed: 600,
            selected: null,
        };
        let HP = null, HPt = null;                 // matrice J2000 -> orizzontali e sua inversa
        let sun = null, moon = null, moonIllum = null, planetPos = [];
        let day = null, dayKey = '';

        // ---------- Three.js ----------
        const renderer = new THREE.WebGLRenderer({ canvas: el.canvas, antialias: true, alpha: false });
        renderer.setClearColor(0x000000, 1);
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(70, 1, 0.01, 20);
        camera.position.set(0, 0, 0);
        const eqGroup = new THREE.Group();        // oggetti in coordinate equatoriali J2000
        eqGroup.matrixAutoUpdate = false;
        const horGroup = new THREE.Group();       // oggetti fissi rispetto all'orizzonte
        scene.add(eqGroup, horGroup);
        const groups = {};
        const layerGroup = (id, parent) => { const g = new THREE.Group(); parent.add(g); groups[id] = g; return g; };

        // Cielo (atmosfera): cupola con gradiente in base all'altezza del Sole
        const skyUniforms = { uSunDir: { value: new THREE.Vector3(0, -1, 0) }, uSunAlt: { value: -30 } };
        const sky = new THREE.Mesh(new THREE.SphereGeometry(5, 48, 24), new THREE.ShaderMaterial({
            uniforms: skyUniforms, side: THREE.BackSide, depthWrite: false, depthTest: false,
            vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
            fragmentShader: `varying vec3 vDir; uniform vec3 uSunDir; uniform float uSunAlt;
                void main(){
                    float dayK = smoothstep(-4.0, 8.0, uSunAlt);
                    float tw = smoothstep(-18.0, -2.0, uSunAlt) * (1.0 - dayK);
                    vec3 zen = mix(vec3(0.0, 0.004, 0.016), vec3(0.03, 0.07, 0.2), tw);
                    zen = mix(zen, vec3(0.16, 0.38, 0.82), dayK);
                    vec3 hor = mix(vec3(0.006, 0.012, 0.03), vec3(0.32, 0.2, 0.3), tw);
                    hor = mix(hor, vec3(0.6, 0.78, 0.98), dayK);
                    float h = clamp(vDir.y, 0.0, 1.0);
                    vec3 c = mix(hor, zen, pow(h, 0.45));
                    float near = max(dot(normalize(vDir), uSunDir), 0.0);
                    c += vec3(1.0, 0.55, 0.25) * pow(near, 6.0) * (tw * 0.8 + dayK * 0.25);
                    c += vec3(1.0, 0.95, 0.85) * pow(near, 300.0) * dayK;
                    gl_FragColor = vec4(c, 1.0);
                }`,
        }));
        sky.renderOrder = -10;
        scene.add(sky);

        // Stelle (shader: dimensione e luminosità dalla magnitudine e dalla magnitudine limite)
        const starUniforms = { uLimit: { value: 6.5 }, uPR: { value: 1 }, uDim: { value: 1 } };
        (function buildStars() {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(S.vec, 3));
            geo.setAttribute('aMag', new THREE.BufferAttribute(S.mag, 1));
            const col = new Float32Array(S.n * 3);
            for (let i = 0; i < S.n; i++) col.set(starColor(S.bv[i]), i * 3);
            geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
            const mat = new THREE.ShaderMaterial({
                uniforms: starUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
                vertexShader: `attribute float aMag; attribute vec3 aColor; uniform float uLimit; uniform float uPR; uniform float uDim;
                    varying vec3 vColor; varying float vAlpha;
                    void main(){
                        float d = uLimit - aMag;
                        if (d < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
                        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                        gl_PointSize = clamp(2.6 + d * 1.55, 2.6, 22.0) * uPR;
                        vAlpha = clamp(0.4 + d * 0.45, 0.0, 1.0) * uDim;
                        vColor = aColor;
                    }`,
                fragmentShader: `varying vec3 vColor; varying float vAlpha;
                    void main(){
                        vec2 p = gl_PointCoord - 0.5; float r2 = dot(p, p) * 4.0;
                        if (r2 > 1.0) discard;
                        float a = exp(-r2 * 3.2) + 0.22 * exp(-r2 * 1.0);   // nucleo più largo + alone: niente stelle da 1 pixel
                        gl_FragColor = vec4(vColor * a * vAlpha, 1.0);
                    }`,
            });
            const pts = new THREE.Points(geo, mat);
            pts.frustumCulled = false;
            layerGroup('stars', eqGroup).add(pts);
        })();

        // Via Lattea (punti morbidi additivi, livello di luminosità 1-5)
        const mwUniforms = { uPx: { value: 500 }, uAlpha: { value: 1 } };
        (function buildMilkyWay() {
            const m = data.mw, n = m.length / 3;
            const pos = new Float32Array(n * 3), lev = new Float32Array(n);
            for (let i = 0; i < n; i++) { pos.set(eqVec(m[i * 3] / 10, m[i * 3 + 1] / 10), i * 3); lev[i] = m[i * 3 + 2]; }
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
            geo.setAttribute('aLevel', new THREE.BufferAttribute(lev, 1));
            const pts = new THREE.Points(geo, new THREE.ShaderMaterial({
                uniforms: mwUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
                vertexShader: `attribute float aLevel; uniform float uPx; varying float vL;
                    void main(){ vL = aLevel; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = min(0.065 * uPx, 512.0); }`,
                fragmentShader: `varying float vL; uniform float uAlpha;
                    void main(){ vec2 p = gl_PointCoord - 0.5; float r2 = dot(p, p) * 4.0; if (r2 > 1.0) discard;
                        float a = exp(-r2 * 3.2) * 0.016 * vL * uAlpha;   // macchie larghe e tenui: si fondono in una nebulosità continua
                        gl_FragColor = vec4(vec3(0.62, 0.62, 0.8) * a, 1.0); }`,
            }));
            pts.frustumCulled = false;
            layerGroup('milkyWay', eqGroup).add(pts);
        })();

        const lineMat = (color, opacity) => new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
        function segmentsFrom(polylines, toVec) {
            const pts = [];
            polylines.forEach(pl => { for (let i = 1; i < pl.length; i++) pts.push(toVec(pl[i - 1]), toVec(pl[i])); });
            return pts;
        }
        const V = a => new THREE.Vector3(a[0], a[1], a[2]);
        const eqV = ([ra, dec]) => V(eqVec(ra, dec));
        // densifica i segmenti lunghi (archi sulla sfera)
        function arcPoints(a, b, r) {
            const va = V(eqVec(a[0], a[1])), vb = V(eqVec(b[0], b[1]));
            const ang = va.angleTo(vb), n = Math.max(1, Math.ceil(ang / (2 * DEG)));
            const out = [];
            for (let i = 0; i <= n; i++) out.push(va.clone().lerp(vb, i / n).normalize().multiplyScalar(r || 1));
            return out;
        }
        const lineMats = {};
        (function buildLines() {
            // figure delle costellazioni
            lineMats.conLines = lineMat(0x5b8fd8, 0.6);
            const segs = [];
            CONS.forEach(c => c.lines.forEach(pl => { for (let i = 1; i < pl.length; i++) { const arc = arcPoints(pl[i - 1], pl[i], 0.999); for (let k = 1; k < arc.length; k++) segs.push(arc[k - 1], arc[k]); } }));
            layerGroup('conLines', eqGroup).add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(segs), lineMats.conLines));
            // confini (tratteggiati)
            lineMats.borders = new THREE.LineDashedMaterial({ color: 0xb07a4a, transparent: true, opacity: 0.55, dashSize: 0.006, gapSize: 0.006, depthWrite: false });
            const bsegs = [];
            data.borders.forEach(pl => { for (let i = 1; i < pl.length; i++) { const arc = arcPoints(pl[i - 1], pl[i], 0.998); for (let k = 1; k < arc.length; k++) bsegs.push(arc[k - 1], arc[k]); } });
            const bl = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(bsegs), lineMats.borders);
            bl.computeLineDistances();
            layerGroup('borders', eqGroup).add(bl);
            // griglia equatoriale
            lineMats.eqGrid = lineMat(0x3b82f6, 0.32);
            const eg = [];
            for (let dec = -80; dec <= 80; dec += 10) for (let ra = 0; ra < 360; ra += 2) eg.push(eqV([ra, dec]).multiplyScalar(0.997), eqV([ra + 2, dec]).multiplyScalar(0.997));
            for (let ra = 0; ra < 360; ra += 15) for (let dec = -88; dec < 88; dec += 2) eg.push(eqV([ra, dec]).multiplyScalar(0.997), eqV([ra, dec + 2]).multiplyScalar(0.997));
            layerGroup('eqGrid', eqGroup).add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(eg), lineMats.eqGrid));
            // eclittica
            lineMats.ecliptic = lineMat(0xf59e0b, 0.65);
            const ec = [];
            const eclV = l => V(eclToEq([Math.cos(l * DEG), Math.sin(l * DEG), 0])).multiplyScalar(0.996);
            for (let l = 0; l < 360; l += 1.5) ec.push(eclV(l), eclV(l + 1.5));
            layerGroup('ecliptic', eqGroup).add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(ec), lineMats.ecliptic));
            // meridiano locale (Nord - Zenit - Sud), nel riferimento dell'orizzonte
            const mer = [];
            for (let a = 0; a < 360; a += 1.5) {
                const p = x => new THREE.Vector3(0, Math.sin(x * DEG), -Math.cos(x * DEG)).multiplyScalar(0.996);
                mer.push(p(a), p(a + 1.5));
            }
            lineMats.meridian = lineMat(0x4ade80, 0.5);
            groups.ecliptic.userData.meridian = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(mer), lineMats.meridian);
            layerGroup('meridian', horGroup).add(groups.ecliptic.userData.meridian);
            // griglia azimutale
            lineMats.azGrid = lineMat(0x84cc16, 0.3);
            const ag = [];
            const hv = (alt, az) => V(A.horToVec(alt, az, 0.995));
            for (let alt = -80; alt <= 80; alt += 10) { if (alt === 0) continue; for (let az = 0; az < 360; az += 2) ag.push(hv(alt, az), hv(alt, az + 2)); }
            for (let az = 0; az < 360; az += 15) for (let alt = -88; alt < 88; alt += 2) ag.push(hv(alt, az), hv(alt + 2, az));
            layerGroup('azGrid', horGroup).add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(ag), lineMats.azGrid));
        })();

        // Suolo (semisfera inferiore opaca) e linea dell'orizzonte
        const groundMat = new THREE.MeshBasicMaterial({ color: 0x07110a, side: THREE.DoubleSide });
        const ground = new THREE.Mesh(new THREE.SphereGeometry(0.92, 64, 16, 0, Math.PI * 2, Math.PI / 2 + 0.0005, Math.PI / 2), groundMat);
        layerGroup('ground', horGroup).add(ground);
        const horizonPts = [];
        for (let az = 0; az <= 360; az += 1) horizonPts.push(new THREE.Vector3(...A.horToVec(0, az, 0.915)));
        const horizonLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(horizonPts), lineMat(0x94a3b8, 0.8));
        horGroup.add(horizonLine);

        // ---------- Testo e simboli (canvas 2D sovrapposto) ----------
        const octx = el.overlay.getContext('2d');
        let W = 0, H = 0, dpr = 1;
        const viewProj = new THREE.Matrix4();
        const camFwd = new THREE.Vector3();
        const tmp = new THREE.Vector3();
        // Proietta un vettore nel riferimento dell'orizzonte: [x, y] in px CSS, o null se dietro la camera / fuori campo
        function projectHor(v, margin) {
            if (v[0] * camFwd.x + v[1] * camFwd.y + v[2] * camFwd.z < 0.02) return null;
            tmp.set(v[0], v[1], v[2]).applyMatrix4(viewProj);
            const x = (tmp.x + 1) / 2 * W, y = (1 - tmp.y) / 2 * H;
            const m = margin === undefined ? 40 : margin;
            if (x < -m || x > W + m || y < -m || y > H + m) return null;
            return [x, y];
        }
        const toHor = v => apply3(HP, v);

        function pxPerRad() { return H / (2 * Math.tan(camera.fov * DEG / 2)); }

        function labelCollides(boxes, b) {
            for (const o of boxes) if (b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]) return true;
            boxes.push(b);
            return false;
        }
        function text(x, y, s, color, font, align, boxes) {
            octx.font = font;
            const w = octx.measureText(s).width, h = 12;
            let x0 = align === 'center' ? x - w / 2 : x;
            const b = [x0 - 2, y - h, x0 + w + 2, y + 3];
            if (boxes && labelCollides(boxes, b)) return false;
            octx.fillStyle = 'rgba(2,6,23,0.75)';
            octx.fillText(s, x0 + 1, y + 1);
            octx.fillStyle = color;
            octx.fillText(s, x0, y);
            return true;
        }
        const groundOn = () => state.layers.ground;
        const hidden = alt => groundOn() && alt < -0.3;

        function starName(i) {
            const e = S.names[i];
            if (!e) return '';
            return e.it || e.n || '';
        }
        function starDesignation(i) {
            const e = S.names[i] || {};
            const c = CONS[S.con[i]];
            if (e.b && c) return `${e.b} ${c.gen}`;
            if (e.f && c) return `${e.f} ${c.gen}`;
            if (S.hip[i]) return `HIP ${S.hip[i]}`;
            if (S.hd[i]) return `HD ${S.hd[i]}`;
            return `Stella n. ${i}`;
        }

        let limitMag = 6.5, dayK = 0;
        function drawOverlay() {
            octx.setTransform(dpr, 0, 0, dpr, 0, 0);
            octx.clearRect(0, 0, W, H);
            octx.textBaseline = 'alphabetic';
            const boxes = [];
            const ppr = pxPerRad();
            const fovShort = shortFov();

            // Sole, Luna, pianeti
            if (state.layers.sunMoon && sun) {
                const p = projectHor(A.horToVec(sun.alt, sun.az), 60);
                if (p && !hidden(sun.alt)) {
                    const r = Math.max(7, 0.267 * DEG * ppr);
                    const g = octx.createRadialGradient(p[0], p[1], 0, p[0], p[1], r * 3.2);
                    g.addColorStop(0, 'rgba(255,250,220,1)'); g.addColorStop(0.3, 'rgba(253,224,71,0.95)'); g.addColorStop(1, 'rgba(253,186,116,0)');
                    octx.fillStyle = g; octx.beginPath(); octx.arc(p[0], p[1], r * 3.2, 0, 2 * Math.PI); octx.fill();
                    text(p[0] + r + 6, p[1] + 4, 'Sole', '#fde68a', '600 12px system-ui, sans-serif', 'left', boxes);
                }
            }
            if (state.layers.sunMoon && moon) {
                const mv = A.horToVec(moon.alt, moon.az);
                const p = projectHor(mv, 60);
                if (p && !hidden(moon.alt)) {
                    const r = Math.max(6, 0.259 * DEG * ppr);
                    drawMoon(p, r, mv);
                    text(p[0] + r + 6, p[1] + 4, `Luna ${Math.round(moonIllum.fraction * 100)}%`, '#e5e7eb', '600 12px system-ui, sans-serif', 'left', boxes);
                }
            }
            if (state.layers.planets) planetPos.forEach(pl => {
                const p = projectHor(pl.hor, 30);
                if (!p || hidden(pl.alt) || pl.mag > limitMag + 1.5) return;
                const r = Math.max(2.5, Math.min(6, 4.2 - pl.mag * 0.55));
                octx.fillStyle = PLANET_COLORS[pl.id] || '#fff';
                octx.beginPath(); octx.arc(p[0], p[1], r, 0, 2 * Math.PI); octx.fill();
                if (pl.id === 'sat') { octx.strokeStyle = PLANET_COLORS.sat; octx.lineWidth = 1.2; octx.beginPath(); octx.ellipse(p[0], p[1], r * 2.1, r * 0.75, -0.35, 0, 2 * Math.PI); octx.stroke(); }
                text(p[0] + r + 5, p[1] + 4, pl.it, '#fdba74', '600 12px system-ui, sans-serif', 'left', boxes);
            });

            // Messier
            if (state.layers.messier && dayK < 0.6) {
                data.messier.forEach(m => {
                    if (m.mag !== null && m.mag > limitMag + 1.2) return;
                    const h = toHor(m.vec);
                    const p = projectHor(h, 20);
                    if (!p) return;
                    const alt = Math.asin(h[1]) / DEG;
                    if (hidden(alt)) return;
                    drawMessierSymbol(p, m.type);
                    if (fovShort < 90 || (m.mag !== null && m.mag < 5)) {
                        const lbl = fovShort < 25 && m.it ? `${m.id} ${m.it}` : m.id;
                        text(p[0] + 8, p[1] + 4, lbl, '#f9a8d4', '500 11px system-ui, sans-serif', 'left', boxes);
                    }
                });
            }

            // Nomi delle stelle (le più luminose prima: l'array è ordinato per magnitudine)
            if (state.layers.stars && state.layers.starNames && dayK < 0.85) {
                const nameLimit = Math.min(limitMag - 0.8, 1.8 + 2.6 * Math.log10(70 / Math.max(1, fovShort)));
                let count = 0;
                for (let i = 0; i < S.n && count < 70; i++) {
                    if (S.mag[i] > nameLimit) break;
                    const e = S.names[i];
                    if (!e) continue;
                    const zoomed = fovShort < 20;
                    const label = e.it || e.n || (zoomed ? (e.b || e.f ? `${e.b || e.f}` : '') : '');
                    if (!label) continue;
                    const h = toHor([S.vec[i * 3], S.vec[i * 3 + 1], S.vec[i * 3 + 2]]);
                    const p = projectHor(h, 0);
                    if (!p || hidden(Math.asin(h[1]) / DEG)) continue;
                    if (text(p[0] + 6, p[1] - 4, label, 'rgba(226,232,240,0.92)', '500 11px system-ui, sans-serif', 'left', boxes)) count++;
                }
            }

            // Nomi delle costellazioni
            if (state.layers.conNames && dayK < 0.85) {
                CONS.forEach(c => {
                    if (fovShort > 100 && c.rank > 2) return;
                    const h = toHor(c.vec);
                    const p = projectHor(h, 0);
                    if (!p || hidden(Math.asin(h[1]) / DEG)) return;
                    text(p[0], p[1], c.it.toUpperCase(), 'rgba(125,211,252,0.78)', 'italic 600 10.5px system-ui, sans-serif', 'center', boxes);
                });
            }

            // Punti cardinali sull'orizzonte
            [['N', 0, '#f87171'], ['NE', 45], ['E', 90], ['SE', 135], ['S', 180], ['SO', 225], ['O', 270], ['NO', 315]].forEach(([s, az, c]) => {
                const p = projectHor(A.horToVec(0.6, az), 10);
                if (p) text(p[0], p[1], s, c || (s.length === 1 ? '#e2e8f0' : '#94a3b8'), `700 ${s.length === 1 ? 15 : 12}px system-ui, sans-serif`, 'center', null);
            });

            // Selezione
            if (state.selected) {
                const info = selectedPosition();
                if (info) {
                    const p = projectHor(info.hor, 30);
                    if (p) {
                        octx.strokeStyle = '#fbbf24'; octx.lineWidth = 1.6;
                        if (hidden(info.alt)) octx.setLineDash([3, 3]);
                        const r = 11;
                        octx.beginPath();
                        [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([sx, sy]) => {
                            octx.moveTo(p[0] + sx * r, p[1] + sy * (r - 5)); octx.lineTo(p[0] + sx * r, p[1] + sy * r); octx.lineTo(p[0] + sx * (r - 5), p[1] + sy * r);
                        });
                        octx.stroke(); octx.setLineDash([]);
                    }
                }
            }
        }

        function drawMoon(p, r, mv) {
            // lato illuminato rivolto verso il Sole (direzione calcolata in 3D e proiettata)
            const sv = A.horToVec(sun.alt, sun.az);
            const d = sv[0] * mv[0] + sv[1] * mv[1] + sv[2] * mv[2];
            const tv = [sv[0] - d * mv[0], sv[1] - d * mv[1], sv[2] - d * mv[2]];
            const tl = Math.hypot(...tv) || 1;
            const q = projectHor([mv[0] + tv[0] / tl * 0.02, mv[1] + tv[1] / tl * 0.02, mv[2] + tv[2] / tl * 0.02], 400);
            const ang = q ? Math.atan2(q[1] - p[1], q[0] - p[0]) : 0;
            const k = moonIllum.fraction;              // 0 nuova, 1 piena
            octx.save();
            octx.translate(p[0], p[1]);
            octx.rotate(ang);
            octx.fillStyle = 'rgba(71,85,105,0.55)';
            octx.beginPath(); octx.arc(0, 0, r, 0, 2 * Math.PI); octx.fill();
            octx.fillStyle = '#f1f5f9';
            octx.beginPath();
            octx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);            // metà verso il Sole (+x)
            octx.ellipse(0, 0, Math.abs(1 - 2 * k) * r, r, 0, Math.PI / 2, -Math.PI / 2, k < 0.5);   // falce: il terminatore curva verso il Sole
            octx.fill();
            octx.restore();
        }
        function drawMessierSymbol(p, type) {
            octx.save();
            octx.translate(p[0], p[1]);
            octx.lineWidth = 1.3;
            if (type === 'e' || type === 's' || type === 'i') {
                octx.strokeStyle = '#f87171'; octx.beginPath(); octx.ellipse(0, 0, 6.5, 3.2, -0.5, 0, 2 * Math.PI); octx.stroke();
            } else if (type === 'gc') {
                octx.strokeStyle = '#fde047'; octx.beginPath(); octx.arc(0, 0, 5, 0, 2 * Math.PI); octx.moveTo(-5, 0); octx.lineTo(5, 0); octx.moveTo(0, -5); octx.lineTo(0, 5); octx.stroke();
            } else if (type === 'oc' || type === 'pos') {
                octx.strokeStyle = '#fde047'; octx.setLineDash([2, 2]); octx.beginPath(); octx.arc(0, 0, 5.5, 0, 2 * Math.PI); octx.stroke();
            } else if (type === 'pn') {
                octx.strokeStyle = '#4ade80'; octx.beginPath(); octx.arc(0, 0, 4, 0, 2 * Math.PI); octx.moveTo(-7, 0); octx.lineTo(-4, 0); octx.moveTo(4, 0); octx.lineTo(7, 0); octx.moveTo(0, -7); octx.lineTo(0, -4); octx.moveTo(0, 4); octx.lineTo(0, 7); octx.stroke();
            } else {
                octx.strokeStyle = '#4ade80'; octx.strokeRect(-5, -5, 10, 10);
            }
            octx.restore();
        }

        // vettori precalcolati
        CONS.forEach(c => { c.vec = eqVec(c.ra, c.dec); c.key = normalize(c.it) + ' ' + normalize(c.la); });
        data.messier.forEach(m => { m.vec = eqVec(m.ra, m.dec); });

        // ---------- Tempo e posizioni ----------
        function updatePositions() {
            HP = j2000ToHorMatrix(state.t, state.lat, state.lon);
            HPt = transpose3(HP);
            eqGroup.matrix.set(HP[0], HP[1], HP[2], 0, HP[3], HP[4], HP[5], 0, HP[6], HP[7], HP[8], 0, 0, 0, 0, 1);
            eqGroup.matrixWorldNeedsUpdate = true;
            sun = A.sunAltAz(SunCalc, state.t, state.lat, state.lon);
            moon = A.moonAltAz(SunCalc, state.t, state.lat, state.lon);
            moonIllum = SunCalc.getMoonIllumination(new Date(state.t));
            planetPos = PLANETS.filter(p => p.id !== 'ter').map(p => {
                const g = planetGeo(PLANETS, p.id, state.t);
                const hor = toHor(g.vec);
                return Object.assign(g, { id: p.id, it: p.it, hor, alt: Math.asin(hor[1]) / DEG, az: A.norm360(Math.atan2(hor[0], -hor[2]) / DEG) });
            });
            const sv = A.horToVec(sun.alt, sun.az);
            skyUniforms.uSunDir.value.set(sv[0], sv[1], sv[2]);
            skyUniforms.uSunAlt.value = sun.alt;
            applyBrightness();
        }
        function applyBrightness() {
            const atm = state.layers.atmosphere;
            sky.visible = atm;
            dayK = atm ? Math.max(0, Math.min(1, (sun.alt + 6) / 12)) : 0;
            limitMag = limitingMagnitude(shortFov(), sun.alt, atm);
            starUniforms.uLimit.value = limitMag;
            starUniforms.uDim.value = 1;
            const fade = 1 - dayK * 0.85;
            const twilight = atm ? Math.max(0, Math.min(1, (-sun.alt - 4) / 12)) : 1;
            mwUniforms.uAlpha.value = (atm ? twilight : 1) * (shortFov() < 8 ? shortFov() / 8 : 1);
            lineMats.conLines.opacity = 0.6 * fade;
            lineMats.borders.opacity = 0.55 * fade;
            lineMats.eqGrid.opacity = 0.32 * fade + 0.1;
            lineMats.azGrid.opacity = 0.3 * fade + 0.1;
            lineMats.ecliptic.opacity = 0.65 * fade + 0.15;
            groundMat.color.setHSL(0.36, 0.35, atm ? 0.03 + 0.11 * dayK : 0.03);
        }

        function ensureDay() {
            const key = `${A.localDateStr(state.t)}|${state.lat.toFixed(4)}|${state.lon.toFixed(4)}`;
            if (key === dayKey) return;
            dayKey = key;
            day = A.localDayRange(A.localDateStr(state.t));
            timelineCache = null;
        }

        function setTime(t, quiet) {
            state.t = Math.round(t / 1000) * 1000;
            ensureDay();
            updatePositions();
            renderHeader();
            renderInfo();
            drawTimeline();
            requestRender();
            if (!quiet) onChange();
        }

        // ---------- Camera ----------
        function shortFov() { return state.fov; }
        function applyCamera() {
            const aspect = camera.aspect;
            // state.fov è il campo sul lato corto del riquadro
            camera.fov = Math.min(150, aspect >= 1 ? state.fov : 2 * Math.atan(Math.tan(state.fov * DEG / 2) / aspect) / DEG);
            camera.updateProjectionMatrix();
            if (state.mode === 'manual') {
                const alt = Math.max(-89.5, Math.min(89.5, state.alt));
                const d = A.horToVec(alt, state.az);
                camera.up.set(0, 1, 0);
                camera.lookAt(d[0], d[1], d[2]);
            }
        }

        let rafPending = false;
        function requestRender() {
            if (rafPending || !state.active) return;
            rafPending = true;
            requestAnimationFrame(renderFrame);
        }
        let lastFrame = 0;
        function renderFrame(now) {
            rafPending = false;
            if (!state.active) return;
            resizeIfNeeded();
            if (state.playing) {
                const dt = lastFrame ? Math.min(0.25, (now - lastFrame) / 1000) : 0;
                lastFrame = now;
                if (dt > 0) setTime(state.t + dt * state.speed * 1000, true);
            } else lastFrame = 0;
            if (state.mode === 'gyro' && sensor.has) {
                camera.quaternion.slerp(sensor.q, sensor.first ? 1 : 0.25);
                sensor.first = false;
                const f = new THREE.Vector3(); camera.getWorldDirection(f);
                const h = A.vecToHor(f.x, f.y, f.z);
                state.az = h.az; state.alt = h.alt;
            }
            applyCamera();
            applyBrightness();
            starUniforms.uPR.value = renderer.getPixelRatio();
            mwUniforms.uPx.value = pxPerRad() * renderer.getPixelRatio();
            camera.updateMatrixWorld();
            viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
            camera.getWorldDirection(camFwd);
            renderer.render(scene, camera);
            drawOverlay();
            renderReadout();
            if (state.playing || state.mode === 'gyro') requestRender();
        }
        let lastW = 0, lastH = 0;
        function resizeIfNeeded() {
            const w = el.viewer.clientWidth, h = el.viewer.clientHeight;
            if (!w || !h || (w === lastW && h === lastH)) return;
            lastW = w; lastH = h; W = w; H = h;
            dpr = Math.min(window.devicePixelRatio || 1, 2);
            renderer.setPixelRatio(dpr);
            renderer.setSize(w, h, false);
            el.overlay.width = Math.round(w * dpr); el.overlay.height = Math.round(h * dpr);
            camera.aspect = w / h;
            drawTimeline();
        }
        const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { requestRender(); drawTimeline(); }) : null;
        if (ro) { ro.observe(el.viewer); ro.observe(el.timeline); }

        // ---------- Interazione: trascina, pizzica, rotella, tocco per selezionare ----------
        const pointers = new Map();
        let pinch0 = 0, fov0 = 0, downAt = null;
        el.overlay.addEventListener('pointerdown', e => {
            el.overlay.setPointerCapture(e.pointerId);
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            downAt = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 };
            if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); fov0 = state.fov; }
        });
        el.overlay.addEventListener('pointermove', e => {
            if (!pointers.has(e.pointerId)) return;
            const prev = pointers.get(e.pointerId);
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (downAt) downAt.moved += Math.hypot(e.clientX - prev.x, e.clientY - prev.y);
            if (pointers.size === 1 && state.mode === 'manual') {
                const k = camera.fov / Math.max(1, H);
                state.az = A.norm360(state.az - (e.clientX - prev.x) * k);
                state.alt = Math.max(-89.5, Math.min(89.5, state.alt + (e.clientY - prev.y) * k));
                requestRender();
            } else if (pointers.size === 2 && pinch0) {
                const [a, b] = [...pointers.values()];
                setFov(fov0 * pinch0 / Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)));
            }
        });
        const endPointer = e => {
            const wasSingle = pointers.size === 1;
            pointers.delete(e.pointerId);
            if (pointers.size < 2) pinch0 = 0;
            if (wasSingle && downAt && downAt.moved < 8 && performance.now() - downAt.t < 600 && e.type === 'pointerup') {
                const r = el.overlay.getBoundingClientRect();
                pickAt(e.clientX - r.left, e.clientY - r.top, e.pointerType === 'touch' ? 26 : 16);
            }
            if (!pointers.size) downAt = null;
        };
        el.overlay.addEventListener('pointerup', endPointer);
        el.overlay.addEventListener('pointercancel', endPointer);
        el.overlay.addEventListener('wheel', e => { e.preventDefault(); setFov(state.fov * (1 + e.deltaY * 0.0012)); }, { passive: false });
        function setFov(f) { state.fov = Math.max(1, Math.min(120, f)); requestRender(); }
        if (el.zoomIn) el.zoomIn.addEventListener('click', () => setFov(state.fov / 1.5));
        if (el.zoomOut) el.zoomOut.addEventListener('click', () => setFov(state.fov * 1.5));

        // ---------- Selezione e scheda dettagli ----------
        function pickAt(x, y, radius) {
            let best = null, bestScore = Infinity;
            const consider = (obj, p, bonus) => {
                if (!p) return;
                const d = Math.hypot(p[0] - x, p[1] - y);
                if (d > radius) return;
                const score = d - bonus;
                if (score < bestScore) { bestScore = score; best = obj; }
            };
            if (state.layers.sunMoon) {
                consider({ type: 'sun' }, !hidden(sun.alt) && projectHor(A.horToVec(sun.alt, sun.az)), 8);
                consider({ type: 'moon' }, !hidden(moon.alt) && projectHor(A.horToVec(moon.alt, moon.az)), 8);
            }
            if (state.layers.planets) planetPos.forEach(pl => consider({ type: 'planet', id: pl.id }, !hidden(pl.alt) && projectHor(pl.hor), 6));
            if (state.layers.messier) data.messier.forEach((m, i) => { const h = toHor(m.vec); consider({ type: 'messier', i }, !hidden(Math.asin(h[1]) / DEG) && projectHor(h), 2); });
            if (state.layers.stars) {
                for (let i = 0; i < S.n; i++) {
                    if (S.mag[i] > limitMag) break;
                    const h = toHor([S.vec[i * 3], S.vec[i * 3 + 1], S.vec[i * 3 + 2]]);
                    if (hidden(Math.asin(h[1]) / DEG)) continue;
                    consider({ type: 'star', i }, projectHor(h, 0), (limitMag - S.mag[i]) * 0.9);
                }
            }
            state.selected = best;
            renderInfo();
            requestRender();
            onChange();
        }
        function selectedPosition() {
            const s = state.selected;
            if (!s) return null;
            let hor;
            if (s.type === 'sun') hor = A.horToVec(sun.alt, sun.az);
            else if (s.type === 'moon') hor = A.horToVec(moon.alt, moon.az);
            else if (s.type === 'planet') { const pl = planetPos.find(p => p.id === s.id); hor = pl && pl.hor; }
            else if (s.type === 'messier') hor = toHor(data.messier[s.i].vec);
            else if (s.type === 'star') hor = toHor([S.vec[s.i * 3], S.vec[s.i * 3 + 1], S.vec[s.i * 3 + 2]]);
            else if (s.type === 'con') hor = toHor(CONS[s.i].vec);
            if (!hor) return null;
            return { hor, alt: Math.asin(Math.max(-1, Math.min(1, hor[1]))) / DEG, az: A.norm360(Math.atan2(hor[0], -hor[2]) / DEG) };
        }
        // Sorge / culmina / tramonta nel giorno locale, per un oggetto con funzione altezza(t)
        let rtsMemo = { key: '', value: '' };
        function riseTransitSet(altFn, threshold) {
            const key = `${JSON.stringify(state.selected)}|${dayKey}`;
            if (rtsMemo.key === key) return rtsMemo.value;
            rtsMemo = { key, value: computeRiseTransitSet(altFn, threshold) };
            return rtsMemo.value;
        }
        function computeRiseTransitSet(altFn, threshold) {
            const cross = A.findCrossings(altFn, day.start, day.end, threshold, 10 * MIN);
            const top = A.findMaximum(altFn, day.start, day.end, 15 * MIN);
            const rise = cross.find(c => c.rising), set = cross.find(c => !c.rising);
            if (!cross.length) return top.alt > threshold ? 'Sempre sopra l\'orizzonte (circumpolare)' : 'Non sorge in questo giorno';
            return [rise ? `sorge ${A.hhmm(rise.t)}` : '', top.alt > threshold ? `culmina ${A.hhmm(top.t)} (${top.alt.toFixed(0)}°)` : '', set ? `tramonta ${A.hhmm(set.t)}` : '']
                .filter(Boolean).join(' · ');
        }
        const fixedAltFn = vecJ2000 => t => { const h = apply3(j2000ToHorMatrix(t, state.lat, state.lon), vecJ2000); return Math.asin(h[1]) / DEG; };
        function row(k, v) { return v ? `<div class="flex gap-2"><span class="text-slate-400 shrink-0 w-24">${k}</span><span class="text-slate-100">${v}</span></div>` : ''; }
        function altAzRow(pos) { return row('Altezza / Az.', `${pos.alt >= 0 ? '+' : ''}${pos.alt.toFixed(1)}° · ${Math.round(pos.az)}° ${A.cardinal(pos.az)}${pos.alt < 0 ? ' (sotto l\'orizzonte)' : ''}`); }
        function eqRows(vecJ2000) {
            const j = vecToEq(vecJ2000);
            return row('AR / Dec J2000', `${formatRa(j.ra)} · ${formatDec(j.dec)}`);
        }
        let lastInfoKey = '';
        function renderInfo() {
            if (!el.info) return;
            const s = state.selected;
            if (!s) { el.info.classList.add('hidden'); lastInfoKey = ''; return; }
            const pos = selectedPosition();
            if (!pos) { el.info.classList.add('hidden'); return; }
            let title = '', sub = '', body = '', swatch = '#fff';
            if (s.type === 'star') {
                const i = s.i, e = S.names[i] || {};
                const c = CONS[S.con[i]];
                title = starName(i) || starDesignation(i);
                const ids = [];
                if (starName(i)) ids.push(starDesignation(i));
                if (e.it && e.n) ids.push(e.n);
                if (e.f && e.b && c) ids.push(`${e.f} ${c.id}`);
                if (S.hip[i]) ids.push(`HIP ${S.hip[i]}`);
                if (S.hd[i]) ids.push(`HD ${S.hd[i]}`);
                if (e.v) ids.push(`variabile ${e.v}`);
                sub = ids.filter((x, k, a) => a.indexOf(x) === k).join(' · ');
                const rgb = starColor(S.bv[i]).map(x => Math.round(x * 255));
                swatch = `rgb(${rgb.join(',')})`;
                const sp = S.spect[i];
                body = row('Costellazione', c ? `${c.it} (${c.la})` : '') +
                    row('Magnitudine', S.mag[i].toFixed(2)) +
                    row('Colore', `${colorName(S.bv[i])} (B−V ${(Math.abs(S.bv[i]) < 0.005 ? 0 : S.bv[i]).toFixed(2).replace('-', '−')})`) +
                    row('Tipo spettrale', sp ? `${sp}${spectDescription(sp) ? ' · ' + spectDescription(sp) : ''}` : '') +
                    row('Distanza', S.ly[i] ? `${S.ly[i].toLocaleString('it-IT', { maximumFractionDigits: S.ly[i] < 100 ? 1 : 0 })} anni luce` : 'non nota') +
                    eqRows([S.vec[i * 3], S.vec[i * 3 + 1], S.vec[i * 3 + 2]]) + altAzRow(pos) +
                    row('Nel giorno', riseTransitSet(fixedAltFn([S.vec[i * 3], S.vec[i * 3 + 1], S.vec[i * 3 + 2]]), -0.5667));
            } else if (s.type === 'planet') {
                const pl = planetPos.find(p => p.id === s.id);
                title = pl.it; sub = 'Pianeta'; swatch = PLANET_COLORS[pl.id];
                body = row('Magnitudine', pl.mag !== null ? pl.mag.toFixed(1) : '') +
                    row('Distanza', `${pl.dist.toFixed(3)} UA · ${(pl.dist * 149.598).toFixed(1)} milioni di km`) +
                    row('Elongazione', `${pl.elong.toFixed(1)}° dal Sole`) +
                    (pl.id === 'mer' || pl.id === 'ven' || pl.id === 'mar' ? row('Fase', `${Math.round(pl.phase * 100)}% illuminato`) : '') +
                    eqRows(pl.vec) + altAzRow(pos) +
                    row('Nel giorno', riseTransitSet(t => { const g = planetGeo(PLANETS, pl.id, t); return Math.asin(apply3(j2000ToHorMatrix(t, state.lat, state.lon), g.vec)[1]) / DEG; }, -0.5667));
            } else if (s.type === 'sun') {
                title = 'Sole'; sub = 'Stella di tipo G2V'; swatch = '#fde047';
                body = altAzRow(pos) + row('Fase', A.sunPhase(sun.alt).label.toLowerCase()) +
                    row('Nel giorno', riseTransitSet(t => A.sunAltAz(SunCalc, t, state.lat, state.lon).alt, -0.833));
            } else if (s.type === 'moon') {
                const k = moonIllum.fraction, ph = moonIllum.phase;
                const phaseName = ph < 0.03 || ph > 0.97 ? 'Luna nuova' : ph < 0.22 ? 'Falce crescente' : ph < 0.28 ? 'Primo quarto' : ph < 0.47 ? 'Gibbosa crescente'
                    : ph < 0.53 ? 'Luna piena' : ph < 0.72 ? 'Gibbosa calante' : ph < 0.78 ? 'Ultimo quarto' : 'Falce calante';
                title = 'Luna'; sub = phaseName; swatch = '#e5e7eb';
                body = row('Illuminata', `${Math.round(k * 100)}%`) + row('Distanza', `${Math.round(moon.dist).toLocaleString('it-IT')} km`) + altAzRow(pos) +
                    row('Nel giorno', riseTransitSet(t => A.moonAltAz(SunCalc, t, state.lat, state.lon).alt, 0.133));
            } else if (s.type === 'messier') {
                const m = data.messier[s.i];
                title = m.it ? `${m.id} · ${m.it}` : m.id; sub = [m.ngc, MESSIER_TYPES[m.type]].filter(Boolean).join(' · '); swatch = '#f472b6';
                body = row('Magnitudine', m.mag !== null ? String(m.mag) : '') + row('Dimensioni', m.dim ? `${m.dim}′` : '') +
                    eqRows(m.vec) + altAzRow(pos) + row('Nel giorno', riseTransitSet(fixedAltFn(m.vec), 0));
            } else if (s.type === 'con') {
                const c = CONS[s.i];
                title = c.it; sub = `${c.la} · genitivo ${c.gen} · sigla ${c.id}`; swatch = '#7dd3fc';
                body = altAzRow(pos) + row('Nel giorno', riseTransitSet(fixedAltFn(c.vec), 0));
            }
            const key = `${title}|${Math.round(state.t / MIN)}|${pos.alt.toFixed(1)}`;
            if (key === lastInfoKey) return;
            lastInfoKey = key;
            el.info.innerHTML = `
                <div class="flex items-start gap-2">
                    <span class="mt-1 w-3 h-3 rounded-full shrink-0" style="background:${swatch}"></span>
                    <div class="min-w-0 flex-1">
                        <div class="font-bold text-white text-sm leading-tight">${title}</div>
                        <div class="text-[11px] text-slate-400 leading-tight">${sub}</div>
                    </div>
                    <button type="button" data-sm-close class="text-slate-400 hover:text-white text-lg leading-none px-1" title="Chiudi">×</button>
                </div>
                <div class="mt-2 space-y-0.5 text-[11px]">${body}</div>
                <button type="button" data-sm-center class="mt-2 text-[11px] px-2 py-1 rounded border border-slate-600 bg-slate-800 text-slate-100 hover:bg-slate-700">🎯 Centra</button>`;
            el.info.classList.remove('hidden');
            el.info.querySelector('[data-sm-close]').addEventListener('click', () => { state.selected = null; renderInfo(); requestRender(); onChange(); });
            el.info.querySelector('[data-sm-center]').addEventListener('click', centerSelected);
        }
        function centerSelected() {
            const pos = selectedPosition();
            if (!pos) return;
            if (state.mode !== 'manual') { say('🧭 In modalità giroscopio muovi il telefono verso l\'oggetto (riquadro giallo).', 3000); return; }
            state.az = pos.az; state.alt = Math.max(-89.5, Math.min(89.5, pos.alt));
            if (pos.alt < 0 && groundOn()) say('L\'oggetto è sotto l\'orizzonte: disattiva «Suolo» per vederlo.', 3500);
            requestRender();
        }

        // ---------- Ricerca ----------
        const searchIndex = [];
        (function buildSearch() {
            for (let i = 0; i < S.n; i++) {
                const e = S.names[i];
                if (!e) continue;
                const c = CONS[S.con[i]];
                const names = [e.it, e.n, e.b && c ? `${e.b} ${c.gen}` : '', e.b && c ? `${e.b} ${c.id}` : '', e.f && c ? `${e.f} ${c.gen}` : ''].filter(Boolean);
                if (!e.it && !e.n && S.mag[i] > 4.5) continue;
                searchIndex.push({ label: e.it || e.n || starDesignation(i), sub: `Stella · mag ${S.mag[i].toFixed(1)}${c ? ' · ' + c.it : ''}`, key: names.map(normalize).join(' | '), mag: S.mag[i], ref: { type: 'star', i } });
            }
            CONS.forEach((c, i) => searchIndex.push({ label: c.it, sub: `Costellazione · ${c.la}`, key: c.key + ' | ' + normalize(c.id), mag: -5, ref: { type: 'con', i } }));
            PLANETS.filter(p => p.id !== 'ter').forEach(p => searchIndex.push({ label: p.it, sub: 'Pianeta', key: normalize(p.it), mag: -6, ref: { type: 'planet', id: p.id } }));
            searchIndex.push({ label: 'Sole', sub: 'Stella', key: 'sole sun', mag: -9, ref: { type: 'sun' } });
            searchIndex.push({ label: 'Luna', sub: 'Satellite', key: 'luna moon', mag: -8, ref: { type: 'moon' } });
            data.messier.forEach((m, i) => searchIndex.push({ label: m.it ? `${m.id} · ${m.it}` : m.id, sub: `${MESSIER_TYPES[m.type] || 'Oggetto Messier'}${m.ngc ? ' · ' + m.ngc : ''}`,
                key: normalize(`${m.id} m ${m.id.slice(1)} ${m.it} ${m.ngc}`), mag: m.mag === null ? 9 : m.mag, ref: { type: 'messier', i } }));
        })();
        function search(q) {
            const n = normalize(q);
            if (!n) return [];
            const starts = [], contains = [];
            for (const it of searchIndex) {
                const parts = it.key.split(' | ');
                if (parts.some(p => p.startsWith(n) || p.split(' ').some(w => w.startsWith(n)))) starts.push(it);
                else if (it.key.includes(n)) contains.push(it);
            }
            const byMag = (a, b) => a.mag - b.mag;
            return starts.sort(byMag).concat(contains.sort(byMag)).slice(0, 8);
        }
        if (el.search && el.searchList) {
            let results = [];
            const close = () => { el.searchList.classList.add('hidden'); };
            const choose = it => {
                state.selected = it.ref;
                if (it.ref.type === 'planet' || it.ref.type === 'sun' || it.ref.type === 'moon') {
                    const lay = it.ref.type === 'planet' ? 'planets' : 'sunMoon';
                    if (!state.layers[lay]) { state.layers[lay] = true; applyLayers(); }
                }
                if (it.ref.type === 'messier' && !state.layers.messier) { state.layers.messier = true; applyLayers(); }
                el.search.value = '';
                close();
                el.search.blur();
                renderInfo();
                centerSelected();
                onChange();
            };
            el.search.addEventListener('input', () => {
                results = search(el.search.value);
                el.searchList.innerHTML = results.map((r, k) => `<li><button type="button" data-k="${k}" class="w-full text-left px-3 py-1.5 hover:bg-slate-600"><span class="text-white">${r.label}</span> <span class="text-[11px] text-slate-400">${r.sub}</span></button></li>`).join('')
                    || (el.search.value.trim() ? '<li class="px-3 py-1.5 text-slate-400 italic">Nessun risultato</li>' : '');
                el.searchList.classList.toggle('hidden', !el.search.value.trim());
                el.searchList.querySelectorAll('[data-k]').forEach(b => b.addEventListener('click', () => choose(results[Number(b.dataset.k)])));
            });
            el.search.addEventListener('keydown', e => {
                if (e.key === 'Enter' && results.length) { e.preventDefault(); choose(results[0]); }
                if (e.key === 'Escape') close();
            });
            el.search.addEventListener('blur', () => setTimeout(close, 200));
        }

        // ---------- Modalità giroscopio ----------
        const sensor = { q: new THREE.Quaternion(), has: false, first: true, absolute: false, handler: null, timer: null };
        const zee = new THREE.Vector3(0, 0, 1), euler = new THREE.Euler(), q0 = new THREE.Quaternion(), q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
        const screenAngle = () => ((screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle : (window.orientation || 0)) * DEG;
        function onOrientation(e) {
            if (e.alpha === null || e.beta === null) return;
            let alpha = e.alpha;
            if (e.type === 'deviceorientation' && typeof e.webkitCompassHeading === 'number') { alpha = 360 - e.webkitCompassHeading; sensor.absolute = true; }
            else if (e.type === 'deviceorientationabsolute' || e.absolute) sensor.absolute = true;
            euler.set(e.beta * DEG, alpha * DEG, -e.gamma * DEG, 'YXZ');
            sensor.q.setFromEuler(euler).multiply(q1).multiply(q0.setFromAxisAngle(zee, -screenAngle()));
            sensor.has = true;
        }
        function gyroSupported() { return typeof DeviceOrientationEvent !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches; }
        async function startGyro() {
            if (!gyroSupported()) { say('🧭 La modalità giroscopio richiede un telefono o tablet con giroscopio e bussola.'); return; }
            let denied = false;
            if (typeof DeviceOrientationEvent.requestPermission === 'function') {
                try { denied = (await DeviceOrientationEvent.requestPermission()) !== 'granted'; } catch (err) { denied = true; }
            }
            state.mode = 'gyro';
            sensor.has = false; sensor.first = true; sensor.absolute = false; sensor.handler = onOrientation;
            if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', sensor.handler);
            else window.addEventListener('deviceorientation', sensor.handler);
            say('🧭 Punta il telefono verso il cielo: la mappa segue il movimento.', 3500);
            clearTimeout(sensor.timer);
            sensor.timer = setTimeout(() => {
                if (state.mode !== 'gyro') return;
                if (!sensor.has) say(denied ? '🧭 Permesso ai sensori di movimento negato: consentilo nelle impostazioni del browser.' : '🧭 Nessun dato dai sensori di orientamento su questo dispositivo.');
                else if (!sensor.absolute) say('🧭 Bussola non disponibile: la direzione del Nord potrebbe non essere allineata.');
            }, 2500);
            renderModeButtons();
            requestRender();
        }
        function stopGyro() {
            if (state.mode !== 'gyro') return;
            state.mode = 'manual';
            clearTimeout(sensor.timer);
            if (sensor.handler) {
                window.removeEventListener('deviceorientationabsolute', sensor.handler);
                window.removeEventListener('deviceorientation', sensor.handler);
                sensor.handler = null;
            }
            renderModeButtons();
            requestRender();
        }
        function renderModeButtons() {
            el.modeButtons.forEach(b => {
                const on = b.dataset.smMode === state.mode;
                b.classList.toggle('bg-blue-600', on); b.classList.toggle('text-white', on); b.classList.toggle('text-slate-300', !on);
                b.setAttribute('aria-pressed', on ? 'true' : 'false');
                if (b.dataset.smMode === 'gyro') {
                    b.disabled = !gyroSupported();
                    b.title = b.disabled ? 'Disponibile su telefono o tablet con giroscopio e bussola' : 'Muovi il telefono per esplorare il cielo';
                }
            });
        }
        el.modeButtons.forEach(b => b.addEventListener('click', () => { if (b.dataset.smMode === 'gyro') { if (state.mode !== 'gyro') startGyro(); } else stopGyro(); }));

        // ---------- Barra delle impostazioni ----------
        function applyLayers() {
            LAYERS.forEach(l => { if (groups[l.id]) groups[l.id].visible = !!state.layers[l.id]; });
            if (groups.meridian) groups.meridian.visible = !!state.layers.ecliptic;
            if (el.stage) el.stage.classList.toggle('sm-night', !!state.layers.night);
            renderLayerBar();
            requestRender();
        }
        function renderLayerBar() {
            if (!el.layerBar.children.length) {
                LAYERS.forEach(l => {
                    const b = document.createElement('button');
                    b.type = 'button'; b.dataset.layer = l.id; b.title = l.name; b.setAttribute('aria-label', l.name);
                    b.className = 'eph-layer-btn';
                    b.innerHTML = `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[l.id]}</svg><span>${l.short}</span>`;
                    b.addEventListener('click', () => {
                        state.layers[l.id] = !state.layers[l.id];
                        applyLayers();
                        say(`${l.name}: ${state.layers[l.id] ? 'attivo' : 'disattivato'}`, 1600);
                        onChange();
                    });
                    el.layerBar.appendChild(b);
                });
            }
            Array.from(el.layerBar.children).forEach(b => {
                const l = LAYER_BY_ID[b.dataset.layer];
                b.style.setProperty('--eph-color', l.color);
                b.classList.toggle('is-on', !!state.layers[l.id]);
                b.setAttribute('aria-pressed', state.layers[l.id] ? 'true' : 'false');
            });
        }

        // ---------- Messaggi e letture ----------
        let sayTimer = null;
        function say(msg, ms) {
            if (!el.status) return;
            clearTimeout(sayTimer);
            el.status.textContent = msg || '';
            if (ms) sayTimer = setTimeout(() => { el.status.textContent = ''; }, ms);
        }
        let lastReadout = '';
        function renderReadout() {
            if (!el.readout) return;
            const txt = `${state.mode === 'gyro' ? '🧭 ' : ''}${Math.round(state.az)}° ${A.cardinal(state.az)} · ${state.alt >= 0 ? '+' : ''}${Math.round(state.alt)}° · campo ${state.fov < 10 ? state.fov.toFixed(1) : Math.round(state.fov)}° · mag ≤ ${limitMag.toFixed(1)} · ${A.sunPhase(sun.alt).label.toLowerCase()}`;
            if (txt !== lastReadout) { el.readout.textContent = txt; lastReadout = txt; }
        }
        function renderHeader() {
            if (el.place) el.place.textContent = state.source === 'device' ? `Posizione del dispositivo (${A.gmtLabel(state.t)})` : `Località del Pannello di Controllo (${A.gmtLabel(state.t)})`;
            if (el.coords) el.coords.textContent = A.formatCoords(state.lat, state.lon);
            if (el.deviceBtn) el.deviceBtn.classList.toggle('hidden', state.source === 'device');
            if (el.panelBtn) el.panelBtn.classList.toggle('hidden', state.source !== 'device');
            const d = new Date(state.t);
            if (el.scaleBtn) el.scaleBtn.textContent = state.scale;
            if (el.yearLabel) el.yearLabel.textContent = d.getFullYear();
            if (el.dateLabel) el.dateLabel.textContent = d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
            if (el.timeLabel) el.timeLabel.textContent = A.hhmm(state.t);
            if (el.dateInput && document.activeElement !== el.dateInput) el.dateInput.value = A.localDateStr(state.t);
            if (el.timeInput && document.activeElement !== el.timeInput) el.timeInput.value = A.hhmm(state.t);
            if (el.playBtn) { el.playBtn.textContent = state.playing ? '⏸' : '▶'; el.playBtn.title = state.playing ? 'Ferma lo scorrimento del tempo' : 'Fai scorrere il tempo'; }
            if (el.speedBtn) el.speedBtn.textContent = SPEED_LABEL[state.speed] || `×${state.speed}`;
        }

        // ---------- Barra del tempo (24h / 365d) ----------
        const SCALES = ['24h', '365d'];
        const SPEEDS = [60, 600, 3600];
        const SPEED_LABEL = { 60: '1 min/s', 600: '10 min/s', 3600: '1 h/s' };
        let timelineCache = null;
        const TL = { top: 16, bottom: 16 };
        const minutesOfDay = ms => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); };
        function timeRange() {
            const d = new Date(state.t);
            if (state.scale === '365d') return { t0: new Date(d.getFullYear(), 0, 1).getTime(), t1: new Date(d.getFullYear() + 1, 0, 1).getTime() };
            return { t0: day.start, t1: day.end };
        }
        const altToY = (alt, h) => { const mid = TL.top + (h - TL.top - TL.bottom) / 2; return mid - (alt / 90) * (h - TL.top - TL.bottom) / 2; };
        function timelineSize() {
            const c = el.timeline, w = Math.max(200, c.clientWidth), h = Math.max(60, c.clientHeight), r = Math.min(window.devicePixelRatio || 1, 3);
            if (c.width !== Math.round(w * r) || c.height !== Math.round(h * r)) { c.width = Math.round(w * r); c.height = Math.round(h * r); timelineCache = null; }
            return { w, h, r };
        }
        function buildTimelineCache(w, h, r) {
            const { t0, t1 } = timeRange();
            const mins = minutesOfDay(state.t);
            const key = `${state.scale}|${t0}|${w}|${h}|${dayKey}|${state.scale === '365d' ? mins : ''}`;
            if (timelineCache && timelineCache.key === key) return timelineCache;
            const off = document.createElement('canvas');
            off.width = Math.round(w * r); off.height = Math.round(h * r);
            const ctx = off.getContext('2d');
            ctx.setTransform(r, 0, 0, r, 0, 0);
            const year = new Date(t0).getFullYear(), nDays = Math.round((t1 - t0) / DAY);
            const timeAt = x => state.scale === '365d'
                ? new Date(year, 0, 1 + Math.min(nDays - 1, Math.floor(x / w * nDays)), Math.floor(mins / 60), mins % 60).getTime()
                : t0 + (x / w) * (t1 - t0);
            const bandH = h - TL.top - TL.bottom, sunC = [], moonC = [];
            for (let x = 0; x <= w; x += 2) {
                const t = timeAt(x), s = A.sunAltAz(SunCalc, t, state.lat, state.lon).alt, c = A.skyColor(s);
                ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`; ctx.fillRect(x, TL.top, 2.5, bandH);
                sunC.push([x, s]); moonC.push([x, A.moonAltAz(SunCalc, t, state.lat, state.lon).alt]);
            }
            ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(0, altToY(0, h)); ctx.lineTo(w, altToY(0, h)); ctx.stroke();
            [[moonC, '#4ade80', 1.8], [sunC, '#fde047', 2]].forEach(([pts, col, lw]) => {
                ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.beginPath();
                pts.forEach(([x, a], i) => { const y = altToY(a, h); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
                ctx.stroke();
            });
            ctx.fillStyle = '#94a3b8'; ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
            if (state.scale === '365d') {
                for (let m = 0; m < 12; m++) {
                    const x = (Math.round((new Date(year, m, 1).getTime() - t0) / DAY) + 0.5) / nDays * w;
                    ctx.fillText(new Date(year, m, 1).toLocaleDateString('it-IT', { month: 'short' }), Math.min(w - 12, x + 10), h - TL.bottom + 3);
                }
            } else {
                for (let t = t0; t <= t1; t += 3 * HOUR) {
                    const x = (t - t0) / (t1 - t0) * w;
                    ctx.fillText(String(new Date(t).getHours()), Math.max(8, Math.min(w - 10, x)), h - TL.bottom + 3);
                    ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(x, TL.top, 1, bandH); ctx.fillStyle = '#94a3b8';
                }
            }
            timelineCache = { key, canvas: off, timeAt, t0, t1, nDays };
            return timelineCache;
        }
        function drawTimeline() {
            if (!el.timeline || !day || !state.active) return;
            const { w, h, r } = timelineSize();
            const cache = buildTimelineCache(w, h, r);
            const ctx = el.timeline.getContext('2d');
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, el.timeline.width, el.timeline.height);
            ctx.drawImage(cache.canvas, 0, 0);
            ctx.setTransform(r, 0, 0, r, 0, 0);
            let x;
            if (state.scale === '365d') {
                const d = new Date(state.t);
                x = (Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - cache.t0) / DAY) + 0.5) / cache.nDays * w;
            } else x = (state.t - cache.t0) / (cache.t1 - cache.t0) * w;
            x = Math.max(1, Math.min(w - 1, x));
            ctx.fillStyle = '#fff'; ctx.fillRect(x - 1, TL.top - 4, 2, h - TL.top - TL.bottom + 8);
            [[moon.alt, '#4ade80'], [sun.alt, '#fde047']].forEach(([a, col]) => {
                ctx.beginPath(); ctx.arc(x, altToY(a, h), 5, 0, 2 * Math.PI); ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = '#0f172a'; ctx.stroke();
            });
            ctx.font = '700 10px system-ui, sans-serif'; ctx.textBaseline = 'top'; ctx.fillStyle = '#e2e8f0'; ctx.textAlign = 'left';
            const label = state.scale === '365d' ? new Date(state.t).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }) : A.sunPhase(sun.alt).label;
            const lw = ctx.measureText(label).width;
            ctx.fillText(label, Math.max(2, Math.min(w - lw - 2, x - lw / 2)), 2);
        }
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
        if (el.scaleBtn) el.scaleBtn.addEventListener('click', () => {
            state.scale = SCALES[(SCALES.indexOf(state.scale) + 1) % SCALES.length];
            timelineCache = null;
            say(state.scale === '24h' ? 'Cursore: le 24 ore del giorno' : 'Cursore: i 365 giorni dell\'anno alla stessa ora', 2000);
            setTime(state.t);
        });
        function shift(sign) {
            const d = new Date(state.t);
            if (state.scale === '365d') setTime(new Date(d.getFullYear() + sign, d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()).getTime());
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
        function setPlaying(on) { state.playing = !!on; lastFrame = 0; renderHeader(); requestRender(); }
        if (el.playBtn) el.playBtn.addEventListener('click', () => setPlaying(!state.playing));
        if (el.speedBtn) el.speedBtn.addEventListener('click', () => { state.speed = SPEEDS[(SPEEDS.indexOf(state.speed) + 1) % SPEEDS.length]; renderHeader(); });

        // ---------- API ----------
        function setLocation(lat, lon, source) { state.lat = lat; state.lon = lon; state.source = source || 'panel'; dayKey = ''; setTime(state.t, true); }
        function setDate(dateStr) {
            const now = new Date(), m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
            setTime(m ? new Date(+m[1], +m[2] - 1, +m[3], now.getHours(), now.getMinutes()).getTime() : now.getTime(), true);
        }
        function setActive(on) {
            state.active = !!on;
            if (!on) { stopGyro(); setPlaying(false); }
            else { lastW = 0; requestRender(); drawTimeline(); }
        }
        function getState() {
            return { layers: Object.assign({}, state.layers), scale: state.scale, t: state.t, az: state.az, alt: state.alt, fov: state.fov,
                     selected: state.selected ? Object.assign({}, state.selected) : null };
        }
        function applyState(s) {
            if (!s) return;
            if (s.layers) LAYERS.forEach(l => { if (typeof s.layers[l.id] === 'boolean') state.layers[l.id] = s.layers[l.id]; });
            if (SCALES.includes(s.scale)) state.scale = s.scale;
            ['az', 'alt', 'fov'].forEach(k => { if (isFinite(s[k])) state[k] = s[k]; });
            state.selected = s.selected || null;
            applyLayers();
            if (isFinite(s.t)) setTime(s.t, true);
        }

        renderModeButtons();
        setTime(state.t, true);
        applyLayers();
        return { setLocation, setDate, setTime, setActive, getState, applyState, search,
                 select(ref) { state.selected = ref; renderInfo(); requestRender(); },
                 get mode() { return state.mode; }, get source() { return state.source; } };
    }

    const api = { astro, LAYERS, createView };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.SkyStarMap = api;
})(typeof window !== 'undefined' ? window : globalThis);
