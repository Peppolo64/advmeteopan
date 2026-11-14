package it.skyguardian.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;

import org.json.JSONObject;

import java.util.Locale;

/**
 * Servizio in primo piano per registrare il percorso ad app chiusa («Esegui in background»).
 * Notifica «SkyGuardian sta registrando» con Pausa/Riprendi e Ferma. Durante la registrazione tiene
 * sveglio il processore (wake lock parziale) perché il GPS non venga sospeso a schermo spento;
 * in pausa GPS e wake lock sono spenti. «Ferma» chiude tutto.
 */
public class TrackingService extends Service {
    static final String ACTION_START = "it.skyguardian.app.TRACK_START";
    static final String ACTION_STOP = "it.skyguardian.app.TRACK_STOP";
    static final String ACTION_PAUSE = "it.skyguardian.app.TRACK_PAUSE";
    static final String ACTION_RESUME = "it.skyguardian.app.TRACK_RESUME";
    private static final String CHANNEL = "skyguardian_track";
    private static final int NOTIFICATION_ID = 4107;

    private TrackRecorder recorder;
    private PowerManager.WakeLock wakeLock;
    private TrackRecorder.Options options;
    private boolean useWakeLock = true;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable refresh = new Runnable() {
        @Override public void run() {
            updateNotification();
            handler.postDelayed(this, 5000);
        }
    };

    static void command(Context ctx, String action) {
        Intent i = new Intent(ctx, TrackingService.class).setAction(action);
        if (ACTION_START.equals(action) && Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i); else ctx.startService(i);
    }

    static void stop(Context ctx) { ctx.stopService(new Intent(ctx, TrackingService.class)); }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            TrackStore.end();
            TrackerPlugin.notifyEvent("stopped", "notification");
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_PAUSE.equals(action)) { doPause(true); return START_NOT_STICKY; }
        if (ACTION_RESUME.equals(action)) { doResume(true); return START_NOT_STICKY; }

        createChannel();
        Notification n = build("Avvio del GPS…", false);
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        else startForeground(NOTIFICATION_ID, n);
        options = optionsFrom(TrackStore.settings());
        if (recorder == null) recorder = new TrackRecorder(this, TrackStore::add);
        if (!recorder.start(options)) {
            TrackStore.end();
            TrackerPlugin.notifyEvent("stopped", "gps");
            stopSelf();
            return START_NOT_STICKY;
        }
        acquireWakeLock();
        handler.removeCallbacks(refresh);
        handler.postDelayed(refresh, 3000);
        return START_NOT_STICKY;
    }

    void doPause(boolean fromNotification) {
        if (!TrackStore.isActive() || TrackStore.isPaused()) return;
        TrackStore.pause(System.currentTimeMillis());
        if (recorder != null) recorder.stop();   // in pausa il GPS è spento
        releaseWakeLock();
        updateNotification();
        if (fromNotification) TrackerPlugin.notifyEvent("paused", "notification");
    }

    void doResume(boolean fromNotification) {
        if (!TrackStore.isActive() || !TrackStore.isPaused()) return;
        TrackStore.resume(System.currentTimeMillis());
        if (recorder != null) recorder.start(options);
        acquireWakeLock();
        updateNotification();
        if (fromNotification) TrackerPlugin.notifyEvent("resumed", "notification");
    }

    static TrackRecorder.Options optionsFrom(String json) {
        TrackRecorder.Options o = new TrackRecorder.Options();
        try {
            JSONObject s = new JSONObject(json);
            o.intervalMs = Math.round(s.optDouble("intervalS", 1) * 1000);
            o.minDistanceM = (float) s.optDouble("minDistanceM", 0);
            o.fullGnss = s.optBoolean("fullGnss", false);
        } catch (Exception ignored) { }
        return o;
    }

    private void acquireWakeLock() {
        try { useWakeLock = new JSONObject(TrackStore.settings()).optBoolean("keepAwake", true); } catch (Exception ignored) { }
        if (!useWakeLock) return;
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SkyGuardian:percorso");
            wakeLock.setReferenceCounted(false);
        }
        if (!wakeLock.isHeld()) wakeLock.acquire(12 * 60 * 60 * 1000L);   // massimo 12 ore, poi Android lo rilascia comunque
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(refresh);
        releaseWakeLock();
        if (recorder != null) recorder.shutdown();
        recorder = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Percorso GPS", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Visibile solo mentre un percorso è registrato in background");
            nm.createNotificationChannel(ch);
        }
    }

    private PendingIntent servicePi(String action, int code, int flags) {
        return PendingIntent.getService(this, code, new Intent(this, TrackingService.class).setAction(action), flags);
    }

    private Notification build(String text, boolean paused) {
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPi = PendingIntent.getActivity(this, 0, open, piFlags);
        return new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(getApplicationInfo().icon)
            .setContentTitle(paused ? "SkyGuardian · percorso in pausa" : "SkyGuardian sta registrando")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(openPi)
            .addAction(0, paused ? "Riprendi" : "Pausa", servicePi(paused ? ACTION_RESUME : ACTION_PAUSE, 2, piFlags))
            .addAction(0, "Ferma", servicePi(ACTION_STOP, 1, piFlags))
            .build();
    }

    private void updateNotification() {
        boolean paused = TrackStore.isPaused();
        long secs = Math.max(0, (System.currentTimeMillis() - TrackStore.startedAt()) / 1000);
        String time = String.format(Locale.ITALY, "%d:%02d:%02d", secs / 3600, (secs / 60) % 60, secs % 60);
        double[] p = TrackStore.last();
        String text;
        if (paused) text = "In pausa · GPS spento · " + time;
        else if (p != null && !Double.isNaN(p[4])) text = String.format(Locale.ITALY, "%.1f km/h · %s · %d punti", p[4] * 3.6, time, TrackStore.size());
        else text = "In attesa del GPS · " + time;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIFICATION_ID, build(text, paused));
    }
}
