package it.skyguardian.app;

import android.Manifest;
import android.app.ActivityManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * Pannello «GPS Tracking».
 * - anteprima della velocità: GPS solo a pannello aperto e app in primo piano;
 * - percorso senza background: GPS solo con l'app in primo piano (i periodi ad app chiusa restano vuoti);
 * - percorso con «Esegui in background»: servizio TrackingService con notifica, Pausa e Ferma.
 * Pausa: GPS spento finché non si riprende.
 */
@CapacitorPlugin(
    name = "Tracker",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class TrackerPlugin extends Plugin {
    private static TrackerPlugin instance;
    private TrackRecorder foregroundRecorder;   // percorso senza background
    private TrackRecorder previewRecorder;      // velocità istantanea a pannello aperto (non registrata)
    private TrackRecorder.Options foregroundOptions;

    @Override
    public void load() {
        instance = this;
        TrackStore.init(getContext().getFilesDir());
        TrackStore.setListener(p -> notifyListeners("point", pointJs(p)));
    }

    static void notifyEvent(String event, String reason) {
        TrackerPlugin p = instance;
        if (p != null) p.notifyListeners(event, new JSObject().put("reason", reason));
    }

    private boolean hasLocation() { return getPermissionState("location") == PermissionState.GRANTED; }

    // ---------- stato, batteria e impostazioni di sistema ----------
    private JSObject power() {
        Context ctx = getContext();
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
        JSObject r = new JSObject();
        r.put("ignoringBatteryOptimizations", Build.VERSION.SDK_INT < 23 || pm.isIgnoringBatteryOptimizations(ctx.getPackageName()));
        r.put("backgroundRestricted", Build.VERSION.SDK_INT >= 28 && am.isBackgroundRestricted());   // Samsung: «Consenti attività in background» spento
        r.put("powerSaveMode", pm.isPowerSaveMode());
        r.put("manufacturer", Build.MANUFACTURER);
        r.put("model", Build.MODEL);
        r.put("sdk", Build.VERSION.SDK_INT);
        r.put("fullGnssSupported", Build.VERSION.SDK_INT >= 31);
        r.put("notifications", Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED);
        return r;
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = power();
        r.put("active", TrackStore.isActive());
        r.put("paused", TrackStore.isPaused());
        r.put("background", TrackStore.isBackground());
        r.put("startedAt", TrackStore.startedAt());
        r.put("count", TrackStore.size());
        r.put("settings", TrackStore.settings());
        r.put("locationPermission", hasLocation());
        call.resolve(r);
    }

    @PluginMethod
    public void powerStatus(PluginCall call) { call.resolve(power()); }

    // Riquadro di sistema "Consentire all'app di funzionare sempre in background?"
    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            openAppSettings(call);
        }
    }

    // Schermata dell'app nelle impostazioni (Batteria → Senza restrizioni, Consenti attività in background)
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Impossibile aprire le impostazioni: " + e.getMessage());
        }
    }

    // ---------- Anteprima (solo primo piano) ----------
    @PluginMethod
    public void startPreview(PluginCall call) {
        if (!hasLocation()) { requestPermissionForAlias("location", call, "previewPermission"); return; }
        doStartPreview(call);
    }

    @PermissionCallback
    private void previewPermission(PluginCall call) {
        if (hasLocation()) doStartPreview(call); else call.reject("Permesso di posizione negato");
    }

    private void doStartPreview(PluginCall call) {
        if (previewRecorder == null) previewRecorder = new TrackRecorder(getContext(), p -> notifyListeners("fix", pointJs(p)));
        boolean ok = previewRecorder.start(new TrackRecorder.Options());
        call.resolve(new JSObject().put("gps", ok));
    }

    @PluginMethod
    public void stopPreview(PluginCall call) {
        if (previewRecorder != null) previewRecorder.stop();
        call.resolve();
    }

    // ---------- Percorso ----------
    @PluginMethod
    public void start(PluginCall call) {
        boolean bg = Boolean.TRUE.equals(call.getBoolean("background", false));
        if (!hasLocation()) { requestPermissionForAlias("location", call, "startPermission"); return; }
        if (bg && Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") == PermissionState.PROMPT) {
            requestPermissionForAlias("notifications", call, "startPermission");   // senza permesso la notifica è nascosta ma il servizio funziona
            return;
        }
        doStart(call, bg);
    }

    @PermissionCallback
    private void startPermission(PluginCall call) {
        if (!hasLocation()) { call.reject("Permesso di posizione negato"); return; }
        boolean bg = Boolean.TRUE.equals(call.getBoolean("background", false));
        if (bg && Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") == PermissionState.PROMPT) {
            requestPermissionForAlias("notifications", call, "startPermission");
            return;
        }
        doStart(call, bg);
    }

    private void doStart(PluginCall call, boolean background) {
        stopEverything();
        JSObject settings = call.getObject("settings", new JSObject());
        String json = settings != null ? settings.toString() : "{}";
        TrackStore.begin(background, json);
        boolean ok;
        if (background) {
            try {
                TrackingService.command(getContext(), TrackingService.ACTION_START);
                ok = true;
            } catch (Exception e) {
                TrackStore.end();
                call.reject("Impossibile avviare il percorso in background: " + e.getMessage());
                return;
            }
        } else {
            foregroundOptions = TrackingService.optionsFrom(json);
            foregroundRecorder = new TrackRecorder(getContext(), TrackStore::add);
            ok = foregroundRecorder.start(foregroundOptions);
        }
        if (!ok) {
            TrackStore.end();
            call.reject("GPS spento: attivalo nelle impostazioni di Android");
            return;
        }
        JSObject r = power();
        r.put("startedAt", TrackStore.startedAt());
        r.put("background", background);
        call.resolve(r);
    }

    @PluginMethod
    public void pause(PluginCall call) {
        if (TrackStore.isBackground()) TrackingService.command(getContext(), TrackingService.ACTION_PAUSE);
        else {
            TrackStore.pause(System.currentTimeMillis());
            if (foregroundRecorder != null) foregroundRecorder.stop();
        }
        call.resolve(new JSObject().put("paused", true));
    }

    @PluginMethod
    public void resume(PluginCall call) {
        if (TrackStore.isBackground()) TrackingService.command(getContext(), TrackingService.ACTION_RESUME);
        else {
            TrackStore.resume(System.currentTimeMillis());
            if (foregroundRecorder != null) foregroundRecorder.start(foregroundOptions);
        }
        call.resolve(new JSObject().put("paused", false));
    }

    @PluginMethod
    public void stop(PluginCall call) {
        int n = TrackStore.size();
        stopEverything();
        call.resolve(new JSObject().put("count", n));
    }

    private void stopEverything() {
        TrackStore.end();
        TrackingService.stop(getContext());
        if (foregroundRecorder != null) { foregroundRecorder.shutdown(); foregroundRecorder = null; }
    }

    @PluginMethod
    public void getPoints(PluginCall call) {
        int from = call.getInt("from", 0);
        List<double[]> list = TrackStore.from(from);
        JSArray arr = new JSArray();
        for (double[] p : list) arr.put(pointArray(p));
        JSArray pauses = new JSArray();
        for (long[] p : TrackStore.pauses()) pauses.put(new JSONArray().put(p[0]).put(p[1]));
        JSObject r = new JSObject();
        r.put("from", from);
        r.put("points", arr);
        r.put("pauses", pauses);
        r.put("total", TrackStore.size());
        r.put("active", TrackStore.isActive());
        r.put("paused", TrackStore.isPaused());
        call.resolve(r);
    }

    // Percorso rimasto a metà perché il sistema ha chiuso l'app: righe del file di registrazione
    @PluginMethod
    public void recover(PluginCall call) {
        List<String> lines = TrackStore.recover();
        JSObject r = new JSObject();
        r.put("found", lines != null);
        if (lines != null) {
            JSArray a = new JSArray();
            for (String s : lines) a.put(s);
            r.put("lines", a);
        }
        call.resolve(r);
    }

    @PluginMethod
    public void discardRecovered(PluginCall call) {
        TrackStore.discardRecovered();
        call.resolve();
    }

    // ---------- Esportazione GPX (condivisione: Files, Drive, Strava…) ----------
    @PluginMethod
    public void exportGpx(PluginCall call) {
        String name = call.getString("name", "percorso.gpx").replaceAll("[^A-Za-z0-9._-]", "_");
        String gpx = call.getString("gpx", "");
        try {
            File dir = new File(getContext().getCacheDir(), "exports");
            if (!dir.exists() && !dir.mkdirs()) throw new Exception("cartella non creata");
            File f = new File(dir, name);
            try (FileOutputStream out = new FileOutputStream(f)) { out.write(gpx.getBytes(StandardCharsets.UTF_8)); }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent send = new Intent(Intent.ACTION_SEND)
                .setType("application/gpx+xml")
                .putExtra(Intent.EXTRA_STREAM, uri)
                .putExtra(Intent.EXTRA_SUBJECT, name)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, "Esporta il percorso GPX");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);
            call.resolve(new JSObject().put("file", f.getName()));
        } catch (Exception e) {
            call.reject("Esportazione non riuscita: " + e.getMessage());
        }
    }

    // ---------- Ciclo di vita ----------
    @Override
    protected void handleOnPause() {
        if (previewRecorder != null) previewRecorder.stop();
        // senza background il percorso si ferma con l'app: il buco apparirà come velocità zero
        if (foregroundRecorder != null) foregroundRecorder.stop();
        super.handleOnPause();
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (foregroundRecorder != null && TrackStore.isActive() && !TrackStore.isBackground() && !TrackStore.isPaused()) foregroundRecorder.start(foregroundOptions);
    }

    @Override
    protected void handleOnDestroy() {
        if (previewRecorder != null) previewRecorder.shutdown();
        if (foregroundRecorder != null) { foregroundRecorder.shutdown(); foregroundRecorder = null; TrackStore.end(); }
        if (instance == this) instance = null;
        super.handleOnDestroy();
    }

    private static Object num(double v) { return Double.isNaN(v) || Double.isInfinite(v) ? JSONObject.NULL : v; }

    private static JSONArray pointArray(double[] p) {
        JSONArray a = new JSONArray();
        for (double v : p) a.put(num(v));
        return a;
    }

    private static JSObject pointJs(double[] p) {
        JSObject o = new JSObject();
        o.put("p", pointArray(p));
        return o;
    }
}
