package com.pactista.app.appblock;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Blocks have to survive a restart, otherwise rebooting the phone would be the
 * easy way around one.
 *
 * The accessibility service is re-bound by Android on its own, and it reads
 * {@link BlockStore} from disk, so nothing needs re-arming here. All this does
 * is drop entries whose deadline passed while the phone was off.
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                || Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action)) {
            BlockStore.pruneExpired(context);
        }
    }
}
