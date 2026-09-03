# Third-party notices

Codey is licensed under Apache-2.0. The Android native runtime derives its
arm64 binaries from the checksum-pinned Termux artifacts in
`apps/android/native-runtime/termux-packages.lock`. The preparation step
relocates ELF dependency names and runpaths, rewrites Git's compiled shell path,
redirects LuaLS's embedded sibling-file bootstrap to checksum-verified runtime
data, and preserves LLVM libc++'s GNU property note across ELF rewriting.
Tree-sitter parsers are built from the sources pinned in
`apps/android/native-runtime/tree-sitter-parsers.lock`.

| Component | Version | License |
| --- | --- | --- |
| Neovim | 0.12.5 | Apache-2.0 and Vim |
| GNU Binutils (`libbfd`, `libsframe`) | 2.47 | GPL-3.0-or-later |
| Mozilla CA certificate bundle | 2026-08-13 | MPL-2.0 |
| Git | 2.55.0 | GPL-2.0-only |
| Termux `libandroid-support` | 29-1 | Apache-2.0 and MIT components |
| LLVM libc++ | 29 | Apache-2.0 WITH LLVM-exception and NCSA components |
| curl/libcurl | 8.22.0 | curl license |
| GNU libiconv | 1.18-1 | LGPL-2.1-or-later (library) |
| nghttp2 | 1.70.0 | MIT |
| nghttp3 | 1.18.0 | MIT |
| ngtcp2 | 1.25.0 | MIT |
| libssh2 | 1.11.1-2 | BSD-3-Clause |
| unibilium | 2.1.4 | LGPL-3.0-or-later |
| libuv | 1.52.1 | MIT |
| LPeg | 1.1.0 | MIT |
| Lua Language Server | 3.19.1 | MIT |
| LuaJIT | 2.1.1787165859-g1ee778a | MIT |
| luv | 1.52.1-0-0 | Apache-2.0 |
| OpenSSL | 3.6.3 | Apache-2.0 |
| PCRE2 | 10.47 | BSD-3-Clause WITH PCRE2-exception |
| ripgrep | 15.2.0 | MIT OR Unlicense |
| StyLua | 2.5.2 | MPL-2.0 |
| tree-sitter | 0.26.13 | MIT |
| utf8proc | 2.11.3 | MIT |
| zlib | 1.3.2 | Zlib |
| Zstandard | 1.5.7 | BSD-3-Clause OR GPL-2.0-only |
| kickstart.nvim configuration | 626c660f54054953e630bef85fdf65e159c7516a | MIT |
| nvim-treesitter | 427e9222363d07c32d6db6169e4049c28d58d141 | Apache-2.0 |
| tree-sitter-bash | a06c2e4415e9bc0346c6b86d401879ffb44058f7 | MIT |
| tree-sitter-c | b780e47fc780ddc8da13afa35a3f4ed5c157823d | MIT |
| tree-sitter-diff | ada384ac7bfc1307f32de474620120add29998fb | MIT |
| tree-sitter-html | 73a3947324f6efddf9e17c0ea58d454843590cc0 | MIT |
| tree-sitter-lua | 10fe0054734eec83049514ea2e718b2a56acd0c9 | MIT |
| tree-sitter-luadoc | 4d04632a3a398b78af52e83be074883e722f40be | MIT |
| tree-sitter-markdown (Markdown and Markdown-inline parsers) | a0a00f817d02412bd92c54d316f164d827b57b5c | MIT |
| tree-sitter-query | 8e9e223812ff30854fbc912adbec696ba5f0e023 | Apache-2.0 |
| tree-sitter-vim | 039c8d0aa1deae00ddeb0374dd70bcc0ec56938d | MIT |
| tree-sitter-vimdoc | 23daa416c1ff5d15f59a1aa648f031d6e3ee15c5 | Apache-2.0 |

The preparation script verifies each package checksum and copies the license
documents shipped in those packages into the generated APK assets. LPeg's
license, which is not present in its Termux binary package, is retained in
`apps/android/native-runtime/LICENSES/lpeg-MIT.txt`.

The Tree-sitter preparation helper separately checksum-verifies each pinned
source archive, compiles only its pre-generated parser/scanner sources with the
Android NDK, and copies every grammar and nvim-treesitter license into the APK.
Kickstart's pinned upstream license is retained in
`apps/android/native-runtime/LICENSES/kickstart.nvim-MIT.txt`.

The pinned Termux binaries are a temporary feasibility input, not the planned
F-Droid supply chain. Do not redistribute an APK produced by this binary recipe.
A public/F-Droid release must build NeoVim and every native dependency from
source in a reproducible recipe, retain corresponding source archives and
notices, and satisfy the LGPL source and relinking obligations rather than
assuming that bundled license texts alone are sufficient.
