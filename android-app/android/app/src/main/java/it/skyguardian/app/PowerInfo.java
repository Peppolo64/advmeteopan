package it.skyguardian.app;

import android.app.ActivityManager;
import android.content.ContentResolver;
import android.content.Context;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

/**
 * Stato energetico del telefono, per capire in quali condizioni è stato registrato un percorso.
 * Il livello «Massimo» di Samsung non ha un'API pubblica: si leggono le impostazioni interne note
 * (best effort); se non si riconosce, resta «standard» e l'utente può correggerlo nell'archivio.
 */
final class PowerInfo {
    static final int SAVER_OFF = 0, SAVER_STANDARD = 1, SAVER_MAX = 2;
    private static final String[] MAX_KEYS = { "ultra_powersaving_mode", "minimal_battery_use", "emergency_mode", "ultra_powersaving_mode_enabled" };

    private PowerInfo() { }

    static boolean ignoringBatteryOptimizations(Context ctx) {
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        return Build.VERSION.SDK_INT < 23 || pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
    }

    static boolean backgroundRestricted(Context ctx) {
        ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
        return Build.VERSION.SDK_INT >= 28 && am.isBackgroundRestricted();
    }

    static boolean screenOn(Context ctx) {
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        return pm.isInteractive();
    }

    /** 0 = spento, 1 = standard, 2 = massimo (Samsung, se riconosciuto) */
    static int saverLevel(Context ctx) {
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        ContentResolver cr = ctx.getContentResolver();
        for (String k : MAX_KEYS) {
            if (readInt(cr, k) == 1) return SAVER_MAX;
        }
        return pm.isPowerSaveMode() ? SAVER_STANDARD : SAVER_OFF;
    }

    /** Chiave interna da cui è stato riconosciuto il livello massimo (per la diagnostica), oppure "" */
    static String maxKey(Context ctx) {
        ContentResolver cr = ctx.getContentResolver();
        for (String k : MAX_KEYS) if (readInt(cr, k) == 1) return k;
        return "";
    }

    private static int readInt(ContentResolver cr, String key) {
        try { int v = Settings.System.getInt(cr, key, -1); if (v >= 0) return v; } catch (Exception ignored) { }
        try { int v = Settings.Global.getInt(cr, key, -1); if (v >= 0) return v; } catch (Exception ignored) { }
        try { int v = Settings.Secure.getInt(cr, key, -1); if (v >= 0) return v; } catch (Exception ignored) { }
        return -1;
    }
}
