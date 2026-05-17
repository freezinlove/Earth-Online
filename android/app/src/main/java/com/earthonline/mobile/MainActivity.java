package com.earthonline.mobile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(EarthGeodataPlugin.class);
        registerPlugin(EarthPhotoLibraryPlugin.class);
        registerPlugin(EarthRepositoryPlugin.class);
        registerPlugin(EarthSecretsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
