package com.pactista.app.notify;

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

import com.pactista.app.MainActivity;
import com.pactista.app.R;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The native half of `src/lib/localNotify.ts`.
 *
 * Pactista has no push service, so nothing reaches a phone whose app is closed.
 * What this does is turn a message the app has just pulled from the shared inbox
 * into a real system notification, so it is seen even if the person is not
 * looking at Pactista at that moment.
 *
 * Everything here is best-effort. A missing permission, a stale channel or an
 * OEM that drops the post must never break the sync that produced the message:
 * the message itself already lives in the inbox and is shown in-app regardless.
 */
@CapacitorPlugin(name = "ComitraNotify")
public class ComitraNotifyPlugin extends Plugin {

    /** Must match `notification_channel_id` in strings.xml and fcm.ts. */
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
        String title = call.getString("title", "Pactista");
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
            //
            // THE ZERO MATTERS. Firebase posts its own notifications with
            // `notify(tag, 0, ...)` — verified against firebase-messaging, which
            // passes a literal 0 alongside the message's tag. Using the same id
            // here means a message that arrived BOTH ways (pushed while the app
            // was closed, then found again by the sync on open) replaces its own
            // banner instead of showing the reader two of them. The backend puts
            // this same string in the tag — see supabase/functions/api/fcm.ts.
            NotificationManagerCompat.from(context).notify(id == null ? "" : id, 0, notification);
        } catch (SecurityException e) {
            posted = false;
        }

        JSObject result = new JSObject();
        result.put("posted", posted);
        call.resolve(result);
    }

    /**
     * Create the app's one notification channel if it is not there already.
     *
     * Static and public because two very different things need it: this plugin,
     * posting a banner for a message the app has just pulled, and MainActivity
     * at startup — a notification PUSHED from the backend names this channel by
     * id, and Android silently drops one whose channel does not exist.
     *
     * The strings come from resources so the manifest's
     * `default_notification_channel_id` and the id used here cannot drift apart.
     */
    public static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.notification_channel_name),
                NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription(context.getString(R.string.notification_channel_description));
        manager.createNotificationChannel(channel);
    }
}
