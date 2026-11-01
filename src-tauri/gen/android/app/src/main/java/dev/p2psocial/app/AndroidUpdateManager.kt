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
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.ZipInputStream
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
  fun getOtaVersion(): String {
    val verFile = File(activity.filesDir, ".ota_version")
    return if (verFile.exists()) {
      verFile.readText().trim()
    } else {
      getAppVersion()
    }
  }

  @JavascriptInterface
  fun reloadWebView() {
    activity.runOnUiThread {
      webView.reload()
    }
  }

  @JavascriptInterface
  fun rollbackOta(): Boolean {
    val otaDir = File(activity.filesDir, "ui")
    val verFile = File(activity.filesDir, ".ota_version")
    if (otaDir.exists()) otaDir.deleteRecursively()
    if (verFile.exists()) verFile.delete()
    reloadWebView()
    return true
  }

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

      var otaUrl: String? = null
      var otaName: String? = null
      var otaSize: Long = 0

      if (assets != null) {
        for (i in 0 until assets.length()) {
          val asset = assets.getJSONObject(i)
          val name = asset.optString("name", "")
          val downloadUrl = asset.optString("browser_download_url", "")
          val size = asset.optLong("size", 0L)

          if (name.endsWith(".apk", ignoreCase = true)) {
            if (apkUrl == null || name.contains("arm64", ignoreCase = true) || name.contains("universal", ignoreCase = true)) {
              apkUrl = downloadUrl
              apkName = name
              apkSize = size
            }
          } else if (name.endsWith(".zip", ignoreCase = true) && (name.contains("ota", ignoreCase = true) || name.contains("bundle", ignoreCase = true))) {
            otaUrl = downloadUrl
            otaName = name
            otaSize = size
          }
        }
      }

      val currentVersion = BuildConfig.VERSION_NAME.removePrefix("v").trim()
      val currentOtaVersion = getOtaVersion().removePrefix("v").trim()
      val latestVersion = tagName.removePrefix("v").trim()

      val hasNativeUpdate = isNewerVersion(latestVersion, currentVersion)
      val hasOtaUpdate = otaUrl != null && isNewerVersion(latestVersion, currentOtaVersion)

      result.put("success", true)
      result.put("currentVersion", currentVersion)
      result.put("currentOtaVersion", currentOtaVersion)
      result.put("latestVersion", latestVersion)
      result.put("tagName", tagName)
      result.put("releaseName", releaseName)
      result.put("releaseNotes", releaseNotes)
      result.put("hasUpdate", hasNativeUpdate || hasOtaUpdate)
      result.put("hasNativeUpdate", hasNativeUpdate)
      result.put("hasOtaUpdate", hasOtaUpdate)
      result.put("apkUrl", apkUrl ?: "")
      result.put("apkName", apkName ?: "")
      result.put("apkSize", apkSize)
      result.put("otaUrl", otaUrl ?: "")
      result.put("otaName", otaName ?: "")
      result.put("otaSize", otaSize)

      Log.i(tag, "Update check result: current=$currentVersion, otaCurrent=$currentOtaVersion, latest=$latestVersion, hasOta=$hasOtaUpdate, hasNative=$hasNativeUpdate")
      return result.toString()
    } catch (e: Exception) {
      Log.e(tag, "Failed to check for updates", e)
      result.put("success", false)
      result.put("error", e.message ?: "Unknown network error")
      return result.toString()
    }
  }

  @JavascriptInterface
  fun downloadAndApplyOta(otaUrl: String, otaVersion: String) {
    Log.i(tag, "Starting silent OTA download: url=$otaUrl, version=$otaVersion")
    thread(name = "ota-downloader") {
      try {
        var currentUrl = otaUrl
        var conn: HttpURLConnection
        var redirects = 0
        val maxRedirects = 6

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

        val otaZip = File(activity.cacheDir, "ota_download.zip")
        if (otaZip.exists()) otaZip.delete()

        conn.inputStream.use { input ->
          FileOutputStream(otaZip).use { output ->
            input.copyTo(output)
          }
        }

        Log.i(tag, "OTA zip downloaded (${otaZip.length()} bytes). Unpacking...")

        val uiDir = File(activity.filesDir, "ui")
        if (!uiDir.exists()) uiDir.mkdirs()

        ZipInputStream(otaZip.inputStream()).use { zip ->
          var entry = zip.nextEntry
          while (entry != null) {
            val name = entry.name
            val outFile = when {
              name.startsWith("ui/") -> File(activity.filesDir, name)
              name.startsWith("backend/") -> File(activity.filesDir, name)
              else -> File(uiDir, name)
            }
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

        File(activity.filesDir, ".ota_version").writeText(otaVersion.trim())
        otaZip.delete()

        Log.i(tag, "OTA update $otaVersion successfully applied to internal storage!")
        activity.runOnUiThread {
          webView.evaluateJavascript("window.__onOtaApplied?.('$otaVersion')", null)
        }
      } catch (e: Exception) {
        Log.e(tag, "Failed to apply OTA update", e)
        activity.runOnUiThread {
          val errorMsg = JSONObject.quote(e.message ?: "OTA download failed")
          webView.evaluateJavascript("window.__onOtaError?.($errorMsg)", null)
        }
      }
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