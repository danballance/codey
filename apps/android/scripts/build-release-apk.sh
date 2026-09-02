#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_directory="$(cd "$script_directory/.." && pwd)"

cd "$app_directory"
CODEY_BUILD_PROFILE=standalone pnpm run prebuild:clean
NODE_ENV=production ./android/gradlew -p android assembleRelease

echo "Release APK: $app_directory/android/app/build/outputs/apk/release/app-release.apk"
