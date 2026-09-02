#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_directory="$(cd "$script_directory/.." && pwd)"

cd "$app_directory"
CODEY_BUILD_PROFILE=standalone pnpm run prebuild:clean
pnpm run native:test

NODE_ENV=development ./android/gradlew -p android assembleDebug
mkdir -p dist
mv android/app/build/outputs/apk/debug/app-debug.apk dist/app-debug.apk

# Debug and release app intermediates do not need to coexist. Keeping the
# verified APK outside app/build lets the release build run in constrained
# development environments without repeating the prepared prebuild.
./android/gradlew -p android :app:clean
NODE_ENV=production ./android/gradlew -p android assembleRelease
