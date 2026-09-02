# Third-party notices

Codey is licensed under Apache-2.0. The Android native runtime packages the
unmodified arm64 Termux artifacts pinned in
`apps/android/native-runtime/termux-packages.lock`.

| Component | Version | License |
| --- | --- | --- |
| Neovim | 0.12.5 | Apache-2.0 and Vim |
| Termux `libandroid-support` | 29-1 | Apache-2.0 and MIT components |
| GNU libiconv | 1.18-1 | LGPL-2.1-or-later (library) |
| unibilium | 2.1.4 | LGPL-3.0-or-later |
| libuv | 1.52.1 | MIT |
| LPeg | 1.1.0 | MIT |
| LuaJIT | 2.1.1787165859-g1ee778a | MIT |
| luv | 1.52.1-0-0 | Apache-2.0 |
| tree-sitter | 0.26.13 | MIT |
| utf8proc | 2.11.3 | MIT |

The preparation script verifies each package checksum and copies the license
documents shipped in those packages into the generated APK assets. LPeg's
license, which is not present in its Termux binary package, is retained in
`apps/android/native-runtime/LICENSES/lpeg-MIT.txt`.

The pinned Termux binaries are a temporary feasibility input, not the planned
F-Droid supply chain. Do not redistribute an APK produced by this binary recipe.
A public/F-Droid release must build NeoVim and every native dependency from
source in a reproducible recipe, retain corresponding source archives and
notices, and satisfy the LGPL source and relinking obligations rather than
assuming that bundled license texts alone are sufficient.
