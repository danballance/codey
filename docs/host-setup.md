# Linux host setup

Start with a clean Neovim configuration while validating transport, input, and
redraw behavior. Bind the listener to the host's concrete private-LAN address:

```sh
nvim --clean --headless --listen 192.168.1.20:6666
```

Replace `192.168.1.20` with the development host's actual address. A desktop
client on the same machine can use `127.0.0.1`; an Android tablet cannot, because
its loopback address refers to the tablet.

Useful host checks are:

```sh
ip -brief address
ss -ltn | grep 6666
nvim --version
```

The tablet and host must be on the same trusted private network, and the host
firewall must allow the chosen TCP port from the tablet. Enter the same concrete
host address and port in Codey's connection toolbar. Only one UI client should
connect during this prototype.

Stopping Neovim closes the session. Codey reports the terminal error and leaves
reconnection explicit; restart Neovim, then use Connect again.

## Physical Android tablet

The Android vertical slice targets a 12–14-inch tablet in portrait or landscape.
It supports windows with a shortest side of at least `600dp`; smaller windows
and phones show only the unsupported-device screen. Portrait and square windows
stack the action pad below the terminal, with its button groups anchored left
and right. Landscape windows place the groups at the top and bottom of a
scrollable two-column right-hand rail.

Enable Android developer options and USB debugging, attach the device, and
accept its authorization prompt. From `nix develop`, verify that ADB can see it:

```sh
adb devices
```

Install the native development client with `pnpm android:install`. Keep USB
attached for the most predictable development workflow, or make sure Metro's
LAN address is reachable from the tablet before using `pnpm android:metro`.
Native module or Expo configuration changes require a clean
`pnpm android:prebuild` followed by another install; ordinary TypeScript changes
only require Metro. Orientation support is generated into the native manifest,
so changing it also requires rebuilding and reinstalling the development client.

## Safety

Neovim's native RPC API can execute commands with the privileges of the user
running Neovim. The current client has no TLS or authentication. Treat the
listener as a trusted-LAN-only development endpoint:

- bind the concrete private address, never `0.0.0.0`;
- do not forward the port at the router;
- restrict inbound TCP port 6666 to the tablet address or trusted subnet;
- do not use the prototype on public Wi-Fi or across the internet.

Introduce the normal Neovim configuration and plugins incrementally only after
the `--clean` path behaves correctly.
