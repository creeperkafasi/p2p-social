package dev.p2psocial.app

import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.system.Os
import android.util.Log
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.enableEdgeToEdge
import java.io.File
import java.io.FileOutputStream
import java.util.zip.ZipInputStream

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    setupP2PEnvironment()
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    Log.i("p2p-social", "Registering AndroidUpdater JavaScript interface...")
    val updateManager = AndroidUpdateManager(this, webView)
    webView.addJavascriptInterface(updateManager, "AndroidUpdater")
    webView.post {
      setupOtaInterceptor(webView)
    }
  }

  private fun setupOtaInterceptor(webView: WebView) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val originalClient = try {
      webView.webViewClient
    } catch (e: Exception) {
      Log.w("p2p-social", "Cannot access webViewClient", e)
      null
    } ?: return

    val otaDir = File(filesDir, "ui")
    webView.webViewClient = object : WebViewClient() {
      override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        val url = request.url
        val host = url.host ?: ""
        if (host == "tauri.localhost" || host == "localhost" || url.scheme == "tauri") {
          val path = (url.path ?: "").removePrefix("/")
          val relPath = if (path.isEmpty() || path == "index.html") "index.html" else path
          val otaFile = File(otaDir, relPath)
          if (otaFile.exists() && otaFile.isFile) {
            try {
              val mime = getMimeType(relPath)
              val headers = mutableMapOf(
                "Access-Control-Allow-Origin" to "*",
                "Cache-Control" to "no-cache, no-store, must-revalidate"
              )
              Log.d("p2p-social-ota", "Serving OTA asset: $relPath (${otaFile.length()} bytes)")
              return WebResourceResponse(mime, "UTF-8", 200, "OK", headers, otaFile.inputStream())
            } catch (e: Exception) {
              Log.w("p2p-social-ota", "Failed to stream OTA file $relPath", e)
            }
          }
        }
        return originalClient.shouldInterceptRequest(view, request)
      }

      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        return originalClient.shouldOverrideUrlLoading(view, request)
      }

      override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
        originalClient.onPageStarted(view, url, favicon)
      }

      override fun onPageFinished(view: WebView, url: String) {
        originalClient.onPageFinished(view, url)
      }

      override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        originalClient.onReceivedError(view, request, error)
      }
    }
  }

  private fun getMimeType(path: String): String {
    return when {
      path.endsWith(".html") -> "text/html"
      path.endsWith(".css") -> "text/css"
      path.endsWith(".js") || path.endsWith(".mjs") -> "application/javascript"
      path.endsWith(".json") -> "application/json"
      path.endsWith(".svg") -> "image/svg+xml"
      path.endsWith(".png") -> "image/png"
      path.endsWith(".jpg") || path.endsWith(".jpeg") -> "image/jpeg"
      path.endsWith(".webp") -> "image/webp"
      path.endsWith(".gif") -> "image/gif"
      path.endsWith(".woff2") -> "font/woff2"
      path.endsWith(".woff") -> "font/woff"
      path.endsWith(".ttf") -> "font/ttf"
      else -> "application/octet-stream"
    }
  }

  private fun setupP2PEnvironment() {
    val filesPath = filesDir.absolutePath
    val storageDir = File(filesDir, "storage")
    if (!storageDir.exists()) storageDir.mkdirs()

    val backendMarker = File(filesDir, "backend/index.js")
    val lastUpdateTime = try {
      packageManager.getPackageInfo(packageName, 0).lastUpdateTime
    } catch (_: Exception) {
      0L
    }
    val versionMarker = File(filesDir, ".bundle_${BuildConfig.VERSION_CODE}_$lastUpdateTime")
    if (!versionMarker.exists() || !backendMarker.exists()) {
      Log.i("p2p-social", "New APK build detected; clearing old OTA cache...")
      val otaDir = File(filesDir, "ui")
      if (otaDir.exists()) otaDir.deleteRecursively()
      val otaVerMarker = File(filesDir, ".ota_version")
      if (otaVerMarker.exists()) otaVerMarker.delete()

      Log.i("p2p-social", "Extracting backend bundle from assets...")
      try {
        assets.open("backend.zip").use { input ->
          ZipInputStream(input).use { zip ->
            var entry = zip.nextEntry
            while (entry != null) {
              val outFile = File(filesDir, entry.name)
              if (entry.isDirectory) {
                outFile.mkdirs()
              } else {
                outFile.parentFile?.mkdirs()
                FileOutputStream(outFile).use { out ->
                  zip.copyTo(out)
                }
              }
              zip.closeEntry()
              entry = zip.nextEntry
            }
          }
        }
        versionMarker.createNewFile()
        Log.i("p2p-social", "Backend extraction complete.")
      } catch (e: Exception) {
        Log.e("p2p-social", "Failed to extract backend bundle", e)
      }
    }

    val nativeLibDir = applicationInfo.nativeLibraryDir
    val bareBin = File(nativeLibDir, "libbare.so")
    Log.i("p2p-social", "nativeLibraryDir: $nativeLibDir (libbare.so exists: ${bareBin.exists()})")
    if (!bareBin.exists()) {
      val files = File(nativeLibDir).listFiles()?.map { it.name }
      Log.w("p2p-social", "nativeLibDir listing: $files")
    }

    try {
      Os.setenv("BARE_BIN", bareBin.absolutePath, true)
      Os.setenv("LD_LIBRARY_PATH", nativeLibDir, true)
      Os.setenv("P2P_SOCIAL_ROOT", filesPath, true)
      Os.setenv("P2P_SOCIAL_STORAGE", storageDir.absolutePath, true)
    } catch (e: Exception) {
      Log.e("p2p-social", "Failed to set environment variables", e)
    }
  }
}
