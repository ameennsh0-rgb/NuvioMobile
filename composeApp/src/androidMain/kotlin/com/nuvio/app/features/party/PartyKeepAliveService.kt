package com.nuvio.app.features.party

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Keeps a watch party (and its video call) connected while the screen is off.
 *
 * Without this, Android suspends the app's network and threads soon after the screen
 * turns off, the party's live connection drops, and the server drops you from the party.
 * While you're in a party this runs as a small foreground service holding a CPU wake
 * lock and a Wi-Fi lock, with an ongoing "Watch party active" notification.
 */
class PartyKeepAliveService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        val notification = buildNotification(intent?.getStringExtra(EXTRA_TITLE))
        runCatching {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        }.onFailure {
            Log.w(TAG, "couldn't start keep-alive", it)
            stopSelf()
            return START_NOT_STICKY
        }
        acquireLocks()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        releaseLocks()
        super.onDestroy()
    }

    @SuppressLint("WakelockTimeout")
    private fun acquireLocks() {
        if (wakeLock?.isHeld != true) {
            val power = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Nuvio:WatchParty").apply {
                setReferenceCounted(false)
                acquire()
            }
        }
        if (wifiLock?.isHeld != true) {
            val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            @Suppress("DEPRECATION")
            val mode = if (Build.VERSION.SDK_INT >= 29) {
                WifiManager.WIFI_MODE_FULL_LOW_LATENCY
            } else {
                WifiManager.WIFI_MODE_FULL_HIGH_PERF
            }
            wifiLock = runCatching {
                wifi.createWifiLock(mode, "Nuvio:WatchParty").apply {
                    setReferenceCounted(false)
                    acquire()
                }
            }.getOrNull()
        }
    }

    private fun releaseLocks() {
        runCatching { wakeLock?.takeIf { it.isHeld }?.release() }
        runCatching { wifiLock?.takeIf { it.isHeld }?.release() }
        wakeLock = null
        wifiLock = null
    }

    private fun buildNotification(title: String?): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Watch party", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Keeps your watch party connected while the screen is off"
                    setShowBadge(false)
                },
            )
        }
        val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(com.nuvio.app.R.drawable.ic_notification_small)
            .setContentTitle("Watch party active")
            .setContentText(title?.takeIf { it.isNotBlank() } ?: "Staying connected while the screen is off")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(open)
            .build()
    }

    companion object {
        private const val TAG = "PartyKeepAlive"
        private const val CHANNEL_ID = "watch_party_keepalive"
        private const val NOTIFICATION_ID = 0x5A17
        private const val ACTION_STOP = "com.nuvio.app.party.KEEPALIVE_STOP"
        private const val EXTRA_TITLE = "title"

        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        private var installed = false

        /** Starts/stops the service automatically as you join and leave watch parties. */
        fun install(context: Context) {
            if (installed) return
            installed = true
            val appContext = context.applicationContext
            scope.launch {
                PartyRepository.state
                    .map { state -> state.party?.let { it.id to it.media.title } }
                    .distinctUntilChanged()
                    .collect { active ->
                        if (active != null) start(appContext, active.second) else stop(appContext)
                    }
            }
        }

        private fun start(context: Context, title: String?) {
            val intent = Intent(context, PartyKeepAliveService::class.java).putExtra(EXTRA_TITLE, title)
            runCatching { ContextCompat.startForegroundService(context, intent) }
                .onFailure { Log.w(TAG, "couldn't start keep-alive", it) }
        }

        private fun stop(context: Context) {
            runCatching { context.stopService(Intent(context, PartyKeepAliveService::class.java)) }
        }
    }
}
