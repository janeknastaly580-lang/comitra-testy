package com.fineline.app.notify;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.fineline.app.MainActivity;
import com.fineline.app.R;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The native half of `src/lib/localNotify.ts`.
 *
 * Comitra has no push service, so nothing reaches a phone whose app is closed.
 * What this does is turn a message the app has just pulled from the shared inbox
 * into a real system notification, so it is seen even if the person is not
 * looking at Comitra at that moment.
 *
 * Everything here is best-effort. A missing permission, a stale channel or an
 * OEM that drops the post must never break the sync that produced the message:
 * the message itself already lives in the inbox and is shown in-app regardless.
 */
@CapacitorPlugin(name = "ComitraNotify")
public class ComitraNotifyPlugin extends Plugin {

    private static final String CHANNEL_ID = "comitra_goals";
    private static final int PERMISSION_REQUEST = 4711;

    @PluginMethod
    public void isSupported(PluginCall call) {
        JSObject result = new JSObject();
        result.put("supported", true);
        call.resolve(result);
    }

    @PluginMethod
    public void notify(PluginCall call) {
        String id = call.getString("id", "");
        String title = call.getString("title", "Comitra");
        String body = call.getString("body", "");

        if (body == null || body.isEmpty()) {
            call.reject("body is required.");
            return;
        }

        Context context = getContext();
        ensureChannel(context);

        // Android 13+ will not show anything without this, and asking is only
        // allowed from an Activity. Ask once, then answer honestly: the caller
        // treats `posted:false` as "it is in the inbox but no banner appeared".
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ActivityCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
                   != PackageManager.PERMISSION_GRANTED) {
            if (getActivity() != null) {
                ActivityCompat.requestPermissions(
                        getActivity(), new String[] { Manifest.permission.POST_NOTIFICATIONS }, PERMISSION_REQUEST);
            }
            JSObject denied = new JSObject();
            denied.put("posted", false);
            call.resolve(denied);
            return;
        }

        Intent open = new Intent(context, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent tap = PendingIntent.getActivity(
                context,
                0,
                open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification notification = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setContentIntent(tap)
                .setAutoCancel(true)
                .build();

        boolean posted = true;
        try {
            // The inbox id is stable per message, so a re-delivery updates the
            // same notification instead of stacking a second copy.
            NotificationManagerCompat.from(context).notify(id == null ? "" : id, 1, notification);
        } catch (SecurityException e) {
            posted = false;
        }

        JSObject result = new JSObject();
        result.put("posted", posted);
        call.resolve(result);
    }

    private void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "Goal updates", NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription("Messages about goals your friends asked you to be part of.");
        manager.createNotificationChannel(channel);
    }
}
