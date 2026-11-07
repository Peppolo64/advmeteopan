package it.skyguardian.app;

import android.Manifest;
import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.GnssStatus;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Looper;
import android.os.SystemClock;

import androidx.annotation.RequiresApi;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Pannello "Posizione e Altitudine": barometro, GNSS (con satelliti usati e doppia frequenza L5) e
 * quota sul livello del mare calcolata da Android 14+ (AltitudeConverter).
 *
 * Privacy: i sensori sono attivi SOLO tra start() e stop() mentre l'app è in primo piano.
 * In pausa (app in secondo piano, schermo spento) tutto viene fermato da handleOnPause().
 */
@CapacitorPlugin(
    name = "Altimeter",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION })
    }
)
public class AltimeterPlugin extends Plugin implements SensorEventListener {
    private SensorManager sensorManager;
    private Sensor pressureSensor;
    private LocationManager locationManager;
    private LocationListener locationListener;
    private Object gnssCallback;   // GnssStatus.Callback (API 24+)
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private Object altitudeConverter;   // android.location.altitude.AltitudeConverter (API 34+)
    private volatile boolean running = false;
    private volatile int satsVisible = 0, satsUsed = 0, satsUsedL5 = 0;

    @Override
    public void load() {
        sensorManager = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
        pressureSensor = sensorManager != null ? sensorManager.getDefaultSensor(Sensor.TYPE_PRESSURE) : null;
        locationManager = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
    }

    @PluginMethod
    public void capabilities(PluginCall call) {
        JSObject r = new JSObject();
        r.put("barometer", pressureSensor != null);
        if (pressureSensor != null) {
            r.put("barometerName", pressureSensor.getName());
            r.put("barometerVendor", pressureSensor.getVendor());
            r.put("barometerResolution", pressureSensor.getResolution());
        }
        r.put("gps", locationManager != null && locationManager.getAllProviders().contains(LocationManager.GPS_PROVIDER));
        r.put("gpsEnabled", locationManager != null && locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER));
        r.put("sdk", Build.VERSION.SDK_INT);
        r.put("mslAltitude", Build.VERSION.SDK_INT >= 34);
        r.put("model", Build.MANUFACTURER + " " + Build.MODEL);
        r.put("locationPermission", getPermissionState("location") == PermissionState.GRANTED);
        call.resolve(r);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
            requestPermissionForAlias("location", call, "locationPermissionResult");
            return;
        }
        doStart(call);
    }

    @PermissionCallback
    private void locationPermissionResult(PluginCall call) {
        if (getPermissionState("location") == PermissionState.GRANTED) doStart(call);
        else call.reject("Permesso di posizione negato");
    }

    private void doStart(PluginCall call) {
        stopAll();
        running = true;
        satsVisible = 0; satsUsed = 0; satsUsedL5 = 0;
        if (pressureSensor != null) sensorManager.registerListener(this, pressureSensor, SensorManager.SENSOR_DELAY_UI);
        boolean gpsStarted = false;
        try {
            if (locationManager != null && locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationListener = new LocationListener() {
                    @Override public void onLocationChanged(Location location) { onFix(location); }
                    @Override public void onStatusChanged(String provider, int status, Bundle extras) { }
                    @Override public void onProviderEnabled(String provider) { }
                    @Override public void onProviderDisabled(String provider) { }
                };
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, locationListener, Looper.getMainLooper());
                gpsStarted = true;
                if (Build.VERSION.SDK_INT >= 24) registerGnssStatus();
            }
        } catch (SecurityException e) {
            gpsStarted = false;
        }
        JSObject r = new JSObject();
        r.put("barometer", pressureSensor != null);
        r.put("gps", gpsStarted);
        call.resolve(r);
    }

    @RequiresApi(24)
    private void registerGnssStatus() {
        GnssStatus.Callback cb = new GnssStatus.Callback() {
            @Override
            public void onSatelliteStatusChanged(GnssStatus status) {
                int visible = status.getSatelliteCount(), used = 0, usedL5 = 0;
                for (int i = 0; i < visible; i++) {
                    if (!status.usedInFix(i)) continue;
                    used++;
                    if (Build.VERSION.SDK_INT >= 26 && status.hasCarrierFrequencyHz(i)) {
                        float f = status.getCarrierFrequencyHz(i);
                        if (f > 1.15e9f && f < 1.20e9f) usedL5++;   // L5 / E5a (1176,45 MHz)
                    }
                }
                satsVisible = visible; satsUsed = used; satsUsedL5 = usedL5;
            }
        };
        try {
            locationManager.registerGnssStatusCallback(cb, new android.os.Handler(Looper.getMainLooper()));
            gnssCallback = cb;
        } catch (SecurityException ignored) { }
    }

    private void onFix(Location location) {
        if (!running) return;
        final Location loc = new Location(location);
        executor.execute(() -> {
            JSObject o = new JSObject();
            o.put("lat", loc.getLatitude());
            o.put("lon", loc.getLongitude());
            o.put("t", loc.getTime());
            o.put("ageMs", (SystemClock.elapsedRealtimeNanos() - loc.getElapsedRealtimeNanos()) / 1000000L);
            if (loc.hasAccuracy()) o.put("hAcc", loc.getAccuracy());
            if (loc.hasAltitude()) o.put("alt", loc.getAltitude());   // sopra l'ellissoide WGS84
            if (Build.VERSION.SDK_INT >= 26 && loc.hasVerticalAccuracy()) o.put("vAcc", loc.getVerticalAccuracyMeters());
            if (Build.VERSION.SDK_INT >= 34 && loc.hasAltitude()) addMsl(loc, o);
            o.put("satsUsed", satsUsed);
            o.put("satsVisible", satsVisible);
            o.put("satsL5", satsUsedL5);
            o.put("provider", loc.getProvider());
            if (running) notifyListeners("location", o);
        });
    }

    @RequiresApi(34)
    private void addMsl(Location loc, JSObject o) {
        try {
            if (altitudeConverter == null) altitudeConverter = new android.location.altitude.AltitudeConverter();
            ((android.location.altitude.AltitudeConverter) altitudeConverter).addMslAltitudeToLocation(getContext(), loc);
            if (loc.hasMslAltitude()) {
                o.put("msl", loc.getMslAltitudeMeters());
                if (loc.hasMslAltitudeAccuracy()) o.put("mslAcc", loc.getMslAltitudeAccuracyMeters());
            }
        } catch (Exception ignored) {
            // modello del geoide non disponibile: la conversione la fa la pagina con EGM96
        }
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        if (!running || event.sensor.getType() != Sensor.TYPE_PRESSURE) return;
        JSObject o = new JSObject();
        o.put("hPa", event.values[0]);
        o.put("accuracy", event.accuracy);
        o.put("t", System.currentTimeMillis());
        notifyListeners("pressure", o);
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) { }

    @PluginMethod
    public void stop(PluginCall call) {
        stopAll();
        call.resolve();
    }

    private void stopAll() {
        running = false;
        if (sensorManager != null) sensorManager.unregisterListener(this);
        if (locationManager != null) {
            if (locationListener != null) {
                try { locationManager.removeUpdates(locationListener); } catch (Exception ignored) { }
                locationListener = null;
            }
            if (Build.VERSION.SDK_INT >= 24 && gnssCallback != null) {
                try { locationManager.unregisterGnssStatusCallback((GnssStatus.Callback) gnssCallback); } catch (Exception ignored) { }
                gnssCallback = null;
            }
        }
    }

    // METAR: scaricato dal lato nativo (nessun limite CORS), solo da aviationweather.gov
    @PluginMethod
    public void fetchMetar(PluginCall call) {
        final String url = call.getString("url", "");
        if (!url.startsWith("https://aviationweather.gov/api/data/metar?")) {
            call.reject("Indirizzo METAR non consentito");
            return;
        }
        executor.execute(() -> {
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(8000);
                c.setReadTimeout(8000);
                c.setRequestProperty("User-Agent", "SkyGuardian");
                int code = c.getResponseCode();
                InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                if (in != null) {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) > 0 && out.size() < 2_000_000) out.write(buf, 0, n);
                    in.close();
                }
                JSObject r = new JSObject();
                r.put("status", code);
                r.put("body", new String(out.toByteArray(), StandardCharsets.UTF_8));
                call.resolve(r);
            } catch (Exception e) {
                call.reject("METAR non raggiungibile: " + e.getMessage());
            } finally {
                if (c != null) c.disconnect();
            }
        });
    }

    @Override
    protected void handleOnPause() {
        // l'app va in secondo piano: nessun sensore resta acceso
        if (running) notifyListeners("stopped", new JSObject().put("reason", "pause"));
        stopAll();
        super.handleOnPause();
    }

    @Override
    protected void handleOnDestroy() {
        stopAll();
        executor.shutdownNow();
        super.handleOnDestroy();
    }
}
