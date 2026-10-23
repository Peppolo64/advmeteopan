// Finti SunCalc / satellite.js / Leaflet usati SOLO dai test end-to-end (le librerie vere si installano con npm).
// Servono a eseguire la pagina reale in Chromium senza rete: simulano l'API quanto basta per i flussi snapshot.
window.__stubs = true;
window.Capacitor = { isNativePlatform: () => true };

const dateAt = (h) => new Date(2026, 9, 22, h, 0, 0);
window.SunCalc = {
    addTime() {},
    getTimes: () => new Proxy({}, { get: (t, k) => (typeof k === 'string' ? dateAt(6 + (k.length % 12)) : undefined) }),
    getMoonTimes: () => ({ rise: dateAt(18), set: dateAt(5) }),
    getMoonIllumination: () => ({ fraction: 0.5, phase: 0.5, angle: 0 }),
    getPosition: () => ({ azimuth: 1, altitude: 0.5 }),
    getMoonPosition: () => ({ azimuth: 1, altitude: 0.5, distance: 380000, parallacticAngle: 0 })
};

window.satellite = {
    twoline2satrec: (l1, l2) => ({ l1, l2 }),
    propagate: () => ({ position: false, velocity: false }),   // nessun passaggio calcolato: basta per il flusso
    gstime: () => 0,
    eciToEcf: () => ({ x: 0, y: 0, z: 0 }),
    ecfToLookAngles: () => ({ azimuth: 0, elevation: 0, rangeSat: 1000 }),
    degreesToRadians: (d) => d * Math.PI / 180,
    radiansToDegrees: (r) => r * 180 / Math.PI
};

(function () {
    const chain = () => new Proxy(function () {}, {
        get: (t, p) => (p === 'then' ? undefined : (p === Symbol.toPrimitive ? () => 0 : chain())),
        apply: () => chain(), construct: () => chain()
    });

    class FakeMap {
        constructor() { this._layers = new Set(); this._zoom = 15; this.minZoom = null; this.maxZoom = null; window.__map = this; }
        setView(c, z) { if (z != null) this._zoom = z; this._center = c; return this; }
        setZoom(z) { this._zoom = z; return this; }
        getZoom() { return this._zoom; }
        getCenter() { const c = this._center || [38.1157, 13.3615]; return { lat: c[0], lng: c[1] }; }
        getBounds() { return { getNorth: () => 38.1200, getSouth: () => 38.1110, getEast: () => 13.3700, getWest: () => 13.3530 }; }
        hasLayer(l) { return this._layers.has(l); }
        addLayer(l) { this._layers.add(l); return this; }
        removeLayer(l) { this._layers.delete(l); return this; }
        setMinZoom(z) { this.minZoom = z; return this; }
        setMaxZoom(z) { this.maxZoom = z; return this; }
        invalidateSize() { return this; }
        on() { return this; } off() { return this; } remove() {} fitBounds() { return this; } panTo() { return this; }
    }

    class FakeTileLayer {
        constructor(url, options) { this._url = url; this.options = options || {}; this.redraws = 0; }
        addTo(map) { map.addLayer(this); return this; }
        redraw() { this.redraws++; return this; }
    }
    FakeTileLayer.extend = (proto) => {
        class K extends FakeTileLayer {}
        Object.assign(K.prototype, proto);
        return K;
    };
    FakeTileLayer.prototype.createTile = function () { return document.createElement('img'); };

    window.L = new Proxy({
        map: () => new FakeMap(),
        TileLayer: FakeTileLayer,
        tileLayer: (url, opts) => new FakeTileLayer(url, opts),
        control: { zoom: () => chain() },
        layerGroup: () => ({ addTo() { return this; }, clearLayers() {}, addLayer() {} })
    }, { get: (t, p) => (p in t ? t[p] : chain()) });
})();
