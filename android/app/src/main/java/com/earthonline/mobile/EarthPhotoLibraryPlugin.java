package com.earthonline.mobile;

import android.app.Activity;
import android.Manifest;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
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

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
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
    private static final int THUMBNAIL_MAX_SIZE = 480;
    private static final String DEFAULT_MIME_TYPE = "image/jpeg";

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
        }
        JSObject result = new JSObject();
        result.put("released", released);
        call.resolve(result);
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
        int flags = data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        execute(() -> resolvePickedPhotos(call, uris, flags));
    }

    private void resolvePickedPhotos(PluginCall call, List<Uri> uris, int flags) {
        JSArray photos = new JSArray();
        for (Uri uri : uris) {
            try {
                JSObject asset = describeAsset(uri, flags);
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

    private JSObject describeAsset(Uri uri, int flags) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        PersistResult persistResult = persistReadGrant(resolver, uri, flags);
        QueryMetadata query = queryMetadata(resolver, uri);
        ExifMetadata exif = readExif(resolver, uri);
        BitmapMetadata bitmap = readBitmapMetadata(resolver, uri);

        JSObject asset = new JSObject();
        asset.put("uri", uri.toString());
        String localUrl = getBridge().getLocalUrl();
        if (localUrl != null) {
            asset.put("webPath", localUrl + uri.toString().replace("content:/", "/_capacitor_content_"));
        }
        asset.put("fileName", query.displayName == null ? fallbackFileName(uri) : query.displayName);
        String mimeType = query.mimeType == null ? resolver.getType(uri) : query.mimeType;
        asset.put("mimeType", mimeType == null ? DEFAULT_MIME_TYPE : mimeType);
        if (query.size != null) asset.put("size", query.size);
        if (query.lastModified != null) asset.put("lastModified", query.lastModified);
        if (bitmap.width > 0) asset.put("width", bitmap.width);
        if (bitmap.height > 0) asset.put("height", bitmap.height);
        if (exif.capturedAt != null) asset.put("capturedAt", exif.capturedAt);
        if (exif.latitude != null) asset.put("latitude", exif.latitude);
        if (exif.longitude != null) asset.put("longitude", exif.longitude);
        asset.put("persisted", persistResult.persisted);
        if (persistResult.error != null) asset.put("persistedError", persistResult.error);
        String thumbnail = createThumbnailDataUrl(resolver, uri);
        if (thumbnail != null) asset.put("thumbnailDataUrl", thumbnail);
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

    private PersistResult persistReadGrant(ContentResolver resolver, Uri uri, int flags) {
        if ((flags & Intent.FLAG_GRANT_READ_URI_PERMISSION) == 0) return new PersistResult(false, "Read grant flag missing");
        try {
            resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            return new PersistResult(true, null);
        } catch (SecurityException | IllegalArgumentException error) {
            return new PersistResult(false, error.getMessage());
        }
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

    private String createThumbnailDataUrl(ContentResolver resolver, Uri uri) {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        try (InputStream stream = resolver.openInputStream(uri)) {
            if (stream != null) BitmapFactory.decodeStream(stream, null, bounds);
        } catch (IOException ignored) {
            return null;
        }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null;

        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, THUMBNAIL_MAX_SIZE);
        try (InputStream stream = resolver.openInputStream(uri)) {
            if (stream == null) return null;
            Bitmap bitmap = BitmapFactory.decodeStream(stream, null, options);
            if (bitmap == null) return null;
            bitmap = orientBitmap(bitmap, readExifOrientation(resolver, uri));
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            bitmap.compress(Bitmap.CompressFormat.JPEG, 72, output);
            bitmap.recycle();
            return "data:image/jpeg;base64," + Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP);
        } catch (IOException ignored) {
            return null;
        }
    }

    private int sampleSize(int width, int height, int maxSize) {
        int sampleSize = 1;
        int longest = Math.max(width, height);
        while (longest / sampleSize > maxSize * 2) {
            sampleSize *= 2;
        }
        return Math.max(1, sampleSize);
    }

    private int readExifOrientation(ContentResolver resolver, Uri uri) {
        try (InputStream stream = resolver.openInputStream(uri)) {
            if (stream == null) return ExifInterface.ORIENTATION_NORMAL;
            ExifInterface exif = new ExifInterface(stream);
            return exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
        } catch (IOException ignored) {
            return ExifInterface.ORIENTATION_NORMAL;
        }
    }

    private Bitmap orientBitmap(Bitmap source, int orientation) {
        Matrix matrix = new Matrix();
        switch (orientation) {
            case ExifInterface.ORIENTATION_ROTATE_90:
                matrix.postRotate(90);
                break;
            case ExifInterface.ORIENTATION_ROTATE_180:
                matrix.postRotate(180);
                break;
            case ExifInterface.ORIENTATION_ROTATE_270:
                matrix.postRotate(270);
                break;
            default:
                return source;
        }
        Bitmap rotated = Bitmap.createBitmap(source, 0, 0, source.getWidth(), source.getHeight(), matrix, true);
        if (rotated != source) source.recycle();
        return rotated;
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

    private static class PersistResult {
        final boolean persisted;
        final String error;

        PersistResult(boolean persisted, String error) {
            this.persisted = persisted;
            this.error = error;
        }
    }

    private static class QueryMetadata {
        String displayName;
        String mimeType;
        Long size;
        Long lastModified;
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
