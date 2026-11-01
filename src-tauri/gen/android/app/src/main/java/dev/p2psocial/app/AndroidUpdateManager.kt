package dev.p2psocial.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

class AndroidUpdateManager(
  private val activity: Activity,
  private val webView: WebView
) {

  private val tag = "p2p-social-updater"

  @JavascriptInterface
  fun isAndroid(): Boolean = true

  @JavascriptInterface
  fun getAppVersion(): String = BuildConfig.VERSION_NAME

  @JavascriptInterface
  fun checkForUpdates(repo: String): String {
    val result = JSONObject()
    try {
      val cleanRepo = repo.trim().removePrefix("https://github.com/").removePrefix("github.com/").trim('/')
      val apiUrl = "https://api.github.com/repos/$cleanRepo/releases/latest"
      Log.i(tag, "Checking for updates at $apiUrl...")

      val url = URL(apiUrl)
      val conn = url.openConnection() as HttpURLConnection
      conn.requestMethod = "GET"
      conn.setRequestProperty("User-Agent", "p2p-social-android-app")
      conn.setRequestProperty("Accept", "application/vnd.github.v3+json")
      conn.connectTimeout = 10000
      conn.readTimeout = 15000

      val code = conn.responseCode
      if (code != 200) {
        val errorStream = conn.errorStream?.bufferedReader()?.use { it.readText() } ?: ""
        Log.w(tag, "GitHub API returned status $code: $errorStream")
        result.put("success", false)
        result.put("error", "GitHub API error: HTTP $code")
        return result.toString()
      }

      val body = conn.inputStream.bufferedReader().use { it.readText() }
      val json = JSONObject(body)

      val tagName = json.optString("tag_name", "")
      val releaseName = json.optString("name", tagName)
      val releaseNotes = json.optString("body", "")
      val assets = json.optJSONArray("assets")

      var apkUrl: String? = null
      var apkName: String? = null
      var apkSize: Long = 0

      if (assets != null) {
        for (i in 0 until assets.length()) {
          val asset = assets.getJSONObject(i)
          val name = asset.optString("name", "")
          if (name.endsWith(".apk", ignoreCase = true)) {
            apkUrl = asset.optString("browser_download_url", "")
            apkName = name
            apkSize = asset.optLong("size", 0L)
            // Prefer arm64 or universal over generic x86
            if (name.contains("arm64", ignoreCase = true) || name.contains("universal", ignoreCase = true)) {
              break
            }
          }
        }
      }

      val currentVersion = BuildConfig.VERSION_NAME.removePrefix("v").trim()
      val latestVersion = tagName.removePrefix("v").trim()
      val hasUpdate = isNewerVersion(latestVersion, currentVersion)

      result.put("success", true)
      result.put("currentVersion", currentVersion)
      result.put("latestVersion", latestVersion)
      result.put("tagName", tagName)
      result.put("releaseName", releaseName)
      result.put("releaseNotes", releaseNotes)
      result.put("hasUpdate", hasUpdate)
      result.put("apkUrl", apkUrl ?: "")
      result.put("apkName", apkName ?: "")
      result.put("apkSize", apkSize)

      Log.i(tag, "Update check result: current=$currentVersion, latest=$latestVersion, hasUpdate=$hasUpdate, apk=$apkUrl")
      return result.toString()
    } catch (e: Exception) {
      Log.e(tag, "Failed to check for updates", e)
      result.put("success", false)
      result.put("error", e.message ?: "Unknown network error")
      return result.toString()
    }
  }

  @JavascriptInterface
  fun downloadAndInstall(apkUrl: String) {
    Log.i(tag, "Starting APK download from: $apkUrl")
    thread(name = "apk-downloader") {
      try {
        var currentUrl = apkUrl
        var conn: HttpURLConnection
        var redirects = 0
        val maxRedirects = 6

        // Handle HTTP 301/302 redirects
        while (true) {
          val url = URL(currentUrl)
          conn = url.openConnection() as HttpURLConnection
          conn.instanceFollowRedirects = true
          conn.setRequestProperty("User-Agent", "p2p-social-android-app")
          conn.connectTimeout = 15000
          conn.readTimeout = 30000

          val status = conn.responseCode
          if (status == HttpURLConnection.HTTP_MOVED_PERM ||
              status == HttpURLConnection.HTTP_MOVED_TEMP ||
              status == 307 || status == 308
          ) {
            val newUrl = conn.getHeaderField("Location")
            conn.disconnect()
            if (newUrl != null && redirects < maxRedirects) {
              currentUrl = newUrl
              redirects++
              continue
            }
          }
          break
        }

        val totalLength = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
          conn.contentLengthLong
        } else {
          conn.contentLength.toLong()
        }

        val apkFile = File(activity.cacheDir, "update.apk")
        if (apkFile.exists()) apkFile.delete()

        var downloaded: Long = 0
        val buffer = ByteArray(8192)
        var lastPercent = -1

        conn.inputStream.use { input ->
          FileOutputStream(apkFile).use { output ->
            var read: Int
            while (input.read(buffer).also { read = it } != -1) {
              output.write(buffer, 0, read)
              downloaded += read

              if (totalLength > 0) {
                val percent = ((downloaded * 100) / totalLength).toInt()
                if (percent != lastPercent) {
                  lastPercent = percent
                  activity.runOnUiThread {
                    webView.evaluateJavascript("window.__onUpdateProgress?.($percent, $downloaded, $totalLength)", null)
                  }
                }
              }
            }
            output.flush()
          }
        }

        Log.i(tag, "APK downloaded successfully (${apkFile.length()} bytes)")
        activity.runOnUiThread {
          webView.evaluateJavascript("window.__onUpdateProgress?.(100, ${apkFile.length()}, ${apkFile.length()})", null)
        }

        // Check unknown sources installation permission on Android 8.0+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          if (!activity.packageManager.canRequestPackageInstalls()) {
            Log.w(tag, "REQUEST_INSTALL_PACKAGES permission not yet granted by user")
            activity.runOnUiThread {
              webView.evaluateJavascript("window.__onUpdateStatus?.('permission_required')", null)
            }
            val settingsIntent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
              data = Uri.parse("package:${activity.packageName}")
              addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            activity.startActivity(settingsIntent)
            return@thread
          }
        }

        // Launch system package installer
        val contentUri = FileProvider.getUriForFile(
          activity,
          "${activity.packageName}.fileprovider",
          apkFile
        )
        val installIntent = Intent(Intent.ACTION_VIEW).apply {
          setDataAndType(contentUri, "application/vnd.android.package-archive")
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        activity.startActivity(installIntent)

        activity.runOnUiThread {
          webView.evaluateJavascript("window.__onUpdateStatus?.('installing')", null)
        }
      } catch (e: Exception) {
        Log.e(tag, "Download and install failed", e)
        activity.runOnUiThread {
          val errorMsg = JSONObject.quote(e.message ?: "Download failed")
          webView.evaluateJavascript("window.__onUpdateError?.($errorMsg)", null)
        }
      }
    }
  }

  private fun isNewerVersion(latest: String, current: String): Boolean {
    if (latest.isBlank() || current.isBlank()) return false
    if (latest == current) return false
    val latestParts = latest.split('.').mapNotNull { it.toIntOrNull() }
    val currentParts = current.split('.').mapNotNull { it.toIntOrNull() }
    val maxLen = maxOf(latestParts.size, currentParts.size)
    for (i in 0 until maxLen) {
      val l = latestParts.getOrElse(i) { 0 }
      val c = currentParts.getOrElse(i) { 0 }
      if (l > c) return true
      if (l < c) return false
    }
    return false
  }
}
