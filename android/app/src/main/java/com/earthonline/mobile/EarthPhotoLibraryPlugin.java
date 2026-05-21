package com.earthonline.mobile;

import android.app.Activity;
import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.BitmapFactory;
import android.media.ExifInterface;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

@CapacitorPlugin(
    name = "EarthPhotoLibrary",
    permissions = {
        @Permission(strings = { Manifest.permission.ACCESS_MEDIA_LOCATION }, alias = "mediaLocation")
    }
)
public class EarthPhotoLibraryPlugin extends Plugin {
    private static final String TAG = "EarthPhotoLibrary";
    private static final int DEFAULT_PICK_LIMIT = 80;
    private static final String DEFAULT_MIME_TYPE = "image/jpeg";
    private static final String LOCAL_PHOTO_DIR = "picked_photos";

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", true);
        result.put("platform", "android");
        result.put("maxSelection", maxPhotoPickerSelection());
        call.resolve(result);
    }

    @PluginMethod
    public void pickPhotos(PluginCall call) {
        PermissionState mediaLocationState = getPermissionState("mediaLocation");
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
            (mediaLocationState == PermissionState.PROMPT || mediaLocationState == PermissionState.PROMPT_WITH_RATIONALE)
        ) {
            requestPermissionForAlias("mediaLocation", call, "mediaLocationPermissionCallback");
            return;
        }
        launchPhotoPicker(call);
    }

    @PermissionCallback
    private void mediaLocationPermissionCallback(PluginCall call) {
        launchPhotoPicker(call);
    }

    private void launchPhotoPicker(PluginCall call) {
        launchDocumentPhotoPicker(call);
    }

    private void launchSystemPhotoPicker(PluginCall call) {
        int limit = pickerLimit(call);
        Intent intent = new Intent(MediaStore.ACTION_PICK_IMAGES);
        intent.setType("image/*");
        if (limit > 1) {
            intent.putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, limit);
        }
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            startActivityForResult(call, intent, "pickPhotosResult");
        } catch (ActivityNotFoundException error) {
            Log.w(TAG, "System photo picker unavailable; falling back to document picker.", error);
            launchDocumentPhotoPicker(call);
        }
    }

    private void launchDocumentPhotoPicker(PluginCall call) {
        int limit = pickerLimit(call);
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("image/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, limit > 1);

        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        startActivityForResult(call, intent, "pickPhotosResult");
    }

    private int pickerLimit(PluginCall call) {
        int requestedLimit = call.getInt("limit", DEFAULT_PICK_LIMIT);
        int maxLimit = maxPhotoPickerSelection();
        return Math.max(1, Math.min(requestedLimit, maxLimit));
    }

    @PluginMethod
    public void releasePersistedPermissions(PluginCall call) {
        JSArray uriArray = call.getArray("uris", new JSArray());
        int released = 0;
        ContentResolver resolver = getContext().getContentResolver();
        for (int i = 0; i < uriArray.length(); i += 1) {
            String uriValue = uriArray.optString(i, "");
            if (uriValue.isEmpty()) continue;
            try {
                resolver.releasePersistableUriPermission(Uri.parse(uriValue), Intent.FLAG_GRANT_READ_URI_PERMISSION);
                released += 1;
            } catch (SecurityException | IllegalArgumentException ignored) {
                // URI may already be released, may not be persistable, or may belong to the photo picker grant set.
            }
            if (deleteLocalCopyIfOwned(Uri.parse(uriValue))) released += 1;
        }
        JSObject result = new JSObject();
        result.put("released", released);
        call.resolve(result);
    }

    @PluginMethod
    public void preparePhoto(PluginCall call) {
        String uriValue = call.getString("uri", "");
        if (uriValue.isEmpty()) {
            call.reject("Missing photo URI");
            return;
        }
        execute(() -> {
            try {
                call.resolve(describePreparedAsset(Uri.parse(uriValue)));
            } catch (Exception error) {
                call.reject(error.getMessage() == null ? "Unable to prepare selected photo" : error.getMessage(), error);
            }
        });
    }

    @ActivityCallback
    private void pickPhotosResult(PluginCall call, androidx.activity.result.ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            Log.w(TAG, "Photo picker returned without data. resultCode=" + result.getResultCode());
            JSObject empty = new JSObject();
            empty.put("photos", new JSArray());
            call.resolve(empty);
            return;
        }

        Intent data = result.getData();
        List<Uri> uris = collectResultUris(data);
        if (uris.isEmpty()) Log.w(TAG, "Photo picker returned OK but no URI was present.");
        execute(() -> resolvePickedPhotos(call, uris));
    }

    private void resolvePickedPhotos(PluginCall call, List<Uri> uris) {
        JSArray photos = new JSArray();
        for (Uri uri : uris) {
            try {
                JSObject asset = describePickedAsset(uri);
                photos.put(asset);
            } catch (Exception error) {
                JSObject failed = new JSObject();
                failed.put("uri", uri.toString());
                failed.put("fileName", fallbackFileName(uri));
                failed.put("mimeType", DEFAULT_MIME_TYPE);
                failed.put("error", error.getMessage() == null ? "Unable to read selected photo" : error.getMessage());
                photos.put(failed);
            }
        }
        JSObject response = new JSObject();
        response.put("photos", photos);
        call.resolve(response);
    }

    private JSObject describePickedAsset(Uri uri) {
        ContentResolver resolver = getContext().getContentResolver();
        QueryMetadata query = queryMetadata(resolver, uri);
        boolean persisted = persistReadPermission(resolver, uri);

        JSObject asset = new JSObject();
        asset.put("uri", uri.toString());
        asset.put("fileName", query.displayName == null ? fallbackFileName(uri) : query.displayName);
        String mimeType = query.mimeType == null ? resolver.getType(uri) : query.mimeType;
        asset.put("mimeType", mimeType == null ? DEFAULT_MIME_TYPE : mimeType);
        if (query.size != null) asset.put("size", query.size);
        if (query.lastModified != null) asset.put("lastModified", query.lastModified);
        asset.put("persisted", persisted);
        return asset;
    }

    private JSObject describePreparedAsset(Uri uri) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        QueryMetadata query = queryMetadata(resolver, uri);
        boolean persisted = persistReadPermission(resolver, uri);
        HashResult hash = hashUriWithOriginalFallback(resolver, uri);
        ExifMetadata exif = readExif(resolver, uri);
        BitmapMetadata bitmap = readBitmapMetadata(resolver, uri);

        JSObject asset = new JSObject();
        asset.put("uri", uri.toString());
        String localUrl = getBridge().getLocalUrl();
        if (localUrl != null) {
            asset.put("webPath", webPathForUri(localUrl, uri));
        }
        asset.put("fileName", query.displayName == null ? fallbackFileName(uri) : query.displayName);
        String mimeType = query.mimeType == null ? resolver.getType(uri) : query.mimeType;
        asset.put("mimeType", mimeType == null ? DEFAULT_MIME_TYPE : mimeType);
        asset.put("size", query.size == null ? hash.size : query.size);
        if (query.lastModified != null) asset.put("lastModified", query.lastModified);
        if (bitmap.width > 0) asset.put("width", bitmap.width);
        if (bitmap.height > 0) asset.put("height", bitmap.height);
        if (exif.capturedAt != null) asset.put("capturedAt", exif.capturedAt);
        if (exif.latitude != null) asset.put("latitude", exif.latitude);
        if (exif.longitude != null) asset.put("longitude", exif.longitude);
        if (hash.sha256 != null) asset.put("sha256", hash.sha256);
        asset.put("persisted", persisted);
        return asset;
    }

    private List<Uri> collectResultUris(Intent data) {
        ArrayList<Uri> uris = new ArrayList<>();
        ClipData clipData = data.getClipData();
        if (clipData != null) {
            for (int index = 0; index < clipData.getItemCount(); index += 1) {
                Uri uri = clipData.getItemAt(index).getUri();
                if (uri != null) uris.add(uri);
            }
        }
        Uri single = data.getData();
        if (single != null && !uris.contains(single)) uris.add(single);
        return uris;
    }

    private int maxPhotoPickerSelection() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return Math.max(1, MediaStore.getPickImagesMaxLimit());
        }
        return DEFAULT_PICK_LIMIT;
    }

    private QueryMetadata queryMetadata(ContentResolver resolver, Uri uri) {
        QueryMetadata metadata = new QueryMetadata();
        String[] projection = new String[] {
            OpenableColumns.DISPLAY_NAME,
            OpenableColumns.SIZE,
            MediaStore.MediaColumns.MIME_TYPE,
            MediaStore.MediaColumns.DATE_MODIFIED
        };
        try (Cursor cursor = resolver.query(uri, projection, null, null, null)) {
            if (cursor == null || !cursor.moveToFirst()) return metadata;
            metadata.displayName = stringColumn(cursor, OpenableColumns.DISPLAY_NAME);
            metadata.mimeType = stringColumn(cursor, MediaStore.MediaColumns.MIME_TYPE);
            metadata.size = longColumn(cursor, OpenableColumns.SIZE);
            Long modifiedSeconds = longColumn(cursor, MediaStore.MediaColumns.DATE_MODIFIED);
            if (modifiedSeconds != null) metadata.lastModified = modifiedSeconds * 1000L;
        } catch (IllegalArgumentException ignored) {
            try (Cursor cursor = resolver.query(uri, null, null, null, null)) {
                if (cursor == null || !cursor.moveToFirst()) return metadata;
                metadata.displayName = stringColumn(cursor, OpenableColumns.DISPLAY_NAME);
                metadata.size = longColumn(cursor, OpenableColumns.SIZE);
            }
        }
        return metadata;
    }

    private boolean persistReadPermission(ContentResolver resolver, Uri uri) {
        if (!"content".equals(uri.getScheme())) return true;
        try {
            resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            return true;
        } catch (SecurityException | IllegalArgumentException ignored) {
            return hasPersistedReadPermission(resolver, uri);
        }
    }

    private boolean hasPersistedReadPermission(ContentResolver resolver, Uri uri) {
        try {
            for (android.content.UriPermission permission : resolver.getPersistedUriPermissions()) {
                if (permission.getUri().equals(uri) && permission.isReadPermission()) return true;
            }
        } catch (SecurityException ignored) {
            return false;
        }
        return false;
    }

    private HashResult hashUriWithOriginalFallback(ContentResolver resolver, Uri sourceUri) throws IOException {
        Uri readUri = originalExifUri(sourceUri);
        try {
            return hashUri(resolver, readUri);
        } catch (IOException | RuntimeException error) {
            if (readUri.equals(sourceUri)) throw new IOException("Unable to hash selected photo", error);
            return hashUri(resolver, sourceUri);
        }
    }

    private HashResult hashUri(ContentResolver resolver, Uri sourceUri) throws IOException {
        MessageDigest digest = sha256Digest();
        long size = 0;
        try (InputStream input = resolver.openInputStream(sourceUri)) {
            if (input == null) throw new IOException("Unable to open selected photo");
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                if (digest != null) digest.update(buffer, 0, read);
                size += read;
            }
        }
        return new HashResult(size, digest == null ? null : hex(digest.digest()));
    }

    private MessageDigest sha256Digest() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException ignored) {
            return null;
        }
    }

    private String hex(byte[] bytes) {
        StringBuilder builder = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) builder.append(String.format(Locale.US, "%02x", value));
        return builder.toString();
    }

    private File localPhotoDirectory() {
        return new File(getContext().getFilesDir(), LOCAL_PHOTO_DIR);
    }

    private String webPathForUri(String localUrl, Uri uri) {
        String value = uri.toString();
        if (value.startsWith("file://")) return localUrl + value.replace("file://", "/_capacitor_file_");
        if (value.startsWith("content:/")) return localUrl + value.replace("content:/", "/_capacitor_content_");
        return localUrl + value;
    }

    private boolean deleteLocalCopyIfOwned(Uri uri) {
        if (!"file".equals(uri.getScheme())) return false;
        try {
            File root = localPhotoDirectory().getCanonicalFile();
            File target = new File(uri.getPath()).getCanonicalFile();
            if (!target.getPath().startsWith(root.getPath() + File.separator)) return false;
            return target.isFile() && target.delete();
        } catch (IOException | SecurityException ignored) {
            return false;
        }
    }

    private ExifMetadata readExif(ContentResolver resolver, Uri uri) {
        ExifMetadata metadata = new ExifMetadata();
        Uri exifUri = originalExifUri(uri);
        if (readExifFromUri(resolver, exifUri, metadata)) return metadata;
        if (!exifUri.equals(uri)) readExifFromUri(resolver, uri, metadata);
        return metadata;
    }

    private boolean readExifFromUri(ContentResolver resolver, Uri uri, ExifMetadata metadata) {
        try (InputStream stream = resolver.openInputStream(uri)) {
            if (stream == null) return false;
            ExifInterface exif = new ExifInterface(stream);
            metadata.capturedAt = parseExifDate(exif);
            float[] latLong = new float[2];
            if (exif.getLatLong(latLong)) {
                metadata.latitude = (double) latLong[0];
                metadata.longitude = (double) latLong[1];
            }
            return true;
        } catch (IOException | SecurityException ignored) {
            // Some providers do not expose EXIF through InputStream. The photo is still importable.
            return false;
        }
    }

    private Uri originalExifUri(Uri uri) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || getPermissionState("mediaLocation") != PermissionState.GRANTED) return uri;
        try {
            return MediaStore.setRequireOriginal(uri);
        } catch (RuntimeException ignored) {
            return uri;
        }
    }

    private BitmapMetadata readBitmapMetadata(ContentResolver resolver, Uri uri) {
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inJustDecodeBounds = true;
        try (InputStream stream = resolver.openInputStream(uri)) {
            if (stream != null) BitmapFactory.decodeStream(stream, null, options);
        } catch (IOException ignored) {
            return new BitmapMetadata(0, 0);
        }
        return new BitmapMetadata(options.outWidth, options.outHeight);
    }

    private String parseExifDate(ExifInterface exif) {
        String value = firstNonEmpty(
            exif.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL),
            exif.getAttribute(ExifInterface.TAG_DATETIME_DIGITIZED),
            exif.getAttribute(ExifInterface.TAG_DATETIME)
        );
        if (value == null) return null;
        try {
            SimpleDateFormat input = new SimpleDateFormat("yyyy:MM:dd HH:mm:ss", Locale.US);
            Date date = input.parse(value);
            if (date == null) return null;
            SimpleDateFormat output = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US);
            output.setTimeZone(TimeZone.getDefault());
            return output.format(date);
        } catch (ParseException ignored) {
            return null;
        }
    }

    private String firstNonEmpty(String... values) {
        for (String value : values) {
            if (value != null && !value.trim().isEmpty()) return value;
        }
        return null;
    }

    private String stringColumn(Cursor cursor, String name) {
        int index = cursor.getColumnIndex(name);
        if (index < 0 || cursor.isNull(index)) return null;
        return cursor.getString(index);
    }

    private Long longColumn(Cursor cursor, String name) {
        int index = cursor.getColumnIndex(name);
        if (index < 0 || cursor.isNull(index)) return null;
        return cursor.getLong(index);
    }

    private String fallbackFileName(Uri uri) {
        String segment = uri.getLastPathSegment();
        return segment == null || segment.isEmpty() ? "android-photo.jpg" : segment;
    }

    private static class QueryMetadata {
        String displayName;
        String mimeType;
        Long size;
        Long lastModified;
    }

    private static class HashResult {
        final long size;
        final String sha256;

        HashResult(long size, String sha256) {
            this.size = size;
            this.sha256 = sha256;
        }
    }

    private static class ExifMetadata {
        String capturedAt;
        Double latitude;
        Double longitude;
    }

    private static class BitmapMetadata {
        final int width;
        final int height;

        BitmapMetadata(int width, int height) {
            this.width = width;
            this.height = height;
        }
    }
}
