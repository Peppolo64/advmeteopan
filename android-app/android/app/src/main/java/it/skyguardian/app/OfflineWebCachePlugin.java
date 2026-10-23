package it.skyguardian.app;

import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONException;

@CapacitorPlugin(name = "OfflineWebCache")
public class OfflineWebCachePlugin extends Plugin {
    private SnapshotWebArchive archive;

    @Override
    public void load() {
        archive = new SnapshotWebArchive(getContext());
        getBridge().setWebViewClient(new BridgeWebViewClient(getBridge()) {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse archived = archive.intercept(request);
                return archived != null ? archived : super.shouldInterceptRequest(view, request);
            }
        });
    }

    @PluginMethod
    public void beginSnapshotCapture(PluginCall call) {
        String id = call.getString("snapshotId");
        try {
            archive.beginCapture(id, readUrls(call.getArray("urls")));
            getBridge().executeOnMainThread(() -> {
                WebView webView = getBridge().getWebView();
                if (webView == null) {
                    call.reject("WebView Android non disponibile.");
                    return;
                }
                webView.getSettings().setCacheMode(WebSettings.LOAD_DEFAULT);
                call.resolve();
            });
        } catch (Exception e) {
            call.reject("Impossibile avviare l'archivio web dello snapshot.", e);
        }
    }

    @PluginMethod
    public void finishSnapshotCapture(PluginCall call) {
        JSObject result = new JSObject();
        result.put("result", archive.finishCapture());
        call.resolve(result);
    }

    @PluginMethod
    public void setSnapshotMode(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        if (enabled == null) {
            call.reject("Il parametro enabled è obbligatorio.");
            return;
        }
        try {
            if (enabled && call.getBoolean("archiveEnabled", true)) {
                archive.setSnapshot(call.getString("snapshotId"), readUrls(call.getArray("urls")));
            }
            else archive.disable();
        } catch (Exception e) {
            call.reject("Impossibile preparare l'archivio web dello snapshot.", e);
            return;
        }

        getBridge().executeOnMainThread(() -> {
            WebView webView = getBridge().getWebView();
            if (webView == null) {
                call.reject("WebView Android non disponibile.");
                return;
            }
            webView.getSettings().setCacheMode(
                enabled ? WebSettings.LOAD_CACHE_ONLY : WebSettings.LOAD_DEFAULT
            );
            call.resolve();
        });
    }

    @PluginMethod
    public void getSnapshotFaults(PluginCall call) {
        JSArray result = new JSArray();
        for (java.util.Map<String, String> fault : archive.takeFaults()) {
            JSObject item = new JSObject();
            item.put("url", fault.get("url"));
            item.put("reason", fault.get("reason"));
            result.put(item);
        }
        JSObject payload = new JSObject();
        payload.put("faults", result);
        call.resolve(payload);
    }

    @PluginMethod
    public void clearSnapshot(PluginCall call) {
        try {
            archive.clearSnapshot(call.getString("snapshotId"));
            call.resolve();
        } catch (Exception e) {
            call.reject("Impossibile eliminare l'archivio dello snapshot.", e);
        }
    }

    @PluginMethod
    public void pruneSnapshots(PluginCall call) {
        JSArray ids = call.getArray("snapshotIds");
        if (ids == null) {
            call.reject("L'elenco degli ID snapshot è obbligatorio.");
            return;
        }
        try {
            archive.prune(readUrls(ids));
            call.resolve();
        } catch (Exception e) {
            call.reject("Impossibile ripulire gli archivi web scaduti.", e);
        }
    }

    @PluginMethod
    public void clearCache(PluginCall call) {
        try {
            archive.clearAll();
        } catch (IOException e) {
            call.reject("Impossibile eliminare gli archivi web degli snapshot.", e);
            return;
        }
        getBridge().executeOnMainThread(() -> {
            WebView webView = getBridge().getWebView();
            if (webView == null) {
                call.reject("WebView Android non disponibile.");
                return;
            }
            webView.clearCache(true);
            call.resolve();
        });
    }

    private List<String> readUrls(JSArray values) throws JSONException {
        List<String> result = new ArrayList<>();
        if (values == null) return result;
        for (int i = 0; i < values.length(); i++) {
            String value = values.getString(i);
            if (value != null) result.add(value);
        }
        return result;
    }
}
