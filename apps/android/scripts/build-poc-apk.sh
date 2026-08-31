#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_directory="$(cd "$script_directory/.." && pwd)"

cd "$app_directory"
pnpm run prepare:nvim:poc
CODEY_BUILD_PROFILE=poc pnpm exec expo prebuild --clean --platform android
NODE_ENV=production ./android/gradlew -p android assembleRelease

echo "POC APK: $app_directory/android/app/build/outputs/apk/release/app-release.apk"
