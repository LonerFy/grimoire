package app.grimoire.notes

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.ContextCompat
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

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

    // --- Jeton GitHub : chiffré par une clé AES-GCM qui ne quitte jamais l'Android Keystore ---
    private val keyAlias = "grimoire_github_token"
    private val securePrefs get() = getSharedPreferences("grimoire_secure", MODE_PRIVATE)

    private fun keystoreKey(create: Boolean): SecretKey? {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(keyAlias, null) as? SecretKey)?.let { return it }
        if (!create) return null
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return gen.generateKey()
    }

    /** Efface le jeton chiffré et la clé : après une perte de clé, rien ne doit rester qui boucle en erreur. */
    private fun wipeSecret() {
        securePrefs.edit().remove("token").commit()
        try { KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(keyAlias) } catch (e: Exception) { }
    }

    // Réponses en JSON {"s": ok | none | lost | err, "v": valeur}. Jamais de valeur dans un message d'erreur.
    private fun secretReply(status: String, value: String? = null): String =
        org.json.JSONObject().put("s", status).apply { if (value != null) put("v", value) }.toString()

    inner class Bridge {
        @JavascriptInterface
        fun secretSet(value: String): String = try {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.ENCRYPT_MODE, keystoreKey(true))
            val ct = c.doFinal(value.toByteArray(Charsets.UTF_8))
            val blob = Base64.encodeToString(c.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP)
            if (securePrefs.edit().putString("token", blob).commit()) secretReply("ok") else secretReply("err")
        } catch (e: Exception) { secretReply("err") }

        /** none = rien d'enregistré ; lost = clé perdue ou illisible (l'entrée est alors effacée). */
        @JavascriptInterface
        fun secretGet(): String {
            val blob = securePrefs.getString("token", null) ?: return secretReply("none")
            return try {
                val parts = blob.split(":")
                if (parts.size != 2) throw GeneralSecurityException("format")
                val key = keystoreKey(false) ?: throw GeneralSecurityException("clé absente")
                val c = Cipher.getInstance("AES/GCM/NoPadding")
                c.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)))
                secretReply("ok", String(c.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), Charsets.UTF_8))
            } catch (e: GeneralSecurityException) {
                wipeSecret(); secretReply("lost")
            } catch (e: IllegalArgumentException) {
                wipeSecret(); secretReply("lost")
            } catch (e: Exception) {
                secretReply("err")
            }
        }

        @JavascriptInterface
        fun secretDelete(): String = try { wipeSecret(); secretReply("ok") } catch (e: Exception) { secretReply("err") }

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
