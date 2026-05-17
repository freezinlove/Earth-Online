package com.earthonline.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "EarthSecrets")
public class EarthSecretsPlugin extends Plugin {
    private static final String KEY_ALIAS = "earth_online_ai_secrets_v1";
    private static final String PREF_NAME = "earth_online_secrets";
    private static final String PREF_PAYLOAD = "ai_secrets_payload";
    private static final int GCM_TAG_BITS = 128;
    private static final int GCM_IV_BYTES = 12;

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject result = new JSObject();
        try {
            ensureKey();
            result.put("available", true);
        } catch (Exception error) {
            result.put("available", false);
            result.put("error", error.getMessage());
        }
        call.resolve(result);
    }

    @PluginMethod
    public void readSecrets(PluginCall call) {
        JSObject result = new JSObject();
        try {
            String encrypted = preferences().getString(PREF_PAYLOAD, null);
            if (encrypted == null || encrypted.isEmpty()) {
                result.put("secrets", new JSObject());
                call.resolve(result);
                return;
            }
            String decrypted = decrypt(encrypted);
            result.put("secrets", new JSObject(decrypted));
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    @PluginMethod
    public void writeSecrets(PluginCall call) {
        JSObject secrets = call.getObject("secrets", new JSObject());
        try {
            preferences().edit().putString(PREF_PAYLOAD, encrypt(secrets.toString())).apply();
            JSObject result = new JSObject();
            result.put("ok", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
    }

    private SecretKey ensureKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) {
            return (SecretKey) keyStore.getKey(KEY_ALIAS, null);
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build();
        generator.init(spec);
        return generator.generateKey();
    }

    private String encrypt(String text) throws Exception {
        byte[] iv = new byte[GCM_IV_BYTES];
        new SecureRandom().nextBytes(iv);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, ensureKey(), new GCMParameterSpec(GCM_TAG_BITS, iv));
        byte[] encrypted = cipher.doFinal(text.getBytes(StandardCharsets.UTF_8));
        JSONObject payload = new JSONObject();
        payload.put("iv", Base64.encodeToString(iv, Base64.NO_WRAP));
        payload.put("data", Base64.encodeToString(encrypted, Base64.NO_WRAP));
        return payload.toString();
    }

    private String decrypt(String payloadText) throws Exception {
        JSONObject payload = new JSONObject(payloadText);
        byte[] iv = Base64.decode(payload.getString("iv"), Base64.NO_WRAP);
        byte[] encrypted = Base64.decode(payload.getString("data"), Base64.NO_WRAP);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, ensureKey(), new GCMParameterSpec(GCM_TAG_BITS, iv));
        return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
    }
}
