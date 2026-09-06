package it.wojtaszek.mc.wrapper

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Keeps mc-webui reachable while the user is somewhere else on the phone.
 *
 * Android puts a backgrounded app's process into the cached-process freezer
 * within minutes, and a frozen process runs no JavaScript and holds no socket -
 * which is why alerts used to stop arriving shortly after leaving the app. No
 * battery setting fixes that: "Unrestricted" exempts an app from Doze and App
 * Standby, not from the freezer, which is memory management. A foreground
 * service is the one thing Android accepts as a reason to leave a process alone.
 *
 * This service therefore does nothing at all by itself. Every notification is
 * still built by mc-webui's own JavaScript, exactly as it is in a browser, and
 * so keeps the page's mute rules, blocked senders, channel names, translations
 * and deep links without any of it being duplicated here. All the service
 * contributes is a reason for that JavaScript to still be running.
 *
 * It exists only while the page wants notifications, so anyone who never turns
 * them on never sees the permanent notice that Android requires in return.
 */
class MeshWatchService : Service() {

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            // "Not now" rather than "never": the flag is deliberately not saved
            // anywhere, so simply opening the app again brings alerts back
            stoppedByUser = true
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        // The type has to match what the manifest declares, and remoteMessaging
        // only exists from Android 14. Older versions get an untyped foreground
        // service, which they are perfectly happy with
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
        } else {
            0
        }
        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), type)

        // Nothing to resume: without the activity and its WebView there is no
        // page to keep alive, so a restart on its own would keep an empty
        // process running behind a notification that promises something
        return START_NOT_STICKY
    }

    /**
     * The user swiped the app away. The WebView went with it, so there is no
     * longer anything to hold open - and a notice saying otherwise would be a
     * lie that only Force stop could clear.
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        stopSelf()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    /**
     * A channel of its own, at low importance, so this permanent notice stays
     * silent and collapsed - and can be turned off on its own, without taking
     * the message alerts down with it.
     */
    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.background_channel_name),
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = getString(R.string.background_channel_description)
            setShowBadge(false)
        }
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags = flags or PendingIntent.FLAG_IMMUTABLE

        val open = PendingIntent.getActivity(
            this,
            REQ_OPEN,
            Intent(this, MainActivity::class.java).apply {
                this.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            },
            flags
        )
        val stop = PendingIntent.getService(
            this,
            REQ_STOP,
            Intent(this, MeshWatchService::class.java).setAction(ACTION_STOP),
            flags
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.background_title))
            .setContentText(getString(R.string.background_text))
            .setStyle(NotificationCompat.BigTextStyle().bigText(getString(R.string.background_text)))
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setContentIntent(open)
            .addAction(0, getString(R.string.background_stop), stop)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "mc_webui_background"
        private const val NOTIFICATION_ID = 2
        private const val REQ_OPEN = 10
        private const val REQ_STOP = 11
        private const val ACTION_STOP = "it.wojtaszek.mc.wrapper.STOP_WATCHING"

        /**
         * Set by the Stop action and cleared when the activity is created
         * again, so the refusal lasts exactly as long as this run of the app.
         * Nothing is written to disk: a permanent switch hidden in a
         * notification is how a messaging app goes quiet for months without
         * anyone working out why.
         */
        @Volatile
        var stoppedByUser = false

        fun start(context: Context) {
            if (stoppedByUser) return
            try {
                ContextCompat.startForegroundService(
                    context, Intent(context, MeshWatchService::class.java)
                )
            } catch (e: Exception) {
                // From Android 12 a foreground service cannot be started from
                // the background. The activity asks again whenever it is on
                // screen, which is the only state that start is allowed from
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, MeshWatchService::class.java))
        }
    }
}
