"""QA Hub paired iPhone installer. Release Ad Hoc copies; no uninstall or launch."""
import datetime
import hashlib
import fnmatch
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import tempfile
import urllib.request
import zipfile


class InstallError(Exception):
    def __init__(self, code, unconfirmed=False):
        self.code, self.unconfirmed = code, unconfirmed


def run_json(arguments, directory, timeout=30):
    output = Path(directory) / (os.urandom(8).hex() + '.json')
    try:
        result = subprocess.run(
            ['/usr/bin/xcrun', 'devicectl', *arguments, '--timeout', str(timeout),
             '--json-output', str(output)], capture_output=True, timeout=timeout + 10)
    except subprocess.TimeoutExpired:
        raise InstallError('IOS_INSTALL_TIMEOUT', True)
    try:
        data = json.loads(output.read_text())
    except (OSError, ValueError):
        raise InstallError('IOS_INSTALL_JOB_UNAVAILABLE')
    if result.returncode or data.get('info', {}).get('outcome') != 'success':
        # Only stable categories leave the worker; raw device diagnostics stay local.
        message = json.dumps(data.get('error', {})).lower()
        if 'locked' in message or 'passcode' in message:
            raise InstallError('IOS_DEVICE_LOCKED')
        if 'developer mode' in message:
            raise InstallError('IOS_DEVELOPER_MODE_REQUIRED')
        if 'not connected' in message or 'unavailable' in message or 'disconnected' in message:
            raise InstallError('IOS_DEVICE_OFFLINE')
        raise InstallError('IOS_INSTALL_FAILED')
    return data['result']


def device_inventory(directory):
    devices = run_json(['list', 'devices'], directory).get('devices', [])
    rows, raw = [], {}
    for device in devices:
        hardware = device.get('hardwareProperties', {})
        props = device.get('deviceProperties', {})
        connection = device.get('connectionProperties', {})
        if (hardware.get('platform') != 'iOS' or hardware.get('reality') != 'physical'
                or hardware.get('deviceType') != 'iPhone'
                or connection.get('pairingState') != 'paired'):
            continue
        identifier = device.get('identifier', '')
        if not re.fullmatch(r'[0-9A-Fa-f-]{36}', identifier):
            continue
        raw[identifier.lower()] = device
        rows.append({
            'id': identifier.lower(), 'name': props.get('name', 'iPhone'),
            'model': hardware.get('marketingName', 'iPhone'),
            'osVersion': props.get('osVersionNumber', ''),
            'online': connection.get('tunnelState') in ('connected', 'connecting', 'disconnected'),
            'developerMode': props.get('developerModeStatus') == 'enabled',
            'connection': connection.get('transportType', 'network'),
        })
    return sorted(rows, key=lambda d: (d['model'] != 'iPhone 15', d['model'], d['id'])), raw


def download_ipa(artifact, target):
    if (not re.fullmatch(r'http://10\.100\.5\.129:8000/ozdqp/iOS/(Debug|Release)/'
                         r'\d+\.\d+\.\d+/[1-9]\d*/packages/[A-Za-z0-9][A-Za-z0-9._-]{0,230}\.ipa', artifact['url'])
            or not re.fullmatch(r'[0-9a-f]{64}', artifact['sha256'])
            or not isinstance(artifact['size'], int) or not 0 < artifact['size'] <= 8 * 1024**3):
        raise InstallError('IOS_IPA_INVALID')

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            raise InstallError('IOS_IPA_CHANGED')

    digest, total = hashlib.sha256(), 0
    with urllib.request.build_opener(NoRedirect).open(artifact['url'], timeout=30) as response, open(target, 'wb') as out:
        while chunk := response.read(1024 * 1024):
            total += len(chunk)
            if total > artifact['size']:
                raise InstallError('IOS_IPA_CHANGED')
            digest.update(chunk)
            out.write(chunk)
    if total != artifact['size'] or digest.hexdigest() != artifact['sha256']:
        raise InstallError('IOS_IPA_CHANGED')


def extract_app(ipa, directory):
    destination = Path(directory).resolve()
    with zipfile.ZipFile(ipa) as archive:
        expanded = 0
        for member in archive.infolist():
            name = member.filename
            expanded += member.file_size
            if (expanded > 16 * 1024**3 or '\\' in name or name.startswith('/')
                    or '..' in Path(name).parts):
                raise InstallError('IOS_IPA_INVALID')
            if (member.external_attr >> 16) & 0o170000 == 0o120000:
                link = archive.read(member).decode('utf8')
                if not (destination / name).parent.joinpath(link).resolve().is_relative_to(destination):
                    raise InstallError('IOS_IPA_INVALID')
    result = subprocess.run(['/usr/bin/ditto', '-x', '-k', str(ipa), str(destination)],
                            capture_output=True, timeout=180)
    apps = list((destination / 'Payload').glob('*.app'))
    if result.returncode or len(apps) != 1:
        raise InstallError('IOS_IPA_INVALID')
    return apps[0]


def validate_profile(app, device):
    profile = subprocess.run(['/usr/bin/security', 'cms', '-D', '-i', str(app / 'embedded.mobileprovision')],
                             capture_output=True, timeout=20)
    if profile.returncode:
        raise InstallError('IOS_SIGNING_NOT_SUPPORTED')
    data = plistlib.loads(profile.stdout)
    expiry = data.get('ExpirationDate')
    if not isinstance(expiry, datetime.datetime) or expiry <= datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None):
        raise InstallError('IOS_PROFILE_EXPIRED')
    devices = data.get('ProvisionedDevices')
    if not data.get('ProvisionsAllDevices'):
        if not devices:
            raise InstallError('IOS_SIGNING_NOT_SUPPORTED')
        if device['hardwareProperties']['udid'].lower() not in [d.lower() for d in devices]:
            raise InstallError('IOS_DEVICE_NOT_PROVISIONED')
    verification = subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)],
                                  capture_output=True, timeout=60)
    if verification.returncode:
        raise InstallError('IOS_IPA_INVALID')
    info = plistlib.loads((app / 'Info.plist').read_bytes())
    for key in ('CFBundleIdentifier', 'CFBundleShortVersionString', 'CFBundleVersion'):
        if not isinstance(info.get(key), str) or not info[key]:
            raise InstallError('IOS_IPA_INVALID')
    return info


def entitlement_allowed(value, allowed):
    if isinstance(value, str) and isinstance(allowed, str):
        return fnmatch.fnmatchcase(value, allowed)
    if isinstance(value, list) and isinstance(allowed, list):
        return all(any(entitlement_allowed(v, a) for a in allowed) for v in value)
    if isinstance(value, dict) and isinstance(allowed, dict):
        return all(k in allowed and entitlement_allowed(v, allowed[k]) for k, v in value.items())
    return type(value) is type(allowed) and value == allowed


def adhoc_entitlements(existing, permitted):
    # Keep application capabilities; only replace distribution-specific values.
    result = dict(existing)
    if 'beta-reports-active' not in permitted:
        result.pop('beta-reports-active', None)
    for key in ['application-identifier', 'com.apple.developer.team-identifier', 'get-task-allow']:
        if key in permitted:
            result[key] = permitted[key]
    if any(k not in permitted or not entitlement_allowed(v, permitted[k]) for k, v in result.items()):
        raise InstallError('IOS_ADHOC_ENTITLEMENTS_MISMATCH')
    return result


def choose_adhoc_profile(application_id, udid):
    identity_result = subprocess.run(['/usr/bin/security', 'find-identity', '-v', '-p', 'codesigning'],
                                     capture_output=True, text=True, timeout=20)
    identities = set(re.findall(r'\b[0-9A-F]{40}\b', identity_result.stdout))
    candidates = []
    for root in [Path.home() / 'Library/MobileDevice/Provisioning Profiles',
                 Path.home() / 'Library/Developer/Xcode/UserData/Provisioning Profiles']:
        for file in root.glob('*.mobileprovision'):
            result = subprocess.run(['/usr/bin/security', 'cms', '-D', '-i', str(file)], capture_output=True, timeout=20)
            try:
                profile = plistlib.loads(result.stdout)
                entitlements = profile['Entitlements']
                expiry = profile['ExpirationDate']
                if (entitlements.get('application-identifier') != application_id or entitlements.get('get-task-allow') is not False
                        or not isinstance(expiry, datetime.datetime)
                        or expiry <= datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
                        or udid.lower() not in [d.lower() for d in profile.get('ProvisionedDevices', [])]):
                    continue
                identity = next((hashlib.sha1(cert).hexdigest().upper() for cert in profile.get('DeveloperCertificates', [])
                                 if hashlib.sha1(cert).hexdigest().upper() in identities), None)
                if identity:
                    candidates.append((expiry, str(file), identity, profile))
            except (KeyError, ValueError, TypeError):
                continue
    if not candidates:
        raise InstallError('IOS_ADHOC_PROFILE_UNAVAILABLE')
    return sorted(candidates, key=lambda row: (row[0], row[1]), reverse=True)[0]


def resign_adhoc(app, device, directory):
    # app is extracted into this request's private temporary directory. Never
    # rewrite the downloaded store IPA or the build machine's published package.
    verification = subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)], capture_output=True, timeout=60)
    if verification.returncode:
        raise InstallError('IOS_IPA_INVALID')
    before = (app / 'Info.plist').read_bytes()
    info = plistlib.loads(before)
    old = subprocess.run(['/usr/bin/codesign', '-d', '--entitlements', ':-', str(app)], capture_output=True, timeout=20)
    try:
        existing = plistlib.loads(old.stdout)
        application_id = existing['application-identifier']
        if not application_id.endswith('.' + info['CFBundleIdentifier']):
            raise ValueError('Wrong bundle identity')
    except (KeyError, ValueError):
        raise InstallError('IOS_IPA_INVALID')
    if list(app.rglob('*.appex')) or list(app.rglob('*.app')):
        raise InstallError('IOS_ADHOC_NESTED_APP_UNSUPPORTED')
    _, profile_path, identity, profile = choose_adhoc_profile(application_id, device['hardwareProperties']['udid'])
    entitlements = adhoc_entitlements(existing, profile['Entitlements'])
    entitlements_path = Path(directory) / 'adhoc-entitlements.plist'
    entitlements_path.write_bytes(plistlib.dumps(entitlements))
    shutil.copyfile(profile_path, app / 'embedded.mobileprovision')
    nested = [p for p in app.rglob('*') if p.suffix in ('.framework', '.dylib') and not p.is_symlink()]
    for code in sorted(nested, key=lambda p: len(p.parts), reverse=True) + [app]:
        args = ['/usr/bin/codesign', '--force', '--sign', identity, '--timestamp=none']
        if code == app:
            args += ['--generate-entitlement-der', '--entitlements', str(entitlements_path)]
        result = subprocess.run([*args, str(code)], capture_output=True, timeout=90)
        if result.returncode:
            raise InstallError('IOS_ADHOC_SIGNING_FAILED')
    if (app / 'Info.plist').read_bytes() != before:
        raise InstallError('IOS_IPA_CHANGED')
    validate_profile(app, device)
    prepared = Path(directory) / 'adhoc.ipa'
    result = subprocess.run(['/usr/bin/ditto', '-c', '-k', '--keepParent', str(app.parent), str(prepared)],
                            capture_output=True, timeout=180)
    if result.returncode:
        raise InstallError('IOS_ADHOC_SIGNING_FAILED')
    digest = hashlib.sha256()
    with prepared.open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return {'signingMode': 'adhoc', 'preparedIpaSha256': digest.hexdigest(), 'profileName': profile.get('Name', 'Ad Hoc')}


def prepare_app(request, report, directory, device):
    ipa = Path(directory) / 'package.ipa'
    download_ipa(request['artifact'], ipa)
    app = extract_app(ipa, Path(directory) / 'unpacked')
    report['signingMode'] = 'original'
    try:
        info = validate_profile(app, device)
    except InstallError as error:
        if request['selection']['configuration'] != 'Release' or error.code not in (
                'IOS_SIGNING_NOT_SUPPORTED', 'IOS_DEVICE_NOT_PROVISIONED', 'IOS_PROFILE_EXPIRED'):
            raise
        report.update(resign_adhoc(app, device, directory))
        info = validate_profile(app, device)
    report.update(bundleId=info['CFBundleIdentifier'], appVersion=info['CFBundleShortVersionString'], appBuild=info['CFBundleVersion'])
    return app


def install(request, report, directory, raw):
    selection, artifact = request['selection'], request['artifact']
    identifier = selection['deviceId']
    report.update(deviceId=identifier, artifactSha256=artifact['sha256'])
    device = raw.get(identifier)
    if not device:
        raise InstallError('IOS_DEVICE_NOT_FOUND')
    row = next(d for d in report['devices'] if d['id'] == identifier)
    if not row['online']:
        raise InstallError('IOS_DEVICE_OFFLINE')
    if not row['developerMode']:
        raise InstallError('IOS_DEVELOPER_MODE_REQUIRED')
    app = prepare_app(request, report, directory, device)
    info = plistlib.loads((app / 'Info.plist').read_bytes())
    if report['signingMode'] == 'adhoc':
        shutil.copyfile(Path(directory) / 'adhoc.ipa', 'adhoc.ipa')
    # Save the selected identity before the only mutating command. If Jenkins is
    # interrupted afterwards, the API reports unknown and never replays it.
    Path('install-intent.json').write_text(json.dumps(report), encoding='utf8')
    try:
        result = run_json(['device', 'install', 'app', '--device', identifier, str(app)], directory, timeout=600)
    except InstallError as error:
        if error.code in ('IOS_INSTALL_JOB_UNAVAILABLE', 'IOS_INSTALL_FAILED'):
            raise InstallError('IOS_INSTALL_UNCONFIRMED', True)
        raise
    if (str(result.get('deviceIdentifier', '')).lower() != identifier or
            not any(a.get('bundleID') == info['CFBundleIdentifier'] for a in result.get('installedApplications', []))):
        raise InstallError('IOS_INSTALL_UNCONFIRMED', True)
    try:
        apps = run_json(['device', 'info', 'apps', '--device', identifier, '--bundle-id', info['CFBundleIdentifier']], directory, timeout=45).get('apps', [])
        confirmed = any(a.get('bundleIdentifier') == info['CFBundleIdentifier']
                        and a.get('version') == info['CFBundleShortVersionString']
                        and a.get('bundleVersion') == info['CFBundleVersion'] for a in apps)
        if not confirmed:
            raise InstallError('IOS_INSTALL_UNCONFIRMED', True)
    except InstallError:
        raise InstallError('IOS_INSTALL_UNCONFIRMED', True)


def main():
    request = json.loads(os.environ['INSTALL_REQUEST'])
    if not re.fullmatch(r'[0-9a-f-]{36}', request.get('id', '')) or request.get('action') not in ('devices', 'install'):
        raise RuntimeError('Invalid install request')
    report = {'schemaVersion': 1, 'requestId': request['id'], 'action': request['action'],
              'status': 'complete', 'errorCode': None, 'devices': [],
              'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    try:
        with tempfile.TemporaryDirectory(prefix='qa-ipa-') as directory:
            report['devices'], raw = device_inventory(directory)
            if request['action'] == 'install':
                install(request, report, directory, raw)
    except InstallError as error:
        report.update(status='unconfirmed' if error.unconfirmed else 'failed', errorCode=error.code)
    except Exception:
        report.update(status='failed', errorCode='IOS_INSTALL_FAILED')
    Path('result.json').write_text(json.dumps(report, ensure_ascii=False), encoding='utf8')
    print(json.dumps({'action': request['action'], 'status': report['status'], 'errorCode': report['errorCode']}))
    return 0 if report['status'] == 'complete' else 1


if __name__ == '__main__':
    raise SystemExit(main())
