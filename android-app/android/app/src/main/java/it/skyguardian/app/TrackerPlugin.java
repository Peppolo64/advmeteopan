package it.skyguardian.app;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;

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
 * - anteprima della velocità e percorso senza background: GPS solo con l'app in primo piano
 *   (in pausa si ferma: il grafico mostrerà velocità zero per il periodo ad app chiusa);
 * - percorso con «Esegui in background»: servizio in primo piano TrackingService con notifica visibile,
 *   fermato a fine percorso.
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

    @Override
    public void load() {
        instance = this;
        TrackStore.setListener(p -> notifyListeners("point", pointJs(p)));
    }

    static void notifyStoppedFromNotification() {
        TrackerPlugin p = instance;
        if (p != null) p.notifyListeners("stopped", new JSObject().put("reason", "notification"));
    }

    private boolean hasLocation() { return getPermissionState("location") == PermissionState.GRANTED; }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        r.put("active", TrackStore.isActive());
        r.put("background", TrackStore.isBackground());
        r.put("startedAt", TrackStore.startedAt());
        r.put("count", TrackStore.size());
        r.put("locationPermission", hasLocation());
        r.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(r);
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
        boolean ok = previewRecorder.start();
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
        if (bg && Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
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
        TrackStore.begin(background);
        boolean ok;
        if (background) {
            try {
                TrackingService.start(getContext());
                ok = true;
            } catch (Exception e) {
                TrackStore.end();
                call.reject("Impossibile avviare il percorso in background: " + e.getMessage());
                return;
            }
        } else {
            foregroundRecorder = new TrackRecorder(getContext(), TrackStore::add);
            ok = foregroundRecorder.start();
        }
        if (!ok) {
            TrackStore.end();
            call.reject("GPS spento: attivalo nelle impostazioni di Android");
            return;
        }
        JSObject r = new JSObject();
        r.put("startedAt", TrackStore.startedAt());
        r.put("background", background);
        r.put("notifications", Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED);
        call.resolve(r);
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
        JSObject r = new JSObject();
        r.put("from", from);
        r.put("points", arr);
        r.put("total", TrackStore.size());
        r.put("active", TrackStore.isActive());
        call.resolve(r);
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
        if (foregroundRecorder != null && TrackStore.isActive() && !TrackStore.isBackground()) foregroundRecorder.start();
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
