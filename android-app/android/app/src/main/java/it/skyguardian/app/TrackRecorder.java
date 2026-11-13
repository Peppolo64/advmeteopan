package it.skyguardian.app;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Looper;

import androidx.annotation.RequiresApi;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * GPS (1 fix al secondo) + barometro per il percorso. Usato dal plugin (solo in primo piano) oppure
 * dal servizio in primo piano TrackingService (anche ad app chiusa, con notifica visibile).
 */
final class TrackRecorder implements SensorEventListener {
    interface FixSink { void onFix(double[] p); }

    private final Context context;
    private final FixSink sink;
    private final LocationManager locationManager;
    private final SensorManager sensorManager;
    private final Sensor pressureSensor;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private LocationListener listener;
    private Object altitudeConverter;
    private volatile float lastPressure = Float.NaN;
    private volatile boolean running = false;

    TrackRecorder(Context context, FixSink sink) {
        this.context = context.getApplicationContext();
        this.sink = sink;
        locationManager = (LocationManager) this.context.getSystemService(Context.LOCATION_SERVICE);
        sensorManager = (SensorManager) this.context.getSystemService(Context.SENSOR_SERVICE);
        pressureSensor = sensorManager != null ? sensorManager.getDefaultSensor(Sensor.TYPE_PRESSURE) : null;
    }

    boolean isRunning() { return running; }

    /** @return false se il GPS è spento o manca il permesso */
    boolean start() {
        if (running) return true;
        if (locationManager == null || !locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) return false;
        listener = new LocationListener() {
            @Override public void onLocationChanged(Location location) { handle(location); }
            @Override public void onStatusChanged(String provider, int status, Bundle extras) { }
            @Override public void onProviderEnabled(String provider) { }
            @Override public void onProviderDisabled(String provider) { }
        };
        try {
            locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, listener, Looper.getMainLooper());
        } catch (SecurityException e) {
            listener = null;
            return false;
        }
        if (pressureSensor != null) sensorManager.registerListener(this, pressureSensor, SensorManager.SENSOR_DELAY_NORMAL);
        running = true;
        return true;
    }

    void stop() {
        running = false;
        if (listener != null) {
            try { locationManager.removeUpdates(listener); } catch (Exception ignored) { }
            listener = null;
        }
        if (sensorManager != null) sensorManager.unregisterListener(this);
    }

    void shutdown() {
        stop();
        executor.shutdownNow();
    }

    private void handle(Location location) {
        if (!running) return;
        final Location loc = new Location(location);
        final float pressure = lastPressure;
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
