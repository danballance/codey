#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_directory="$(cd "$script_directory/.." && pwd)"
repository_directory="$(cd "$app_directory/../.." && pwd)"
lock_file="$app_directory/native-runtime/termux-packages.lock"
native_library_lock_file="$app_directory/native-runtime/native-libraries.lock"
dispatcher_source="$app_directory/native-runtime/codey-exec-dispatcher.c"
kickstart_directory="$app_directory/native-runtime/kickstart-codey"
kickstart_lock_file="$kickstart_directory/upstream.lock"
kickstart_init_file="$kickstart_directory/init.lua"
module_main="$app_directory/modules/codey-nvim/android/src/main"
jni_target="$module_main/jniLibs/arm64-v8a"
asset_target="$module_main/assets/codey-nvim"
cache_directory="${CODEY_NVIM_CACHE_DIR:-$app_directory/.cache/nvim-runtime}"
temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/codey-nvim-runtime.XXXXXX")"

nvim_version='0.12.5'
bundle_schema_version='2'
android_ndk_revision='27.1.12297006'
android_api_level='30'
expected_tree_sitter_commit='427e9222363d07c32d6db6169e4049c28d58d141'
command_aliases=(
  git
  git-remote-http
  git-remote-https
  git-sh-i18n--envsubst
  git-submodule
  rg
  stylua
  lua-language-server
)
parser_languages=(bash c diff html lua luadoc markdown markdown_inline query vim vimdoc)

cleanup() {
  rm -rf -- "$temporary_directory"
}
trap cleanup EXIT

for command_name in ar awk curl cut dd find grep head install od patchelf readelf sed sha256sum sort stat tar touch tr zip; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 1
  fi
done

kickstart_commit=''
kickstart_url=''
kickstart_upstream_sha256=''
kickstart_codey_sha256=''
while IFS='|' read -r revision url upstream_sha256 codey_sha256 extra; do
  if [[ -z "$revision" || "$revision" == \#* ]]; then
    continue
  fi
  if [[ -n "$kickstart_commit" || -n "$extra" ||
    ! "$revision" =~ ^[0-9a-f]{40}$ ||
    ! "$upstream_sha256" =~ ^[0-9a-f]{64}$ ||
    ! "$codey_sha256" =~ ^[0-9a-f]{64}$ ]]; then
    echo "Malformed Kickstart lock entry: $revision" >&2
    exit 1
  fi
  expected_url="https://raw.githubusercontent.com/nvim-lua/kickstart.nvim/$revision/init.lua"
  if [[ "$url" != "$expected_url" ]]; then
    echo "Kickstart lock URL does not match its revision: $url" >&2
    exit 1
  fi
  kickstart_commit="$revision"
  kickstart_url="$url"
  kickstart_upstream_sha256="$upstream_sha256"
  kickstart_codey_sha256="$codey_sha256"
done < "$kickstart_lock_file"
if [[ -z "$kickstart_commit" ]]; then
  echo 'Kickstart lock contains no snapshot.' >&2
  exit 1
fi
actual_kickstart_codey_sha256="$(sha256sum "$kickstart_init_file" | cut -d ' ' -f 1)"
if [[ "$actual_kickstart_codey_sha256" != "$kickstart_codey_sha256" ]]; then
  echo 'Codey Kickstart snapshot does not match upstream.lock.' >&2
  exit 1
fi

mapfile -t expected_native_library_names < <(
  sed -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' "$native_library_lock_file"
)
if (( ${#expected_native_library_names[@]} == 0 )); then
  echo 'Native-library lock contains no filenames.' >&2
  exit 1
fi
for native_library_name in "${expected_native_library_names[@]}"; do
  if [[ ! "$native_library_name" =~ ^lib[A-Za-z0-9_.+-]+\.so$ ]]; then
    echo "Invalid native-library lock entry: $native_library_name" >&2
    exit 1
  fi
done
mapfile -t sorted_native_library_names < <(
  printf '%s\n' "${expected_native_library_names[@]}" | LC_ALL=C sort -u
)
if [[ "${expected_native_library_names[*]}" != "${sorted_native_library_names[*]}" ]]; then
  echo 'Native-library lock entries must be unique and bytewise sorted.' >&2
  exit 1
fi

mkdir -p "$cache_directory" "$temporary_directory/packages"

kickstart_upstream="$cache_directory/kickstart_${kickstart_commit}_init.lua"
if [[ -f "$kickstart_upstream" ]]; then
  actual_kickstart_upstream_sha256="$(sha256sum "$kickstart_upstream" | cut -d ' ' -f 1)"
  if [[ "$actual_kickstart_upstream_sha256" != "$kickstart_upstream_sha256" ]]; then
    echo "Cached Kickstart checksum mismatch: $kickstart_upstream" >&2
    exit 1
  fi
else
  kickstart_upstream_partial="$kickstart_upstream.partial"
  curl --fail --location --silent --show-error \
    "$kickstart_url" --output "$kickstart_upstream_partial"
  actual_kickstart_upstream_sha256="$(
    sha256sum "$kickstart_upstream_partial" | cut -d ' ' -f 1
  )"
  if [[ "$actual_kickstart_upstream_sha256" != "$kickstart_upstream_sha256" ]]; then
    echo 'Downloaded Kickstart checksum mismatch.' >&2
    exit 1
  fi
  mv "$kickstart_upstream_partial" "$kickstart_upstream"
fi

while IFS='|' read -r package_name package_version package_url package_sha256; do
  if [[ -z "$package_name" || "$package_name" == \#* ]]; then
    continue
  fi
  if [[ -z "$package_version" || -z "$package_url" || ! "$package_sha256" =~ ^[0-9a-f]{64}$ ]]; then
    echo "Malformed package lock entry: $package_name" >&2
    exit 1
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
tool_stage="$runtime_stage/codey-tools"
mkdir -p "$jni_stage" "$asset_stage" "$license_stage" "$runtime_stage" \
  "$tool_stage/git-core" "$tool_stage/git-templates" \
  "$tool_stage/lua-language-server" "$tool_stage/tls"

termux_prefix='data/data/com.termux/files/usr'
copy_elf() {
  local package_name="$1"
  local source_path="$2"
  local output_name="$3"
  install -m 0755 \
    "$temporary_directory/packages/$package_name/$termux_prefix/$source_path" \
    "$jni_stage/$output_name"
}

copy_license() {
  local package_name="$1"
  local source_path="$2"
  local output_name="$3"
  install -m 0644 \
    "$temporary_directory/packages/$package_name/$termux_prefix/$source_path" \
    "$license_stage/$output_name"
}

# Replace one compile-time absolute path without moving any following ELF
# bytes. This is intentionally narrow: imported binaries remain checksum-pinned
# and the expected source string must occur exactly once.
patch_embedded_path() {
  local file="$1"
  local old_path="$2"
  local new_path="$3"
  local padding offset
  local -a offsets=()

  if (( ${#new_path} > ${#old_path} )); then
    echo "Replacement path is longer than its reserved ELF string: $new_path" >&2
    exit 1
  fi
  while IFS=: read -r offset _; do
    offsets+=("$offset")
  done < <(LC_ALL=C grep -aboF "$old_path" "$file")
  if (( ${#offsets[@]} != 1 )); then
    echo "Expected exactly one embedded path in $(basename "$file"): $old_path" >&2
    exit 1
  fi

  padding=$(( ${#old_path} - ${#new_path} ))
  {
    printf '%s' "$new_path"
    if (( padding > 0 )); then
      head -c "$padding" /dev/zero
    fi
  } | dd of="$file" bs=1 seek="${offsets[0]}" conv=notrunc status=none

  if LC_ALL=C grep -aF "$old_path" "$file" >/dev/null ||
    ! LC_ALL=C grep -aF "$new_path" "$file" >/dev/null; then
    echo "Failed to relocate embedded path in $(basename "$file")" >&2
    exit 1
  fi
}

# LuaLS embeds a short Lua launcher which normally loads bin/main.lua beside
# its executable. Android relocates the executable into nativeLibraryDir while
# the read-only Lua files live in Codey's private runtime, so replace that one
# launcher expression with an environment lookup. Pad with Lua whitespace to
# preserve every following byte in the ELF string table.
patch_embedded_text() {
  local file="$1"
  local old_text="$2"
  local new_text="$3"
  local padding offset
  local -a offsets=()

  if (( ${#new_text} > ${#old_text} )); then
    echo "Replacement text is longer than its reserved ELF string." >&2
    exit 1
  fi
  while IFS=: read -r offset _; do
    offsets+=("$offset")
  done < <(LC_ALL=C grep -aboF "$old_text" "$file")
  if (( ${#offsets[@]} != 1 )); then
    echo "Expected exactly one embedded LuaLS launcher expression in $(basename "$file")." >&2
    exit 1
  fi

  padding=$(( ${#old_text} - ${#new_text} ))
  {
    printf '%s' "$new_text"
    if (( padding > 0 )); then
      printf '%*s' "$padding" ''
    fi
  } | dd of="$file" bs=1 seek="${offsets[0]}" conv=notrunc status=none

  if LC_ALL=C grep -aF "$old_text" "$file" >/dev/null ||
    ! LC_ALL=C grep -aF "$new_text" "$file" >/dev/null; then
    echo "Failed to relocate the embedded LuaLS launcher in $(basename "$file")." >&2
    exit 1
  fi
}

gnu_property_note_is_valid() {
  local file="$1"
  local offset="$2"
  local size="$3"
  local namesz descsz note_type owner

  (( size >= 16 )) || return 1
  read -r namesz descsz note_type < <(
    od -An -tu4 -N12 -j "$offset" "$file"
  )
  owner="$(od -An -tx1 -N4 -j "$(( offset + 12 ))" "$file" | tr -d ' \n')"
  (( namesz == 4 && descsz > 0 && note_type == 5 && descsz <= size - 16 )) &&
    [[ "$owner" == '474e5500' ]]
}

capture_gnu_property_note() {
  local file="$1"
  local output="$2"
  local offset size
  local -a segments=()

  while read -r offset size; do
    segments+=("$offset $size")
  done < <(readelf -lW "$file" | awk '$1 == "GNU_PROPERTY" { print $2, $5 }')
  if (( ${#segments[@]} != 1 )); then
    echo "Expected exactly one GNU property segment in $(basename "$file")." >&2
    exit 1
  fi
  read -r offset size <<< "${segments[0]}"
  offset=$(( offset ))
  size=$(( size ))
  if ! gnu_property_note_is_valid "$file" "$offset" "$size"; then
    echo "GNU property note is invalid before ELF rewriting: $(basename "$file")." >&2
    exit 1
  fi
  dd if="$file" of="$output" bs=1 skip="$offset" count="$size" status=none
}

restore_gnu_property_note() {
  local file="$1"
  local backup="$2"
  local backup_size offset size
  local -a segments=()

  while read -r offset size; do
    segments+=("$offset $size")
  done < <(readelf -lW "$file" | awk '$1 == "GNU_PROPERTY" { print $2, $5 }')
  if (( ${#segments[@]} != 1 )); then
    echo "Expected exactly one GNU property segment after rewriting $(basename "$file")." >&2
    exit 1
  fi
  read -r offset size <<< "${segments[0]}"
  offset=$(( offset ))
  size=$(( size ))
  backup_size="$(stat -c %s "$backup")"
  if (( size != backup_size )); then
    echo "GNU property segment size changed while rewriting $(basename "$file")." >&2
    exit 1
  fi

  # patchelf 0.15.x moves the note section but leaves PT_GNU_PROPERTY at its
  # original bytes, which it fills with 'X'. Android's linker warns on that
  # malformed segment. Restore the checksum-pinned note at the segment offset.
  if ! gnu_property_note_is_valid "$file" "$offset" "$size"; then
    dd if="$backup" of="$file" bs=1 seek="$offset" conv=notrunc status=none
  fi
  if ! gnu_property_note_is_valid "$file" "$offset" "$size"; then
    echo "GNU property note is invalid after rewriting $(basename "$file")." >&2
    exit 1
  fi
}

resolve_ndk_directory() {
  local candidate
  for candidate in "${ANDROID_NDK_HOME:-}" "${ANDROID_NDK_ROOT:-}" "${NDK_HOME:-}"; do
    if [[ -n "$candidate" ]]; then
      (cd "$candidate" && pwd -P)
      return
    fi
  done
  echo 'ANDROID_NDK_HOME, ANDROID_NDK_ROOT, or NDK_HOME must identify the pinned Android NDK.' >&2
  return 1
}

build_dispatcher() {
  local ndk_directory ndk_actual_revision dispatcher_compiler compiler_candidate
  ndk_directory="$(resolve_ndk_directory)"
  if [[ ! -f "$ndk_directory/source.properties" ]]; then
    echo "Android NDK is missing source.properties: $ndk_directory" >&2
    exit 1
  fi
  ndk_actual_revision="$(
    sed -n 's/^Pkg\.Revision[[:space:]]*=[[:space:]]*//p' "$ndk_directory/source.properties" | head -n 1
  )"
  if [[ "$ndk_actual_revision" != "$android_ndk_revision" ]]; then
    echo "Android NDK revision $android_ndk_revision is required, found ${ndk_actual_revision:-unknown}." >&2
    exit 1
  fi

  dispatcher_compiler=''
  while IFS= read -r compiler_candidate; do
    if [[ -n "$dispatcher_compiler" ]]; then
      echo "Multiple Android NDK arm64 API $android_api_level compilers were found." >&2
      exit 1
    fi
    dispatcher_compiler="$compiler_candidate"
  done < <(
    find "$ndk_directory/toolchains/llvm/prebuilt" -mindepth 3 -maxdepth 3 -type f \
      -name "aarch64-linux-android${android_api_level}-clang" -print | LC_ALL=C sort
  )
  if [[ -z "$dispatcher_compiler" ]]; then
    echo "Android NDK arm64 API $android_api_level compiler was not found in $ndk_directory." >&2
    exit 1
  fi

  "$dispatcher_compiler" \
    -std=c17 \
    -D_POSIX_C_SOURCE=200809L \
    -O2 \
    -Wall \
    -Wextra \
    -Werror \
    -fPIE \
    -ffile-prefix-map="$repository_directory"=. \
    -fno-ident \
    -pie \
    -Wl,--build-id=none \
    -Wl,-z,relro \
    -Wl,-z,now \
    -Wl,-z,max-page-size=16384 \
    -Wl,-z,common-page-size=16384 \
    "$dispatcher_source" \
    -o "$jni_stage/libcodey_exec_dispatcher.so"
}

# NeoVim and its original native closure.
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

# Executable tools. Android extracts only lib*.so entries as executable files.
copy_elf git bin/git libcodey_git.so
copy_elf git libexec/git-core/git-remote-http libcodey_git_remote_http.so
copy_elf git libexec/git-core/git-sh-i18n--envsubst libcodey_git_envsubst.so
copy_elf ripgrep bin/rg libcodey_rg.so
copy_elf stylua bin/stylua libcodey_stylua.so
copy_elf lua-language-server share/lua-language-server/bin/lua-language-server \
  libcodey_lua_language_server.so

patch_embedded_text \
  "$jni_stage/libcodey_lua_language_server.so" \
  'local mainlua = (progdir / "main.lua"):string()' \
  'local mainlua=os.getenv"CODEY_LUALS_BOOTSTRAP"'

# Git's SHELL_PATH is compile-time state and ignores the process's SHELL
# variable. Point it at Android's system shell so aliases, hooks, and fallback
# script execution do not try to enter another app's Termux prefix.
for git_elf in \
  libcodey_git.so \
  libcodey_git_remote_http.so \
  libcodey_git_envsubst.so; do
  patch_embedded_path \
    "$jni_stage/$git_elf" \
    '/data/data/com.termux/files/usr/bin/sh' \
    '/system/bin/sh'
done

# Namespace the tools' native closure so it cannot collide with React Native or
# another Android dependency that packages a common library name.
copy_elf binutils lib/libbfd-2.47.so libcodey_bfd.so
copy_elf binutils lib/libsframe.so.3.0.0 libcodey_sframe.so
copy_elf libc++ lib/libc++_shared.so libcodey_libcxx.so
copy_elf libcurl lib/libcurl.so libcodey_curl.so
copy_elf libnghttp2 lib/libnghttp2.so libcodey_nghttp2.so
copy_elf libnghttp3 lib/libnghttp3.so libcodey_nghttp3.so
copy_elf libngtcp2 lib/libngtcp2.so libcodey_ngtcp2.so
copy_elf libngtcp2 lib/libngtcp2_crypto_ossl.so libcodey_ngtcp2_crypto_ossl.so
copy_elf libssh2 lib/libssh2.so libcodey_ssh2.so
copy_elf openssl lib/libcrypto.so.3 libcodey_crypto.so
copy_elf openssl lib/libssl.so.3 libcodey_ssl.so
copy_elf pcre2 lib/libpcre2-8.so libcodey_pcre2_8.so
copy_elf zlib lib/libz.so.1.3.2 libcodey_z.so
copy_elf zstd lib/libzstd.so.1.5.7 libcodey_zstd.so
build_dispatcher

libcxx_gnu_property_note="$temporary_directory/libcodey-libcxx.gnu-property"
capture_gnu_property_note "$jni_stage/libcodey_libcxx.so" "$libcxx_gnu_property_note"

# Git's submodule porcelain and shell helpers are programs in the binary
# package. The dispatcher feeds git-submodule to Android's system shell, while
# Git sources the two helpers. Keep all three as non-executable runtime data and
# remove their Termux-only interpreter path.
for git_shell_file in git-submodule git-sh-setup git-sh-i18n; do
  install -m 0644 \
    "$temporary_directory/packages/git/$termux_prefix/libexec/git-core/$git_shell_file" \
    "$tool_stage/git-core/$git_shell_file"
  sed -i '1c #!/system/bin/sh' "$tool_stage/git-core/$git_shell_file"
done
# The packaged i18n helper defaults to Termux's locale directory. Git is built
# in fall-through (English) mode, but keep the dormant fallback relocatable too.
sed -i \
  's#/data/data/com.termux/files/usr/share/locale#${CODEY_NVIM_DATA_DIR}/codey-tools/git-core/locale#' \
  "$tool_stage/git-core/git-sh-i18n"

git_template_source="$temporary_directory/packages/git/$termux_prefix/share/git-core/templates"
tar -C "$git_template_source" -cf - . | tar -C "$tool_stage/git-templates" -xf -
# Template hooks are examples, not runtime requirements. Some depend on Perl or
# Watchman and all carry Termux-specific interpreters, so ship an empty hook
# directory instead of advertising tools the APK intentionally does not bundle.
rm -rf -- "$tool_stage/git-templates/hooks"
mkdir -p "$tool_stage/git-templates/hooks"

lua_ls_source="$temporary_directory/packages/lua-language-server/$termux_prefix/share/lua-language-server"
tar --exclude='./bin/lua-language-server' -C "$lua_ls_source" -cf - . | \
  tar -C "$tool_stage/lua-language-server" -xf -
install -m 0644 \
  "$temporary_directory/packages/ca-certificates/$termux_prefix/etc/tls/cert.pem" \
  "$tool_stage/tls/cert.pem"
install -m 0644 \
  "$temporary_directory/packages/openssl/$termux_prefix/etc/tls/openssl.cnf" \
  "$tool_stage/tls/openssl.cnf"

# Preserve the licence documents supplied with every newly selected runtime
# component. Generic SPDX texts come from Termux's own pinned licence package.
copy_license libandroid-support share/doc/libandroid-support/LICENSE.txt libandroid-support-Apache-2.0.txt
copy_license libandroid-support share/doc/libandroid-support/LICENSE.txt.1 libandroid-support-components-MIT.txt
copy_license termux-licenses share/LICENSES/GPL-3.0.txt binutils-GPL-3.0.txt
copy_license termux-licenses share/LICENSES/MPL-2.0.txt ca-certificates-MPL-2.0.txt
copy_license termux-licenses share/LICENSES/GPL-2.0.txt Git-GPL-2.0.txt
copy_license termux-licenses share/LICENSES/Apache-2.0.txt libcxx-Apache-2.0.txt
copy_license termux-licenses share/LICENSES/NCSA.txt libcxx-NCSA.txt
copy_license libcurl share/doc/libcurl/copyright libcurl-COPYING.txt
copy_license termux-licenses share/LICENSES/LGPL-2.1.txt libiconv-LGPL-2.1.txt
copy_license libnghttp2 share/doc/libnghttp2/copyright nghttp2-MIT.txt
copy_license libnghttp3 share/doc/libnghttp3/copyright nghttp3-MIT.txt
copy_license libngtcp2 share/doc/libngtcp2/copyright ngtcp2-MIT.txt
copy_license libssh2 share/doc/libssh2/copyright libssh2-BSD.txt
copy_license lua-language-server share/doc/lua-language-server/copyright lua-language-server-MIT.txt
copy_license termux-licenses share/LICENSES/LGPL-3.0.txt libunibilium-LGPL-3.0.txt
copy_license libuv share/doc/libuv/LICENSE libuv-MIT.txt
copy_license luajit share/doc/luajit/copyright LuaJIT-MIT.txt
copy_license termux-licenses share/LICENSES/Apache-2.0.txt luv-Apache-2.0.txt
copy_license neovim share/doc/neovim/LICENSE.txt Neovim-Apache-2.0-and-Vim.txt
copy_license termux-licenses share/LICENSES/Apache-2.0.txt OpenSSL-Apache-2.0.txt
copy_license pcre2 share/doc/pcre2/LICENCE.md PCRE2-BSD-3-Clause.txt
copy_license ripgrep share/doc/ripgrep/copyright ripgrep-dual-license.txt
copy_license ripgrep share/doc/ripgrep/copyright.1 ripgrep-MIT.txt
copy_license termux-licenses share/LICENSES/MPL-2.0.txt StyLua-MPL-2.0.txt
copy_license tree-sitter share/doc/tree-sitter/copyright tree-sitter-MIT.txt
copy_license utf8proc share/doc/utf8proc/copyright utf8proc-MIT.txt
copy_license zlib share/doc/zlib/copyright zlib-license.txt
copy_license termux-licenses share/LICENSES/GPL-2.0.txt zstd-GPL-2.0.txt
install -m 0644 "$app_directory/native-runtime/LICENSES/lpeg-MIT.txt" "$license_stage/LPeg-MIT.txt"
install -m 0644 "$app_directory/native-runtime/LICENSES/libcxx-LLVM-exception.txt" \
  "$license_stage/libcxx-LLVM-exception.txt"
install -m 0644 "$app_directory/native-runtime/LICENSES/zstd-BSD-3-Clause.txt" \
  "$license_stage/zstd-BSD-3-Clause.txt"
install -m 0644 "$app_directory/native-runtime/LICENSES/kickstart.nvim-MIT.txt" \
  "$license_stage/kickstart.nvim-MIT.txt"
install -m 0644 "$repository_directory/LICENSE" "$license_stage/Codey-Apache-2.0.txt"
install -m 0644 "$repository_directory/THIRD_PARTY_NOTICES.md" "$asset_stage/THIRD_PARTY_NOTICES.md"

replace_needed_everywhere() {
  local old_name="$1"
  local new_name="$2"
  local elf
  for elf in "$jni_stage"/*.so; do
    if readelf -d "$elf" | grep -F "Shared library: [$old_name]" >/dev/null; then
      patchelf --replace-needed "$old_name" "$new_name" "$elf"
    fi
  done
}

set_namespaced_soname() {
  local library_name="$1"
  patchelf --set-soname "$library_name" "$jni_stage/$library_name"
}

for elf in "$jni_stage"/*.so; do
  patchelf --set-rpath '$ORIGIN' "$elf"
done
replace_needed_everywhere libutf8proc.so.3 libutf8proc.so
patchelf --set-soname libutf8proc.so "$jni_stage/libutf8proc.so"

replace_needed_everywhere libbfd-2.47.so libcodey_bfd.so
replace_needed_everywhere libc++_shared.so libcodey_libcxx.so
replace_needed_everywhere libcrypto.so.3 libcodey_crypto.so
replace_needed_everywhere libcurl.so libcodey_curl.so
replace_needed_everywhere libnghttp2.so libcodey_nghttp2.so
replace_needed_everywhere libnghttp3.so libcodey_nghttp3.so
replace_needed_everywhere libngtcp2.so libcodey_ngtcp2.so
replace_needed_everywhere libngtcp2_crypto_ossl.so libcodey_ngtcp2_crypto_ossl.so
replace_needed_everywhere libpcre2-8.so libcodey_pcre2_8.so
replace_needed_everywhere libsframe.so.3 libcodey_sframe.so
replace_needed_everywhere libssh2.so libcodey_ssh2.so
replace_needed_everywhere libssl.so.3 libcodey_ssl.so
replace_needed_everywhere libz.so.1 libcodey_z.so
replace_needed_everywhere libzstd.so.1 libcodey_zstd.so

for library_name in \
  libcodey_bfd.so \
  libcodey_crypto.so \
  libcodey_curl.so \
  libcodey_libcxx.so \
  libcodey_nghttp2.so \
  libcodey_nghttp3.so \
  libcodey_ngtcp2.so \
  libcodey_ngtcp2_crypto_ossl.so \
  libcodey_pcre2_8.so \
  libcodey_sframe.so \
  libcodey_ssh2.so \
  libcodey_ssl.so \
  libcodey_z.so \
  libcodey_zstd.so; do
  set_namespaced_soname "$library_name"
done
restore_gnu_property_note "$jni_stage/libcodey_libcxx.so" "$libcxx_gnu_property_note"

runtime_source="$temporary_directory/packages/neovim/$termux_prefix/share/nvim/runtime"
tar --exclude='./parser' -C "$runtime_source" -cf - . | tar -C "$runtime_stage" -xf -
sed -i '1c #!/system/bin/sh' "$runtime_stage/scripts/less.sh"

source_date_epoch="${SOURCE_DATE_EPOCH:-315532800}"
if [[ ! "$source_date_epoch" =~ ^[0-9]+$ ]] || (( source_date_epoch < 315532800 )); then
  echo 'SOURCE_DATE_EPOCH must be an integer at or after 1980-01-01 for ZIP portability.' >&2
  exit 1
fi

tree_sitter_helper="$script_directory/prepare-treesitter-parsers.sh"
if [[ ! -x "$tree_sitter_helper" ]]; then
  echo "Missing executable Tree-sitter preparation helper: $tree_sitter_helper" >&2
  exit 1
fi
tree_sitter_commit="$(
  "$tree_sitter_helper" \
    --jni-stage "$jni_stage" \
    --runtime-stage "$runtime_stage" \
    --license-stage "$license_stage" \
    --cache-dir "$cache_directory/tree-sitter"
)"
if [[ ! "$tree_sitter_commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Tree-sitter helper returned an invalid revision: $tree_sitter_commit" >&2
  exit 1
fi
if [[ "$tree_sitter_commit" != "$expected_tree_sitter_commit" ]]; then
  echo "Tree-sitter revision mismatch: expected $expected_tree_sitter_commit, found $tree_sitter_commit" >&2
  exit 1
fi

required_runtime_files=(
  codey-tools/git-core/git-submodule
  codey-tools/git-core/git-sh-i18n
  codey-tools/git-core/git-sh-setup
  codey-tools/lua-language-server/main.lua
  codey-tools/lua-language-server/bin/main.lua
  codey-tools/tls/cert.pem
  codey-tools/tls/openssl.cnf
  codey-treesitter/REVISION
)
for relative_path in "${required_runtime_files[@]}"; do
  if [[ ! -f "$runtime_stage/$relative_path" ]]; then
    echo "Missing required runtime data: $relative_path" >&2
    exit 1
  fi
done

for git_shell_file in git-submodule git-sh-setup git-sh-i18n; do
  git_shell_path="$tool_stage/git-core/$git_shell_file"
  if [[ "$(head -n 1 "$git_shell_path")" != '#!/system/bin/sh' ]]; then
    echo "Bundled Git shell file has an invalid interpreter: $git_shell_file" >&2
    exit 1
  fi
  if grep -Fq '/data/data/com.termux/' "$git_shell_path"; then
    echo "Bundled Git shell file still contains a Termux path: $git_shell_file" >&2
    exit 1
  fi
done

if grep -R -Fq '/data/data/com.termux/' "$runtime_stage"; then
  echo 'Bundled runtime data still contains a Termux-only absolute path.' >&2
  exit 1
fi

if find "$runtime_stage" -type l -print -quit | grep . >/dev/null; then
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

command_list="$(IFS=,; echo "${command_aliases[*]}")"
parser_list="$(IFS=,; echo "${parser_languages[*]}")"
mapfile -t native_library_names < <(
  find "$jni_stage" -mindepth 1 -maxdepth 1 -type f -name 'lib*.so' -printf '%f\n' | LC_ALL=C sort
)
if (( ${#native_library_names[@]} == 0 )); then
  echo 'No native libraries were staged.' >&2
  exit 1
fi
if [[ "${native_library_names[*]}" != "${expected_native_library_names[*]}" ]]; then
  echo 'Staged native libraries do not match native-libraries.lock.' >&2
  printf 'Expected: %s\n' "${expected_native_library_names[*]}" >&2
  printf 'Staged:   %s\n' "${native_library_names[*]}" >&2
  exit 1
fi
native_library_list="$(IFS=,; echo "${native_library_names[*]}")"
{
  printf 'schemaVersion=%s\n' "$bundle_schema_version"
  printf 'version=%s\n' "$nvim_version"
  printf 'runtimeSha256=%s\n' "$runtime_sha256"
  printf 'kickstartCommit=%s\n' "$kickstart_commit"
  printf 'treeSitterCommit=%s\n' "$tree_sitter_commit"
  printf 'dispatcher=libcodey_exec_dispatcher.so\n'
  printf 'nativeLibraries=%s\n' "$native_library_list"
  printf 'commands=%s\n' "$command_list"
  printf 'command.git=elf:libcodey_git.so\n'
  printf 'command.git-remote-http=elf:libcodey_git_remote_http.so\n'
  printf 'command.git-remote-https=elf:libcodey_git_remote_http.so\n'
  printf 'command.git-sh-i18n--envsubst=elf:libcodey_git_envsubst.so\n'
  printf 'command.git-submodule=script:codey-tools/git-core/git-submodule\n'
  printf 'command.rg=elf:libcodey_rg.so\n'
  printf 'command.stylua=elf:libcodey_stylua.so\n'
  printf 'command.lua-language-server=elf:libcodey_lua_language_server.so\n'
  printf 'parsers=%s\n' "$parser_list"
  for parser_language in "${parser_languages[@]}"; do
    printf 'parser.%s=libcodey_ts_%s.so\n' "$parser_language" "$parser_language"
  done
  printf 'data.gitCore=codey-tools/git-core\n'
  printf 'data.gitTemplates=codey-tools/git-templates\n'
  printf 'data.caBundle=codey-tools/tls/cert.pem\n'
  printf 'data.opensslConfig=codey-tools/tls/openssl.cnf\n'
  printf 'data.luaLsBootstrap=codey-tools/lua-language-server/bin/main.lua\n'
  printf 'data.luaLsMain=codey-tools/lua-language-server/main.lua\n'
  printf 'data.treeSitterRuntime=codey-treesitter\n'
} > "$asset_stage/bundle.properties"

native_command_libraries=(
  libcodey_exec_dispatcher.so
  libcodey_git.so
  libcodey_git_envsubst.so
  libcodey_git_remote_http.so
  libcodey_lua_language_server.so
  libcodey_nvim.so
  libcodey_rg.so
  libcodey_stylua.so
)
for executable_name in "${native_command_libraries[@]}"; do
  if [[ ! -f "$jni_stage/$executable_name" ]]; then
    echo "Missing native command executable: $executable_name" >&2
    exit 1
  fi
  if ! readelf -l "$jni_stage/$executable_name" | grep '/system/bin/linker64' >/dev/null; then
    echo "Native command does not use Android's arm64 dynamic linker: $executable_name" >&2
    exit 1
  fi
done

for parser_language in "${parser_languages[@]}"; do
  if [[ ! -f "$jni_stage/libcodey_ts_${parser_language}.so" ]]; then
    echo "Missing bundled Tree-sitter parser: $parser_language" >&2
    exit 1
  fi
done

system_libraries=' libc.so libdl.so libm.so liblog.so '
for elf in "$jni_stage"/*.so; do
  if ! readelf -h "$elf" | grep -E 'Machine:[[:space:]]+AArch64' >/dev/null; then
    echo "Not an arm64 ELF: $elf" >&2
    exit 1
  fi
  if ! readelf -h "$elf" | grep -E 'Type:[[:space:]]+DYN' >/dev/null; then
    echo "Not an arm64 PIE/shared object: $elf" >&2
    exit 1
  fi
  if readelf -d "$elf" | grep 'TEXTREL' >/dev/null; then
    echo "ELF contains text relocations: $elf" >&2
    exit 1
  fi
  if readelf -d "$elf" | grep '/data/data/com.termux' >/dev/null; then
    echo "ELF still contains the Termux runpath: $elf" >&2
    exit 1
  fi
  while read -r property_offset property_size; do
    if ! gnu_property_note_is_valid "$elf" "$(( property_offset ))" "$(( property_size ))"; then
      echo "ELF contains a malformed GNU property segment: $elf" >&2
      exit 1
    fi
  done < <(readelf -lW "$elf" | awk '$1 == "GNU_PROPERTY" { print $2, $5 }')
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

echo "Prepared NeoVim $nvim_version native runtime and bundled tools in $module_main"
