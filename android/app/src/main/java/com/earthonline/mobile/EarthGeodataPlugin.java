package com.earthonline.mobile;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.zip.GZIPInputStream;

@CapacitorPlugin(name = "EarthGeodata")
public class EarthGeodataPlugin extends Plugin {
    private static final String ASSET_GZIP_PATH = "geodata/geonames.sqlite.gz";
    private static final String ASSET_SQLITE_PATH = "geodata/geonames.sqlite";
    private static final String ASSET_SIGNATURE_PATH = "geodata/geonames.sqlite.sha256";
    private static final double SEARCH_RADIUS_KM = 80.0;
    private static final int RESULT_LIMIT = 5;
    private static final int FORWARD_RESULT_LIMIT = 3;
    private SQLiteDatabase database;

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject result = new JSObject();
        try {
            SQLiteDatabase db = database();
            result.put("available", db != null && db.isOpen());
            result.put("path", databaseFile().getAbsolutePath());
        } catch (Exception error) {
            result.put("available", false);
            result.put("error", error.getMessage());
        }
        call.resolve(result);
    }

    @PluginMethod
    public void reverseGeocode(PluginCall call) {
        double lat = call.getDouble("lat", Double.NaN);
        double lng = call.getDouble("lng", Double.NaN);
        boolean preferCity = call.getBoolean("preferCity", false);
        JSObject result = new JSObject();
        JSArray candidates = new JSArray();
        if (!isUsableLocation(lat, lng)) {
            result.put("candidates", candidates);
            call.resolve(result);
            return;
        }

        try {
            SQLiteDatabase db = database();
            double latDelta = latitudeDelta(SEARCH_RADIUS_KM);
            double lngDelta = longitudeDelta(SEARCH_RADIUS_KM, lat);
            List<NearbyRow> nearby = new ArrayList<>();
            try (Cursor cursor = db.rawQuery(
                "SELECT * FROM geoname_places WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? LIMIT 800",
                new String[] {
                    String.valueOf(lat - latDelta),
                    String.valueOf(lat + latDelta),
                    String.valueOf(lng - lngDelta),
                    String.valueOf(lng + lngDelta)
                }
            )) {
                while (cursor.moveToNext()) {
                    GeonameRow row = GeonameRow.from(cursor);
                    double distanceKm = haversineKm(lat, lng, row.lat, row.lng);
                    if (distanceKm <= SEARCH_RADIUS_KM) nearby.add(new NearbyRow(row, distanceKm));
                }
            }

            nearby.sort((left, right) -> {
                if (preferCity) {
                    double leftScore = cityLevelScore(left.row, left.distanceKm);
                    double rightScore = cityLevelScore(right.row, right.distanceKm);
                    int compared = Double.compare(rightScore, leftScore);
                    return compared != 0 ? compared : Double.compare(left.distanceKm, right.distanceKm);
                }
                double leftScore = confidenceFor(left.row, left.distanceKm);
                double rightScore = confidenceFor(right.row, right.distanceKm);
                int compared = Double.compare(rightScore, leftScore);
                return compared != 0 ? compared : Double.compare(left.distanceKm, right.distanceKm);
            });

            for (int index = 0; index < Math.min(RESULT_LIMIT, nearby.size()); index += 1) {
                NearbyRow item = nearby.get(index);
                candidates.put(rowToCandidate(item.row, confidenceFor(item.row, item.distanceKm), item.distanceKm, index));
            }
            result.put("candidates", candidates);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    @PluginMethod
    public void nearbyRows(PluginCall call) {
        double lat = call.getDouble("lat", Double.NaN);
        double lng = call.getDouble("lng", Double.NaN);
        double radiusKm = call.getDouble("radiusKm", SEARCH_RADIUS_KM);
        JSObject result = new JSObject();
        JSArray rows = new JSArray();
        if (!isUsableLocation(lat, lng)) {
            result.put("rows", rows);
            call.resolve(result);
            return;
        }

        try {
            SQLiteDatabase db = database();
            double boundedRadiusKm = Math.max(1.0, radiusKm);
            double latDelta = latitudeDelta(boundedRadiusKm);
            double lngDelta = longitudeDelta(boundedRadiusKm, lat);
            try (Cursor cursor = db.rawQuery(
                "SELECT * FROM geoname_places WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? LIMIT 800",
                new String[] {
                    String.valueOf(lat - latDelta),
                    String.valueOf(lat + latDelta),
                    String.valueOf(lng - lngDelta),
                    String.valueOf(lng + lngDelta)
                }
            )) {
                while (cursor.moveToNext()) rows.put(rowToJson(GeonameRow.from(cursor)));
            }
            result.put("rows", rows);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    @PluginMethod
    public void forwardGeocode(PluginCall call) {
        String name = trim(call.getString("name", ""));
        String city = trim(call.getString("city", ""));
        String country = trim(call.getString("country", ""));
        JSObject result = new JSObject();
        JSArray candidates = new JSArray();
        List<String> queries = uniqueNonEmpty(city, name);
        if (queries.isEmpty() && country.isEmpty()) {
            result.put("candidates", candidates);
            call.resolve(result);
            return;
        }

        try {
            SQLiteDatabase db = database();
            List<GeonameRow> rows = new ArrayList<>();
            for (String query : queries) {
                try (Cursor cursor = db.rawQuery(
                    "SELECT * FROM geoname_places WHERE lower(name) = lower(?) OR lower(ascii_name) = lower(?) OR lower(name_en) = lower(?) OR name_zh = ? ORDER BY population DESC LIMIT " + FORWARD_RESULT_LIMIT,
                    new String[] { query, query, query, query }
                )) {
                    while (cursor.moveToNext()) {
                        GeonameRow row = GeonameRow.from(cursor);
                        if (countryMatches(row, country)) rows.add(row);
                    }
                }
            }
            rows.sort(Comparator.comparingInt((GeonameRow row) -> row.population).reversed());
            for (int index = 0; index < Math.min(FORWARD_RESULT_LIMIT, rows.size()); index += 1) {
                candidates.put(rowToCandidate(rows.get(index), index == 0 ? 0.72 : 0.62, null, index));
            }
            result.put("candidates", candidates);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    @PluginMethod
    public void forwardRows(PluginCall call) {
        JSArray queriesInput = call.getArray("queries", new JSArray());
        JSObject result = new JSObject();
        JSArray rows = new JSArray();
        List<String> queries = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (int index = 0; index < queriesInput.length(); index += 1) {
            String query = trim(queriesInput.optString(index, ""));
            if (!query.isEmpty() && seen.add(query)) queries.add(query);
        }

        if (queries.isEmpty()) {
            result.put("rows", rows);
            call.resolve(result);
            return;
        }

        try {
            SQLiteDatabase db = database();
            for (String query : queries) {
                try (Cursor cursor = db.rawQuery(
                    "SELECT * FROM geoname_places WHERE lower(name) = lower(?) OR lower(ascii_name) = lower(?) OR lower(name_en) = lower(?) OR name_zh = ? ORDER BY population DESC LIMIT " + FORWARD_RESULT_LIMIT,
                    new String[] { query, query, query, query }
                )) {
                    while (cursor.moveToNext()) rows.put(rowToJson(GeonameRow.from(cursor)));
                }
            }
            result.put("rows", rows);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    @PluginMethod
    public void countryCapitalPoint(PluginCall call) {
        String country = trim(call.getString("country", ""));
        JSObject result = new JSObject();
        if (country.isEmpty()) {
            call.resolve(result);
            return;
        }
        try {
            SQLiteDatabase db = database();
            List<GeonameRow> rows = new ArrayList<>();
            try (Cursor cursor = db.rawQuery("SELECT * FROM geoname_places WHERE feature_code IN ('PPLC', 'PPLCD')", null)) {
                while (cursor.moveToNext()) {
                    GeonameRow row = GeonameRow.from(cursor);
                    if (countryMatches(row, country)) rows.add(row);
                }
            }
            rows.sort((left, right) -> {
                int leftRank = "PPLC".equals(left.featureCode) ? 0 : 1;
                int rightRank = "PPLC".equals(right.featureCode) ? 0 : 1;
                int compared = Integer.compare(leftRank, rightRank);
                return compared != 0 ? compared : Integer.compare(right.population, left.population);
            });
            if (!rows.isEmpty()) {
                JSObject point = new JSObject();
                point.put("lat", rows.get(0).lat);
                point.put("lng", rows.get(0).lng);
                result.put("point", point);
            }
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    @PluginMethod
    public void capitalRows(PluginCall call) {
        JSObject result = new JSObject();
        JSArray rows = new JSArray();
        try {
            SQLiteDatabase db = database();
            try (Cursor cursor = db.rawQuery("SELECT * FROM geoname_places WHERE feature_code IN ('PPLC', 'PPLCD')", null)) {
                while (cursor.moveToNext()) rows.put(rowToJson(GeonameRow.from(cursor)));
            }
            result.put("rows", rows);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    private SQLiteDatabase database() throws IOException {
        if (database != null && database.isOpen()) return database;
        File dbFile = databaseFile();
        String assetSignature = packagedDatabaseSignature();
        if (!dbFile.exists() || dbFile.length() == 0 || isInstalledDatabaseStale(assetSignature)) installDatabase(dbFile, assetSignature);
        database = SQLiteDatabase.openDatabase(dbFile.getAbsolutePath(), null, SQLiteDatabase.OPEN_READONLY);
        return database;
    }

    private File databaseFile() {
        return new File(new File(getContext().getFilesDir(), "geodata"), "geonames.sqlite");
    }

    private File databaseSignatureFile() {
        return new File(databaseFile().getAbsolutePath() + ".sha256");
    }

    private boolean isInstalledDatabaseStale(String assetSignature) {
        if (assetSignature == null || assetSignature.isEmpty()) return false;
        String installedSignature = readTextFile(databaseSignatureFile());
        return !assetSignature.equals(installedSignature);
    }

    private void installDatabase(File dbFile, String assetSignature) throws IOException {
        File dir = dbFile.getParentFile();
        if (dir != null && !dir.exists()) dir.mkdirs();
        File tmp = new File(dbFile.getAbsolutePath() + ".tmp");
        try (InputStream input = openPackagedDatabaseAsset(); FileOutputStream output = new FileOutputStream(tmp)) {
            byte[] buffer = new byte[1024 * 64];
            int read;
            while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
        }
        if (dbFile.exists() && !dbFile.delete()) throw new IOException("Unable to replace old GeoNames database");
        if (!tmp.renameTo(dbFile)) throw new IOException("Unable to install GeoNames database");
        if (assetSignature != null && !assetSignature.isEmpty()) writeTextFile(databaseSignatureFile(), assetSignature);
    }

    private InputStream openPackagedDatabaseAsset() throws IOException {
        try {
            return new GZIPInputStream(getContext().getAssets().open(ASSET_GZIP_PATH));
        } catch (IOException gzipError) {
            return getContext().getAssets().open(ASSET_SQLITE_PATH);
        }
    }

    private String packagedDatabaseSignature() {
        try (InputStream input = getContext().getAssets().open(ASSET_SIGNATURE_PATH)) {
            return readStreamText(input).trim();
        } catch (IOException error) {
            return null;
        }
    }

    private String readTextFile(File file) {
        if (!file.exists()) return null;
        try (InputStream input = new java.io.FileInputStream(file)) {
            return readStreamText(input).trim();
        } catch (IOException error) {
            return null;
        }
    }

    private void writeTextFile(File file, String text) throws IOException {
        File dir = file.getParentFile();
        if (dir != null && !dir.exists()) dir.mkdirs();
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(text.getBytes(StandardCharsets.UTF_8));
        }
    }

    private String readStreamText(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[1024];
        int read;
        while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
        return output.toString(StandardCharsets.UTF_8.name());
    }

    private JSObject rowToCandidate(GeonameRow row, double confidence, Double distanceKm, int index) {
        String zh = localizedName(row);
        String en = firstNonEmpty(row.nameEn, row.asciiName, row.name);
        String countryCode = normalizedCountryCode(row.countryCode);
        String local = "CN".equals(countryCode) ? zh : firstNonEmpty(row.name, row.asciiName, en);
        String countryZh = firstNonEmpty(row.countryNameZh, row.countryNameEn, row.countryName, row.countryCode);
        String countryEn = firstNonEmpty(row.countryNameEn, row.countryName, countryZh);

        JSObject point = new JSObject();
        point.put("lat", row.lat);
        point.put("lng", row.lng);

        JSObject names = new JSObject();
        names.put("zh", zh);
        names.put("en", en);
        names.put("local", local);

        JSObject countryNames = new JSObject();
        countryNames.put("zh", countryZh);
        countryNames.put("en", countryEn);
        countryNames.put("local", firstNonEmpty(row.countryName, countryEn));

        JSObject candidate = new JSObject();
        candidate.put("id", "candidate-geocode-" + row.geonameId);
        candidate.put("name", zh);
        candidate.put("localizedNames", names);
        candidate.put("country", countryZh);
        candidate.put("localizedCountryNames", countryNames);
        candidate.put("city", zh);
        candidate.put("localizedCityNames", names);
        candidate.put("point", point);
        candidate.put("confidence", round(confidence, 3));
        candidate.put("source", "geocode");
        candidate.put("precision", "estimated");
        candidate.put("reason", distanceKm == null ? "GeoNames locality matched by name." : "GeoNames nearest locality, " + round(distanceKm, 1) + "km, " + row.featureCode);
        candidate.put("admin1", emptyToNull(row.admin1Name));
        candidate.put("admin2", emptyToNull(row.admin2Name));
        candidate.put("countryCode", countryCode);
        candidate.put("featureCode", row.featureCode);
        candidate.put("featureLabel", emptyToNull(row.featureLabel));
        candidate.put("geocodeRank", index + 1);
        candidate.put("population", row.population);
        if (distanceKm != null) candidate.put("distanceKm", round(distanceKm, 3));
        return candidate;
    }

    private JSObject rowToJson(GeonameRow row) {
        JSObject object = new JSObject();
        object.put("geoname_id", row.geonameId);
        object.put("name", row.name);
        object.put("ascii_name", row.asciiName);
        object.put("lat", row.lat);
        object.put("lng", row.lng);
        object.put("country_code", normalizedCountryCode(row.countryCode));
        object.put("country_name", row.countryName);
        object.put("country_name_zh", row.countryNameZh);
        object.put("country_name_en", row.countryNameEn);
        object.put("admin1_name", row.admin1Name);
        object.put("admin2_name", row.admin2Name);
        object.put("feature_code", row.featureCode);
        object.put("feature_label", row.featureLabel);
        object.put("name_zh", row.nameZh);
        object.put("name_en", row.nameEn);
        object.put("population", row.population);
        return object;
    }

    private String localizedName(GeonameRow row) {
        return firstNonEmpty(row.nameZh, row.name, row.asciiName, row.nameEn);
    }

    private double confidenceFor(GeonameRow row, double distanceKm) {
        double distanceScore = Math.max(0, 1 - distanceKm / SEARCH_RADIUS_KM) * 0.66;
        double populationScore = Math.min(0.14, Math.log10(Math.max(1, row.population)) / 45.0);
        return Math.max(0.35, Math.min(0.96, 0.22 + distanceScore + featureWeight(row.featureCode) + populationScore));
    }

    private double featureWeight(String code) {
        if ("PPLC".equals(code)) return 0.16;
        if ("PPLA".equals(code)) return 0.14;
        if ("PPLA2".equals(code)) return 0.12;
        if ("PPLA3".equals(code)) return 0.10;
        if ("PPLA4".equals(code)) return 0.08;
        if ("PPL".equals(code)) return 0.05;
        if ("PPLX".equals(code)) return -0.06;
        return 0;
    }

    private double cityLevelScore(GeonameRow row, double distanceKm) {
        double populationScore = Math.min(1.4, Math.log10(Math.max(1, row.population)) / 4.0);
        double distancePenalty = (distanceKm / SEARCH_RADIUS_KM) * 2.0;
        return cityLevelRank(row) + populationScore - distancePenalty;
    }

    private int cityLevelRank(GeonameRow row) {
        if ("PPLC".equals(row.featureCode)) return 6;
        if ("PPLA".equals(row.featureCode)) return 5;
        if ("PPLA2".equals(row.featureCode)) return 4;
        if ("PPLA3".equals(row.featureCode)) return 3;
        if ("PPLA4".equals(row.featureCode)) return 2;
        if (row.population >= 100000) return 3;
        if (row.population >= 50000) return 2;
        if (row.population >= 20000) return 1;
        return 0;
    }

    private boolean countryMatches(GeonameRow row, String country) {
        Set<String> expected = countryAliases(country);
        if (expected.isEmpty()) return true;
        for (String value : new String[] { row.countryNameZh, row.countryNameEn, row.countryName, row.countryCode }) {
            for (String alias : countryAliases(value)) {
                if (expected.contains(alias)) return true;
            }
        }
        return false;
    }

    private Set<String> countryAliases(String value) {
        Set<String> aliases = new HashSet<>();
        String normalized = normalizedText(value);
        if (normalized.isEmpty()) return aliases;
        aliases.add(normalized);
        if (normalized.equals("china") || normalized.equals("cn") || normalized.equals("中国")
            || normalized.equals("hongkong") || normalized.equals("hk") || normalized.equals("香港")
            || normalized.equals("macao") || normalized.equals("macau") || normalized.equals("mo") || normalized.equals("澳门")
            || normalized.equals("taiwan") || normalized.equals("tw") || normalized.equals("台湾") || normalized.equals("臺灣")) {
            aliases.add("china");
            aliases.add("cn");
            aliases.add("中国");
        }
        return aliases;
    }

    private String normalizedCountryCode(String countryCode) {
        String normalized = normalizedText(countryCode);
        if (normalized.equals("hk") || normalized.equals("mo") || normalized.equals("tw")) return "CN";
        return countryCode;
    }

    private static boolean isUsableLocation(double lat, double lng) {
        return !Double.isNaN(lat) && !Double.isNaN(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    }

    private static double longitudeDelta(double radiusKm, double lat) {
        double cos = Math.max(0.08, Math.cos(Math.toRadians(lat)));
        return radiusKm / (111.32 * cos);
    }

    private static double latitudeDelta(double radiusKm) {
        return radiusKm / 110.574;
    }

    private static double haversineKm(double lat1, double lng1, double lat2, double lng2) {
        double radius = 6371.0088;
        double dLat = Math.toRadians(lat2 - lat1);
        double dLng = Math.toRadians(lng2 - lng1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
            + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2))
            * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return 2 * radius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    private static String normalizedText(String value) {
        String text = value == null ? "" : Normalizer.normalize(value, Normalizer.Form.NFKC).trim().toLowerCase(Locale.ROOT);
        return text.replaceAll("[\\s_\\-.'’`]+", "");
    }

    private static String trim(String value) {
        return value == null ? "" : value.trim();
    }

    private static List<String> uniqueNonEmpty(String... values) {
        List<String> output = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (String value : values) {
            String trimmed = trim(value);
            if (!trimmed.isEmpty() && seen.add(trimmed)) output.add(trimmed);
        }
        return output;
    }

    private static String firstNonEmpty(String... values) {
        for (String value : values) {
            if (value != null && !value.trim().isEmpty()) return value;
        }
        return "";
    }

    private static Object emptyToNull(String value) {
        return value == null || value.trim().isEmpty() ? null : value;
    }

    private static double round(double value, int digits) {
        double factor = Math.pow(10, digits);
        return Math.round(value * factor) / factor;
    }

    private static class NearbyRow {
        final GeonameRow row;
        final double distanceKm;

        NearbyRow(GeonameRow row, double distanceKm) {
            this.row = row;
            this.distanceKm = distanceKm;
        }
    }

    private static class GeonameRow {
        String geonameId;
        String name;
        String asciiName;
        double lat;
        double lng;
        String countryCode;
        String countryName;
        String countryNameZh;
        String countryNameEn;
        String admin1Name;
        String admin2Name;
        String featureCode;
        String featureLabel;
        String nameZh;
        String nameEn;
        int population;

        static GeonameRow from(Cursor cursor) {
            GeonameRow row = new GeonameRow();
            row.geonameId = string(cursor, "geoname_id");
            row.name = string(cursor, "name");
            row.asciiName = string(cursor, "ascii_name");
            row.lat = number(cursor, "lat");
            row.lng = number(cursor, "lng");
            row.countryCode = string(cursor, "country_code");
            row.countryName = string(cursor, "country_name");
            row.countryNameZh = string(cursor, "country_name_zh");
            row.countryNameEn = string(cursor, "country_name_en");
            row.admin1Name = string(cursor, "admin1_name");
            row.admin2Name = string(cursor, "admin2_name");
            row.featureCode = string(cursor, "feature_code");
            row.featureLabel = string(cursor, "feature_label");
            row.nameZh = string(cursor, "name_zh");
            row.nameEn = string(cursor, "name_en");
            row.population = (int) number(cursor, "population");
            return row;
        }

        private static String string(Cursor cursor, String name) {
            int index = cursor.getColumnIndex(name);
            return index >= 0 && !cursor.isNull(index) ? cursor.getString(index) : "";
        }

        private static double number(Cursor cursor, String name) {
            int index = cursor.getColumnIndex(name);
            return index >= 0 && !cursor.isNull(index) ? cursor.getDouble(index) : 0;
        }
    }
}
