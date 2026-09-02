#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
android_app_directory="$(cd "$script_directory/.." && pwd)"

cd "$android_app_directory"
pnpm run build:apk
apk="$android_app_directory/android/app/build/outputs/apk/release/app-release.apk"
exec adb "$@" install -r "$apk"
