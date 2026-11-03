package it.skyguardian.wear;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private static final int LOCATION_PERMISSION_REQUEST = 1;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private TextView statusView;
    private TextView weatherView;
    private TextView detailsView;
    private TextView sunView;
    private Button mapButton;
    private Location currentLocation;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildScreen();
        refresh();
    }

    @Override
    protected void onDestroy() {
        executor.shutdownNow();
        super.onDestroy();
    }

    private void buildScreen() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(0xFF080B12);

        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setGravity(Gravity.CENTER_HORIZONTAL);
        int sidePadding = dp(26);
        content.setPadding(sidePadding, dp(22), sidePadding, dp(24));
        scroll.addView(content);

        TextView title = text("SKYGUARDIAN", 12, 0xFF77BFFF, true);
        title.setGravity(Gravity.CENTER);
        content.addView(title, matchWrap());

        weatherView = text("--°", 42, 0xFFFFFFFF, true);
        weatherView.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams weatherParams = matchWrap();
        weatherParams.topMargin = dp(10);
        content.addView(weatherView, weatherParams);

        detailsView = text("Meteo in attesa della posizione", 14, 0xFFD4D9E2, false);
        detailsView.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams detailsParams = matchWrap();
        detailsParams.topMargin = dp(5);
        content.addView(detailsView, detailsParams);

        sunView = text("Alba --:--  ·  Tramonto --:--", 13, 0xFFFFD68A, false);
        sunView.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams sunParams = matchWrap();
        sunParams.topMargin = dp(16);
        content.addView(sunView, sunParams);

        statusView = text("In attesa della posizione…", 12, 0xFF9AA5B5, false);
        statusView.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams statusParams = matchWrap();
        statusParams.topMargin = dp(16);
        content.addView(statusView, statusParams);

        Button refreshButton = new Button(this);
        refreshButton.setText("Aggiorna");
        refreshButton.setOnClickListener(v -> refresh());
        LinearLayout.LayoutParams buttonParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        buttonParams.topMargin = dp(12);
        content.addView(refreshButton, buttonParams);

        mapButton = new Button(this);
        mapButton.setText("Apri mappa");
        mapButton.setEnabled(false);
        mapButton.setOnClickListener(v -> openMap());
        LinearLayout.LayoutParams mapParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        mapParams.topMargin = dp(4);
        content.addView(mapButton, mapParams);

        setContentView(scroll);
    }

    private void refresh() {
        if (!hasLocationPermission()) {
            statusView.setText("Consenti la posizione per iniziare");
            requestPermissions(new String[] {
                    Manifest.permission.ACCESS_COARSE_LOCATION,
                    Manifest.permission.ACCESS_FINE_LOCATION
            }, LOCATION_PERMISSION_REQUEST);
            return;
        }

        statusView.setText("Ricerca della posizione…");
        LocationManager locationManager = (LocationManager) getSystemService(LOCATION_SERVICE);
        if (locationManager == null) {
            statusView.setText("Servizio di localizzazione non disponibile");
            return;
        }

        Location lastKnown = findLastKnownLocation(locationManager);
        if (lastKnown != null) {
            onLocationFound(lastKnown);
        }

        String provider = locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
                ? LocationManager.NETWORK_PROVIDER : LocationManager.GPS_PROVIDER;
        try {
            locationManager.getCurrentLocation(provider, new CancellationSignal(), getMainExecutor(),
                    location -> {
                        if (location != null) {
                            onLocationFound(location);
                        } else if (currentLocation == null) {
                            statusView.setText("Posizione non disponibile. Riprova all'aperto.");
                        }
                    });
        } catch (SecurityException e) {
            statusView.setText("Permesso di posizione non disponibile");
        } catch (IllegalArgumentException e) {
            statusView.setText("Sensore di posizione non disponibile");
        }
    }

    private Location findLastKnownLocation(LocationManager manager) {
        Location best = null;
        for (String provider : manager.getProviders(true)) {
            Location candidate = manager.getLastKnownLocation(provider);
            if (candidate != null && (best == null
                    || candidate.getTime() > best.getTime())) {
                best = candidate;
            }
        }
        return best;
    }

    private void onLocationFound(Location location) {
        currentLocation = location;
        mapButton.setEnabled(true);
        statusView.setText("Aggiornamento meteo…");
        fetchWeather(location);
    }

    private void fetchWeather(Location location) {
        executor.execute(() -> {
            try {
                String url = String.format(Locale.US,
                        "https://api.open-meteo.com/v1/forecast?latitude=%.5f&longitude=%.5f"
                                + "&current=temperature_2m,relative_humidity_2m,apparent_temperature,"
                                + "weather_code,wind_speed_10m&daily=sunrise,sunset&timezone=auto&forecast_days=1",
                        location.getLatitude(), location.getLongitude());
                JSONObject response = new JSONObject(readUrl(url));
                JSONObject current = response.getJSONObject("current");
                JSONObject daily = response.getJSONObject("daily");
                JSONArray sunrises = daily.getJSONArray("sunrise");
                JSONArray sunsets = daily.getJSONArray("sunset");
                String description = weatherDescription(current.getInt("weather_code"));
                String details = String.format(Locale.ITALY, "%s\nPercepiti %.0f° · Umidità %d%%\nVento %.0f km/h",
                        description,
                        current.getDouble("apparent_temperature"),
                        current.getInt("relative_humidity_2m"),
                        current.getDouble("wind_speed_10m"));
                String sun = "Alba " + timeOnly(sunrises.getString(0))
                        + "  ·  Tramonto " + timeOnly(sunsets.getString(0));
                String temp = String.format(Locale.ITALY, "%.0f°",
                        current.getDouble("temperature_2m"));
                runOnUiThread(() -> {
                    weatherView.setText(temp);
                    detailsView.setText(details);
                    sunView.setText(sun);
                    statusView.setText(String.format(Locale.ITALY, "Posizione %.2f, %.2f",
                            location.getLatitude(), location.getLongitude()));
                });
            } catch (IOException | JSONException e) {
                runOnUiThread(() -> statusView.setText("Meteo non disponibile: " + e.getMessage()));
            }
        });
    }

    private String readUrl(String address) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        connection.setConnectTimeout(12000);
        connection.setReadTimeout(12000);
        connection.setRequestMethod("GET");
        try {
            int responseCode = connection.getResponseCode();
            InputStream stream = responseCode >= 200 && responseCode < 300
                    ? connection.getInputStream() : connection.getErrorStream();
            if (responseCode < 200 || responseCode >= 300) {
                throw new IOException("servizio meteo HTTP " + responseCode);
            }
            StringBuilder body = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    body.append(line);
                }
            }
            return body.toString();
        } finally {
            connection.disconnect();
        }
    }

    private void openMap() {
        if (currentLocation == null) return;
        Uri uri = Uri.parse(String.format(Locale.US, "geo:%.6f,%.6f?q=%.6f,%.6f",
                currentLocation.getLatitude(), currentLocation.getLongitude(),
                currentLocation.getLatitude(), currentLocation.getLongitude()));
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (android.content.ActivityNotFoundException e) {
            statusView.setText("Nessuna app mappe installata sul watch");
        }
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
                == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == LOCATION_PERMISSION_REQUEST) {
            if (hasLocationPermission()) {
                refresh();
            } else {
                statusView.setText("Permesso negato: abilita la posizione nelle impostazioni");
            }
        }
    }

    private static String timeOnly(String dateTime) {
        int separator = dateTime.indexOf('T');
        return separator >= 0 && dateTime.length() >= separator + 6
                ? dateTime.substring(separator + 1, separator + 6) : dateTime;
    }

    private static String weatherDescription(int code) {
        switch (code) {
            case 0: return "Sereno";
            case 1: return "Prevalentemente sereno";
            case 2: return "Parzialmente nuvoloso";
            case 3: return "Coperto";
            case 45: case 48: return "Nebbia";
            case 51: case 53: case 55: return "Pioviggine";
            case 56: case 57: return "Pioviggine gelata";
            case 61: case 63: case 65: return "Pioggia";
            case 66: case 67: return "Pioggia gelata";
            case 71: case 73: case 75: case 77: return "Neve";
            case 80: case 81: case 82: return "Rovesci";
            case 85: case 86: return "Rovesci di neve";
            case 95: case 96: case 99: return "Temporale";
            default: return "Condizioni meteo";
        }
    }

    private TextView text(String value, int sizeSp, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(sizeSp);
        view.setTextColor(color);
        if (bold) view.setTypeface(null, android.graphics.Typeface.BOLD);
        return view;
    }

    private LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
