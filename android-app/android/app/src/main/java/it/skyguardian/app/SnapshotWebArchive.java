package it.skyguardian.app;

import android.content.Context;
import android.net.Uri;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;
import java.util.Set;

final class SnapshotWebArchive {
    private static final int MAX_RESOURCE_BYTES = 12 * 1024 * 1024;
    private static final long MAX_SNAPSHOT_BYTES = 48L * 1024 * 1024;
    private static final int MAX_FAULTS = 80;
    private static final String MODE_NONE = "none";

    private final File root;
    private final Map<String, WebFault> faults = new LinkedHashMap<>();
    private final Map<String, Long> storedBytes = new HashMap<>();
    private final Set<String> capturedKeys = new HashSet<>();
    private String snapshotId;
    private String mode = MODE_NONE;
    private List<String> rootHosts = Collections.emptyList();
    private List<String> rootUrls = Collections.emptyList();
    private int capturedResources;
    private long capturedBytes;

    SnapshotWebArchive(Context context) {
        root = new File(context.getFilesDir(), "snapshot-web");
    }

    synchronized void beginCapture(String id, List<String> urls) throws IOException {
        validateId(id);
        snapshotId = id;
        rootHosts = hostsFrom(urls);
        rootUrls = new ArrayList<>(urls);
        mode = "capture";
        capturedResources = 0;
        capturedBytes = 0;
        capturedKeys.clear();
        faults.clear();
        if (!directory(id).exists() && !directory(id).mkdirs()) throw new IOException("impossibile creare archivio");
        storedBytes.put(id, directorySize(directory(id)));
    }

    synchronized void setSnapshot(String id, List<String> urls) throws IOException {
        validateId(id);
        snapshotId = id;
        rootHosts = hostsFrom(urls);
        rootUrls = new ArrayList<>(urls);
        mode = "replay";
        faults.clear();
    }

    synchronized void disable() {
        mode = MODE_NONE;
        snapshotId = null;
        rootHosts = Collections.emptyList();
        rootUrls = Collections.emptyList();
        faults.clear();
    }

    WebResourceResponse intercept(WebResourceRequest request) {
        String currentMode;
        String currentId;
        List<String> hosts;
        List<String> urls;
        synchronized (this) {
            currentMode = mode;
            currentId = snapshotId;
            hosts = rootHosts;
            urls = rootUrls;
        }
        if (MODE_NONE.equals(currentMode) || request.isForMainFrame()) return null;

        Uri uri = request.getUrl();
        if (!"http".equalsIgnoreCase(uri.getScheme()) && !"https".equalsIgnoreCase(uri.getScheme())) return null;
        if ("capture".equals(currentMode)) {
            if (!isRelated(uri, request.getRequestHeaders(), hosts)) return null;
            if (!"GET".equalsIgnoreCase(request.getMethod())) {
                addFault(currentId, uri.toString(), "non supportata: metodo " + request.getMethod());
                return null;
            }
            try {
                return fetchAndSave(currentId, request);
            } catch (Exception e) {
                addFault(currentId, uri.toString(), "non archiviata: " + safeMessage(e));
                return null;
            }
        }

        if (!"GET".equalsIgnoreCase(request.getMethod())) {
            addFault(currentId, uri.toString(), "non disponibile offline: richiesta " + request.getMethod());
            return errorResponse(request.isForMainFrame(), uri.toString());
        }
        try {
            WebResourceResponse saved = read(currentId, uri.toString());
            if (saved != null) return saved;
        } catch (Exception e) {
            addFault(currentId, uri.toString(), "archivio non leggibile");
        }
        addFault(currentId, uri.toString(), "risorsa non archiviata");
        return errorResponse(urls.contains(uri.toString()), uri.toString());
    }

    synchronized Map<String, Object> finishCapture() {
        mode = MODE_NONE;
        snapshotId = null;
        rootHosts = Collections.emptyList();
        rootUrls = Collections.emptyList();
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("capturedResources", capturedResources);
        result.put("capturedBytes", capturedBytes);
        result.put("faults", takeFaults());
        return result;
    }

    synchronized List<Map<String, String>> takeFaults() {
        List<Map<String, String>> result = new ArrayList<>();
        for (WebFault fault : faults.values()) {
            Map<String, String> item = new LinkedHashMap<>();
            item.put("url", fault.url);
            item.put("reason", fault.reason);
            result.add(item);
        }
        faults.clear();
        return result;
    }

    synchronized void clearSnapshot(String id) throws IOException {
        validateId(id);
        deleteRecursively(directory(id));
        storedBytes.remove(id);
    }

    synchronized void clearAll() throws IOException {
        deleteRecursively(root);
        storedBytes.clear();
    }

    synchronized void prune(List<String> validIds) throws IOException {
        if (!root.exists()) return;
        List<File> children = new ArrayList<>();
        File[] files = root.listFiles();
        if (files != null) Collections.addAll(children, files);
        for (File child : children) {
            if (!child.isDirectory() || !validIds.contains(child.getName())) deleteRecursively(child);
        }
        List<String> staleIds = new ArrayList<>();
        for (String id : storedBytes.keySet()) if (!validIds.contains(id)) staleIds.add(id);
        for (String id : staleIds) storedBytes.remove(id);
    }

    private WebResourceResponse fetchAndSave(String id, WebResourceRequest request) throws Exception {
        URL url = new URL(request.getUrl().toString());
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setInstanceFollowRedirects(true);
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(15000);
        connection.setRequestMethod("GET");
        for (Map.Entry<String, String> header : request.getRequestHeaders().entrySet()) {
            String name = header.getKey();
            if (isForwardableHeader(name)) connection.setRequestProperty(name, header.getValue());
        }
        String cookie = CookieManager.getInstance().getCookie(url.toString());
        if (cookie != null && !cookie.isEmpty()) connection.setRequestProperty("Cookie", cookie);

        int status = connection.getResponseCode();
        Map<String, String> headers = responseHeaders(connection);
        List<String> setCookies = connection.getHeaderFields().get("Set-Cookie");
        if (setCookies != null) {
            for (String setCookie : setCookies) CookieManager.getInstance().setCookie(url.toString(), setCookie);
        }
        String contentType = connection.getContentType();
        String mime = contentType == null ? "application/octet-stream" : contentType.split(";", 2)[0].trim();
        String encoding = connection.getContentEncoding();
        if (encoding == null || encoding.isEmpty()) encoding = "UTF-8";
        byte[] body;
        try {
            InputStream source = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            body = source == null ? new byte[0] : readBounded(source);
        } finally {
            connection.disconnect();
        }

        String cacheControl = headers.get("Cache-Control");
        boolean noStore = cacheControl != null && cacheControl.toLowerCase(Locale.ROOT).contains("no-store");
        if (status >= 200 && status < 300 && !noStore) {
            if (save(id, request.getUrl().toString(), mime, encoding, status, headers, body)) {
                synchronized (this) {
                    capturedKeys.add(digest(request.getUrl().toString()));
                    capturedResources = capturedKeys.size();
                    capturedBytes = storedBytes.containsKey(id) ? storedBytes.get(id) : 0L;
                }
            } else {
                addFault(id, request.getUrl().toString(), "limite archivio raggiunto");
            }
        } else {
            addFault(id, request.getUrl().toString(), noStore ? "il sito vieta la memorizzazione (no-store)" : "risposta HTTP " + status);
        }
        return response(mime, encoding, status, headers, body);
    }

    private byte[] readBounded(InputStream source) throws IOException {
        try (InputStream in = source; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = in.read(buffer)) != -1) {
                if (out.size() + count > MAX_RESOURCE_BYTES) throw new IOException("risorsa oltre 12 MB");
                out.write(buffer, 0, count);
            }
            return out.toByteArray();
        }
    }

    private synchronized boolean save(String id, String requestUrl, String mime, String encoding, int status,
                         Map<String, String> headers, byte[] body) throws Exception {
        File dir = directory(id);
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("impossibile creare archivio");

        String key = digest(requestUrl);
        File data = new File(dir, key + ".bin");
        File meta = new File(dir, key + ".properties");
        File dataTmp = new File(dir, key + ".bin.tmp");
        File metaTmp = new File(dir, key + ".properties.tmp");
        long oldBytes = data.isFile() ? data.length() : 0;
        long currentBytes = storedBytes.containsKey(id) ? storedBytes.get(id) : directorySize(dir);
        if (currentBytes - oldBytes + body.length > MAX_SNAPSHOT_BYTES) return false;
        Properties properties = new Properties();
        properties.setProperty("url", requestUrl);
        properties.setProperty("mime", mime);
        properties.setProperty("encoding", encoding);
        properties.setProperty("status", Integer.toString(status));
        properties.setProperty("reason", "OK");
        properties.setProperty("headerCount", Integer.toString(headers.size()));
        int index = 0;
        for (Map.Entry<String, String> header : headers.entrySet()) {
            properties.setProperty("header." + index + ".name", header.getKey());
            properties.setProperty("header." + index + ".value", header.getValue());
            index++;
        }
        try (FileOutputStream out = new FileOutputStream(dataTmp)) { out.write(body); }
        try (FileOutputStream out = new FileOutputStream(metaTmp)) { properties.store(out, null); }
        if (!dataTmp.renameTo(data) || !metaTmp.renameTo(meta)) {
            dataTmp.delete();
            metaTmp.delete();
            throw new IOException("impossibile completare archivio");
        }
        storedBytes.put(id, currentBytes - oldBytes + body.length);
        return true;
    }

    private WebResourceResponse read(String id, String requestUrl) throws Exception {
        File dir = directory(id);
        String key = digest(requestUrl);
        File data = new File(dir, key + ".bin");
        File meta = new File(dir, key + ".properties");
        if (!data.isFile() || !meta.isFile()) return null;

        Properties properties = new Properties();
        try (FileInputStream in = new FileInputStream(meta)) { properties.load(in); }
        Map<String, String> headers = new LinkedHashMap<>();
        int count = Integer.parseInt(properties.getProperty("headerCount", "0"));
        for (int i = 0; i < count; i++) {
            headers.put(properties.getProperty("header." + i + ".name"),
                properties.getProperty("header." + i + ".value"));
        }
        int status = Integer.parseInt(properties.getProperty("status", "200"));
        return new WebResourceResponse(properties.getProperty("mime", "application/octet-stream"),
            properties.getProperty("encoding", "UTF-8"), status,
            properties.getProperty("reason", "OK"), headers, new FileInputStream(data));
    }

    private WebResourceResponse errorResponse(boolean mainFrame, String url) {
        String mime = mainFrame ? "text/html" : "text/plain";
        String body = mainFrame
            ? "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><body style=\"font:16px sans-serif;padding:1em;background:#0f172a;color:#fbbf24\"><b>Contenuto web non archiviato</b><p>Questa risorsa non è disponibile nello snapshot offline.</p></body>"
            : "";
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Cache-Control", "no-store");
        headers.put("X-SkyGuardian-Archive", "miss");
        return new WebResourceResponse(mime, "UTF-8", 504, "Snapshot resource unavailable",
            headers, new ByteArrayInputStream(body.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    }

    private WebResourceResponse response(String mime, String encoding, int status,
                                         Map<String, String> headers, byte[] body) {
        return new WebResourceResponse(mime, encoding, status, "OK", headers, new ByteArrayInputStream(body));
    }

    private Map<String, String> responseHeaders(HttpURLConnection connection) {
        Map<String, String> result = new LinkedHashMap<>();
        String[] allowed = { "Content-Type", "Cache-Control", "Content-Security-Policy",
            "X-Content-Type-Options", "Content-Disposition", "Location", "Access-Control-Allow-Origin",
            "Access-Control-Allow-Credentials", "Access-Control-Allow-Headers",
            "Access-Control-Allow-Methods", "Access-Control-Expose-Headers", "Access-Control-Max-Age", "Vary" };
        for (String name : allowed) {
            String value = connection.getHeaderField(name);
            if (value != null) result.put(name, value);
        }
        return result;
    }

    private boolean isRelated(Uri uri, Map<String, String> requestHeaders, List<String> hosts) {
        String host = lower(uri.getHost());
        if (hosts.contains(host)) return true;
        for (Map.Entry<String, String> header : requestHeaders.entrySet()) {
            if (!"referer".equalsIgnoreCase(header.getKey())) continue;
            if (header.getValue() == null) continue;
            String referrerHost = lower(Uri.parse(header.getValue()).getHost());
            if (hosts.contains(referrerHost)) return true;
        }
        return false;
    }

    private List<String> hostsFrom(List<String> urls) {
        List<String> result = new ArrayList<>();
        for (String value : urls) {
            Uri uri = Uri.parse(value);
            String scheme = uri.getScheme();
            String host = lower(uri.getHost());
            if (host != null && ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))
                && !result.contains(host)) result.add(host);
        }
        return result;
    }

    private boolean isForwardableHeader(String name) {
        return "Accept".equalsIgnoreCase(name) || "Accept-Language".equalsIgnoreCase(name)
            || "Referer".equalsIgnoreCase(name) || "User-Agent".equalsIgnoreCase(name)
            || "Authorization".equalsIgnoreCase(name);
    }

    private synchronized void addFault(String id, String url, String reason) {
        if (faults.size() >= MAX_FAULTS) return;
        faults.put(id + "|" + url, new WebFault(url, reason));
    }

    private File directory(String id) { return new File(root, id); }

    private long directorySize(File dir) {
        File[] files = dir.listFiles();
        if (files == null) return 0;
        long size = 0;
        for (File file : files) size += file.isDirectory() ? directorySize(file) : file.length();
        return size;
    }

    private void validateId(String id) {
        if (id == null || !id.matches("[A-Za-z0-9_-]{1,80}")) throw new IllegalArgumentException("ID snapshot non valido");
    }

    private void deleteRecursively(File file) throws IOException {
        if (!file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteRecursively(child);
        if (!file.delete()) throw new IOException("impossibile eliminare " + file.getName());
    }

    private String digest(String value) throws Exception {
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(value.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        StringBuilder out = new StringBuilder(hash.length * 2);
        for (byte b : hash) out.append(String.format(Locale.ROOT, "%02x", b));
        return out.toString();
    }

    private String lower(String value) { return value == null ? null : value.toLowerCase(Locale.ROOT); }

    private String safeMessage(Exception error) {
        String message = error.getMessage();
        return message == null ? error.getClass().getSimpleName() : message;
    }

    private static final class WebFault {
        final String url;
        final String reason;
        WebFault(String url, String reason) { this.url = url; this.reason = reason; }
    }
}
