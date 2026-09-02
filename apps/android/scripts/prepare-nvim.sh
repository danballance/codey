#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_directory="$(cd "$script_directory/.." && pwd)"
repository_directory="$(cd "$app_directory/../.." && pwd)"
lock_file="$app_directory/native-runtime/termux-packages.lock"
module_main="$app_directory/modules/codey-nvim/android/src/main"
jni_target="$module_main/jniLibs/arm64-v8a"
asset_target="$module_main/assets/codey-nvim"
cache_directory="${CODEY_NVIM_CACHE_DIR:-$app_directory/.cache/nvim-runtime}"
temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/codey-nvim-runtime.XXXXXX")"

cleanup() {
  rm -rf -- "$temporary_directory"
}
trap cleanup EXIT

for command_name in ar curl cut find install patchelf readelf sha256sum sort tar touch zip; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 1
  fi
done

mkdir -p "$cache_directory" "$temporary_directory/packages"

while IFS='|' read -r package_name package_version package_url package_sha256; do
  if [[ -z "$package_name" || "$package_name" == \#* ]]; then
    continue
  fi

  archive="$cache_directory/${package_name}_${package_version}_aarch64.deb"
  if [[ -f "$archive" ]]; then
    actual_sha256="$(sha256sum "$archive" | cut -d ' ' -f 1)"
    if [[ "$actual_sha256" != "$package_sha256" ]]; then
      echo "Cached package checksum mismatch: $archive" >&2
      exit 1
    fi
  else
    partial_archive="$archive.partial"
    curl --fail --location --silent --show-error "$package_url" --output "$partial_archive"
    actual_sha256="$(sha256sum "$partial_archive" | cut -d ' ' -f 1)"
    if [[ "$actual_sha256" != "$package_sha256" ]]; then
      echo "Downloaded package checksum mismatch: $package_name" >&2
      exit 1
    fi
    mv "$partial_archive" "$archive"
  fi

  package_root="$temporary_directory/packages/$package_name"
  mkdir -p "$package_root"
  ar p "$archive" data.tar.xz | tar -xJ -C "$package_root"
done < "$lock_file"

jni_stage="$temporary_directory/jniLibs/arm64-v8a"
asset_stage="$temporary_directory/assets/codey-nvim"
license_stage="$asset_stage/licenses"
runtime_stage="$temporary_directory/runtime"
mkdir -p "$jni_stage" "$asset_stage" "$license_stage" "$runtime_stage"

termux_prefix='data/data/com.termux/files/usr'
copy_elf() {
  local package_name="$1"
  local source_path="$2"
  local output_name="$3"
  install -m 0755 \
    "$temporary_directory/packages/$package_name/$termux_prefix/$source_path" \
    "$jni_stage/$output_name"
}

copy_elf neovim libexec/nvim/nvim libcodey_nvim.so
copy_elf libandroid-support lib/libandroid-support.so libandroid-support.so
copy_elf libiconv lib/libiconv.so libiconv.so
copy_elf libunibilium lib/libunibilium.so libunibilium.so
copy_elf libuv lib/libuv.so libuv.so
copy_elf lua51-lpeg lib/liblpeg-5.1.so liblpeg-5.1.so
copy_elf luajit lib/libluajit-5.1.so.2.1.0 libluajit-5.1.so
copy_elf luv lib/libluv.so libluv.so
copy_elf tree-sitter lib/libtree-sitter.so libtree-sitter.so
copy_elf utf8proc lib/libutf8proc.so.3.2.3 libutf8proc.so

copy_license() {
  local package_name="$1"
  local source_path="$2"
  local output_name="$3"
  install -m 0644 \
    "$temporary_directory/packages/$package_name/$termux_prefix/$source_path" \
    "$license_stage/$output_name"
}

copy_license libandroid-support share/doc/libandroid-support/LICENSE.txt libandroid-support-Apache-2.0.txt
copy_license libandroid-support share/doc/libandroid-support/LICENSE.txt.1 libandroid-support-components-MIT.txt
copy_license termux-licenses share/LICENSES/LGPL-2.1.txt libiconv-LGPL-2.1.txt
copy_license termux-licenses share/LICENSES/LGPL-3.0.txt libunibilium-LGPL-3.0.txt
copy_license libuv share/doc/libuv/LICENSE libuv-MIT.txt
copy_license luajit share/doc/luajit/copyright LuaJIT-MIT.txt
copy_license termux-licenses share/LICENSES/Apache-2.0.txt luv-Apache-2.0.txt
copy_license neovim share/doc/neovim/LICENSE.txt Neovim-Apache-2.0-and-Vim.txt
copy_license tree-sitter share/doc/tree-sitter/copyright tree-sitter-MIT.txt
copy_license utf8proc share/doc/utf8proc/copyright utf8proc-MIT.txt
install -m 0644 "$app_directory/native-runtime/LICENSES/lpeg-MIT.txt" "$license_stage/LPeg-MIT.txt"
install -m 0644 "$repository_directory/LICENSE" "$license_stage/Codey-Apache-2.0.txt"
install -m 0644 "$repository_directory/THIRD_PARTY_NOTICES.md" "$asset_stage/THIRD_PARTY_NOTICES.md"

for elf in "$jni_stage"/*.so; do
  patchelf --set-rpath '$ORIGIN' "$elf"
done
patchelf --replace-needed libutf8proc.so.3 libutf8proc.so "$jni_stage/libcodey_nvim.so"
patchelf --set-soname libutf8proc.so "$jni_stage/libutf8proc.so"

runtime_source="$temporary_directory/packages/neovim/$termux_prefix/share/nvim/runtime"
tar --exclude='./parser' -C "$runtime_source" -cf - . | tar -C "$runtime_stage" -xf -
source_date_epoch="${SOURCE_DATE_EPOCH:-315532800}"
if [[ ! "$source_date_epoch" =~ ^[0-9]+$ ]] || (( source_date_epoch < 315532800 )); then
  echo 'SOURCE_DATE_EPOCH must be an integer at or after 1980-01-01 for ZIP portability.' >&2
  exit 1
fi
if find "$runtime_stage" -type l -print -quit | grep -q .; then
  echo 'NeoVim runtime contains a symbolic link; deterministic packaging requires regular files.' >&2
  exit 1
fi
find "$runtime_stage" -type d -exec chmod 0755 {} +
find "$runtime_stage" -type f -exec chmod 0644 {} +
find "$runtime_stage" -exec touch -h -d "@$source_date_epoch" {} +
(
  cd "$runtime_stage"
  LC_ALL=C find . -mindepth 1 -print | LC_ALL=C sort | TZ=UTC zip -q -X "$asset_stage/runtime.zip" -@
)
runtime_sha256="$(sha256sum "$asset_stage/runtime.zip" | cut -d ' ' -f 1)"
printf 'version=0.12.5\nruntimeSha256=%s\n' \
  "$runtime_sha256" > "$asset_stage/bundle.properties"

system_libraries=' libc.so libdl.so libm.so liblog.so '
for elf in "$jni_stage"/*.so; do
  if ! readelf -h "$elf" | grep -qE 'Machine:[[:space:]]+AArch64'; then
    echo "Not an arm64 ELF: $elf" >&2
    exit 1
  fi
  if ! readelf -h "$elf" | grep -qE 'Type:[[:space:]]+DYN'; then
    echo "Not an arm64 PIE/shared object: $elf" >&2
    exit 1
  fi
  if readelf -d "$elf" | grep -q 'TEXTREL'; then
    echo "ELF contains text relocations: $elf" >&2
    exit 1
  fi
  if readelf -d "$elf" | grep -q '/data/data/com.termux'; then
    echo "ELF still contains the Termux runpath: $elf" >&2
    exit 1
  fi
  while read -r needed; do
    if [[ "$system_libraries" == *" $needed "* || -f "$jni_stage/$needed" ]]; then
      continue
    fi
    echo "Unresolved native dependency $needed required by $elf" >&2
    exit 1
  done < <(readelf -d "$elf" | sed -n 's/.*Shared library: \[\([^]]*\)\].*/\1/p')

  while read -r alignment; do
    if (( alignment < 0x4000 )); then
      echo "ELF is not 16 KiB page compatible: $elf (LOAD alignment $alignment)" >&2
      exit 1
    fi
  done < <(readelf -lW "$elf" | awk '$1 == "LOAD" { print $NF }')
done

if ! readelf -l "$jni_stage/libcodey_nvim.so" | grep -q '/system/bin/linker64'; then
  echo 'NeoVim does not use the Android arm64 dynamic linker.' >&2
  exit 1
fi

case "$jni_target" in
  "$app_directory/modules/codey-nvim/android/src/main/jniLibs/arm64-v8a") ;;
  *) echo "Refusing to replace unexpected JNI target: $jni_target" >&2; exit 1 ;;
esac
case "$asset_target" in
  "$app_directory/modules/codey-nvim/android/src/main/assets/codey-nvim") ;;
  *) echo "Refusing to replace unexpected asset target: $asset_target" >&2; exit 1 ;;
esac

rm -rf -- "$jni_target" "$asset_target"
mkdir -p "$(dirname "$jni_target")" "$(dirname "$asset_target")"
mv "$jni_stage" "$jni_target"
mv "$asset_stage" "$asset_target"

echo "Prepared NeoVim 0.12.5 native runtime in $module_main"
