#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
android_app_directory="$(cd "$script_directory/.." && pwd)"

cd "$android_app_directory"
export NODE_ENV=production
exec pnpm exec expo run:android --variant release --device "$@"
