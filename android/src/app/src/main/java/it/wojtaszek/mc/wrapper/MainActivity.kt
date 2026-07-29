package it.wojtaszek.mc.wrapper

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.view.View
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.URLUtil
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject

/**
 * A thin wrapper around the user's own mc-webui instance: one screen to enter
 * the server address, one full-screen WebView for the interface itself.
 *
 * The saved address is only ever replaced by the user - a failed connection or
 * a stray Back press never makes them type it again.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var prefs: SharedPreferences
    private lateinit var configLayout: LinearLayout
    private lateinit var configMessage: TextView
    private lateinit var webView: WebView
    private lateinit var urlInput: EditText

    /** Camera request from the page (QR scanning), waiting for the Android permission. */
    private var pendingCameraRequest: PermissionRequest? = null

    /** Download the page asked for, waiting for the storage permission on older Android. */
    private var pendingDownload: (() -> Unit)? = null

    private val notificationBridge = NotificationBridge()

    /** Ids of `Notification.requestPermission()` promises awaiting the Android dialog. */
    private val pendingPermissionCallbacks = mutableListOf<String>()

    /** The notification shim, injected into every page as it starts loading. */
    private var pageStartScript: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        configLayout = findViewById(R.id.configLayout)
        configMessage = findViewById(R.id.configMessage)
        webView = findViewById(R.id.webView)
        urlInput = findViewById(R.id.urlInput)

        createNotificationChannel()
        setUpWebView()

        findViewById<Button>(R.id.saveButton).setOnClickListener {
            val typed = urlInput.text.toString().trim()
            if (typed.isEmpty()) {
                Toast.makeText(this, R.string.address_empty, Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            // Without a scheme the address is ambiguous; https is the safe default,
            // and the hint tells local users to type http:// themselves
            val url = if (typed.startsWith("http://") || typed.startsWith("https://")) typed else "https://$typed"
            prefs.edit().putString(KEY_URL, url).apply()
            connect(url)
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = goBack()
        })

        val savedUrl = prefs.getString(KEY_URL, null)
        if (savedUrl.isNullOrEmpty()) showConfig(null) else connect(savedUrl)
    }

    /**
     * A notification tap on a running app lands here rather than in [onCreate].
     * When the app was not running, simply being launched is the whole point of
     * the tap, so there is nothing extra to deliver.
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val tag = intent.getStringExtra(EXTRA_CLICKED_TAG) ?: return
        intent.removeExtra(EXTRA_CLICKED_TAG)
        callJs("window.__mcNotifyClicked", tag)
    }

    // ---------------------------------------------------------------- screens

    /**
     * Shows the address form, pre-filled with the saved address. The saved
     * address itself is left alone, so cancelling out of here changes nothing.
     */
    private fun showConfig(message: String?) {
        urlInput.setText(prefs.getString(KEY_URL, "") ?: "")
        configMessage.text = message ?: ""
        configMessage.visibility = if (message == null) View.GONE else View.VISIBLE
        configLayout.visibility = View.VISIBLE
        webView.visibility = View.GONE
    }

    private fun connect(url: String) {
        configLayout.visibility = View.GONE
        webView.visibility = View.VISIBLE
        webView.loadUrl(url)
    }

    private fun goBack() {
        if (configLayout.visibility == View.VISIBLE) {
            finish()
            return
        }
        if (webView.canGoBack()) {
            webView.goBack()
            return
        }
        // At the first page Back used to drop the saved address; now it asks
        AlertDialog.Builder(this)
            .setTitle(R.string.app_name)
            .setMessage(R.string.leave_prompt)
            .setPositiveButton(R.string.exit) { _, _ -> finish() }
            .setNeutralButton(R.string.change_server) { _, _ -> showConfig(null) }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    // --------------------------------------------------------------- web view

    private fun setUpWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
        }

        installNotificationShim()

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean =
                handleUrl(request?.url)

            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                // Puts window.Notification in place before the page looks for it
                pageStartScript?.let { view?.evaluateJavascript(it, null) }
            }

            // Deprecated, but it is the only one Android 5.x calls
            @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean =
                handleUrl(if (url == null) null else Uri.parse(url))

            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                if (request?.isForMainFrame == true) showConfig(getString(R.string.error_unreachable))
            }

            override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler?, error: SslError?) {
                handler?.cancel()
                showConfig(getString(R.string.error_ssl))
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            /** QR scanning asks the page for the camera; mirror that to Android. */
            override fun onPermissionRequest(request: PermissionRequest?) {
                if (request == null) return
                runOnUiThread {
                    val wanted = request.resources.filter { it == PermissionRequest.RESOURCE_VIDEO_CAPTURE }
                    when {
                        wanted.isEmpty() -> request.deny()
                        hasPermission(Manifest.permission.CAMERA) -> request.grant(wanted.toTypedArray())
                        else -> {
                            pendingCameraRequest = request
                            ActivityCompat.requestPermissions(
                                this@MainActivity, arrayOf(Manifest.permission.CAMERA), REQ_CAMERA
                            )
                        }
                    }
                }
            }
        }

        // Database backups and other files would silently do nothing otherwise
        webView.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            download(url, userAgent, contentDisposition, mimeType)
        }
    }

    /**
     * Keeps mc-webui itself inside the app and hands everything else - links in
     * messages, the packet analyzer, mailto: and friends - to the system.
     *
     * @return true when the URL was handled outside the WebView.
     */
    private fun handleUrl(uri: Uri?): Boolean {
        if (uri == null) return false
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") {
            openExternally(uri)
            return true
        }
        val serverHost = Uri.parse(prefs.getString(KEY_URL, "") ?: "").host
        if (serverHost != null && !serverHost.equals(uri.host, ignoreCase = true)) {
            openExternally(uri)
            return true
        }
        return false
    }

    private fun openExternally(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, R.string.no_app_for_link, Toast.LENGTH_SHORT).show()
        }
    }

    // ---------------------------------------------------------- notifications

    /**
     * Android's WebView implements no Web Notifications API at all, so mc-webui
     * sees `window.Notification` missing and greys its toggle out. We hand the
     * page a stand-in that forwards to Android's own notifications instead.
     *
     * The shim has to be in place before mc-webui reads the permission on
     * DOMContentLoaded, or the toggle stays greyed out for the rest of the
     * page's life. onPageStarted fires as the document begins loading, a whole
     * parse and script pass ahead of that, so it is early enough.
     */
    private fun installNotificationShim() {
        webView.addJavascriptInterface(notificationBridge, BRIDGE_NAME)
        pageStartScript = try {
            assets.open(SHIM_ASSET).bufferedReader().use { it.readText() }
        } catch (e: Exception) {
            null
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_DEFAULT
        ).apply {
            description = getString(R.string.notification_channel_description)
        }
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .createNotificationChannel(channel)
    }

    /** Runs `fn(arg)` in the page, with the argument safely quoted. */
    private fun callJs(fn: String, vararg args: String) {
        val quoted = args.joinToString(", ") { JSONObject.quote(it) }
        webView.evaluateJavascript("if (typeof $fn === 'function') $fn($quoted);", null)
    }

    private fun resolvePermission(callbackId: String) {
        callJs("window.__mcNotifyResolve", callbackId, notificationBridge.getPermission())
    }

    /**
     * The page's `Notification` object, on the Android side. Only the methods
     * mc-webui actually calls are annotated, and nothing else is reachable from
     * JavaScript - worth keeping that way, since the WebView loads whatever
     * address the user typed in.
     */
    private inner class NotificationBridge {

        /**
         * Mirrors the web permission model onto Android's. Before Android 13
         * posting notifications needed no permission at all, so it is granted
         * by definition; after a refusal `shouldShowRequestPermissionRationale`
         * is what separates "ask again" from "blocked for good".
         */
        @JavascriptInterface
        fun getPermission(): String = when {
            Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU -> "granted"
            hasPermission(Manifest.permission.POST_NOTIFICATIONS) -> "granted"
            !prefs.getBoolean(KEY_ASKED_NOTIFICATIONS, false) -> "default"
            ActivityCompat.shouldShowRequestPermissionRationale(
                this@MainActivity, Manifest.permission.POST_NOTIFICATIONS
            ) -> "default"
            else -> "denied"
        }

        @JavascriptInterface
        fun requestPermission(callbackId: String) = runOnUiThread {
            if (getPermission() != "default") {
                resolvePermission(callbackId)
                return@runOnUiThread
            }
            pendingPermissionCallbacks.add(callbackId)
            ActivityCompat.requestPermissions(
                this@MainActivity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFICATIONS
            )
        }

        @JavascriptInterface
        fun notify(tag: String, title: String, body: String, silent: Boolean) = runOnUiThread {
            postNotification(tag, title, body, silent)
        }

        @JavascriptInterface
        fun close(tag: String) = runOnUiThread {
            NotificationManagerCompat.from(this@MainActivity).cancel(tag, NOTIFICATION_ID)
        }
    }

    // areNotificationsEnabled() is false whenever POST_NOTIFICATIONS is missing,
    // so the guard below is the permission check - lint just cannot see that
    @SuppressLint("MissingPermission")
    private fun postNotification(tag: String, title: String, body: String, silent: Boolean) {
        val manager = NotificationManagerCompat.from(this)
        // Covers both the runtime permission and the channel being switched off
        if (!manager.areNotificationsEnabled()) return

        // singleTop plus SINGLE_TOP means a tap returns to the running app
        // instead of starting a second copy of it
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(EXTRA_CLICKED_TAG, tag)
        }
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags = flags or PendingIntent.FLAG_IMMUTABLE
        val contentIntent = PendingIntent.getActivity(this, tag.hashCode(), intent, flags)

        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setSilent(silent)
            .setAutoCancel(true)
            .setContentIntent(contentIntent)
            .build()

        try {
            // The tag makes a new notification replace the matching old one,
            // exactly as the page expects from the web API
            manager.notify(tag, NOTIFICATION_ID, notification)
        } catch (e: SecurityException) {
            // Permission revoked between the check above and here
        }
    }

    // -------------------------------------------------------------- downloads

    private fun download(url: String, userAgent: String?, contentDisposition: String?, mimeType: String?) {
        // Writing to the public Downloads folder needs permission before Android 10
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q &&
            !hasPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        ) {
            pendingDownload = { download(url, userAgent, contentDisposition, mimeType) }
            ActivityCompat.requestPermissions(
                this, arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), REQ_STORAGE
            )
            return
        }
        try {
            val fileName = URLUtil.guessFileName(url, contentDisposition, mimeType)
            val request = DownloadManager.Request(Uri.parse(url)).apply {
                setMimeType(mimeType)
                setTitle(fileName)
                setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                if (!userAgent.isNullOrEmpty()) addRequestHeader("User-Agent", userAgent)
                CookieManager.getInstance().getCookie(url)?.let { addRequestHeader("Cookie", it) }
            }
            (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
            Toast.makeText(this, getString(R.string.downloading, fileName), Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(this, getString(R.string.download_failed, e.message ?: ""), Toast.LENGTH_LONG).show()
        }
    }

    // ------------------------------------------------------------ permissions

    private fun hasPermission(permission: String): Boolean =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        when (requestCode) {
            REQ_CAMERA -> {
                val request = pendingCameraRequest
                pendingCameraRequest = null
                if (granted) {
                    request?.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                } else {
                    request?.deny()
                    Toast.makeText(this, R.string.camera_denied, Toast.LENGTH_LONG).show()
                }
            }
            REQ_STORAGE -> {
                val download = pendingDownload
                pendingDownload = null
                if (granted) download?.invoke()
                else Toast.makeText(this, R.string.storage_denied, Toast.LENGTH_LONG).show()
            }
            REQ_NOTIFICATIONS -> {
                // Recorded before resolving, so "not asked yet" and "refused"
                // stop looking the same to getPermission()
                prefs.edit().putBoolean(KEY_ASKED_NOTIFICATIONS, true).apply()
                val waiting = pendingPermissionCallbacks.toList()
                pendingPermissionCallbacks.clear()
                waiting.forEach { resolvePermission(it) }
                if (!granted) {
                    Toast.makeText(this, R.string.notifications_denied, Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    companion object {
        private const val PREFS = "MC_PREFS"
        private const val KEY_URL = "SERVER_URL"
        private const val KEY_ASKED_NOTIFICATIONS = "ASKED_NOTIFICATIONS"
        private const val REQ_CAMERA = 1
        private const val REQ_STORAGE = 2
        private const val REQ_NOTIFICATIONS = 3

        private const val BRIDGE_NAME = "__mcNotifyBridge"
        private const val SHIM_ASSET = "notification_shim.js"
        private const val CHANNEL_ID = "mc_webui_activity"
        private const val NOTIFICATION_ID = 1
        private const val EXTRA_CLICKED_TAG = "clicked_tag"
    }
}
