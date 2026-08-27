# Windows EXE browser-session continuity fix

Verified on 2026-08-27 (Asia/Shanghai) against the live QA Hub API/Web at
`10.100.5.157:4319/4174`. Unity and Jenkins were not invoked.

## Observed failure

The reporting client was `10.100.5.128`. The API log proves the network path
and pinyin identity were already valid:

```text
GET  /api/v1/auth/me      -> 401 (expected before login)
POST /api/v1/auth/login   -> 200
GET  /api/v1/projects     -> 401
GET  /members and /bugs   -> 401, repeated
```

The same sequence occurred twice. The `NATIVE_SESSION_INVALID` text came from
the downstream business route after the successful browser login; it did not
mean that the EXE sent `x-qa-actor-id`, and it was not a firewall or endpoint
failure.

The previous package smoke was also reproduced as a false green. It accepted
`appReady=true` immediately after the login response even though the real list
had not loaded:

```text
pinyinLoginSucceeded: true
bugRowCount:           0
```

After the smoke was changed to wait for the business workbench, the old package
correctly failed with `Packaged pinyin login failed`.

## Root cause and repair

Electron's `qa-hub://` custom protocol response did not persist the API's
`HttpOnly qa_hub_browser_session` cookie consistently on the reporting Windows
client. Login returned 200 and React entered the shell using that response, but
the next requests contained no usable browser session and reached the native
Bearer guard.

The repair keeps a bounded copy of only `qa_hub_browser_session` inside the
trusted Electron main process. The proxy captures the validated 43-character
session token from `Set-Cookie`, injects it into subsequent API requests, and
clears it on the logout cookie. Renderer-provided cookies remain an accepted
input when the platform cookie jar works.

The renderer API proxy no longer injects the desktop background-notification
Bearer. Pinyin/Web management always uses the browser session; the Bearer is
kept only in the WSS/durable-Inbox background transport. This prevents an old
notification token from overriding or bypassing the selected Web identity.

## Red/green verification

Targeted and full checks:

```text
Desktop network regression: 5/5
Desktop complete tests:      22/22
Desktop TypeScript:          pass
Changed-source Prettier:     pass
Old package + strict smoke:  fail (expected red)
New package + strict smoke:  pass
```

The final packaged process used fresh LocalAppData, fresh Chromium data, no
endpoint environment override, and no Bearer token. It exercised the real API,
not a fake response:

```text
freshProfile:                  true
portableSidecarAutoLoaded:     true
loginVisibleBeforeLogin:       true
notificationsCredentialState: disabled
pinyinLoginSucceeded:          true
bugRowCount:                   3
workbenchErrorText:            <empty>
bugDetailLoaded:               true
bugDetailErrorText:            <empty>
evidenceImageCount:            1
evidenceLoadedCount:           1
```

The ZIP was then downloaded in full through the LAN route and hashed from the
HTTP response stream:

```text
URL:          http://10.100.5.157:4174/downloads/Relay-QA-Hub-Windows-x64.zip
HTTP:         200 application/zip
Cache:        no-store
Bytes:        150,404,868
SHA-256:      896E09F61622305580765354A9FD276F129D722832CA127F805FA0A6A4FD0478
Local match:  true

EXE bytes:    235,534,336
EXE SHA-256:  E3091DC179CD461ADEF08E627944517E55B81CE0AB58E1D116B06CBB3FFC3E68
ZIP entries:  78
Token/secret-shaped ZIP entries: 0
```

Readback of packaged `app.asar` found the main-process Cookie store and browser
session cookie name. The built renderer proxy contains no desktop-token
Authorization injection, while the background Inbox path still uses its
optional token.

## Remaining physical confirmation

The exact reporting second computer still needs to close the old tray process,
download the ZIP above again, fully extract it, and run the new directory. That
physical readback is the only remaining confirmation for this machine-specific
failure; the code/package/LAN route are green.

