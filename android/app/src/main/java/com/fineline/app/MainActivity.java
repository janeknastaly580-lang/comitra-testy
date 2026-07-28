package com.fineline.app;

import android.os.Bundle;

import com.fineline.app.appblock.ComitraAppBlockPlugin;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Must be registered before the bridge starts, or the web layer's calls
        // to `ComitraAppBlock` resolve to nothing.
        registerPlugin(ComitraAppBlockPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
