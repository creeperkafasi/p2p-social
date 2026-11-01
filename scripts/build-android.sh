#!/bin/bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

# Java detection (Gradle requires Java 17-21, Java 25+ / 27 is unsupported by AGP)
if [ -d "/usr/lib/jvm/java-21-openjdk" ]; then
  export JAVA_HOME="/usr/lib/jvm/java-21-openjdk"
elif [ -z "$JAVA_HOME" ]; then
  echo "WARNING: JAVA_HOME is not set, relying on system default java."
fi
if [ -n "$JAVA_HOME" ]; then
  export PATH="$JAVA_HOME/bin:$PATH"
fi

# Android SDK & NDK detection
if [ -z "$ANDROID_HOME" ] && [ -d "/opt/android-sdk" ]; then
  export ANDROID_HOME="/opt/android-sdk"
fi
if [ -z "$NDK_HOME" ]; then
  if [ -d "/opt/android-sdk/ndk/27.0.12077973" ]; then
    export NDK_HOME="/opt/android-sdk/ndk/27.0.12077973"
  elif [ -n "$ANDROID_HOME" ] && [ -d "$ANDROID_HOME/ndk" ]; then
    LATEST_NDK=$(ls -d "$ANDROID_HOME/ndk/"* 2>/dev/null | sort -V | tail -n 1 || true)
    if [ -n "$LATEST_NDK" ]; then
      export NDK_HOME="$LATEST_NDK"
    fi
  fi
fi

TARGET=${1:-aarch64}

echo "========================================="
echo "  p2p-social: Building Android App"
echo "========================================="
echo "Target ABI:   $TARGET"
echo "JAVA_HOME:    ${JAVA_HOME:-default}"
echo "ANDROID_HOME: ${ANDROID_HOME:-not found}"
echo "NDK_HOME:     ${NDK_HOME:-not found}"
echo "========================================="

# Ensure local.properties exists for Gradle
mkdir -p src-tauri/gen/android
if [ ! -f src-tauri/gen/android/local.properties ] && [ -n "$ANDROID_HOME" ]; then
  echo "sdk.dir=$ANDROID_HOME" > src-tauri/gen/android/local.properties
  if [ -n "$NDK_HOME" ]; then
    echo "ndk.dir=$NDK_HOME" >> src-tauri/gen/android/local.properties
  fi
fi

# Ensure Bare runtime binaries are present in jniLibs
mkdir -p src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a
mkdir -p src-tauri/gen/android/app/src/main/jniLibs/x86_64

prepare_bare_binary() {
  local arch="$1"
  local jni_dir="$2"
  local dest="$jni_dir/libbare.so"

  if [ -f "$dest" ]; then
    return 0
  fi

  local mod_bin="node_modules/bare-runtime-android-$arch/bin/bare"
  if [ ! -f "$mod_bin" ]; then
    echo "Downloading official Bare Android runtime ($arch)..."
    TMP_PACK=$(mktemp -d)
    npm pack "bare-runtime-android-$arch@1.36.0" --pack-destination "$TMP_PACK" > /dev/null
    tar -xzf "$TMP_PACK"/*.tgz -C "$TMP_PACK"
    mkdir -p "node_modules/bare-runtime-android-$arch/bin"
    cp "$TMP_PACK/package/bin/bare" "$mod_bin"
    rm -rf "$TMP_PACK"
  fi

  echo "Installing stripped Bare binary into $jni_dir/libbare.so..."
  cp "$mod_bin" "$dest"
  strip "$dest" 2>/dev/null || true
  chmod 755 "$dest"
}

prepare_bare_binary "arm64" "src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a"
prepare_bare_binary "x64"   "src-tauri/gen/android/app/src/main/jniLibs/x86_64"

# Ensure backend assets zip is up to date
mkdir -p src-tauri/gen/android/app/src/main/assets
echo "Syncing backend assets bundle (backend.zip)..."
zip -q -r -FS src-tauri/gen/android/app/src/main/assets/backend.zip backend node_modules \
  -x "node_modules/@tauri-apps*" \
  -x "node_modules/bare-runtime-*" \
  -x "node_modules/.bin*" \
  -x "node_modules/.package-lock.json" \
  -x "node_modules/qrcode*" \
  -x "node_modules/esbuild*"

echo "Running Tauri Android build..."
npx tauri android build --target "$TARGET" --apk -d --ci

APK_PATH="src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk"
if [ -f "$APK_PATH" ]; then
  echo ""
  echo "========================================="
  echo " BUILD SUCCESSFUL!"
  echo " APK location: $DIR/$APK_PATH"
  echo " Size: $(du -h "$APK_PATH" | cut -f1)"
  echo "========================================="
fi
