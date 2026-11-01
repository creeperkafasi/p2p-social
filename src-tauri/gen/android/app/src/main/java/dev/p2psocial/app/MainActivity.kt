package dev.p2psocial.app

import android.os.Bundle
import android.system.Os
import android.util.Log
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

  private fun setupP2PEnvironment() {
    val filesPath = filesDir.absolutePath
    val storageDir = File(filesDir, "storage")
    if (!storageDir.exists()) storageDir.mkdirs()

    val backendMarker = File(filesDir, "backend/index.js")
    val versionMarker = File(filesDir, ".bundle_v${BuildConfig.VERSION_CODE}")
    if (!versionMarker.exists() || !backendMarker.exists()) {
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
