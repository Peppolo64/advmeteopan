package it.skyguardian.app;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Punti grezzi del percorso in corso (condivisi tra TrackerPlugin e TrackingService). I filtri
 * (precisione, salti, pausa automatica…) sono applicati dalla pagina, sempre sui dati grezzi.
 * Ogni punto: [t (ms), lat, lon, hAcc, speed (m/s), speedAcc, mslAlt, ellAlt, vAcc, pressure (hPa),
 *              satelliti usati, satelliti su L5, direzione (°)]; i valori assenti sono NaN.
 * I punti sono anche scritti su file man mano: se il sistema chiude l'app durante un percorso,
 * alla riapertura il percorso si recupera (recover()).
 */
final class TrackStore {
    static final int FIELDS = 13;

    interface Listener { void onPoint(double[] p); }

    private static final List<double[]> points = new ArrayList<>();
    private static final List<long[]> pauses = new ArrayList<>();   // [inizio, fine (0 = in corso)]
    private static boolean active = false, background = false, paused = false;
    private static long startedAt = 0;
    private static String settingsJson = "{}";
    private static Listener listener;
    private static File file;

    private TrackStore() { }

    static synchronized void init(File dir) { if (file == null) file = new File(dir, "track-current.csv"); }

    static synchronized void begin(boolean inBackground, String settings) {
        points.clear();
        pauses.clear();
        active = true; paused = false;
        background = inBackground;
        startedAt = System.currentTimeMillis();
        settingsJson = settings == null ? "{}" : settings;
        write("S," + startedAt + "," + (background ? 1 : 0) + "," + settingsJson.replace('\n', ' '), false);
    }

    static synchronized void end() {
        if (!active) return;
        if (paused) closePause(System.currentTimeMillis());
        active = false; paused = false;
        write("E," + System.currentTimeMillis(), true);
    }

    static synchronized void pause(long t) {
        if (!active || paused) return;
        paused = true;
        pauses.add(new long[] { t, 0 });
        write("P," + t, true);
    }

    static synchronized void resume(long t) {
        if (!active || !paused) return;
        closePause(t);
        paused = false;
        write("R," + t, true);
    }

    private static void closePause(long t) {
        if (!pauses.isEmpty()) pauses.get(pauses.size() - 1)[1] = t;
    }

    static synchronized boolean isActive() { return active; }
    static synchronized boolean isPaused() { return paused; }
    static synchronized boolean isBackground() { return background; }
    static synchronized long startedAt() { return startedAt; }
    static synchronized int size() { return points.size(); }
    static synchronized String settings() { return settingsJson; }
    static synchronized List<long[]> pauses() {
        List<long[]> out = new ArrayList<>();
        for (long[] p : pauses) out.add(new long[] { p[0], p[1] });
        return out;
    }

    static void add(double[] p) {
        Listener l;
        synchronized (TrackStore.class) {
            if (!active || paused) return;
            points.add(p);
            StringBuilder sb = new StringBuilder("T");
            for (double v : p) sb.append(',').append(Double.isNaN(v) ? "" : String.format(Locale.ROOT, "%.7f", v));
            write(sb.toString(), true);
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

    private static void write(String line, boolean append) {
        if (file == null) return;
        try (FileWriter w = new FileWriter(file, append)) { w.write(line); w.write('\n'); } catch (Exception ignored) { }
    }

    /** Percorso rimasto a metà (app chiusa dal sistema): righe del file, oppure null. */
    static synchronized List<String> recover() {
        if (active || file == null || !file.exists()) return null;
        List<String> lines = new ArrayList<>();
        try (BufferedReader r = new BufferedReader(new FileReader(file))) {
            String s;
            while ((s = r.readLine()) != null) lines.add(s);
        } catch (Exception e) { return null; }
        if (lines.isEmpty() || !lines.get(0).startsWith("S,")) return null;
        if (lines.get(lines.size() - 1).startsWith("E,")) return null;   // percorso concluso normalmente
        return lines;
    }

    static synchronized void discardRecovered() {
        if (!active && file != null && file.exists()) write("E," + System.currentTimeMillis(), true);
    }
}
