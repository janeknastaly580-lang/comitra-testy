package com.pactista.app.appblock;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.provider.Settings;
import android.text.TextUtils;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The native half of `src/lib/appBlock.ts`.
 *
 * The JS layer decides WHEN an app should be blocked; this plugin only records
 * it and hands enforcement to {@link ComitraAccessibilityService}. Writing to
 * {@link BlockStore} is all `scheduleBlock` does, that is what makes a block
 * survive the WebView being killed.
 *
 * Blocks are stored even when the accessibility permission has not been granted
 * yet: the goal is real either way, and the moment the user turns the permission
 * on, everything already scheduled starts being enforced.
 */
@CapacitorPlugin(name = "ComitraAppBlock")
public class ComitraAppBlockPlugin extends Plugin {

    @PluginMethod
    public void scheduleBlock(PluginCall call) {
        String goalId = call.getString("goalId");
        String packageName = call.getString("packageName");
        String appLabel = call.getString("appLabel", "");
        Long untilEpochMs = call.getLong("untilEpochMs");

        if (goalId == null || goalId.isEmpty() || packageName == null || packageName.isEmpty()) {
            call.reject("goalId and packageName are required.");
            return;
        }
        if (untilEpochMs == null || untilEpochMs <= System.currentTimeMillis()) {
            // Already expired: storing it would be a no-op that only confuses.
            BlockStore.remove(getContext(), goalId);
            call.resolve();
            return;
        }

        BlockStore.put(getContext(), new BlockStore.Block(goalId, packageName, appLabel, untilEpochMs));

        JSObject result = new JSObject();
        result.put("enforced", isServiceEnabled(getContext()));
        call.resolve(result);
    }

    @PluginMethod
    public void cancelBlock(PluginCall call) {
        String goalId = call.getString("goalId");
        if (goalId == null || goalId.isEmpty()) {
            call.reject("goalId is required.");
            return;
        }
        BlockStore.remove(getContext(), goalId);
        call.resolve();
    }

    @PluginMethod
    public void isSupported(PluginCall call) {
        JSObject result = new JSObject();
        result.put("supported", true);
        call.resolve(result);
    }

    /**
     * Whether blocks are actually being enforced right now. The UI needs this:
     * without the permission a block is stored but toothless, and the user has
     * to be told rather than left thinking it works.
     */
    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject result = new JSObject();
        result.put("supported", true);
        result.put("permissionGranted", isServiceEnabled(getContext()));
        result.put("activeBlocks", BlockStore.hasLiveBlocks(getContext()));
        call.resolve(result);
    }

    /**
     * Send the user to the system Accessibility screen to switch the service on.
     * Android does not allow granting this from code, by design, and it is also
     * what makes a block hard to shrug off later.
     */
    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    /** Is our accessibility service switched on in system settings? */
    static boolean isServiceEnabled(Context context) {
        ComponentName expected = new ComponentName(context, ComitraAccessibilityService.class);
        String enabled = Settings.Secure.getString(
                context.getContentResolver(),
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (TextUtils.isEmpty(enabled)) return false;

        TextUtils.SimpleStringSplitter splitter = new TextUtils.SimpleStringSplitter(':');
        splitter.setString(enabled);
        while (splitter.hasNext()) {
            ComponentName parsed = ComponentName.unflattenFromString(splitter.next());
            if (parsed != null && parsed.equals(expected)) return true;
        }
        return false;
    }
}
