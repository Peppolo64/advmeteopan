package it.skyguardian.app;

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
import android.os.Handler;
import android.os.Looper;

import androidx.annotation.RequiresApi;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * GPS + barometro per il percorso. Intervallo e distanza minima come da impostazioni; con
 * «tracciamento GNSS completo» (Android 12+) il chip GNSS non fa pause per risparmiare energia.
 * Usato dal plugin (solo primo piano) oppure dal servizio TrackingService (anche ad app chiusa).
 */
final class TrackRecorder implements SensorEventListener {
    interface FixSink { void onFix(double[] p); }
    interface BeatSink { void onBeat(long[] b); }
    private static final long BEAT_MS = 5000;

    static final class Options {
        long intervalMs = 1000;
        float minDistanceM = 0;
        boolean fullGnss = false;
    }

    private final Context context;
    private final FixSink sink;
    private final LocationManager locationManager;
    private final SensorManager sensorManager;
    private final Sensor pressureSensor;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private LocationListener listener;
    private Object gnssStatusCallback, gnssMeasurementsCallback, altitudeConverter;
    private volatile float lastPressure = Float.NaN;
    private volatile int satsUsed = -1, satsL5 = -1, satsVisible = -1;
    // Vitalità del GNSS (elapsedRealtime): ultimo aggiornamento dei satelliti, ultimo fix, motore acceso/fermato
    private volatile long lastGnssAt = 0, lastFixAt = 0;
    private volatile int gnssRunning = -1;
    private BeatSink beatSink;
    private final Handler beatHandler = new Handler(Looper.getMainLooper());
    private final Runnable beatTask = new Runnable() {
        @Override public void run() {
            if (!running || beatSink == null) return;
            boolean gpsOn = false;
            try { gpsOn = locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER); } catch (Exception ignored) { }
            long now = android.os.SystemClock.elapsedRealtime();
            beatSink.onBeat(new long[] {
                System.currentTimeMillis(), now, android.os.SystemClock.uptimeMillis(),
                satsVisible, satsUsed, gpsOn ? 1 : 0, PowerInfo.screenOn(context) ? 1 : 0,
                PowerInfo.ignoringBatteryOptimizations(context) ? 1 : 0, PowerInfo.saverLevel(context),
                lastGnssAt > 0 ? now - lastGnssAt : -1,          // età dell'ultimo aggiornamento dei satelliti (ms)
                lastFixAt > 0 ? now - lastFixAt : -1,            // età dell'ultimo fix GPS ricevuto (ms)
                gnssRunning,                                     // 1 motore GNSS avviato, 0 fermato, -1 non noto
                PowerInfo.locationPowerSaveMode(context) });     // limiti del GPS imposti dal risparmio energetico
            beatHandler.postDelayed(this, BEAT_MS);
        }
    };

    /** Battiti indipendenti dal GPS: servono a distinguere «app sospesa» da «GPS senza segnale». */
    void setBeatSink(BeatSink s) { beatSink = s; }
    private volatile boolean running = false;
    private volatile boolean fullGnssActive = false;

    TrackRecorder(Context context, FixSink sink) {
        this.context = context.getApplicationContext();
        this.sink = sink;
        locationManager = (LocationManager) this.context.getSystemService(Context.LOCATION_SERVICE);
        sensorManager = (SensorManager) this.context.getSystemService(Context.SENSOR_SERVICE);
        pressureSensor = sensorManager != null ? sensorManager.getDefaultSensor(Sensor.TYPE_PRESSURE) : null;
    }

    boolean isRunning() { return running; }
    boolean isFullGnssActive() { return fullGnssActive; }

    /** @return false se il GPS è spento o manca il permesso */
    boolean start(Options o) {
        if (running) return true;
        if (locationManager == null || !locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) return false;
        listener = new LocationListener() {
            @Override public void onLocationChanged(Location location) { handle(location); }
            @Override public void onStatusChanged(String provider, int status, Bundle extras) { }
            @Override public void onProviderEnabled(String provider) { }
            @Override public void onProviderDisabled(String provider) { }
        };
        try {
            locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, Math.max(1000L, o.intervalMs), Math.max(0f, o.minDistanceM), listener, Looper.getMainLooper());
        } catch (SecurityException e) {
            listener = null;
            return false;
        }
        if (Build.VERSION.SDK_INT >= 24) registerGnssStatus();
        if (o.fullGnss && Build.VERSION.SDK_INT >= 31) registerFullTracking();
        if (pressureSensor != null) sensorManager.registerListener(this, pressureSensor, SensorManager.SENSOR_DELAY_NORMAL);
        running = true;
        beatHandler.removeCallbacks(beatTask);
        if (beatSink != null) beatHandler.post(beatTask);
        return true;
    }

    void stop() {
        running = false;
        beatHandler.removeCallbacks(beatTask);
        if (listener != null) {
            try { locationManager.removeUpdates(listener); } catch (Exception ignored) { }
            listener = null;
        }
        if (Build.VERSION.SDK_INT >= 24 && gnssStatusCallback != null) {
            try { locationManager.unregisterGnssStatusCallback((GnssStatus.Callback) gnssStatusCallback); } catch (Exception ignored) { }
            gnssStatusCallback = null;
        }
        if (Build.VERSION.SDK_INT >= 24 && gnssMeasurementsCallback != null) {
            try { locationManager.unregisterGnssMeasurementsCallback((android.location.GnssMeasurementsEvent.Callback) gnssMeasurementsCallback); } catch (Exception ignored) { }
            gnssMeasurementsCallback = null;
        }
        fullGnssActive = false;
        if (sensorManager != null) sensorManager.unregisterListener(this);
    }

    void shutdown() {
        stop();
        executor.shutdownNow();
    }

    @RequiresApi(24)
    private void registerGnssStatus() {
        GnssStatus.Callback cb = new GnssStatus.Callback() {
            @Override
            public void onSatelliteStatusChanged(GnssStatus status) {
                int used = 0, l5 = 0;
                for (int i = 0; i < status.getSatelliteCount(); i++) {
                    if (!status.usedInFix(i)) continue;
                    used++;
                    if (Build.VERSION.SDK_INT >= 26 && status.hasCarrierFrequencyHz(i)) {
                        float f = status.getCarrierFrequencyHz(i);
                        if (f > 1.15e9f && f < 1.20e9f) l5++;
                    }
                }
                satsUsed = used; satsL5 = l5; satsVisible = status.getSatelliteCount();
                lastGnssAt = android.os.SystemClock.elapsedRealtime();
            }
            @Override public void onStarted() { gnssRunning = 1; }
            @Override public void onStopped() { gnssRunning = 0; satsUsed = 0; }
        };
        try {
            locationManager.registerGnssStatusCallback(cb, new Handler(Looper.getMainLooper()));
            gnssStatusCallback = cb;
        } catch (SecurityException ignored) { }
    }

    // Misure GNSS con "full tracking": il chip resta sempre acceso (niente duty cycling)
    @RequiresApi(31)
    private void registerFullTracking() {
        try {
            android.location.GnssMeasurementsEvent.Callback cb = new android.location.GnssMeasurementsEvent.Callback() { };
            android.location.GnssMeasurementRequest req = new android.location.GnssMeasurementRequest.Builder().setFullTracking(true).build();
            fullGnssActive = locationManager.registerGnssMeasurementsCallback(req, executor, cb);
            if (fullGnssActive) gnssMeasurementsCallback = cb;
        } catch (Exception e) {
            fullGnssActive = false;
        }
    }

    private void handle(Location location) {
        if (!running) return;
        lastFixAt = android.os.SystemClock.elapsedRealtime();
        final Location loc = new Location(location);
        final float pressure = lastPressure;
        final int used = satsUsed, l5 = satsL5;
        executor.execute(() -> {
            double[] p = new double[TrackStore.FIELDS];
            p[0] = loc.getTime();
            p[1] = loc.getLatitude();
            p[2] = loc.getLongitude();
            p[3] = loc.hasAccuracy() ? loc.getAccuracy() : Double.NaN;
            p[4] = loc.hasSpeed() ? loc.getSpeed() : Double.NaN;
            p[5] = (Build.VERSION.SDK_INT >= 26 && loc.hasSpeedAccuracy()) ? loc.getSpeedAccuracyMetersPerSecond() : Double.NaN;
            p[6] = Double.NaN;
            if (Build.VERSION.SDK_INT >= 34 && loc.hasAltitude()) p[6] = msl(loc);
            p[7] = loc.hasAltitude() ? loc.getAltitude() : Double.NaN;
            p[8] = (Build.VERSION.SDK_INT >= 26 && loc.hasVerticalAccuracy()) ? loc.getVerticalAccuracyMeters() : Double.NaN;
            p[9] = pressure;
            p[10] = used >= 0 ? used : Double.NaN;
            p[11] = l5 >= 0 ? l5 : Double.NaN;
            p[12] = loc.hasBearing() ? loc.getBearing() : Double.NaN;
            if (running) sink.onFix(p);
        });
    }

    @RequiresApi(34)
    private double msl(Location loc) {
        try {
            if (altitudeConverter == null) altitudeConverter = new android.location.altitude.AltitudeConverter();
            ((android.location.altitude.AltitudeConverter) altitudeConverter).addMslAltitudeToLocation(context, loc);
            return loc.hasMslAltitude() ? loc.getMslAltitudeMeters() : Double.NaN;
        } catch (Exception e) {
            return Double.NaN;
        }
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        if (event.sensor.getType() == Sensor.TYPE_PRESSURE) lastPressure = event.values[0];
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) { }
}
