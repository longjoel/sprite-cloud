# sc-server installation and operations

This is the canonical guide for installing, configuring, upgrading, running, and troubleshooting a Sprite Cloud game host.

`sc-server` runs on the Linux machine that owns the ROMs and libretro cores. Do not install it on the `sc-web` gateway VPS unless that machine also intentionally hosts the games.

## Supported systems

- Linux on `x86_64`
- Linux on 64-bit ARM (`aarch64`/`arm64`), including Raspberry Pi 3/4/5 with a 64-bit OS
- Debian/Ubuntu, Fedora/Bazzite, and Arch-family distributions

32-bit ARM (`armv7l`) is not supported. The installer stops with a clear error instead of downloading an incompatible binary.

## Runtime dependencies

The public installer requires `curl`, `tar`, and SHA-256 tooling. `sc-server` also needs GStreamer with the base, good, bad, and ugly plugin sets.

```bash
# Debian/Ubuntu
sudo apt update
sudo apt install curl tar gstreamer1.0-plugins-base \
  gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
  gstreamer1.0-plugins-ugly gstreamer1.0-libav

# Fedora/Bazzite
sudo dnf install curl tar gstreamer1 gstreamer1-plugins-base \
  gstreamer1-plugins-good gstreamer1-plugins-bad-free \
  gstreamer1-plugins-ugly-free

# Arch
sudo pacman -S curl tar gstreamer gst-plugins-base gst-plugins-good \
  gst-plugins-bad gst-plugins-ugly
```

Bazzite normally includes much of the multimedia stack already. The installer warns when the GStreamer runtime cannot be detected.

## What is persistent

The setup wizard writes host configuration to:

```text
~/.config/sprite-cloud/config.toml
```

The user service stores mutable state under:

```text
~/.local/share/sprite-cloud/
```

The following setup choices survive pairing, service restarts, and binary upgrades:

- ROM root
- libretro core directory
- gateway URL
- pairing credentials
- ICE setup values stored in the configuration

Pairing updates only the gateway URL and credentials; it does not discard the ROM, core, or ICE sections. An explicit `GV_ROM_ROOTS` or `GV_CORES_DIR` environment variable overrides the corresponding saved value for that process.

The installer never deletes ROM files. ROMs remain wherever you placed them.

## Recommended installation

The public installer detects the CPU architecture, selects the latest GitHub release, downloads the matching binary and checksum, verifies SHA-256, and atomically replaces the executable.

```bash
curl -fsSL https://sprite-cloud.com/install.sh | bash
```

By default:

- a normal user without write access to `/usr/local/bin` installs to `~/.local/bin/sc-server`;
- root installs to `/usr/local/bin/sc-server`;
- `SC_INSTALL_DIR=/custom/path` overrides the binary destination.

If `~/.local/bin` is new, start a new shell or add it to the current shell:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Verify the binary:

```bash
command -v sc-server
sc-server --version
```

The public installer installs the binary only. It does not silently alter configuration, ROMs, saves, or an existing service.

## First-time setup

Run setup as the same login user that will run the service:

```bash
sc-server setup
```

The wizard asks for:

1. ROM directory
2. libretro cores directory
3. ICE transport policy
4. STUN server

After the core directory is entered, it prints a clickable dashboard URL:

```text
https://sprite-cloud.com/dashboard
```

Setup scans the selected ROM root and reports the number of recognized games. A zero count usually means the path is wrong, unreadable by the current user, or contains unsupported file extensions.

Inspect the saved non-secret path configuration with:

```bash
sed -n '/^\[rom\]/,/^\[/p; /^\[cores\]/,/^\[/p' ~/.config/sprite-cloud/config.toml
```

Do not publish the complete configuration: the `[auth]` section contains host credentials after pairing.

## Pair with sprite-cloud.com

1. Open [https://sprite-cloud.com/dashboard](https://sprite-cloud.com/dashboard).
2. Generate a pairing code.
3. Run the displayed command on the game host:

```bash
sc-server pair <CODE> --sc-web-url https://sprite-cloud.com
```

Pairing codes are short-lived. Generate a new code if the claim is rejected or expired.

Pairing preserves the ROM root and core directory written by `sc-server setup`.

## Test in the foreground

Before installing the service, run:

```bash
sc-server start
```

Stop it with `Ctrl+C` after confirming that the server connects and the local library is available. Do not leave a foreground server running when starting the systemd service: two processes using the same paired server identity can race for commands.

For LAN-only standalone operation without a gateway account:

```bash
sc-server start --standalone
```

Then open:

```text
http://<host-lan-ip>:8787
```

Standalone mode also reads the ROM root and core directory saved by setup.

## Install the systemd user service

Run these commands as your normal login user:

```bash
sc-server install
systemctl --user daemon-reload
systemctl --user enable --now sc-server
```

Never run `sc-server install` or `systemctl --user` through `sudo`. `sudo systemctl --user ...` targets root's user manager and commonly fails with:

```text
Failed to connect to bus: No medium found
```

Check the service:

```bash
systemctl --user status sc-server
journalctl --user -u sc-server -n 100 --no-pager
```

Follow logs:

```bash
journalctl --user -u sc-server -f
```

The generated unit is:

```text
~/.config/systemd/user/sc-server.service
```

It explicitly sets persistent `GV_DATA_DIR` to `~/.local/share/sprite-cloud`.

### Headless hosts and Bazzite

Enable lingering so the user service survives logout and starts without an interactive login:

```bash
sudo loginctl enable-linger "$USER"
loginctl show-user "$USER" -p Linger
```

Expected result:

```text
Linger=yes
```

If `systemctl --user` still cannot reach the bus, log out and back in once after enabling lingering. Then run the `systemctl --user` commands again without `sudo`.

## Verify ROM-root persistence

Check the saved root:

```bash
sc-server scan
```

Restart and check again:

```bash
systemctl --user restart sc-server
journalctl --user -u sc-server -n 100 --no-pager
```

If a temporary environment override is present, it wins over the saved config:

```bash
systemctl --user show-environment | grep '^GV_ROM_ROOTS=' || true
printf 'shell GV_ROM_ROOTS=%s\n' "${GV_ROM_ROOTS-<unset>}"
```

Remove an unwanted shell override with:

```bash
unset GV_ROM_ROOTS
```

After changing setup values, restart the service:

```bash
systemctl --user restart sc-server
```

## Upgrade

Preferred:

```bash
sc-server upgrade
systemctl --user restart sc-server
```

The command downloads and verifies both required executables (`sc-server` and
`sc-core`) before atomically replacing each file in the current installation directory.

Installer fallback:

Rerun the public installer:

```bash
curl -fsSL https://sprite-cloud.com/install.sh | bash
systemctl --user restart sc-server
```

This replaces only the verified executable. It preserves:

- `~/.config/sprite-cloud/config.toml`
- `~/.local/share/sprite-cloud/`
- ROM files and directories
- pairing credentials
- library preferences and recent-play state

Confirm the release and service afterward:

```bash
sc-server --version
systemctl --user status sc-server
```

## Repository installer for managed/self-hosted deployments

Repository administrators can use `scripts/install.sh`. Unlike the public binary-only installer, it can install GStreamer packages, create a service, and configure either a dedicated system account or a rootless user service.

```bash
git clone https://github.com/longjoel/sprite-cloud
cd sprite-cloud

# Dedicated system service (default):
sudo ./scripts/install.sh \
  --web-url https://your-gateway.example \
  --rom-dir /srv/storage/games/roms

# Rootless user service:
./scripts/install.sh --rootless \
  --web-url https://your-gateway.example \
  --rom-dir "$HOME/roms"
```

The repository installer supports Debian/Ubuntu, Fedora/Bazzite, and Arch-family package managers. It verifies the release checksum before replacing the binary and preserves an existing config on reinstall.

For a system-wide install, claim the pairing code as the `sprite-cloud` service account so pairing updates `/etc/sprite-cloud/config.toml`:

```bash
sudo -u sprite-cloud env XDG_CONFIG_HOME=/etc \
  /usr/local/bin/sc-server pair <CODE> \
  --sc-web-url https://your-gateway.example
sudo systemctl enable --now sc-server
```

A plain `sc-server pair` run as your login user writes to your user config and does not pair the managed system service.

### Managed system-service paths

| Item | System-wide | Rootless |
|---|---|---|
| Binary | `/usr/local/bin/sc-server` | `~/.local/bin/sc-server` |
| Config | `/etc/sprite-cloud/config.toml` | `~/.config/sprite-cloud/config.toml` |
| Data | `/var/lib/sprite-cloud` | `~/.local/share/sprite-cloud` |
| Unit | `/etc/systemd/system/sc-server.service` | `~/.config/systemd/user/sc-server.service` |
| Service command | `sudo systemctl ... sc-server` | `systemctl --user ... sc-server` |

The dedicated system service runs as the `sprite-cloud` account. Its configured ROM root must be readable by that account. The hardened system unit uses `ProtectHome=yes`, so do not point it at ROMs under a private home directory; use a readable path such as `/srv/storage/games/roms`, or choose rootless mode.

## Configuration reference

Example user configuration:

```toml
[sc_web]
url = "https://sprite-cloud.com"

[auth]
api_key = "<written by pairing>"
server_id = "<written by pairing>"

[rom]
roots = ["/path/to/roms"]

[cores]
dir = "/usr/lib/libretro"
```

Multiple ROM roots can be configured manually:

```toml
[rom]
roots = [
  "/srv/roms/consoles",
  "/srv/roms/arcade",
]
```

Environment overrides:

```bash
export GV_ROM_ROOTS=/srv/roms/consoles,/srv/roms/arcade
export GV_CORES_DIR=/srv/libretro/cores
```

See [configuration.md](configuration.md) for all runtime variables.

## Troubleshooting

### Setup saved a root but no games appear

Run:

```bash
sc-server scan
namei -l /path/to/roms
```

Check that:

- the path exists on the `sc-server` host, not the gateway VPS;
- the service user can traverse every parent directory and read the ROM files;
- the files use supported ROM extensions;
- `GV_ROM_ROOTS` is not overriding the saved value;
- only one `sc-server` process is running for the paired server.

For a user service:

```bash
systemctl --user status sc-server
journalctl --user -u sc-server -n 200 --no-pager
```

For a managed system service:

```bash
sudo systemctl status sc-server
sudo journalctl -u sc-server -n 200 --no-pager
```

### `Failed to connect to bus: No medium found`

Do not use:

```bash
sudo systemctl --user ...
```

Use:

```bash
systemctl --user daemon-reload
systemctl --user enable --now sc-server
```

For a headless machine, enable lingering as described above.

### Service starts but uses an old binary

Compare the shell and unit paths:

```bash
command -v sc-server
systemctl --user show sc-server -p ExecStart
```

Reinstall to the same path used by `ExecStart`, or rerun `sc-server install` as the login user and reload the user manager.

### Core cannot be found

Confirm the persisted directory and its contents:

```bash
sed -n '/^\[cores\]/,/^\[/p' ~/.config/sprite-cloud/config.toml
find /path/to/cores -maxdepth 1 -name '*_libretro.so' -print
```

`GV_CORES_DIR` overrides the saved `[cores].dir` for that process.

### Authentication is rejected

If logs show HTTP `401`, an invalid API key, or a server that needs pairing, generate a fresh code from the dashboard and pair again. For a user service:

```bash
sc-server pair <CODE> --sc-web-url https://sprite-cloud.com
systemctl --user restart sc-server
```

For a managed system service, run the service-account pairing command from the managed-install section instead.

### Two-server race

Run exactly one process per paired `server_id`:

```bash
pgrep -af sc-server
systemctl --user status sc-server
```

Stop foreground copies before enabling the service.

## Uninstall

### User installation

Stop and remove the unit and binary:

```bash
systemctl --user disable --now sc-server
rm -f ~/.config/systemd/user/sc-server.service
systemctl --user daemon-reload
rm -f ~/.local/bin/sc-server
```

The commands above intentionally preserve configuration and state. To remove those too, after backing up anything needed:

```bash
rm -rf ~/.config/sprite-cloud ~/.local/share/sprite-cloud
```

ROM directories are never part of those paths and must not be deleted by uninstalling Sprite Cloud.

### Managed system installation

```bash
sudo systemctl disable --now sc-server
sudo rm -f /etc/systemd/system/sc-server.service /usr/local/bin/sc-server
sudo systemctl daemon-reload
```

Preserve `/etc/sprite-cloud` and `/var/lib/sprite-cloud` unless you explicitly want to erase pairing and server state. Never delete the configured ROM root as part of uninstalling the service.

## Reporting installer problems

Include:

```bash
uname -a
uname -m
sc-server --version
command -v sc-server
systemctl --user status sc-server --no-pager
journalctl --user -u sc-server -n 100 --no-pager
```

Redact the complete `[auth]` section, pairing codes, API keys, TURN credentials, and any private filesystem names you do not want to share.
