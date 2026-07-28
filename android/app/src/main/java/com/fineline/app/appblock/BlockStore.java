package com.fineline.app.appblock;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * The list of blocks currently in force, persisted so they survive a reboot, a
 * force-stop, or the JS layer never running again.
 *
 * The web app owns the lifecycle (it decides when a block starts and ends), but
 * it is NOT the source of truth while a block runs: everything the accessibility
 * service needs lives here, on disk. That is deliberate — if the store depended
 * on the WebView being alive, killing the app would lift every block.
 *
 * `untilEpochMs` is a hard expiry the service honours by itself, so a block can
 * never outlive the goal that created it even if `cancelBlock` is never called.
 */
public final class BlockStore {

    private static final String PREFS = "comitra_app_blocks";
    private static final String KEY_BLOCKS = "blocks";

    /** One blocked app, keyed by the goal that asked for it. */
    public static final class Block {
        public final String goalId;
        public final String packageName;
        public final String appLabel;
        public final long untilEpochMs;

        public Block(String goalId, String packageName, String appLabel, long untilEpochMs) {
            this.goalId = goalId;
            this.packageName = packageName;
            this.appLabel = appLabel;
            this.untilEpochMs = untilEpochMs;
        }

        boolean isLive(long now) {
            return now < untilEpochMs;
        }

        /** Still in force right now. */
        public boolean isLiveNow() {
            return isLive(System.currentTimeMillis());
        }
    }

    /**
     * Accessibility events arrive many times a second, so the disk copy is read
     * once and kept here. The plugin invalidates it whenever it writes, and both
     * live in the same process, so the service never reads a stale list.
     */
    private static volatile List<Block> cache;

    private BlockStore() {}

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Every stored block, expired ones included. */
    public static synchronized List<Block> all(Context context) {
        List<Block> cached = cache;
        if (cached != null) return cached;

        List<Block> parsed = new ArrayList<>();
        String raw = prefs(context).getString(KEY_BLOCKS, "[]");
        try {
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                parsed.add(new Block(
                        o.getString("goalId"),
                        o.getString("packageName"),
                        o.optString("appLabel", ""),
                        o.getLong("untilEpochMs")));
            }
        } catch (JSONException e) {
            // Corrupt store: start clean rather than crashing the service that
            // has to keep running for every app switch on the device.
            parsed = new ArrayList<>();
        }
        cache = Collections.unmodifiableList(parsed);
        return cache;
    }

    /** Add or replace the block for a goal. */
    public static synchronized void put(Context context, Block block) {
        List<Block> next = new ArrayList<>();
        for (Block b : all(context)) {
            if (!b.goalId.equals(block.goalId)) next.add(b);
        }
        next.add(block);
        write(context, next);
    }

    /** Drop a goal's block (it completed, was cancelled, or the goal ended). */
    public static synchronized void remove(Context context, String goalId) {
        List<Block> next = new ArrayList<>();
        for (Block b : all(context)) {
            if (!b.goalId.equals(goalId)) next.add(b);
        }
        write(context, next);
    }

    /** Forget anything whose deadline has passed. */
    public static synchronized void pruneExpired(Context context) {
        long now = System.currentTimeMillis();
        List<Block> next = new ArrayList<>();
        boolean changed = false;
        for (Block b : all(context)) {
            if (b.isLive(now)) next.add(b);
            else changed = true;
        }
        if (changed) write(context, next);
    }

    private static void write(Context context, List<Block> blocks) {
        JSONArray arr = new JSONArray();
        for (Block b : blocks) {
            try {
                JSONObject o = new JSONObject();
                o.put("goalId", b.goalId);
                o.put("packageName", b.packageName);
                o.put("appLabel", b.appLabel);
                o.put("untilEpochMs", b.untilEpochMs);
                arr.put(o);
            } catch (JSONException ignored) {
                // A single unserialisable entry must not lose the others.
            }
        }
        prefs(context).edit().putString(KEY_BLOCKS, arr.toString()).apply();
        cache = Collections.unmodifiableList(new ArrayList<>(blocks));
    }

    /**
     * The live block for a package, or null. When several goals block the same
     * app, the one that lasts longest wins — finishing one goal must not unlock
     * an app another goal is still holding shut.
     */
    public static Block liveBlockFor(Context context, String packageName) {
        if (packageName == null) return null;
        long now = System.currentTimeMillis();
        Block best = null;
        for (Block b : all(context)) {
            if (!b.isLive(now) || !b.packageName.equals(packageName)) continue;
            if (best == null || b.untilEpochMs > best.untilEpochMs) best = b;
        }
        return best;
    }

    /** True when at least one block is still in force (cheap early-out). */
    public static boolean hasLiveBlocks(Context context) {
        long now = System.currentTimeMillis();
        for (Block b : all(context)) {
            if (b.isLive(now)) return true;
        }
        return false;
    }
}
