# Codey Kickstart configuration

`init.lua` is the complete single-file Kickstart configuration pinned by
`upstream.lock`, with a small Android-specific branch. Copy it to `init.lua` in
the configuration directory selected in Codey. It remains a normal portable
Kickstart file: when Codey's environment variables are absent, its desktop
plugin, Mason, and Tree-sitter installation behavior is unchanged.

Codey's launcher sets `CODEY_NVIM=1` and supplies these paths and revision:

- `CODEY_NVIM_NATIVE_DIR`: Android's extracted APK native-library directory.
- `CODEY_NVIM_TREESITTER_RTP`: the installed `codey-treesitter` runtime root.
- `CODEY_NVIM_TREESITTER_REV`: the matching pinned nvim-treesitter commit.
- `CODEY_NVIM_BIN_DIR`: Codey's app-private command-alias directory.
- `CODEY_NVIM_LUALS_MAIN`: the bundled Lua language server's `main.lua`.

The Codey branch prepends that runtime root, loads all eleven packaged parser
libraries by absolute path, and never invokes an on-device parser download or
compiler. Unsupported languages retain Neovim's normal syntax fallback. The
branch also disables Mason's incompatible desktop-tool downloads and enables
the Android-compatible Lua language server supplied by Codey directly. StyLua
is on Codey's `PATH` for users who opt in to Lua formatting with Conform. It
also disables Neovim's optional bytecode-caching loader on Codey because that
loader flattens absolute module paths into cache filenames that can exceed
Android/Linux's per-filename limit; desktop Neovim retains the optimization.

## Updating the snapshot

Treat the configuration, nvim-treesitter runtime, query files, and parser
libraries as one compatibility unit:

1. Download the new Kickstart `init.lua`, record its exact 40-character commit,
   raw URL, and upstream SHA-256 in `upstream.lock`, then reapply the documented
   Codey branches and record the adapted file's SHA-256 in the fourth field.
2. Update `../tree-sitter-parsers.lock` from one exact nvim-treesitter commit.
   Keep the eleven parser revisions identical to that snapshot's parser table.
3. Run `pnpm android:prepare:nvim` in `nix develop`. The preparation scripts
   verify both locked Kickstart checksums, all archive checksums, parser ABI
   compatibility, exported symbols, ELF architecture, and 16 KiB load
   alignment.
4. Smoke-test Lua highlighting and an injected language such as Markdown, plus
   a filetype without a bundled parser to confirm graceful fallback.

Do not add a second Lua module for this adaptation: the user-facing
configuration is intentionally a single file.
