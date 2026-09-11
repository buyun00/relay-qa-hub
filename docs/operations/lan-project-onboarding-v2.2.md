# QA Hub LAN project onboarding v2.2 operations

This runbook covers only the isolated `qa-hub-lan-v22-0911` instance. It must not be used against daily production or the earlier preview instance.

The evidence and user-self-test handoff for the 2026-09-11 deployment are recorded in [lan-project-onboarding-v2.2-delivery.md](./lan-project-onboarding-v2.2-delivery.md).

## Fixed boundaries

| Resource                   | LAN v2.2 value                                               |
| -------------------------- | ------------------------------------------------------------ |
| Runtime                    | `C:\Users\lin0\.codex\parallel-runtimes\qa-hub-lan-v22-0911` |
| Off-runtime backup archive | `C:\Users\lin0\.codex\parallel-archives\qa-hub-lan-v22-0911` |
| API                        | `127.0.0.1:4739` (loopback only)                             |
| Web and API proxy          | `0.0.0.0:4740`, published as `http://10.100.5.157:4740`      |
| Server MCP                 | `0.0.0.0:4741`, firewall-limited to the selected LAN CIDR    |
| Desktop MCP                | `127.0.0.1:4742` inside each Windows client                  |
| Cookie/update identity     | `qa-hub-lan-v22-0911`                                        |
| Scheduled task             | `Relay QA Hub LAN - qa-hub-lan-v22-0911`                     |

The current recommended adapter is `vEthernet (CorpAccess)`, address `10.100.5.157/21`, gateway `10.100.1.1`, network profile `Public`, and subnet `10.100.0.0/21`. The adapter is a Hyper-V external switch and is intentionally eligible. The address is currently DHCP-assigned; router-side DHCP reservation is still a network-administrator action and must not be reported as completed.

Production ports `4319/4174/4320` and earlier preview ports `4639/4640/4641/4642` are out of scope.

## Initialize and operate

Run from an ordinary PowerShell in this repository:

```powershell
.\scripts\project-components\Get-QAHubLanAddress.ps1
.\scripts\project-components\Initialize-QAHubLan.ps1
.\scripts\project-components\Manage-QAHubLan.ps1 -Action Start
.\scripts\project-components\Manage-QAHubLan.ps1 -Action Status
.\scripts\project-components\Manage-QAHubLan.ps1 -Action Stop
```

The initializer is create-only and refuses to overwrite an existing runtime, archive, database, download, or secret. The GM password and onboarding encryption key exist only in the restricted local `secrets.json`; do not copy that file into Git, chat, screenshots, the download page, or a client package.

Use an elevated PowerShell for the two machine-level operations:

```powershell
.\scripts\project-components\Enable-QAHubLanAccess.ps1
.\scripts\project-components\Manage-QAHubLan.ps1 -Action Install
```

The firewall rules allow only the Node executable, Web port 4740 and server MCP port 4741, from `10.100.0.0/21` on the adapter's actual network profile. They do not expose API port 4739 or desktop MCP port 4742. The scheduled task starts at boot and checks every five minutes so a missing owned process can be restarted. Process control verifies PID, creation time, executable path and command line rather than killing by process name.

`Uninstall` removes the scheduled task and stops only receipt-matched LAN processes. It retains the complete runtime, logs, downloads and backups:

```powershell
.\scripts\project-components\Manage-QAHubLan.ps1 -Action Uninstall
```

## Address changes

After a DHCP reservation or office-network change, detect the current preferred default route and update the instance:

```powershell
.\scripts\project-components\Get-QAHubLanAddress.ps1
.\scripts\project-components\Set-QAHubLanAddress.ps1 -Address 10.100.5.157 -Cidr 10.100.0.0/21
```

The update stops only this instance, retains the previous configuration, replaces its narrow firewall rules under elevation, and restarts the instance. Rebuild/publish clients if their baked-in initial server address also needs to change. Android users can save a new private-LAN or HTTPS server address in the login screen; it takes effect after fully reopening the app and does not clear Room data, drafts, attachments, queues or credentials.

## Backup and isolated restore proof

The API creates an online SQLite recovery point at startup and hourly. Each successful point is archived outside the runtime together with every referenced attachment and strict hash/binding manifests. Retention is enabled only for this instance's archive; the newest successful recoverable point is retained.

Restore validation must target a new, non-existent directory and must never replace the live database:

```powershell
node .\scripts\project-components\verify-lan-recovery.mjs `
  C:\Users\lin0\.codex\parallel-runtimes\qa-hub-lan-v22-0911\instance.json `
  C:\Users\lin0\.codex\parallel-restores\qa-hub-lan-v22-0911-verify
```

The verifier validates the archived database and attachment binding, restores both into the new directory, revalidates referenced blobs, and copies the recovery-required configuration into a restricted local subdirectory. A restore result is evidence only for that isolated target; it does not mutate the running instance.

## Onboarding and downloads

1. GM signs in through the management entry and creates a pending project.
2. GM shares the one-time fragment link with the project lead. The token does not enter the URL query or server access log.
3. The lead sets the unique project name, optional PNG/JPEG/WebP Logo (at most 512 KiB), and initial names.
4. Staff enter project name, the fixed four-digit code, and their name. Leading zeroes in the code are significant.
5. GM can reset the code, rotate/revoke an initialization link, disable membership, or disable the project without deleting history.

The employee Web entry is `http://10.100.5.157:4740`. The client download page is `http://10.100.5.157:4740/downloads/`, with the machine-readable manifest at `/downloads/distribution.json`. Published artifacts must match the file name, byte size, version and SHA-256 shown there. Client packages contain neither the GM password, initialization token nor project join code.

The shared host must remain powered on, awake and connected. When it is offline, users should treat connection errors as server unavailability; local Android drafts and queues are retained.

## Acceptance boundary

Agent-owned checks cover Web/API/server MCP through the LAN address, isolated data and membership behavior, package byte/hash publication, controlled restart/readiness, and isolated backup restore. If no second controllable network endpoint is available, that limitation is recorded instead of claiming office-wide connectivity.

The following remain **user self-test / handed off, not executed by the agent**: every Windows EXE operation (installation, launch, upgrade, notification and local MCP), physical Android, real game packaging, one-click package upload, real incremental publication, Relay AI production delivery, and Qingyu synchronization closure. These are neither proxy PASS results nor blockers for the bounded v2.2 delivery.
