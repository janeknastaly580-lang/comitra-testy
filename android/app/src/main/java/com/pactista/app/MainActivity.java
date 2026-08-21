package com.pactista.app;

import android.os.Bundle;

import com.pactista.app.appblock.ComitraAppBlockPlugin;
import com.pactista.app.notify.ComitraNotifyPlugin;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Must be registered before the bridge starts, or the web layer's calls
        // to `ComitraAppBlock` / `ComitraNotify` resolve to nothing.
        registerPlugin(ComitraAppBlockPlugin.class);
        registerPlugin(ComitraNotifyPlugin.class);
        // A notification pushed to a channel that does not exist yet is dropped
        // by Android without a word, and a push can arrive when the app has not
        // been opened since it was installed. Creating it here rather than at
        // the first local notification is what makes the very first push land.
        ComitraNotifyPlugin.ensureChannel(this);
        super.onCreate(savedInstanceState);
    }
}
