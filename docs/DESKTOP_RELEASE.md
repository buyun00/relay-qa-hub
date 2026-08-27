# Relay QA Hub Windows release and in-app updates

The Windows product is a per-user NSIS installation. This is intentional: the
initial install and every later update can complete without an administrator
prompt. The installer creates the Desktop and Start Menu shortcuts, registers
the `qa-hub://` protocol, and writes the current user's login-start entry. A
login start uses `--autostart`, so the tray and notification transport start
without forcing the main window to the foreground.

Closing the window keeps the application resident in the system tray. The tray
menu exposes login-start, notification pause/resume, manual update checking, and
explicit exit. A crashed renderer is reloaded up to three times while the main
process and tray remain alive. This is an interactive desktop product, not a
Windows service; it does not request SYSTEM or Session 0 privileges.

## Migrating an existing portable EXE

The earlier unpacked/portable EXE has no installed updater registration and
cannot discover this release retroactively. Install `1.0.0` once with the NSIS
installer. Every later release with a strictly newer version can then use the
in-app update flow described below.

## Build the installer

1. Increment `apps/desktop/package.json` with a strictly newer semantic version.
2. Build `apps/web` and `apps/desktop`.
3. Run `apps/desktop/scripts/build-installer.ps1`. Pass `-UpdateUrl` when the
   deployment does not use the loopback API default.
4. Verify the generated installer, blockmap, and `latest.yml` under
   `apps/desktop/release/installer`.

The update URL must be HTTPS, except for the explicitly loopback-only local
deployment. `electron-builder` produces a versioned NSIS installer and
`latest.yml`; `electron-updater` checks on startup, then every four hours, and
also on demand from the application or tray. Downloads are verified against the
SHA-512 metadata before the application offers “重启并安装”.

## Publish an update

Run `apps/desktop/scripts/publish-update.ps1` only after validating the packaged
application. The script refuses to replace an existing versioned artifact with
different bytes, copies and verifies the installer and blockmap first, and
publishes `latest.yml` last. The API serves the configured directory at:

```text
/api/v1/desktop-updates/stable/latest.yml
/api/v1/desktop-updates/stable/Relay-QA-Hub-Setup-<version>-x64.exe
/api/v1/desktop-updates/stable/Relay-QA-Hub-Setup-<version>-x64.exe.blockmap
```

The API defaults to
`<QA_HUB_DATA_ROOT>\desktop-updates\stable`; override it with the absolute
`QA_HUB_DESKTOP_UPDATE_ROOT` when required. Metadata is uncached, while
versioned artifacts are immutable and support byte ranges for differential
downloads.

## Signing boundary

The update workflow is functional without a certificate and always validates
the generated cryptographic metadata. A broadly distributed production release
must additionally inject an Authenticode certificate through the build
environment. Do not commit certificate files or passwords. Once a publisher
certificate is configured, keep its subject stable so `electron-updater` can
reject installers signed by a different publisher.
