#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_directory="$(cd "$script_directory/.." && pwd)"
lock_file="$app_directory/native-runtime/tree-sitter-parsers.lock"
expected_ndk_revision='27.1.12297006'
android_api_level='30'

usage() {
  cat <<'EOF'
Usage: prepare-treesitter-parsers.sh \
  --jni-stage DIRECTORY \
  --runtime-stage DIRECTORY \
  --license-stage DIRECTORY \
  [--cache-dir DIRECTORY]

Cross-compiles Codey's pinned arm64 Android Tree-sitter parsers and stages the
matching nvim-treesitter Lua, plugin, and query runtime. On success stdout is
exactly the pinned nvim-treesitter commit, suitable for bundle.properties.

The Android NDK is read from ANDROID_NDK_HOME, ANDROID_NDK_ROOT, or NDK_HOME.
All progress and diagnostics are written to stderr.
EOF
}

die() {
  echo "$*" >&2
  exit 1
}

jni_stage=''
runtime_stage=''
license_stage=''
cache_directory="$app_directory/.cache/nvim-runtime/tree-sitter"

while (( $# > 0 )); do
  case "$1" in
    --jni-stage|--runtime-stage|--license-stage|--cache-dir)
      (( $# >= 2 )) || die "Missing value for $1"
      case "$1" in
        --jni-stage) jni_stage="$2" ;;
        --runtime-stage) runtime_stage="$2" ;;
        --license-stage) license_stage="$2" ;;
        --cache-dir) cache_directory="$2" ;;
      esac
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

[[ -n "$jni_stage" ]] || die 'Missing required --jni-stage directory.'
[[ -n "$runtime_stage" ]] || die 'Missing required --runtime-stage directory.'
[[ -n "$license_stage" ]] || die 'Missing required --license-stage directory.'
[[ -f "$lock_file" ]] || die "Missing Tree-sitter lock file: $lock_file"

for command_name in awk cp curl cut find grep install mkdir mktemp mv nvim rm sha256sum sort tar; do
  command -v "$command_name" >/dev/null 2>&1 || die "Missing required command: $command_name"
done

mkdir -p "$jni_stage" "$runtime_stage" "$license_stage" "$cache_directory"
jni_stage="$(cd "$jni_stage" && pwd -P)"
runtime_stage="$(cd "$runtime_stage" && pwd -P)"
license_stage="$(cd "$license_stage" && pwd -P)"
cache_directory="$(cd "$cache_directory" && pwd -P)"

[[ "$jni_stage" != / ]] || die 'Refusing to use / as the JNI stage.'
[[ "$runtime_stage" != / ]] || die 'Refusing to use / as the runtime stage.'
[[ "$license_stage" != / ]] || die 'Refusing to use / as the license stage.'

ndk_root="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-${NDK_HOME:-}}}"
[[ -n "$ndk_root" ]] || die 'Set ANDROID_NDK_HOME to the Android NDK used by this project.'
[[ -d "$ndk_root" ]] || die "Android NDK directory does not exist: $ndk_root"
[[ -f "$ndk_root/source.properties" ]] || die "Android NDK is missing source.properties: $ndk_root"
actual_ndk_revision="$(awk -F= '/^Pkg\.Revision/ { value = $2; gsub(/^[ \t]+|[ \t]+$/, "", value); print value; exit }' "$ndk_root/source.properties")"
[[ "$actual_ndk_revision" == "$expected_ndk_revision" ]] || die "Android NDK revision $expected_ndk_revision is required, found ${actual_ndk_revision:-unknown}."

shopt -s nullglob
clang_candidates=("$ndk_root"/toolchains/llvm/prebuilt/*/bin/aarch64-linux-android"$android_api_level"-clang)
shopt -u nullglob
(( ${#clang_candidates[@]} == 1 )) || die "Expected one aarch64-linux-android${android_api_level}-clang below $ndk_root; found ${#clang_candidates[@]}."

android_clang="${clang_candidates[0]}"
toolchain_bin="$(dirname "$android_clang")"
llvm_readelf="$toolchain_bin/llvm-readelf"
llvm_nm="$toolchain_bin/llvm-nm"
[[ -x "$llvm_readelf" ]] || die "Missing NDK tool: $llvm_readelf"
[[ -x "$llvm_nm" ]] || die "Missing NDK tool: $llvm_nm"

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/codey-treesitter.XXXXXX")"
cleanup() {
  rm -rf -- "$temporary_directory"
}
trap cleanup EXIT

declare -a names revisions urls checksums source_subdirectories parser_sources scanner_sources exported_symbols license_paths
while IFS='|' read -r name revision url checksum source_subdirectory parser_source scanner_source exported_symbol license_path extra; do
  if [[ -z "$name" || "$name" == \#* ]]; then
    continue
  fi
  [[ -z "${extra:-}" ]] || die "Unexpected extra field in $lock_file for $name."
  [[ "$name" =~ ^[a-z][a-z0-9_-]*$ ]] || die "Invalid locked component name: $name"
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || die "Invalid locked revision for $name: $revision"
  [[ "$checksum" =~ ^[0-9a-f]{64}$ ]] || die "Invalid locked SHA-256 for $name: $checksum"
  [[ "$url" == https://codeload.github.com/*/tar.gz/"$revision" ]] || die "Locked URL does not end in the pinned revision for $name."
  for relative_path in "$source_subdirectory" "$license_path"; do
    [[ -n "$relative_path" && "$relative_path" != /* ]] || die "Invalid locked relative path for $name: $relative_path"
    [[ "/$relative_path/" != */../* ]] || die "Locked path escapes its source tree for $name: $relative_path"
  done
  for optional_relative_path in "$parser_source" "$scanner_source"; do
    [[ -z "$optional_relative_path" || "$optional_relative_path" != /* ]] || die "Invalid locked source path for $name: $optional_relative_path"
    [[ -z "$optional_relative_path" || "/$optional_relative_path/" != */../* ]] || die "Locked source path escapes its source tree for $name: $optional_relative_path"
  done
  if [[ "$name" == nvim-treesitter ]]; then
    [[ -z "$parser_source" && -z "$scanner_source" && -z "$exported_symbol" ]] || die 'nvim-treesitter must not declare parser build fields.'
  else
    [[ -n "$parser_source" ]] || die "Missing locked parser source for $name."
    [[ "$exported_symbol" == "tree_sitter_$name" ]] || die "Unexpected locked exported symbol for $name: $exported_symbol"
  fi
  names+=("$name")
  revisions+=("$revision")
  urls+=("$url")
  checksums+=("$checksum")
  source_subdirectories+=("$source_subdirectory")
  parser_sources+=("$parser_source")
  scanner_sources+=("$scanner_source")
  exported_symbols+=("$exported_symbol")
  license_paths+=("$license_path")
done < "$lock_file"

expected_names='nvim-treesitter bash c diff html lua luadoc markdown markdown_inline query vim vimdoc'
[[ "${names[*]}" == "$expected_names" ]] || die "Unexpected component set or ordering in $lock_file: ${names[*]}"

verify_archive_paths() {
  local archive="$1"
  if ! tar -tzf "$archive" | awk '
    /^\// { exit 1 }
    {
      count = split($0, parts, "/")
      for (i = 1; i <= count; i++) {
        if (parts[i] == "..") exit 1
      }
    }
    END { if (NR == 0) exit 1 }
  '; then
    die "Archive has an unsafe path or is empty: $archive"
  fi
}

fetch_archive() {
  local name="$1"
  local url="$2"
  local expected_checksum="$3"
  local archive="$cache_directory/$expected_checksum.tar.gz"
  local actual_checksum

  if [[ -f "$archive" ]]; then
    actual_checksum="$(sha256sum "$archive" | cut -d ' ' -f 1)"
    [[ "$actual_checksum" == "$expected_checksum" ]] || die "Cached source checksum mismatch for $name: $archive"
  else
    local partial_archive="$temporary_directory/$expected_checksum.download"
    echo "Downloading pinned $name source" >&2
    curl --fail --location --silent --show-error "$url" --output "$partial_archive"
    actual_checksum="$(sha256sum "$partial_archive" | cut -d ' ' -f 1)"
    [[ "$actual_checksum" == "$expected_checksum" ]] || die "Downloaded source checksum mismatch for $name."
    mv "$partial_archive" "$archive"
  fi

  verify_archive_paths "$archive"
  printf '%s\n' "$archive"
}

extract_source() {
  local index="$1"
  local source_root="$temporary_directory/source-$index"
  local archive
  archive="$(fetch_archive "${names[$index]}" "${urls[$index]}" "${checksums[$index]}")"
  mkdir -p "$source_root"
  tar --no-same-owner --no-same-permissions --strip-components=1 -xzf "$archive" -C "$source_root"
  printf '%s\n' "$source_root"
}

nvim_treesitter_source="$(extract_source 0)"
nvim_treesitter_revision="${revisions[0]}"
nvim_treesitter_runtime="$runtime_stage/codey-treesitter"
case "$nvim_treesitter_runtime" in
  "$runtime_stage/codey-treesitter") ;;
  *) die "Refusing to replace unexpected nvim-treesitter runtime path: $nvim_treesitter_runtime" ;;
esac
rm -rf -- "$nvim_treesitter_runtime"
mkdir -p "$nvim_treesitter_runtime/queries"

for required_path in lua plugin LICENSE; do
  [[ -e "$nvim_treesitter_source/$required_path" ]] || die "Pinned nvim-treesitter source is missing $required_path."
done
cp -R "$nvim_treesitter_source/lua" "$nvim_treesitter_runtime/lua"
cp -R "$nvim_treesitter_source/plugin" "$nvim_treesitter_runtime/plugin"

query_languages=(bash c diff html html_tags lua luadoc markdown markdown_inline query vim vimdoc)
for language in "${query_languages[@]}"; do
  query_source="$nvim_treesitter_source/runtime/queries/$language"
  [[ -d "$query_source" ]] || die "Pinned nvim-treesitter source is missing queries for $language."
  cp -R "$query_source" "$nvim_treesitter_runtime/queries/$language"
done
printf '%s\n' "$nvim_treesitter_revision" > "$nvim_treesitter_runtime/REVISION"
install -m 0644 "$nvim_treesitter_source/LICENSE" "$license_stage/nvim-treesitter-Apache-2.0.txt"

system_libraries=' libc.so libdl.so libm.so liblog.so '
for (( index = 1; index < ${#names[@]}; index++ )); do
  language="${names[$index]}"
  source_root="$(extract_source "$index")"
  grammar_root="$source_root/${source_subdirectories[$index]}"
  parser_source="$grammar_root/${parser_sources[$index]}"
  scanner_source=''
  if [[ -n "${scanner_sources[$index]}" ]]; then
    scanner_source="$grammar_root/${scanner_sources[$index]}"
  fi
  scanner_cxx="$grammar_root/src/scanner.cc"
  output_name="libcodey_ts_${language}.so"
  output_path="$temporary_directory/$output_name"
  parser_symbol="${exported_symbols[$index]}"

  [[ -f "$parser_source" ]] || die "Pinned $language grammar is missing ${parser_sources[$index]}."
  [[ ! -f "$scanner_cxx" ]] || die "Pinned $language grammar unexpectedly requires a C++ scanner."
  if [[ -n "$scanner_source" ]]; then
    [[ -f "$scanner_source" ]] || die "Pinned $language grammar is missing ${scanner_sources[$index]}."
  elif [[ -f "$grammar_root/src/scanner.c" ]]; then
    die "Pinned $language grammar contains src/scanner.c but the lock omits it."
  fi
  parser_abi="$(awk '$1 == "#define" && $2 == "LANGUAGE_VERSION" { print $3; exit }' "$parser_source")"
  [[ "$parser_abi" =~ ^[0-9]+$ ]] || die "Could not determine the $language parser ABI."
  if (( parser_abi < 13 || parser_abi > 15 )); then
    die "$language parser ABI $parser_abi is outside Neovim 0.12's supported ABI range 13-15."
  fi

  compile_sources=("$parser_source")
  if [[ -n "$scanner_source" ]]; then
    compile_sources+=("$scanner_source")
  fi

  echo "Building $language Tree-sitter parser (ABI $parser_abi)" >&2
  "$android_clang" \
    -std=c11 \
    -O2 \
    -g0 \
    -fPIC \
    -ffunction-sections \
    -fdata-sections \
    -ffile-prefix-map="$temporary_directory"=. \
    -fno-ident \
    -I "$grammar_root/src" \
    -shared \
    -Wl,--build-id=none \
    -Wl,--gc-sections \
    -Wl,-soname,"$output_name" \
    -Wl,-z,relro \
    -Wl,-z,now \
    -Wl,-z,noexecstack \
    -Wl,-z,max-page-size=16384 \
    -Wl,-z,common-page-size=16384 \
    "${compile_sources[@]}" \
    -o "$output_path"

  "$llvm_readelf" -h "$output_path" | grep -E 'Machine:[[:space:]]+AArch64' >/dev/null || die "Not an AArch64 ELF: $output_name"
  "$llvm_readelf" -h "$output_path" | grep -E 'Type:[[:space:]]+DYN' >/dev/null || die "Not a shared object: $output_name"
  if "$llvm_readelf" -d "$output_path" | grep 'TEXTREL' >/dev/null; then
    die "Tree-sitter parser has text relocations: $output_name"
  fi
  if ! "$llvm_nm" -D --defined-only "$output_path" | awk '{ print $NF }' | grep -Fx "$parser_symbol" >/dev/null; then
    die "Tree-sitter parser does not export $parser_symbol: $output_name"
  fi
  while read -r needed; do
    [[ "$system_libraries" == *" $needed "* ]] || die "Unexpected dependency $needed in $output_name"
  done < <("$llvm_readelf" -d "$output_path" | awk '/Shared library:/ { sub(/^.*\[/, ""); sub(/\].*$/, ""); print }')
  while read -r alignment; do
    (( alignment >= 0x4000 )) || die "$output_name is not 16 KiB page compatible (LOAD alignment $alignment)."
  done < <("$llvm_readelf" -lW "$output_path" | awk '$1 == "LOAD" { print $NF }')

  install -m 0755 "$output_path" "$jni_stage/$output_name"

  license_source="$source_root/${license_paths[$index]}"
  [[ -f "$license_source" ]] || die "Pinned $language grammar is missing ${license_paths[$index]}."
  case "$language" in
    query|vimdoc) license_identifier='Apache-2.0' ;;
    *) license_identifier='MIT' ;;
  esac
  install -m 0644 "$license_source" "$license_stage/tree-sitter-$language-$license_identifier.txt"
done

expected_parser_files='libcodey_ts_bash.so libcodey_ts_c.so libcodey_ts_diff.so libcodey_ts_html.so libcodey_ts_lua.so libcodey_ts_luadoc.so libcodey_ts_markdown.so libcodey_ts_markdown_inline.so libcodey_ts_query.so libcodey_ts_vim.so libcodey_ts_vimdoc.so'
actual_parser_files="$(find "$jni_stage" -maxdepth 1 -type f -name 'libcodey_ts_*.so' -printf '%f\n' | sort | awk '{ printf "%s%s", separator, $0; separator = " " } END { print "" }')"
[[ "$actual_parser_files" == "$expected_parser_files" ]] || die "Unexpected staged Tree-sitter parser set: $actual_parser_files"

# Prove that the flattened query layout is a real Neovim runtime path. Checking
# file existence alone would miss a layout such as codey-treesitter/runtime/queries.
mkdir -p "$temporary_directory/nvim-cache" "$temporary_directory/nvim-state"
CODEY_TS_TEST_RTP="$nvim_treesitter_runtime" \
XDG_CACHE_HOME="$temporary_directory/nvim-cache" \
XDG_STATE_HOME="$temporary_directory/nvim-state" \
nvim --headless --clean -i NONE \
  --cmd 'lua vim.opt.runtimepath:prepend(vim.env.CODEY_TS_TEST_RTP)' \
  -c "lua local expected = vim.fs.joinpath(vim.env.CODEY_TS_TEST_RTP, 'queries/lua/highlights.scm'); local paths = vim.api.nvim_get_runtime_file('queries/lua/highlights.scm', false); assert(paths[1] == expected, 'Codey nvim-treesitter queries are not visible on runtimepath')" \
  -c 'qa!' 1>&2

printf '%s\n' "$nvim_treesitter_revision"
