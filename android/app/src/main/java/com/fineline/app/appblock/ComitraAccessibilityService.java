package com.fineline.app.appblock;

import android.accessibilityservice.AccessibilityService;
import android.content.Intent;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Enforces the blocks. This is the only piece that can actually stop another app
 * from being used, which is why the whole feature needs the user to switch on an
 * accessibility service by hand.
 *
 * How it blocks: whenever the foreground window changes, the package is checked
 * against {@link BlockStore}. On a hit the user is sent Home and a full-screen
 * {@link BlockedActivity} explains why. There is no "ignore", no snooze and no
 * dismiss — the only ways out are finishing the goal in Comitra, waiting for the
 * deadline, or going into Android Settings and turning this service off. That is
 * the intended escape hatch, so Settings itself is never blocked.
 *
 * Browsers get the same treatment via the URL in their address bar, so blocking
 * TikTok also blocks tiktok.com (see {@link BlockedSites} for what stays
 * reachable — help, legal and billing pages are never blocked).
 */
public class ComitraAccessibilityService extends AccessibilityService {

    /** Browsers whose address bar we know how to read. */
    private static final Set<String> BROWSERS = new HashSet<>(Arrays.asList(
            "com.android.chrome",
            "com.chrome.beta",
            "com.chrome.dev",
            "com.brave.browser",
            "com.microsoft.emmx",
            "org.mozilla.firefox",
            "org.mozilla.focus",
            "com.opera.browser",
            "com.opera.mini.native",
            "com.opera.gx",
            "com.sec.android.app.sbrowser",
            "com.duckduckgo.mobile.android",
            "com.vivaldi.browser",
            "com.kiwibrowser.browser",
            "com.UCMobile.intl",
            "com.ecosia.android",
            "com.yandex.browser",
            "com.android.browser"
    ));

    /**
     * View ids of the address bar, per browser family. Most Chromium forks keep
     * Chrome's `url_bar` id, so the list stays short.
     */
    private static final List<String> URL_BAR_IDS = Arrays.asList(
            ":id/url_bar",
            ":id/mozac_browser_toolbar_url_view",
            ":id/url_bar_title",
            ":id/location_bar_edit_text",
            ":id/omnibarTextInput",
            ":id/url_field",
            ":id/display_url",
            ":id/search_box_text"
    );

    /**
     * Re-showing the block screen on every content change would fight the user's
     * own taps, so back-to-back hits on the same target are collapsed.
     */
    private static final long RETRIGGER_MS = 900L;

    /**
     * TYPE_WINDOW_CONTENT_CHANGED fires constantly while a page renders, and
     * reading the URL means walking the node tree. Throttle it so scrolling a
     * browser doesn't burn CPU; a page the user opens is still caught within a
     * blink.
     */
    private static final long URL_CHECK_MS = 400L;

    private String lastTarget = "";
    private long lastTriggerAt = 0L;
    private long lastUrlCheckAt = 0L;

    @Override
    public void onServiceConnected() {
        super.onServiceConnected();
        // Anything whose deadline passed while the service was off is dead.
        BlockStore.pruneExpired(this);
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null) return;
        int type = event.getEventType();
        if (type != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
                && type != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) {
            return;
        }
        // Cheap early-out: with nothing blocked this service costs almost nothing.
        if (!BlockStore.hasLiveBlocks(this)) return;

        CharSequence pkg = event.getPackageName();
        if (pkg == null) return;
        String packageName = pkg.toString();

        // Never block ourselves: the goal has to stay reachable to be finished.
        // Nothing else needs excluding — only apps the user explicitly chose are
        // ever in the store, so Settings (the way to switch this service off)
        // and the launcher can never end up blocked.
        if (packageName.equals(getPackageName())) return;

        BlockStore.Block direct = BlockStore.liveBlockFor(this, packageName);
        if (direct != null) {
            block(direct, packageName, null);
            return;
        }

        if (BROWSERS.contains(packageName)) {
            long now = SystemClock.elapsedRealtime();
            if (now - lastUrlCheckAt < URL_CHECK_MS) return;
            lastUrlCheckAt = now;

            String url = readUrl();
            if (url == null) return;
            for (BlockStore.Block b : BlockStore.all(this)) {
                if (!b.isLiveNow()) continue;
                if (BlockedSites.matches(b.packageName, url)) {
                    block(b, packageName, url);
                    return;
                }
            }
        }
    }

    /** Send the user home, then explain. */
    private void block(BlockStore.Block block, String foregroundPackage, String url) {
        String target = foregroundPackage + "|" + (url == null ? "" : hostOf(url));
        long now = SystemClock.elapsedRealtime();
        if (target.equals(lastTarget) && now - lastTriggerAt < RETRIGGER_MS) return;
        lastTarget = target;
        lastTriggerAt = now;

        // Home first, so the blocked app is not left sitting behind our screen.
        performGlobalAction(GLOBAL_ACTION_HOME);

        Intent intent = new Intent(this, BlockedActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_CLEAR_TASK
                | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS
                | Intent.FLAG_ACTIVITY_NO_HISTORY);
        intent.putExtra(BlockedActivity.EXTRA_APP_LABEL, block.appLabel);
        intent.putExtra(BlockedActivity.EXTRA_UNTIL, block.untilEpochMs);
        intent.putExtra(BlockedActivity.EXTRA_WAS_WEBSITE, url != null);
        startActivity(intent);
    }

    private static String hostOf(String url) {
        int start = url.indexOf("://");
        String rest = start >= 0 ? url.substring(start + 3) : url;
        int slash = rest.indexOf('/');
        return (slash >= 0 ? rest.substring(0, slash) : rest).toLowerCase(Locale.US);
    }

    /**
     * Pull the current URL out of whichever browser is in front.
     *
     * `recycle()` is a no-op from API 33 on, but this ships to API 24 where the
     * node pool is real and leaking it churns memory on every page change.
     */
    @SuppressWarnings("deprecation")
    private String readUrl() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return null;
        String found = null;
        try {
            for (String id : URL_BAR_IDS) {
                List<AccessibilityNodeInfo> nodes =
                        root.findAccessibilityNodeInfosByViewId(root.getPackageName() + id);
                if (nodes == null || nodes.isEmpty()) continue;
                for (AccessibilityNodeInfo node : nodes) {
                    if (node == null) continue;
                    CharSequence text = node.getText();
                    if (found == null && text != null && text.length() > 0) {
                        found = text.toString();
                    }
                    node.recycle(); // every node, including the ones after a hit
                }
                if (found != null) return found;
            }
        } catch (Exception e) {
            // A browser we cannot read must never crash the service — the app
            // block itself still works, only its website twin is missed.
            return null;
        } finally {
            root.recycle();
        }
        return found;
    }

    @Override
    public void onInterrupt() {
        // Nothing to wind down: state lives in BlockStore, not in this service.
    }
}
