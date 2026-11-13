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

import androidx.core.app.NotificationCompat;

import java.util.Locale;

/**
 * Servizio in primo piano per registrare il percorso ad app chiusa.
 * Parte SOLO se l'utente avvia un percorso con «Esegui in background» e si ferma a fine percorso
 * (dall'app o dal tasto «Ferma» della notifica). Mentre è attivo la notifica è sempre visibile.
 */
public class TrackingService extends Service {
    static final String ACTION_START = "it.skyguardian.app.TRACK_START";
    static final String ACTION_STOP = "it.skyguardian.app.TRACK_STOP";
    private static final String CHANNEL = "skyguardian_track";
    private static final int NOTIFICATION_ID = 4107;

    private TrackRecorder recorder;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable refresh = new Runnable() {
        @Override public void run() {
            updateNotification();
            handler.postDelayed(this, 5000);
        }
    };

    static void start(Context ctx) {
        Intent i = new Intent(ctx, TrackingService.class).setAction(ACTION_START);
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i); else ctx.startService(i);
    }

    static void stop(Context ctx) {
        ctx.stopService(new Intent(ctx, TrackingService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            TrackStore.end();
            TrackerPlugin.notifyStoppedFromNotification();
            stopSelf();
            return START_NOT_STICKY;
        }
        createChannel();
        Notification n = build("Avvio del GPS…");
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        else startForeground(NOTIFICATION_ID, n);
        if (recorder == null) recorder = new TrackRecorder(this, TrackStore::add);
        if (!recorder.start()) {
            TrackStore.end();
            TrackerPlugin.notifyStoppedFromNotification();
            stopSelf();
            return START_NOT_STICKY;
        }
        handler.removeCallbacks(refresh);
        handler.postDelayed(refresh, 5000);
        return START_NOT_STICKY;   // se il sistema lo chiude non riparte da solo
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(refresh);
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

    private Notification build(String text) {
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPi = PendingIntent.getActivity(this, 0, open, piFlags);
        Intent stop = new Intent(this, TrackingService.class).setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(this, 1, stop, piFlags);
        return new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(getApplicationInfo().icon)
            .setContentTitle("SkyGuardian · percorso in corso")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(openPi)
            .addAction(0, "Ferma", stopPi)
            .build();
    }

    private void updateNotification() {
        double[] p = TrackStore.last();
        long secs = Math.max(0, (System.currentTimeMillis() - TrackStore.startedAt()) / 1000);
        String time = String.format(Locale.ITALY, "%d:%02d:%02d", secs / 3600, (secs / 60) % 60, secs % 60);
        String text = (p != null && !Double.isNaN(p[4]))
            ? String.format(Locale.ITALY, "%.1f km/h · %s · %d punti", p[4] * 3.6, time, TrackStore.size())
            : "In attesa del GPS · " + time;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIFICATION_ID, build(text));
    }
}
