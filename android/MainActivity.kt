package app.grimoire.notes

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.ContextCompat

/**
 * Remplace le MainActivity généré par `tauri android init` (voir scripts/android-patch.js).
 * Expose à la page un objet `GrimoireAndroid` : accès aux fichiers, partage, texte reçu.
 */
class MainActivity : TauriActivity() {
    private var shared: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        readShare(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        readShare(intent)
    }

    private fun readShare(i: Intent?) {
        if (i?.action == Intent.ACTION_SEND && i.type?.startsWith("text/") == true) {
            val text = i.getStringExtra(Intent.EXTRA_TEXT)
            val subject = i.getStringExtra(Intent.EXTRA_SUBJECT)
            if (!text.isNullOrBlank()) {
                shared = if (subject.isNullOrBlank()) text else subject + "\n\n" + text
            }
        }
    }

    override fun onWebViewCreate(webView: WebView) {
        webView.addJavascriptInterface(Bridge(), "GrimoireAndroid")
    }

    inner class Bridge {
        @JavascriptInterface
        fun hasFileAccess(): Boolean =
            if (Build.VERSION.SDK_INT >= 30) Environment.isExternalStorageManager()
            else ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED

        @JavascriptInterface
        fun requestFileAccess() {
            runOnUiThread {
                if (Build.VERSION.SDK_INT >= 30) {
                    val uri = Uri.parse("package:" + packageName)
                    try {
                        startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, uri))
                    } catch (e: Exception) {
                        startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
                    }
                } else {
                    requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE, Manifest.permission.READ_EXTERNAL_STORAGE)) { }
                }
            }
        }

        @JavascriptInterface
        fun shareText(title: String, text: String) {
            runOnUiThread {
                val send = Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_SUBJECT, title)
                    putExtra(Intent.EXTRA_TEXT, text)
                }
                startActivity(Intent.createChooser(send, title))
            }
        }

        /** Texte reçu par « Partager vers Grimoire » ; vidé une fois lu. */
        @JavascriptInterface
        fun takeSharedText(): String {
            val t = shared ?: ""
            shared = null
            return t
        }
    }
}
