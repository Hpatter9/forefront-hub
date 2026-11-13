#!/usr/bin/env bash
# Builds the Keystone phone app (keystone.apk) with Google's Android build tools: no Gradle, no libraries.
#   ANDROID_TOOLS  folder with aapt2, d8, zipalign, apksigner (build-tools)
#   ANDROID_JAR    the platform's android.jar
#   KEYSTORE       the signing key (default signing/keystone.jks, kept in the repo by Hunter's choice so every
#                  update installs over the last one; an update signed with a different key won't install)
set -euo pipefail
cd "$(dirname "$0")"
T="${ANDROID_TOOLS:?set ANDROID_TOOLS}"; JAR="${ANDROID_JAR:?set ANDROID_JAR}"; KS="${KEYSTORE:-signing/keystone.jks}"
OUT="${OUT:-build}"; rm -rf "$OUT"; mkdir -p "$OUT/classes" "$OUT/dex"
[ -f "$KS" ] || keytool -genkeypair -keystore "$KS" -storepass keystone -keypass keystone -alias keystone -keyalg RSA -keysize 2048 -validity 20000 -dname "CN=Keystone" >/dev/null 2>&1
"$T/aapt2" compile --dir res -o "$OUT/res.zip"
"$T/aapt2" link -o "$OUT/base.apk" -I "$JAR" --min-sdk-version 26 --target-sdk-version 34 --manifest AndroidManifest.xml -A assets "$OUT/res.zip"
javac -nowarn --release 11 -cp "$JAR" -d "$OUT/classes" $(find src -name '*.java') 2>&1 | grep -v "^Picked up\|^Note:" || true
"$T/d8" --lib "$JAR" --min-api 26 --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')
(cd "$OUT/dex" && zip -q -j ../base.apk classes.dex)
"$T/zipalign" -f 4 "$OUT/base.apk" "$OUT/aligned.apk"
"$T/apksigner" sign --min-sdk-version 26 --ks "$KS" --ks-pass pass:keystone --key-pass pass:keystone --out "$OUT/keystone.apk" "$OUT/aligned.apk"
"$T/apksigner" verify "$OUT/keystone.apk" && ls -la "$OUT/keystone.apk"
