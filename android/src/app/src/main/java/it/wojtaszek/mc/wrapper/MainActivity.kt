package it.wojtaszek.mc.wrapper

import android.Manifest
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.view.View
import android.webkit.CookieManager
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
import androidx.core.content.ContextCompat

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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        configLayout = findViewById(R.id.configLayout)
        configMessage = findViewById(R.id.configMessage)
        webView = findViewById(R.id.webView)
        urlInput = findViewById(R.id.urlInput)

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

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean =
                handleUrl(request?.url)

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
        }
    }

    companion object {
        private const val PREFS = "MC_PREFS"
        private const val KEY_URL = "SERVER_URL"
        private const val REQ_CAMERA = 1
        private const val REQ_STORAGE = 2
    }
}
