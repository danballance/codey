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
          pkgs = import nixpkgs {
            inherit system;
            config = {
              allowUnfree = true;
              android_sdk.accept_license = true;
            };
          };

          androidPlatformVersion = "36";
          # Expo's aggregate Android library leaves its build-tools selection
          # to AGP, whose SDK 57 default remains 35.0.0. The app itself is
          # pinned to 36.0.0, but both must exist in the immutable Nix SDK.
          androidCompatibilityBuildToolsVersion = "35.0.0";
          androidBuildToolsVersion = "36.0.0";
          androidNdkVersion = "27.1.12297006";
          androidCmakeVersion = "3.22.1";

          # This is deliberately a physical-device SDK: no emulator or system
          # images are composed into the development shell.
          androidComposition = pkgs.androidenv.composeAndroidPackages {
            platformVersions = [ androidPlatformVersion ];
            buildToolsVersions = [
              androidCompatibilityBuildToolsVersion
              androidBuildToolsVersion
            ];
            includeCmake = true;
            cmakeVersions = [ androidCmakeVersion ];
            includeNDK = true;
            ndkVersions = [ androidNdkVersion ];
            includeEmulator = false;
            includeSystemImages = false;
          };
          androidSdk = androidComposition.androidsdk;
          androidHome = "${androidSdk}/libexec/android-sdk";
          androidNdkHome = "${androidHome}/ndk/${androidNdkVersion}";
          androidAapt2 = "${androidHome}/build-tools/${androidBuildToolsVersion}/aapt2";
          jdk = pkgs.jdk17;

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
                androidSdk
                androidComposition.platform-tools
                eas-cli
                jdk
                watchman
              ]
              ++ electronRuntimeLibraries;

            ANDROID_HOME = androidHome;
            ANDROID_SDK_ROOT = androidHome;
            ANDROID_NDK_HOME = androidNdkHome;
            ANDROID_NDK_ROOT = androidNdkHome;
            NDK_HOME = androidNdkHome;
            JAVA_HOME = jdk.home;
            LANG = "C.UTF-8";
            LC_ALL = "C.UTF-8";

            shellHook = ''
              export LD_LIBRARY_PATH="${electronLibraryPath}''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
              export NIX_LD_LIBRARY_PATH="${electronLibraryPath}''${NIX_LD_LIBRARY_PATH:+:$NIX_LD_LIBRARY_PATH}"
              export GRADLE_OPTS="-Dorg.gradle.project.android.aapt2FromMavenOverride=${androidAapt2}''${GRADLE_OPTS:+ $GRADLE_OPTS}"
            '';
          };
        }
      );

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
