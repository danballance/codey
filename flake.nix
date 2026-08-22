{
  description = "Codey remote Neovim client development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { nixpkgs, ... }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };

          # Electron is installed by pnpm so its JS API and runtime stay on the
          # same version. These packages provide the shared libraries expected
          # by that upstream, FHS-linked Electron binary on NixOS.
          electronRuntimeLibraries = with pkgs; [
            alsa-lib
            at-spi2-core
            atk
            cairo
            cups
            dbus
            expat
            fontconfig
            freetype
            glib
            gtk3
            libdrm
            libgbm
            libnotify
            libx11
            libxcb
            libxcomposite
            libxdamage
            libxext
            libxfixes
            libxkbcommon
            libxrandr
            mesa
            nspr
            nss
            pango
            stdenv.cc.cc.lib
            systemd
          ];

          electronLibraryPath = pkgs.lib.makeLibraryPath electronRuntimeLibraries;
        in
        {
          default = pkgs.mkShell {
            name = "codey";

            packages =
              with pkgs;
              [
                git
                gnumake
                neovim
                nodejs_24
                pkg-config
                pnpm
                python3
                stdenv.cc
              ]
              ++ electronRuntimeLibraries;

            shellHook = ''
              export LD_LIBRARY_PATH="${electronLibraryPath}''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
              export NIX_LD_LIBRARY_PATH="${electronLibraryPath}''${NIX_LD_LIBRARY_PATH:+:$NIX_LD_LIBRARY_PATH}"
            '';
          };
        }
      );

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
