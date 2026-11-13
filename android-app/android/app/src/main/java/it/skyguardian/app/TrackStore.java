package it.skyguardian.app;

import java.util.ArrayList;
import java.util.List;

/**
 * Punti del percorso GPS in corso, in memoria (condivisi tra TrackerPlugin e TrackingService).
 * Ogni punto: [t (ms), lat, lon, hAcc, speed (m/s), speedAcc, mslAlt, ellAlt, vAcc, pressure (hPa)];
 * i valori assenti sono NaN.
 */
final class TrackStore {
    static final int FIELDS = 10;

    interface Listener { void onPoint(double[] p); }

    private static final List<double[]> points = new ArrayList<>();
    private static boolean active = false;
    private static boolean background = false;
    private static long startedAt = 0;
    private static Listener listener;

    private TrackStore() { }

    static synchronized void begin(boolean inBackground) {
        points.clear();
        active = true;
        background = inBackground;
        startedAt = System.currentTimeMillis();
    }

    static synchronized void end() { active = false; }

    static synchronized boolean isActive() { return active; }
    static synchronized boolean isBackground() { return background; }
    static synchronized long startedAt() { return startedAt; }
    static synchronized int size() { return points.size(); }

    static void add(double[] p) {
        Listener l;
        synchronized (TrackStore.class) {
            if (!active) return;
            points.add(p);
            l = listener;
        }
        if (l != null) l.onPoint(p);
    }

    static synchronized double[] last() { return points.isEmpty() ? null : points.get(points.size() - 1); }

    static synchronized List<double[]> from(int index) {
        int i = Math.max(0, Math.min(index, points.size()));
        return new ArrayList<>(points.subList(i, points.size()));
    }

    static synchronized void setListener(Listener l) { listener = l; }
}
