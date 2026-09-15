import datetime
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('installer', Path(__file__).with_name('jenkins-ios-install.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
ID = '23155d04-d2d0-5469-8457-0294b916899e'


class InstallerTests(unittest.TestCase):
    def test_offline_prevents_download_or_install(self):
        request = {'selection': {'deviceId': ID, 'configuration': 'Debug'}, 'artifact': {'sha256': 'a'*64}}
        with patch.object(installer, 'download_ipa') as download, patch.object(installer, 'run_json') as command:
            with self.assertRaisesRegex(installer.InstallError, 'IOS_DEVICE_OFFLINE'):
                installer.install(request, {'devices': [{'id': ID, 'online': False}]}, '.', {ID: {'identifier': ID}})
            download.assert_not_called()
            command.assert_not_called()

    def test_inventory_returns_paired_iphones_without_serials_or_udids(self):
        device = {'identifier': ID.upper(), 'hardwareProperties': {'platform': 'iOS', 'reality': 'physical', 'deviceType': 'iPhone', 'marketingName': 'iPhone 15', 'serialNumber': 'SECRET', 'udid': 'PRIVATE'},
                  'deviceProperties': {'name': 'tester', 'developerModeStatus': 'enabled'}, 'connectionProperties': {'pairingState': 'paired', 'tunnelState': 'unavailable'}}
        with patch.object(installer, 'run_json', return_value={'devices': [device]}):
            rows, raw = installer.device_inventory('.')
        self.assertFalse(rows[0]['online'])
        self.assertEqual(rows[0]['id'], ID)
        self.assertNotIn('SECRET', json.dumps(rows))
        self.assertNotIn('PRIVATE', json.dumps(rows))
        self.assertIn(ID, raw)

    def test_zip_path_escape_is_rejected_before_extraction(self):
        with tempfile.TemporaryDirectory() as root:
            ipa = Path(root) / 'bad.ipa'
            with zipfile.ZipFile(ipa, 'w') as archive:
                archive.writestr('../other.txt', 'bad')
            with patch.object(installer.subprocess, 'run') as command:
                with self.assertRaisesRegex(installer.InstallError, 'IOS_IPA_INVALID'):
                    installer.extract_app(ipa, Path(root) / 'unpack')
                command.assert_not_called()

    def test_profile_requires_selected_device_and_valid_expiry(self):
        profile = {'ExpirationDate': datetime.datetime.now() + datetime.timedelta(days=10), 'ProvisionedDevices': ['other-device']}
        with patch.object(installer.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, plistlib.dumps(profile))):
            with self.assertRaisesRegex(installer.InstallError, 'IOS_DEVICE_NOT_PROVISIONED'):
                installer.validate_profile(Path('.'), {'hardwareProperties': {'udid': 'target'}})
        profile['ExpirationDate'] = datetime.datetime.now() - datetime.timedelta(days=1)
        with patch.object(installer.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, plistlib.dumps(profile))):
            with self.assertRaisesRegex(installer.InstallError, 'IOS_PROFILE_EXPIRED'):
                installer.validate_profile(Path('.'), {'hardwareProperties': {'udid': 'target'}})

    def test_store_profile_cannot_be_installed_as_development(self):
        profile = {'ExpirationDate': datetime.datetime.now() + datetime.timedelta(days=10)}
        with patch.object(installer.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, plistlib.dumps(profile))):
            with self.assertRaisesRegex(installer.InstallError, 'IOS_SIGNING_NOT_SUPPORTED'):
                installer.validate_profile(Path('.'), {'hardwareProperties': {'udid': 'target'}})

    def test_install_requires_device_receipt_then_exact_version_readback(self):
        request = {'selection': {'deviceId': ID, 'configuration': 'Debug'}, 'artifact': {'sha256': 'a'*64}}
        info = {'CFBundleIdentifier': 'com.test.app', 'CFBundleShortVersionString': '2.5.1', 'CFBundleVersion': '44'}
        with tempfile.TemporaryDirectory() as root, patch.object(installer, 'download_ipa'), patch.object(installer, 'extract_app', return_value=Path(root)/'App.app'), patch.object(installer, 'validate_profile', return_value=info), patch.object(Path, 'write_text'), patch.object(Path, 'read_bytes', return_value=plistlib.dumps(info)):
            for version, success in [('2.5.1', True), ('2.5.0', False)]:
                calls = []
                def run(args, directory, timeout):
                    calls.append(args)
                    return {'deviceIdentifier': ID, 'installedApplications': [{'bundleID': 'com.test.app'}]} if args[1] == 'install' else {'apps': [{'bundleIdentifier': 'com.test.app', 'version': version, 'bundleVersion': '44'}]}
                report = {'devices': [{'id': ID, 'online': True, 'developerMode': True}]}
                with patch.object(installer, 'run_json', side_effect=run):
                    if success:
                        installer.install(request, report, root, {ID: {'hardwareProperties': {}}})
                    else:
                        with self.assertRaisesRegex(installer.InstallError, 'IOS_INSTALL_UNCONFIRMED'):
                            installer.install(request, report, root, {ID: {'hardwareProperties': {}}})
                self.assertEqual(len(calls), 2)
                self.assertEqual(calls[0][4], ID)
                self.assertNotIn('uninstall', json.dumps(calls))
                self.assertNotIn('launch', json.dumps(calls))

    def test_adhoc_entitlements_preserve_capabilities_and_require_profile_permission(self):
        existing = {'application-identifier': 'TEAM.com.app', 'get-task-allow': False,
                    'keychain-access-groups': ['TEAM.com.app'], 'beta-reports-active': True,
                    'aps-environment': 'production'}
        permitted = {'application-identifier': 'TEAM.com.app', 'get-task-allow': False,
                     'keychain-access-groups': ['TEAM.*'], 'aps-environment': 'production'}
        entitlements = installer.adhoc_entitlements(existing, permitted)
        self.assertNotIn('beta-reports-active', entitlements)
        self.assertEqual(entitlements['keychain-access-groups'], ['TEAM.com.app'])
        self.assertEqual(entitlements['aps-environment'], 'production')
        with self.assertRaisesRegex(installer.InstallError, 'IOS_ADHOC_ENTITLEMENTS_MISMATCH'):
            installer.adhoc_entitlements(existing, {k:v for k,v in permitted.items() if k != 'aps-environment'})

    def test_only_release_store_signing_can_prepare_an_adhoc_copy(self):
        info = {'CFBundleIdentifier': 'com.app', 'CFBundleShortVersionString': '2.5.11', 'CFBundleVersion': '58'}
        with tempfile.TemporaryDirectory() as root, patch.object(installer, 'download_ipa'), patch.object(installer, 'extract_app', return_value=Path(root)/'App.app'), patch.object(installer, 'resign_adhoc', return_value={'signingMode':'adhoc','preparedIpaSha256':'a'*64}) as resign:
            request = {'selection': {'configuration':'Release'}, 'artifact': {}}
            report = {}
            with patch.object(installer, 'validate_profile', side_effect=[installer.InstallError('IOS_SIGNING_NOT_SUPPORTED'), info]):
                installer.prepare_app(request, report, root, {})
            self.assertEqual(resign.call_count, 1)
            self.assertEqual(report['appVersion'], '2.5.11')
            self.assertEqual(report['appBuild'], '58')
            request['selection']['configuration']='Debug'
            with patch.object(installer, 'validate_profile', side_effect=installer.InstallError('IOS_SIGNING_NOT_SUPPORTED')):
                with self.assertRaisesRegex(installer.InstallError, 'IOS_SIGNING_NOT_SUPPORTED'):
                    installer.prepare_app(request, {}, root, {})
            self.assertEqual(resign.call_count, 1)


if __name__ == '__main__':
    unittest.main()
