# Bundled Android Nerd Font

Codey bundles **JetBrainsMono Nerd Font Mono 3.4.0**, based on JetBrains Mono
2.304, so the Android renderer does not depend on fonts installed on a device.
The `Mono` build keeps every patched icon within one terminal cell.

The five TTF files were copied without modification from the Nerd Fonts 3.4.0
`JetBrainsMono.tar.xz` release artifact, via the Nix package
`nerd-fonts-jetbrains-mono-3.4.0+2.304`.

- Upstream release: https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.4.0
- Upstream font project: https://github.com/JetBrains/JetBrainsMono
- JetBrains Mono license: SIL Open Font License 1.1; see `OFL.txt`.
- Nerd Fonts patched-font notice and license: see `NERD_FONTS_LICENSE.txt`,
  copied unmodified from the pinned v3.4.0 tag.
- Nerd Fonts incorporated-source audit: see `NERD_FONTS_LICENSE_AUDIT.md`,
  also copied unmodified from that tag.

SHA-256 checksums:

```text
f01031f40e48dc29e1112e6b0b0450a2c6cd097f3f35cfff05c55cb311f8034c  JetBrainsMonoNerdFontMono-Regular.ttf
dab3a592048fc1a678dbb25434e4e2bb2a6358296dcfccb162cb8e0b8893e69a  JetBrainsMonoNerdFontMono-SemiBold.ttf
5bdd4a873f3cd32f882d2c55545089123926e27707d5880fc9eaf84eb01b6686  JetBrainsMonoNerdFontMono-Bold.ttf
ccd88b36d325e6a905edc8dd3f2522718d9690d9bed3fbb4684c7e746c34f846  JetBrainsMonoNerdFontMono-Italic.ttf
d931df2928b3216892d35980cddcad9edade1b9c9cd2e09a6c2937139f474742  JetBrainsMonoNerdFontMono-BoldItalic.ttf
```

## Icon catalog

`nerd-font-glyphs.json` is a generated, compact icon catalog used by the
in-app picker. It is derived from the Nerd Fonts 3.4.0 `glyphnames.json`,
collapses aliases onto their shared Unicode code point, and is bundled with
the app. The app never downloads catalog data at runtime.

- Pinned source: https://raw.githubusercontent.com/ryanoasis/nerd-fonts/v3.4.0/glyphnames.json
- Source SHA-256: `e2d10d23f5bff0bd6f0676e9b01d9789fcdc656de7b498a2955c27716ea4439c`
- Nerd Fonts source licensing and incorporated-font notices: see
  `NERD_FONTS_LICENSE.txt` and `NERD_FONTS_LICENSE_AUDIT.md`.

Regenerate from the network with:

```sh
pnpm --filter @codey/android generate:nerd-font-catalog
```

For an offline or audited build, pass a local copy of the pinned source. The
generator verifies the version, SHA-256, row contents, and expected counts
before replacing the generated catalog:

```sh
pnpm --filter @codey/android generate:nerd-font-catalog -- /path/to/glyphnames.json
```
