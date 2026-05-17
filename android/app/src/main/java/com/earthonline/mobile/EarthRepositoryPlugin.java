package com.earthonline.mobile;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

@CapacitorPlugin(name = "EarthRepository")
public class EarthRepositoryPlugin extends Plugin {
    private static final LinkedHashMap<String, String> TABLES = new LinkedHashMap<>();

    static {
        TABLES.put("trips", "trips");
        TABLES.put("photos", "photos");
        TABLES.put("placeNodes", "place_nodes");
        TABLES.put("routes", "routes");
        TABLES.put("importBatches", "import_batches");
        TABLES.put("pendingItems", "pending_items");
    }

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
    public void readState(PluginCall call) {
        try {
            SQLiteDatabase db = database();
            JSObject state = new JSObject();
            for (Map.Entry<String, String> entry : TABLES.entrySet()) {
                state.put(entry.getKey(), readPayloadTable(db, entry.getValue()));
            }
            call.resolve(state);
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    @PluginMethod
    public void writeState(PluginCall call) {
        JSObject state = call.getObject("state", new JSObject());
        try {
            SQLiteDatabase db = database();
            db.beginTransaction();
            try {
                for (Map.Entry<String, String> entry : TABLES.entrySet()) {
                    writePayloadTable(db, entry.getValue(), state.optJSONArray(entry.getKey()));
                }
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
            JSObject result = new JSObject();
            result.put("ok", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    @PluginMethod
    public void readVectorIndex(PluginCall call) {
        try {
            SQLiteDatabase db = database();
            JSObject vectors = new JSObject();
            try (Cursor cursor = db.rawQuery("SELECT photo_id, payload FROM vector_index ORDER BY photo_id", null)) {
                while (cursor.moveToNext()) {
                    String photoId = cursor.getString(0);
                    String payload = cursor.getString(1);
                    vectors.put(photoId, new JSONArray(payload));
                }
            }
            JSObject result = new JSObject();
            result.put("index", vectors);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    @PluginMethod
    public void getImportJob(PluginCall call) {
        String id = call.getString("id", "");
        if (id == null || id.isEmpty()) {
            call.reject("id is required");
            return;
        }
        try {
            SQLiteDatabase db = database();
            JSObject result = new JSObject();
            try (Cursor cursor = db.rawQuery("SELECT payload FROM import_jobs WHERE id = ?", new String[] { id })) {
                if (cursor.moveToNext()) result.put("job", new JSONObject(cursor.getString(0)));
            }
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    @PluginMethod
    public void saveImportJob(PluginCall call) {
        JSObject job = call.getObject("job");
        if (job == null) {
            call.reject("job is required");
            return;
        }
        String id = job.optString("id", "");
        if (id.isEmpty()) {
            call.reject("job.id is required");
            return;
        }
        try {
            SQLiteDatabase db = database();
            db.execSQL(
                "INSERT OR REPLACE INTO import_jobs(id, payload, updated_at) VALUES(?, ?, CURRENT_TIMESTAMP)",
                new Object[] { id, job.toString() }
            );
            JSObject result = new JSObject();
            result.put("ok", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    @PluginMethod
    public void writeVectorIndex(PluginCall call) {
        JSObject index = call.getObject("index", new JSObject());
        try {
            SQLiteDatabase db = database();
            db.beginTransaction();
            try {
                db.execSQL("DELETE FROM vector_index");
                Iterator<String> keys = index.keys();
                while (keys.hasNext()) {
                    String photoId = keys.next();
                    Object value = index.opt(photoId);
                    if (!(value instanceof JSONArray)) continue;
                    db.execSQL(
                        "INSERT OR REPLACE INTO vector_index(photo_id, payload, updated_at) VALUES(?, ?, CURRENT_TIMESTAMP)",
                        new Object[] { photoId, value.toString() }
                    );
                }
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
            JSObject result = new JSObject();
            result.put("ok", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    @PluginMethod
    public void deleteVectors(PluginCall call) {
        JSArray photoIds = call.getArray("photoIds", new JSArray());
        try {
            SQLiteDatabase db = database();
            db.beginTransaction();
            try {
                for (int index = 0; index < photoIds.length(); index += 1) {
                    String photoId = photoIds.optString(index, "");
                    if (!photoId.isEmpty()) db.execSQL("DELETE FROM vector_index WHERE photo_id = ?", new Object[] { photoId });
                }
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
            JSObject result = new JSObject();
            result.put("ok", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    private SQLiteDatabase database() {
        if (database != null && database.isOpen()) return database;
        File file = databaseFile();
        File dir = file.getParentFile();
        if (dir != null && !dir.exists()) dir.mkdirs();
        database = SQLiteDatabase.openOrCreateDatabase(file, null);
        ensureSchema(database);
        return database;
    }

    private File databaseFile() {
        return new File(getContext().getFilesDir(), "earth-online.sqlite");
    }

    private void ensureSchema(SQLiteDatabase db) {
        db.execSQL("PRAGMA foreign_keys = ON");
        db.execSQL("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        for (String table : TABLES.values()) {
            db.execSQL("CREATE TABLE IF NOT EXISTS " + table + " (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
        }
        db.execSQL("CREATE TABLE IF NOT EXISTS import_jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
        db.execSQL("CREATE TABLE IF NOT EXISTS vector_index (photo_id TEXT PRIMARY KEY, payload TEXT NOT NULL, metadata TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
        db.execSQL("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', '1')");
    }

    private JSArray readPayloadTable(SQLiteDatabase db, String table) throws JSONException {
        JSArray values = new JSArray();
        try (Cursor cursor = db.rawQuery("SELECT payload FROM " + table + " ORDER BY id", null)) {
            while (cursor.moveToNext()) values.put(new JSONObject(cursor.getString(0)));
        }
        return values;
    }

    private void writePayloadTable(SQLiteDatabase db, String table, JSONArray values) {
        db.execSQL("DELETE FROM " + table);
        if (values == null) return;
        for (int index = 0; index < values.length(); index += 1) {
            JSONObject item = values.optJSONObject(index);
            if (item == null) continue;
            String id = item.optString("id", "");
            if (id.isEmpty()) id = table + "-" + index;
            db.execSQL(
                "INSERT OR REPLACE INTO " + table + "(id, payload, updated_at) VALUES(?, ?, CURRENT_TIMESTAMP)",
                new Object[] { id, item.toString() }
            );
        }
    }
}
