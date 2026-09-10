Unicode true
RequestExecutionLevel user
SetCompressor /SOLID lzma
!include LogicLib.nsh
!include FileFunc.nsh
!include Win\COM.nsh
!include Win\Propkey.nsh
!ifndef INSTANCE_ID
  !error "INSTANCE_ID is required"
!endif
!ifndef INSTALL_DIRECTORY_NAME
  !error "INSTALL_DIRECTORY_NAME is required"
!endif
!ifndef EXECUTABLE_BASENAME
  !error "EXECUTABLE_BASENAME is required"
!endif
!ifndef UNINSTALL_REGISTRY_KEY
  !error "UNINSTALL_REGISTRY_KEY is required"
!endif
!ifndef SHORTCUT_NAME
  !error "SHORTCUT_NAME is required"
!endif
!ifndef PROTOCOL_SCHEME
  !error "PROTOCOL_SCHEME is required"
!endif
!ifndef APP_USER_MODEL_ID
  !error "APP_USER_MODEL_ID is required"
!endif
!ifndef TOAST_ACTIVATOR_CLSID
  !error "TOAST_ACTIVATOR_CLSID is required"
!endif
!ifndef DISPLAY_NAME
  !error "DISPLAY_NAME is required"
!endif
; The updater waits for the main PID, but a child can retain an image or directory
; handle briefly. Each rename phase is bounded to 40 attempts and 9.75s asleep.
!define INSTALL_RENAME_MAX_ATTEMPTS 40
!define INSTALL_RENAME_RETRY_DELAY_MS 250
!define MIN_UNINSTALLER_BYTES 1024
; Shortcut and instance-owned registry exports are small. Bound the byte loop so
; a wrapped 32-bit length, a multi-gigabyte file, or hostile oversized state is
; refused instead of being treated as an exact backup.
!define MAX_REGISTRATION_COMPARE_BYTES 1048576
!define /ifndef PKEY_AppUserModel_ToastActivatorCLSID '"{9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}",26'
!define /ifndef VT_CLSID 72
Name "${DISPLAY_NAME}"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\${INSTALL_DIRECTORY_NAME}"
Icon "${ICON_FILE}"
VIProductVersion "0.2.0.${BUILD_NUMBER}"
VIAddVersionKey /LANG=1033 "ProductName" "${DISPLAY_NAME}"
VIAddVersionKey /LANG=1033 "FileDescription" "${DISPLAY_NAME} installer"
VIAddVersionKey /LANG=1033 "FileVersion" "${APP_VERSION}"
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Var BackupDirectory
Var CanonicalShortcutWasPresent
Var Clsid32WasPresent
Var Clsid64WasPresent
Var CompareFileA
Var CompareFileB
Var CompareFilesSucceeded
Var DesktopShortcutWasPresent
Var ExistingIdentity
Var FailedDirectory
Var HadExistingInstall
Var LegacyNestedShortcutWasPresent
Var LegacyNestedDirectoryWasPresent
Var LegacyRootShortcutWasPresent
Var OperationSuffix
Var ProtocolKeyWasPresent
Var RenameAttemptsRemaining
Var RenameDestination
Var RenameSource
Var RenameSucceeded
Var RegistrationCleanupSucceeded
Var RegistrationBackupDirectory
Var RegistrationBackupFile
Var RegistrationBackupSucceeded
Var RegistrationMayBeDirty
Var RegistrationOperationSucceeded
Var RegistrationResourceWasPresent
Var RegistrationRestoreSucceeded
Var RegistrationSourcePath
Var RegistryKeyAbsent
Var RegistryKeyPath
Var RegistryViewAccess
Var RegistryViewName
Var ShortcutPath
Var ShortcutWriteSucceeded
Var UninstallKeyWasPresent
Var VerificationDirectory
Var VerificationOutputDirectory
Var VerificationSucceeded

Function .onInit
  SetShellVarContext current
  StrCpy $VerificationOutputDirectory ""
  ${GetParameters} $R0
  ${GetOptions} $R0 "/QA_HUB_VERIFY_PAYLOAD=" $VerificationOutputDirectory
  StrCmp $VerificationOutputDirectory "" normal_install_init
  SetSilent silent
  System::Call 'kernel32::GetFileAttributesW(w "$VerificationOutputDirectory") i.r0'
  IntCmp $0 -1 verification_init_invalid
  IntOp $1 $0 & 0x10
  IntCmp $1 0 verification_init_invalid verification_init_directory verification_init_directory
verification_init_directory:
  IntOp $1 $0 & 0x400
  IntCmp $1 0 verification_init_ready verification_init_invalid verification_init_invalid
verification_init_ready:
  Return
verification_init_invalid:
  SetErrorLevel 40
  Quit
normal_install_init:
  StrCmp $INSTDIR "$LOCALAPPDATA\Programs\${INSTALL_DIRECTORY_NAME}" +3
    SetErrorLevel 10
    Quit
  ClearErrors
  CreateDirectory "$LOCALAPPDATA\Programs"
  IfErrors 0 +3
    SetErrorLevel 11
    Quit
  System::Call 'kernel32::GetFileAttributesW(w "$LOCALAPPDATA\Programs") i.r0'
  IntOp $0 $0 & 0x400
  IntCmp $0 0 +3
    SetErrorLevel 11
    Quit
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i.r0'
  IntCmp $0 -1 validated normal_install_path_exists normal_install_path_exists
normal_install_path_exists:
  IntOp $1 $0 & 0x10
  IntCmp $1 0 normal_install_path_invalid normal_install_path_directory normal_install_path_directory
normal_install_path_directory:
  IntOp $1 $0 & 0x400
  IntCmp $1 0 normal_install_identity_check normal_install_path_invalid normal_install_path_invalid
normal_install_path_invalid:
    SetErrorLevel 11
    Quit
normal_install_identity_check:
  IfFileExists "$INSTDIR\.preview-instance-id" +3
    SetErrorLevel 12
    Quit
  FileOpen $0 "$INSTDIR\.preview-instance-id" r
  FileRead $0 $ExistingIdentity
  FileClose $0
  StrCmp $ExistingIdentity "${INSTANCE_ID}" validated
    SetErrorLevel 12
    Quit
validated:
FunctionEnd

Function RetryRenameDirectory
  StrCpy $RenameAttemptsRemaining ${INSTALL_RENAME_MAX_ATTEMPTS}
  StrCpy $RenameSucceeded 0
rename_directory_attempt:
  ClearErrors
  Rename "$RenameSource" "$RenameDestination"
  IfErrors rename_directory_retry
  StrCpy $RenameSucceeded 1
  Return
rename_directory_retry:
  IntOp $RenameAttemptsRemaining $RenameAttemptsRemaining - 1
  IntCmp $RenameAttemptsRemaining 0 rename_directory_exhausted rename_directory_exhausted rename_directory_wait
rename_directory_wait:
  Sleep ${INSTALL_RENAME_RETRY_DELAY_MS}
  Goto rename_directory_attempt
rename_directory_exhausted:
FunctionEnd

Function VerifyPreviewInstallDirectory
  StrCpy $VerificationSucceeded 0
  IfFileExists "$VerificationDirectory\.preview-instance-id" 0 verification_finished
  IfFileExists "$VerificationDirectory\${EXECUTABLE_BASENAME}.exe" 0 verification_finished
  ClearErrors
  FileOpen $0 "$VerificationDirectory\.preview-instance-id" r
  IfErrors verification_finished
  FileRead $0 $ExistingIdentity
  IfErrors verification_read_failed
  FileClose $0
  StrCmp $ExistingIdentity "${INSTANCE_ID}" 0 verification_finished
  StrCpy $VerificationSucceeded 1
  Return
verification_read_failed:
  FileClose $0
verification_finished:
FunctionEnd

Function un.RetryRenameDirectory
  StrCpy $RenameAttemptsRemaining ${INSTALL_RENAME_MAX_ATTEMPTS}
  StrCpy $RenameSucceeded 0
un_rename_directory_attempt:
  ClearErrors
  Rename "$RenameSource" "$RenameDestination"
  IfErrors un_rename_directory_retry
  StrCpy $RenameSucceeded 1
  Return
un_rename_directory_retry:
  IntOp $RenameAttemptsRemaining $RenameAttemptsRemaining - 1
  IntCmp $RenameAttemptsRemaining 0 un_rename_directory_exhausted un_rename_directory_exhausted un_rename_directory_wait
un_rename_directory_wait:
  Sleep ${INSTALL_RENAME_RETRY_DELAY_MS}
  Goto un_rename_directory_attempt
un_rename_directory_exhausted:
FunctionEnd

Function un.VerifyPreviewInstallDirectory
  StrCpy $VerificationSucceeded 0
  IfFileExists "$VerificationDirectory\.preview-instance-id" 0 un_verification_finished
  IfFileExists "$VerificationDirectory\${EXECUTABLE_BASENAME}.exe" 0 un_verification_finished
  ClearErrors
  FileOpen $0 "$VerificationDirectory\.preview-instance-id" r
  IfErrors un_verification_finished
  FileRead $0 $ExistingIdentity
  IfErrors un_verification_read_failed
  FileClose $0
  StrCmp $ExistingIdentity "${INSTANCE_ID}" 0 un_verification_finished
  StrCpy $VerificationSucceeded 1
  Return
un_verification_read_failed:
  FileClose $0
un_verification_finished:
FunctionEnd

Function VerifyRegistryKeyAbsent
  StrCpy $RegistryKeyAbsent 0
  ; RegOpenKeyEx is used because missing values or empty subkeys do not prove that
  ; the instance-owned key itself was removed. Treat every result except the
  ; exact ERROR_FILE_NOT_FOUND code as cleanup failure.
  System::Call 'advapi32::RegOpenKeyExW(p 0x80000001, w "$RegistryKeyPath", i 0, i $RegistryViewAccess, *p .r0) i.r1'
  IntCmp $1 2 registry_key_absent registry_key_not_absent registry_key_not_absent
registry_key_not_absent:
  StrCmp $1 0 0 registry_key_check_finished
  System::Call 'advapi32::RegCloseKey(p r0)'
  Goto registry_key_check_finished
registry_key_absent:
  StrCpy $RegistryKeyAbsent 1
registry_key_check_finished:
FunctionEnd

Function un.VerifyRegistryKeyAbsent
  StrCpy $RegistryKeyAbsent 0
  System::Call 'advapi32::RegOpenKeyExW(p 0x80000001, w "$RegistryKeyPath", i 0, i $RegistryViewAccess, *p .r0) i.r1'
  IntCmp $1 2 un_registry_key_absent un_registry_key_not_absent un_registry_key_not_absent
un_registry_key_not_absent:
  StrCmp $1 0 0 un_registry_key_check_finished
  System::Call 'advapi32::RegCloseKey(p r0)'
  Goto un_registry_key_check_finished
un_registry_key_absent:
  StrCpy $RegistryKeyAbsent 1
un_registry_key_check_finished:
FunctionEnd

Function VerifyRegistrationRemoved
  StrCpy $RegistrationCleanupSucceeded 0
  IfFileExists "$DESKTOP\${SHORTCUT_NAME}.lnk" registration_removal_finished
  IfFileExists "$SMPROGRAMS\${DISPLAY_NAME}.lnk" registration_removal_finished
  IfFileExists "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" registration_removal_finished
  IfFileExists "$SMPROGRAMS\${SHORTCUT_NAME}\${SHORTCUT_NAME}.lnk" registration_removal_finished
  StrCpy $RegistryViewAccess 0x20119
  StrCpy $RegistryKeyPath "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_REGISTRY_KEY}"
  Call VerifyRegistryKeyAbsent
  StrCmp $RegistryKeyAbsent 1 0 registration_removal_finished
  StrCpy $RegistryKeyPath "Software\Classes\${PROTOCOL_SCHEME}"
  Call VerifyRegistryKeyAbsent
  StrCmp $RegistryKeyAbsent 1 0 registration_removal_finished
  StrCpy $RegistryKeyPath "Software\Classes\CLSID\${TOAST_ACTIVATOR_CLSID}"
  Call VerifyRegistryKeyAbsent
  StrCmp $RegistryKeyAbsent 1 0 registration_removal_finished
  ; NSIS is a 32-bit process. Releases before the explicit SetRegView migration
  ; could have registered this x64 Electron local server in the redirected view.
  StrCpy $RegistryViewAccess 0x20219
  Call VerifyRegistryKeyAbsent
  StrCmp $RegistryKeyAbsent 1 0 registration_removal_finished
  StrCpy $RegistrationCleanupSucceeded 1
registration_removal_finished:
FunctionEnd

Function un.VerifyRegistrationRemoved
  StrCpy $RegistrationCleanupSucceeded 0
  IfFileExists "$DESKTOP\${SHORTCUT_NAME}.lnk" un_registration_removal_finished
  IfFileExists "$SMPROGRAMS\${DISPLAY_NAME}.lnk" un_registration_removal_finished
  IfFileExists "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" un_registration_removal_finished
  IfFileExists "$SMPROGRAMS\${SHORTCUT_NAME}\${SHORTCUT_NAME}.lnk" un_registration_removal_finished
  StrCpy $RegistryViewAccess 0x20119
  StrCpy $RegistryKeyPath "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_REGISTRY_KEY}"
  Call un.VerifyRegistryKeyAbsent
  StrCmp $RegistryKeyAbsent 1 0 un_registration_removal_finished
  StrCpy $RegistryKeyPath "Software\Classes\${PROTOCOL_SCHEME}"
  Call un.VerifyRegistryKeyAbsent
  StrCmp $RegistryKeyAbsent 1 0 un_registration_removal_finished
  StrCpy $RegistryKeyPath "Software\Classes\CLSID\${TOAST_ACTIVATOR_CLSID}"
  Call un.VerifyRegistryKeyAbsent
  StrCmp $RegistryKeyAbsent 1 0 un_registration_removal_finished
  StrCpy $RegistryViewAccess 0x20219
  Call un.VerifyRegistryKeyAbsent
  StrCmp $RegistryKeyAbsent 1 0 un_registration_removal_finished
  StrCpy $RegistrationCleanupSucceeded 1
un_registration_removal_finished:
FunctionEnd

Function CompareFilesExact
  StrCpy $CompareFilesSucceeded 0
  ClearErrors
  FileOpen $0 "$CompareFileA" r
  IfErrors compare_files_finished
  ClearErrors
  FileOpen $1 "$CompareFileB" r
  IfErrors compare_files_close_a

  ; GetFileSize returns a low DWORD and writes the high DWORD through its second
  ; argument. Reject every non-zero high DWORD and every negative/wrapped low
  ; DWORD before using NSIS's signed 32-bit IntCmp/IntOp byte counter.
  System::Call 'kernel32::GetFileSize(p r0, *i .r4) i.r2'
  StrCmp $4 0 0 compare_files_close_b
  IntCmp $2 0 compare_files_a_size_nonnegative compare_files_close_b compare_files_a_size_nonnegative
compare_files_a_size_nonnegative:
  IntCmp $2 ${MAX_REGISTRATION_COMPARE_BYTES} compare_files_a_size_valid compare_files_a_size_valid compare_files_close_b
compare_files_a_size_valid:
  System::Call 'kernel32::GetFileSize(p r1, *i .r5) i.r3'
  StrCmp $5 0 0 compare_files_close_b
  IntCmp $3 0 compare_files_b_size_nonnegative compare_files_close_b compare_files_b_size_nonnegative
compare_files_b_size_nonnegative:
  IntCmp $3 ${MAX_REGISTRATION_COMPARE_BYTES} compare_files_b_size_valid compare_files_b_size_valid compare_files_close_b
compare_files_b_size_valid:
  StrCmp $2 $3 compare_files_sizes_match compare_files_close_b
compare_files_sizes_match:
  StrCpy $6 0
compare_files_next_byte:
  IntCmp $6 $2 compare_files_verify_final_sizes compare_files_read_byte compare_files_close_b
compare_files_read_byte:
  ClearErrors
  FileReadByte $0 $7
  ; The expected byte count is known. An error before that count is always an
  ; I/O failure or premature EOF, never evidence that the files are equal.
  IfErrors compare_files_close_b
  ClearErrors
  FileReadByte $1 $8
  IfErrors compare_files_close_b
  IntCmp $7 $8 compare_files_byte_equal compare_files_close_b compare_files_close_b
compare_files_byte_equal:
  IntOp $6 $6 + 1
  Goto compare_files_next_byte

  ; Refuse a concurrent truncate/append and any late GetFileSize failure. Since
  ; every expected byte was read successfully, equality no longer depends on
  ; FileReadByte's ambiguous EOF/error flag.
compare_files_verify_final_sizes:
  System::Call 'kernel32::GetFileSize(p r0, *i .r8) i.r7'
  StrCmp $8 0 0 compare_files_close_b
  StrCmp $7 $2 0 compare_files_close_b
  System::Call 'kernel32::GetFileSize(p r1, *i .r8) i.r7'
  StrCmp $8 0 0 compare_files_close_b
  StrCmp $7 $3 0 compare_files_close_b
  StrCpy $CompareFilesSucceeded 1
compare_files_close_b:
  FileClose $1
compare_files_close_a:
  FileClose $0
compare_files_finished:
FunctionEnd

Function BackupRegistrationFile
  StrCpy $RegistrationOperationSucceeded 0
  StrCpy $RegistrationResourceWasPresent 0
  IfFileExists "$RegistrationSourcePath" 0 backup_registration_file_absent
  ClearErrors
  CopyFiles /SILENT /FILESONLY "$RegistrationSourcePath" "$RegistrationBackupFile"
  IfErrors backup_registration_file_finished
  IfFileExists "$RegistrationBackupFile" 0 backup_registration_file_finished
  StrCpy $CompareFileA "$RegistrationSourcePath"
  StrCpy $CompareFileB "$RegistrationBackupFile"
  Call CompareFilesExact
  StrCmp $CompareFilesSucceeded 1 0 backup_registration_file_finished
  StrCpy $RegistrationResourceWasPresent 1
backup_registration_file_absent:
  StrCpy $RegistrationOperationSucceeded 1
backup_registration_file_finished:
FunctionEnd

Function RestoreRegistrationFile
  StrCpy $RegistrationOperationSucceeded 0
  Delete "$RegistrationSourcePath"
  IfFileExists "$RegistrationSourcePath" restore_registration_file_finished
  StrCmp $RegistrationResourceWasPresent 1 0 restore_registration_file_absent
  ClearErrors
  CopyFiles /SILENT /FILESONLY "$RegistrationBackupFile" "$RegistrationSourcePath"
  IfErrors restore_registration_file_finished
  IfFileExists "$RegistrationSourcePath" 0 restore_registration_file_finished
  StrCpy $CompareFileA "$RegistrationBackupFile"
  StrCpy $CompareFileB "$RegistrationSourcePath"
  Call CompareFilesExact
  StrCmp $CompareFilesSucceeded 1 0 restore_registration_file_finished
restore_registration_file_absent:
  StrCpy $RegistrationOperationSucceeded 1
restore_registration_file_finished:
FunctionEnd

Function BackupRegistryKey
  StrCpy $RegistrationOperationSucceeded 0
  StrCpy $RegistrationResourceWasPresent 0
  Call VerifyRegistryKeyAbsent
  StrCmp $RegistryKeyAbsent 1 backup_registry_key_absent
  Delete "$RegistrationBackupFile"
  nsExec::ExecToStack /TIMEOUT=10000 '"$SYSDIR\reg.exe" export "HKCU\$RegistryKeyPath" "$RegistrationBackupFile" /y /reg:$RegistryViewName'
  Pop $0
  Pop $1
  StrCmp $0 0 0 backup_registry_key_finished
  IfFileExists "$RegistrationBackupFile" 0 backup_registry_key_finished
  StrCpy $RegistrationResourceWasPresent 1
backup_registry_key_absent:
  StrCpy $RegistrationOperationSucceeded 1
backup_registry_key_finished:
FunctionEnd

Function RestoreRegistryKey
  StrCpy $RegistrationOperationSucceeded 0
  nsExec::ExecToStack /TIMEOUT=10000 '"$SYSDIR\reg.exe" delete "HKCU\$RegistryKeyPath" /f /reg:$RegistryViewName'
  Pop $0
  Pop $1
  StrCmp $RegistrationResourceWasPresent 1 restore_registry_key_present
  Call VerifyRegistryKeyAbsent
  StrCmp $RegistryKeyAbsent 1 restore_registry_key_complete restore_registry_key_finished
restore_registry_key_present:
  nsExec::ExecToStack /TIMEOUT=10000 '"$SYSDIR\reg.exe" import "$RegistrationBackupFile" /reg:$RegistryViewName'
  Pop $0
  Pop $1
  StrCmp $0 0 0 restore_registry_key_finished
  StrCpy $CompareFileA "$RegistrationBackupFile"
  StrCpy $CompareFileB "$RegistrationBackupFile.verify"
  Delete "$CompareFileB"
  nsExec::ExecToStack /TIMEOUT=10000 '"$SYSDIR\reg.exe" export "HKCU\$RegistryKeyPath" "$CompareFileB" /y /reg:$RegistryViewName'
  Pop $0
  Pop $1
  StrCmp $0 0 0 restore_registry_key_finished
  Call CompareFilesExact
  StrCmp $CompareFilesSucceeded 1 0 restore_registry_key_finished
restore_registry_key_complete:
  StrCpy $RegistrationOperationSucceeded 1
restore_registry_key_finished:
FunctionEnd

Function BackupRegistrationState
  StrCpy $RegistrationBackupSucceeded 0
  StrCpy $OperationSuffix 0
  StrCpy $RegistrationBackupDirectory "$TEMP\${INSTANCE_ID}-registration-${RELEASE_ID}"
choose_registration_backup:
  IfFileExists "$RegistrationBackupDirectory" next_registration_backup
  IfFileExists "$RegistrationBackupDirectory\*.*" next_registration_backup registration_backup_ready
next_registration_backup:
  IntOp $OperationSuffix $OperationSuffix + 1
  StrCpy $RegistrationBackupDirectory "$TEMP\${INSTANCE_ID}-registration-${RELEASE_ID}-$OperationSuffix"
  Goto choose_registration_backup
registration_backup_ready:
  ClearErrors
  CreateDirectory "$RegistrationBackupDirectory"
  IfErrors registration_backup_finished

  StrCpy $RegistrationSourcePath "$DESKTOP\${SHORTCUT_NAME}.lnk"
  StrCpy $RegistrationBackupFile "$RegistrationBackupDirectory\desktop.lnk"
  Call BackupRegistrationFile
  StrCmp $RegistrationOperationSucceeded 1 0 registration_backup_finished
  StrCpy $DesktopShortcutWasPresent $RegistrationResourceWasPresent

  StrCpy $RegistrationSourcePath "$SMPROGRAMS\${DISPLAY_NAME}.lnk"
  StrCpy $RegistrationBackupFile "$RegistrationBackupDirectory\start-canonical.lnk"
  Call BackupRegistrationFile
  StrCmp $RegistrationOperationSucceeded 1 0 registration_backup_finished
  StrCpy $CanonicalShortcutWasPresent $RegistrationResourceWasPresent

  StrCpy $RegistrationSourcePath "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
  StrCpy $RegistrationBackupFile "$RegistrationBackupDirectory\start-legacy-root.lnk"
  Call BackupRegistrationFile
  StrCmp $RegistrationOperationSucceeded 1 0 registration_backup_finished
  StrCpy $LegacyRootShortcutWasPresent $RegistrationResourceWasPresent

  StrCpy $RegistrationSourcePath "$SMPROGRAMS\${SHORTCUT_NAME}\${SHORTCUT_NAME}.lnk"
  StrCpy $RegistrationBackupFile "$RegistrationBackupDirectory\start-legacy-nested.lnk"
  Call BackupRegistrationFile
  StrCmp $RegistrationOperationSucceeded 1 0 registration_backup_finished
  StrCpy $LegacyNestedShortcutWasPresent $RegistrationResourceWasPresent
  StrCpy $LegacyNestedDirectoryWasPresent 0
  IfFileExists "$SMPROGRAMS\${SHORTCUT_NAME}" 0 +2
    StrCpy $LegacyNestedDirectoryWasPresent 1

  StrCpy $RegistryViewName 64
  StrCpy $RegistryViewAccess 0x20119
  StrCpy $RegistryKeyPath "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_REGISTRY_KEY}"
  StrCpy $RegistrationBackupFile "$RegistrationBackupDirectory\uninstall-64.reg"
  Call BackupRegistryKey
  StrCmp $RegistrationOperationSucceeded 1 0 registration_backup_finished
  StrCpy $UninstallKeyWasPresent $RegistrationResourceWasPresent

  StrCpy $RegistryKeyPath "Software\Classes\${PROTOCOL_SCHEME}"
  StrCpy $RegistrationBackupFile "$RegistrationBackupDirectory\protocol-64.reg"
  Call BackupRegistryKey
  StrCmp $RegistrationOperationSucceeded 1 0 registration_backup_finished
  StrCpy $ProtocolKeyWasPresent $RegistrationResourceWasPresent

  StrCpy $RegistryKeyPath "Software\Classes\CLSID\${TOAST_ACTIVATOR_CLSID}"
  StrCpy $RegistrationBackupFile "$RegistrationBackupDirectory\clsid-64.reg"
  Call BackupRegistryKey
  StrCmp $RegistrationOperationSucceeded 1 0 registration_backup_finished
  StrCpy $Clsid64WasPresent $RegistrationResourceWasPresent

  StrCpy $RegistryViewName 32
  StrCpy $RegistryViewAccess 0x20219
  StrCpy $RegistrationBackupFile "$RegistrationBackupDirectory\clsid-32.reg"
  Call BackupRegistryKey
  StrCmp $RegistrationOperationSucceeded 1 0 registration_backup_finished
  StrCpy $Clsid32WasPresent $RegistrationResourceWasPresent
  StrCpy $RegistrationBackupSucceeded 1
registration_backup_finished:
FunctionEnd

Function RestoreRegistrationState
  StrCpy $RegistrationRestoreSucceeded 0
  StrCpy $RegistrationSourcePath "$DESKTOP\${SHORTCUT_NAME}.lnk"
  StrCpy $RegistrationBackupFile "$RegistrationBackupDirectory\desktop.lnk"
  StrCpy $RegistrationResourceWasPresent $DesktopShortcutWasPresent
  Call RestoreRegistrationFile
  StrCmp $RegistrationOperationSucceeded 1 0 registration_restore_finished

  StrCpy $RegistrationSourcePath "$SMPROGRAMS\${DISPLAY_NAME}.lnk"
  StrCpy $RegistrationBackupFile "$RegistrationBackupDirectory\start-canonical.lnk"
  StrCpy $RegistrationResourceWasPresent $CanonicalShortcutWasPresent
  Call RestoreRegistrationFile
  StrCmp $RegistrationOperationSucceeded 1 0 registration_restore_finished

  StrCpy $RegistrationSourcePath "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
  StrCpy $RegistrationBackupFile "$RegistrationBackupDirectory\start-legacy-root.lnk"
  StrCpy $RegistrationResourceWasPresent $LegacyRootShortcutWasPresent
  Call RestoreRegistrationFile
  StrCmp $RegistrationOperationSucceeded 1 0 registration_restore_finished

  StrCpy $RegistrationSourcePath "$SMPROGRAMS\${SHORTCUT_NAME}\${SHORTCUT_NAME}.lnk"
  StrCpy $RegistrationBackupFile "$RegistrationBackupDirectory\start-legacy-nested.lnk"
  StrCpy $RegistrationResourceWasPresent $LegacyNestedShortcutWasPresent
  StrCmp $RegistrationResourceWasPresent 1 0 restore_legacy_nested_parent_ready
  ClearErrors
  CreateDirectory "$SMPROGRAMS\${SHORTCUT_NAME}"
  IfErrors registration_restore_finished
restore_legacy_nested_parent_ready:
  Call RestoreRegistrationFile
  StrCmp $RegistrationOperationSucceeded 1 0 registration_restore_finished
  StrCmp $LegacyNestedDirectoryWasPresent 1 restore_legacy_nested_directory_present
  RMDir "$SMPROGRAMS\${SHORTCUT_NAME}"
  IfFileExists "$SMPROGRAMS\${SHORTCUT_NAME}" registration_restore_finished restore_legacy_nested_directory_restored
restore_legacy_nested_directory_present:
  ClearErrors
  CreateDirectory "$SMPROGRAMS\${SHORTCUT_NAME}"
  IfErrors registration_restore_finished
restore_legacy_nested_directory_restored:

  StrCpy $RegistryViewName 64
  StrCpy $RegistryViewAccess 0x20119
  StrCpy $RegistryKeyPath "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_REGISTRY_KEY}"
  StrCpy $RegistrationBackupFile "$RegistrationBackupDirectory\uninstall-64.reg"
  StrCpy $RegistrationResourceWasPresent $UninstallKeyWasPresent
  Call RestoreRegistryKey
  StrCmp $RegistrationOperationSucceeded 1 0 registration_restore_finished

  StrCpy $RegistryKeyPath "Software\Classes\${PROTOCOL_SCHEME}"
  StrCpy $RegistrationBackupFile "$RegistrationBackupDirectory\protocol-64.reg"
  StrCpy $RegistrationResourceWasPresent $ProtocolKeyWasPresent
  Call RestoreRegistryKey
  StrCmp $RegistrationOperationSucceeded 1 0 registration_restore_finished

  StrCpy $RegistryKeyPath "Software\Classes\CLSID\${TOAST_ACTIVATOR_CLSID}"
  StrCpy $RegistrationBackupFile "$RegistrationBackupDirectory\clsid-64.reg"
  StrCpy $RegistrationResourceWasPresent $Clsid64WasPresent
  Call RestoreRegistryKey
  StrCmp $RegistrationOperationSucceeded 1 0 registration_restore_finished

  StrCpy $RegistryViewName 32
  StrCpy $RegistryViewAccess 0x20219
  StrCpy $RegistrationBackupFile "$RegistrationBackupDirectory\clsid-32.reg"
  StrCpy $RegistrationResourceWasPresent $Clsid32WasPresent
  Call RestoreRegistryKey
  StrCmp $RegistrationOperationSucceeded 1 0 registration_restore_finished
  SetRegView 64
  StrCpy $RegistrationRestoreSucceeded 1
registration_restore_finished:
FunctionEnd

; Create the link and both identity properties in one COM object so every shortcut
; that can launch this EXE carries the same per-instance notification identity.
Function CreateIdentityShortcut
  StrCpy $ShortcutWriteSucceeded 0
  StrCpy $0 0
  StrCpy $1 0
  System::Call 'OLE32::CoInitialize(p0)i.r9'
  IntCmp $9 0 shortcut_com_ready shortcut_finished shortcut_com_ready
shortcut_com_ready:
  !insertmacro ComHlpr_CreateInProcInstance ${CLSID_ShellLink} ${IID_IShellLink} r0 r2
  StrCmp $0 0 shortcut_cleanup
  StrCmp $2 0 shortcut_set_path shortcut_cleanup
shortcut_set_path:
  ${IShellLink::SetPath} $0 '("$INSTDIR\${EXECUTABLE_BASENAME}.exe").r2'
  StrCmp $2 0 shortcut_set_working_directory shortcut_cleanup
shortcut_set_working_directory:
  ${IShellLink::SetWorkingDirectory} $0 '("$INSTDIR").r2'
  StrCmp $2 0 shortcut_set_description shortcut_cleanup
shortcut_set_description:
  ${IShellLink::SetDescription} $0 '("${DISPLAY_NAME}").r2'
  StrCmp $2 0 shortcut_set_icon shortcut_cleanup
shortcut_set_icon:
  ${IShellLink::SetIconLocation} $0 '("$INSTDIR\${EXECUTABLE_BASENAME}.exe",0).r2'
  StrCmp $2 0 shortcut_open_property_store shortcut_cleanup
shortcut_open_property_store:
  ${IUnknown::QueryInterface} $0 '("${IID_IPropertyStore}",.r1).r2'
  StrCmp $2 0 shortcut_property_store_acquired shortcut_cleanup
shortcut_property_store_acquired:
  StrCmp $1 0 shortcut_cleanup shortcut_set_aumid
shortcut_set_aumid:
  System::Call '*${SYSSTRUCT_PROPERTYKEY}(${PKEY_AppUserModel_ID})p.r2'
  System::Call '*(&w129 "${APP_USER_MODEL_ID}")p.r4'
  System::Call '*${SYSSTRUCT_PROPVARIANT}(${VT_LPWSTR},,&i8 $4)p.r3'
  ${IPropertyStore::SetValue} $1 '($2,$3).r5'
  System::Free $2
  System::Free $3
  System::Free $4
  StrCmp $5 0 shortcut_set_toast_clsid shortcut_cleanup
shortcut_set_toast_clsid:
  System::Alloc 16
  Pop $4
  System::Call 'OLE32::CLSIDFromString(w "${TOAST_ACTIVATOR_CLSID}",p r4)i.r5'
  StrCmp $5 0 shortcut_write_toast_clsid shortcut_free_clsid
shortcut_write_toast_clsid:
  System::Call '*${SYSSTRUCT_PROPERTYKEY}(${PKEY_AppUserModel_ToastActivatorCLSID})p.r2'
  System::Call '*${SYSSTRUCT_PROPVARIANT}(${VT_CLSID},,&i8 $4)p.r3'
  ${IPropertyStore::SetValue} $1 '($2,$3).r5'
  System::Free $2
  System::Free $3
shortcut_free_clsid:
  System::Free $4
  StrCmp $5 0 shortcut_commit shortcut_cleanup
shortcut_commit:
  ${IPropertyStore::Commit} $1 '().r5'
  StrCmp $5 0 shortcut_close_property_store shortcut_cleanup
shortcut_close_property_store:
  ${IUnknown::Release} $1 ''
  StrCpy $1 0
  ${IUnknown::QueryInterface} $0 '("${IID_IPersistFile}",.r1).r2'
  StrCmp $2 0 shortcut_persist_file_acquired shortcut_cleanup
shortcut_persist_file_acquired:
  StrCmp $1 0 shortcut_cleanup shortcut_save
shortcut_save:
  ${IPersistFile::Save} $1 '("$ShortcutPath",1).r2'
  StrCmp $2 0 shortcut_saved shortcut_cleanup
shortcut_saved:
  StrCpy $ShortcutWriteSucceeded 1
shortcut_cleanup:
  !insertmacro ComHlpr_SafeReleaseAndNull $1
  !insertmacro ComHlpr_SafeReleaseAndNull $0
  System::Call 'OLE32::CoUninitialize()'
shortcut_finished:
FunctionEnd

Section "QA Hub Preview"
  StrCmp $VerificationOutputDirectory "" normal_install_start verification_extract_start
verification_extract_start:
  SetOutPath "$VerificationOutputDirectory"
  Goto embedded_payload
normal_install_start:
  ; The packaged Electron binary is x64. Its unqualified RegKey access resolves
  ; the redirected HKCU\Software\Classes\CLSID path in the 64-bit view.
  SetRegView 64
  StrCpy $HadExistingInstall 0
  StrCpy $RegistrationCleanupSucceeded 1
  StrCpy $RegistrationMayBeDirty 0
  StrCpy $BackupDirectory "$INSTDIR.backup-${RELEASE_ID}"
  StrCpy $OperationSuffix 0
choose_backup:
  IfFileExists "$BackupDirectory" next_backup
  IfFileExists "$BackupDirectory\*.*" next_backup backup_ready
next_backup:
  IntOp $OperationSuffix $OperationSuffix + 1
  StrCpy $BackupDirectory "$INSTDIR.backup-${RELEASE_ID}-$OperationSuffix"
  Goto choose_backup
backup_ready:
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i.r0'
  IntCmp $0 -1 install_files existing_install_path existing_install_path
existing_install_path:
  IntOp $1 $0 & 0x10
  IntCmp $1 0 install_path_invalid_before_rename existing_install_directory existing_install_directory
existing_install_directory:
  IntOp $1 $0 & 0x400
  IntCmp $1 0 existing_install_safe install_path_invalid_before_rename install_path_invalid_before_rename
existing_install_safe:
  StrCpy $HadExistingInstall 1
  SetOutPath "$TEMP"
  StrCpy $RenameSource "$INSTDIR"
  StrCpy $RenameDestination "$BackupDirectory"
  Call RetryRenameDirectory
  StrCmp $RenameSucceeded 1 install_files rename_failed
install_files:
  ClearErrors
  CreateDirectory "$INSTDIR"
  IfErrors install_directory_invalid
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i.r0'
  IntCmp $0 -1 install_directory_invalid install_directory_created install_directory_created
install_directory_created:
  IntOp $1 $0 & 0x10
  IntCmp $1 0 install_directory_invalid install_directory_not_reparse install_directory_not_reparse
install_directory_not_reparse:
  IntOp $1 $0 & 0x400
  IntCmp $1 0 install_directory_set_out install_directory_invalid install_directory_invalid
install_directory_set_out:
  ClearErrors
  SetOutPath "$INSTDIR"
  IfErrors install_directory_invalid
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i.r0'
  IntCmp $0 -1 install_directory_invalid install_directory_write_check install_directory_write_check
install_directory_write_check:
  IntOp $1 $0 & 0x10
  IntCmp $1 0 install_directory_invalid install_directory_write_not_reparse install_directory_write_not_reparse
install_directory_write_not_reparse:
  IntOp $1 $0 & 0x400
  IntCmp $1 0 embedded_payload install_directory_invalid install_directory_invalid
install_directory_invalid:
  Goto install_failed
install_path_invalid_before_rename:
  SetErrorLevel 11
  Goto finished
embedded_payload:
  ClearErrors
  File /r "${PACKAGE_DIR}\*"
  IfErrors embedded_payload_failed
  StrCmp $VerificationOutputDirectory "" embedded_payload_installed verification_extract_complete
verification_extract_complete:
  SetErrorLevel 0
  Goto finished
embedded_payload_failed:
  StrCmp $VerificationOutputDirectory "" install_failed verification_extract_failed
verification_extract_failed:
  SetErrorLevel 40
  Goto finished
embedded_payload_installed:
  IfFileExists "$BackupDirectory\preview-instance.json" 0 write_registration
  ClearErrors
  CopyFiles /SILENT "$BackupDirectory\preview-instance.json" "$INSTDIR\preview-instance.json"
  IfErrors install_failed
write_registration:
  ClearErrors
  FileOpen $0 "$INSTDIR\.preview-instance-id" w
  IfErrors registration_failed
  ClearErrors
  FileWrite $0 "${INSTANCE_ID}"
  IfErrors marker_write_failed
  ClearErrors
  FileClose $0
  IfErrors registration_failed
  ClearErrors
  FileOpen $0 "$INSTDIR\.preview-instance-id" r
  IfErrors registration_failed
  FileRead $0 $ExistingIdentity
  IfErrors marker_read_failed
  ClearErrors
  FileClose $0
  IfErrors registration_failed
  StrCmp $ExistingIdentity "${INSTANCE_ID}" marker_verified registration_failed
marker_write_failed:
  FileClose $0
  Goto registration_failed
marker_read_failed:
  FileClose $0
  Goto registration_failed
marker_verified:
  ClearErrors
  WriteUninstaller "$INSTDIR\Uninstall-Preview.exe"
  IfErrors registration_failed
  IfFileExists "$INSTDIR\Uninstall-Preview.exe" +2
    Goto registration_failed
  ClearErrors
  FileOpen $0 "$INSTDIR\Uninstall-Preview.exe" r
  IfErrors registration_failed
  FileSeek $0 0 END $1
  IfErrors uninstaller_read_failed
  ClearErrors
  FileClose $0
  IfErrors registration_failed
  IntCmp $1 ${MIN_UNINSTALLER_BYTES} uninstaller_verified registration_failed uninstaller_verified
uninstaller_read_failed:
  FileClose $0
  Goto registration_failed
uninstaller_verified:
  StrCmp $HadExistingInstall 1 backup_existing_registration registration_backup_complete
backup_existing_registration:
  Call BackupRegistrationState
  StrCmp $RegistrationBackupSucceeded 1 registration_backup_complete registration_failed
registration_backup_complete:
  ; From this point an upgrade failure can leave exact shell resources changed.
  ; Restoring only the old payload is then recoverable but unsafe to relaunch.
  StrCpy $RegistrationMayBeDirty 1
  StrCpy $ShortcutPath "$DESKTOP\${SHORTCUT_NAME}.lnk"
  Call CreateIdentityShortcut
  StrCmp $ShortcutWriteSucceeded 1 +2
    Goto registration_failed
  ; Electron's NotificationActivator resolves the unpackaged app shortcut from
  ; FOLDERID_Programs\<EXE ProductName>.lnk. Create that exact canonical path so
  ; Electron reuses this identity-bearing link instead of adding another one.
  StrCpy $ShortcutPath "$SMPROGRAMS\${DISPLAY_NAME}.lnk"
  Call CreateIdentityShortcut
  StrCmp $ShortcutWriteSucceeded 1 +2
    Goto registration_failed
  ClearErrors
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_REGISTRY_KEY}" "DisplayName" "${DISPLAY_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_REGISTRY_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_REGISTRY_KEY}" "UninstallString" '$\"$INSTDIR\Uninstall-Preview.exe$\"'
  WriteRegStr HKCU "Software\Classes\${PROTOCOL_SCHEME}" "" "URL:${DISPLAY_NAME}"
  WriteRegStr HKCU "Software\Classes\${PROTOCOL_SCHEME}" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\${PROTOCOL_SCHEME}\shell\open\command" "" '$\"$INSTDIR\${EXECUTABLE_BASENAME}.exe$\" $\"%1$\"'
  WriteRegStr HKCU "Software\Classes\CLSID\${TOAST_ACTIVATOR_CLSID}" "" "Electron Notification Activator"
  WriteRegDWORD HKCU "Software\Classes\CLSID\${TOAST_ACTIVATOR_CLSID}" "CustomActivator" 1
  WriteRegStr HKCU "Software\Classes\CLSID\${TOAST_ACTIVATOR_CLSID}\LocalServer32" "" '$\"$INSTDIR\${EXECUTABLE_BASENAME}.exe$\"'
  IfErrors registration_failed
  ; Remove the misplaced CLSID written by older 32-bit NSIS installers, then
  ; return to the x64 Electron registry view before any later failure branch.
  SetRegView 32
  DeleteRegKey HKCU "Software\Classes\CLSID\${TOAST_ACTIVATOR_CLSID}"
  StrCpy $RegistryKeyPath "Software\Classes\CLSID\${TOAST_ACTIVATOR_CLSID}"
  StrCpy $RegistryViewAccess 0x20219
  Call VerifyRegistryKeyAbsent
  SetRegView 64
  StrCmp $RegistryKeyAbsent 1 +2
    Goto registration_failed
  ; Remove only the two exact legacy Start Menu paths used for this instance.
  ; Legacy preview identity uses the same display and shortcut names, so retain
  ; the newly written canonical root link in that one case.
  StrCmp "${DISPLAY_NAME}" "${SHORTCUT_NAME}" cleanup_legacy_nested_shortcut
  Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
  IfFileExists "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" registration_failed
cleanup_legacy_nested_shortcut:
  Delete "$SMPROGRAMS\${SHORTCUT_NAME}\${SHORTCUT_NAME}.lnk"
  IfFileExists "$SMPROGRAMS\${SHORTCUT_NAME}\${SHORTCUT_NAME}.lnk" registration_failed
  RMDir "$SMPROGRAMS\${SHORTCUT_NAME}"
  ; DisplayVersion is the only release-specific registration value. Write it
  ; after every other fallible identity and migration operation so a rollback
  ; cannot advertise the failed new version over the restored old payload.
  ClearErrors
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_REGISTRY_KEY}" "DisplayVersion" "${APP_VERSION}"
  IfErrors registration_failed
  StrCmp $HadExistingInstall 1 0 registration_backup_cleanup_complete
  RMDir /r "$RegistrationBackupDirectory"
registration_backup_cleanup_complete:
  SetErrorLevel 0
  Goto finished
registration_failed:
  ; A fresh failure has no prior registration to preserve. An upgrade must restore
  ; and byte-verify every captured shortcut and registry view before it is safe to
  ; relaunch the old payload.
  StrCmp $HadExistingInstall 1 restore_existing_registration
  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  Delete "$SMPROGRAMS\${DISPLAY_NAME}.lnk"
  Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
  Delete "$SMPROGRAMS\${SHORTCUT_NAME}\${SHORTCUT_NAME}.lnk"
  RMDir "$SMPROGRAMS\${SHORTCUT_NAME}"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_REGISTRY_KEY}"
  DeleteRegKey HKCU "Software\Classes\${PROTOCOL_SCHEME}"
  DeleteRegKey HKCU "Software\Classes\CLSID\${TOAST_ACTIVATOR_CLSID}"
  SetRegView 32
  DeleteRegKey HKCU "Software\Classes\CLSID\${TOAST_ACTIVATOR_CLSID}"
  SetRegView 64
  StrCpy $RegistrationCleanupSucceeded 0
  Call VerifyRegistrationRemoved
  Goto install_failed
restore_existing_registration:
  StrCmp $RegistrationMayBeDirty 1 0 install_failed
  Call RestoreRegistrationState
  StrCmp $RegistrationRestoreSucceeded 1 registration_restored install_failed
registration_restored:
  StrCpy $RegistrationMayBeDirty 0
  Goto install_failed
install_failed:
  SetOutPath "$TEMP"
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i.r0'
  IntCmp $0 -1 no_failed_payload_to_isolate failed_install_path_exists failed_install_path_exists
failed_install_path_exists:
  IntOp $1 $0 & 0x10
  IntCmp $1 0 quarantine_failed failed_install_path_directory failed_install_path_directory
failed_install_path_directory:
  IntOp $1 $0 & 0x400
  IntCmp $1 0 choose_failed_directory quarantine_failed quarantine_failed
choose_failed_directory:
  StrCpy $FailedDirectory "$INSTDIR.failed-${RELEASE_ID}"
  StrCpy $OperationSuffix 0
find_unique_failed_directory:
  System::Call 'kernel32::GetFileAttributesW(w "$FailedDirectory") i.r0'
  IntCmp $0 -1 failed_directory_ready next_failed_directory next_failed_directory
next_failed_directory:
  IntOp $OperationSuffix $OperationSuffix + 1
  StrCpy $FailedDirectory "$INSTDIR.failed-${RELEASE_ID}-$OperationSuffix"
  Goto find_unique_failed_directory
failed_directory_ready:
  StrCpy $RenameSource "$INSTDIR"
  StrCpy $RenameDestination "$FailedDirectory"
  Call RetryRenameDirectory
  StrCmp $RenameSucceeded 1 failed_payload_isolated quarantine_failed
failed_payload_isolated:
  System::Call 'kernel32::GetFileAttributesW(w "$FailedDirectory") i.r0'
  IntCmp $0 -1 quarantine_failed failed_payload_directory_exists failed_payload_directory_exists
failed_payload_directory_exists:
  IntOp $1 $0 & 0x10
  IntCmp $1 0 quarantine_failed failed_payload_directory failed_payload_directory
failed_payload_directory:
  IntOp $1 $0 & 0x400
  IntCmp $1 0 failed_payload_canonical_absent quarantine_failed quarantine_failed
failed_payload_canonical_absent:
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i.r0'
  IntCmp $0 -1 failed_payload_ready quarantine_failed quarantine_failed
no_failed_payload_to_isolate:
failed_payload_ready:
  StrCmp $HadExistingInstall 1 restore_backup verify_fresh_failure
verify_fresh_failure:
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i.r0'
  IntCmp $0 -1 fresh_failure_confirmed quarantine_failed quarantine_failed
fresh_failure_confirmed:
  ; A fresh install has no old backup; the failed payload is off the canonical path.
  StrCmp $RegistrationCleanupSucceeded 1 fresh_failure_cleanup_confirmed registration_cleanup_failed
fresh_failure_cleanup_confirmed:
  SetErrorLevel 25
  Goto finished
registration_cleanup_failed:
  ; A failed fresh registration left an exact instance-owned shell resource.
  SetErrorLevel 26
  Goto finished
restore_backup:
  StrCpy $VerificationDirectory "$BackupDirectory"
  Call VerifyPreviewInstallDirectory
  StrCmp $VerificationSucceeded 1 restore_verified_backup rollback_restore_failed
restore_verified_backup:
  StrCpy $RenameSource "$BackupDirectory"
  StrCpy $RenameDestination "$INSTDIR"
  Call RetryRenameDirectory
  StrCmp $RenameSucceeded 1 verify_restored_backup rollback_restore_failed
verify_restored_backup:
  StrCpy $VerificationDirectory "$INSTDIR"
  Call VerifyPreviewInstallDirectory
  StrCmp $VerificationSucceeded 1 rollback_confirmed rollback_restore_failed
rollback_confirmed:
  ; Payload-only failures leave shell registration untouched and are safe for the
  ; updater to relaunch. Registration failures require explicit repair instead.
  StrCmp $RegistrationMayBeDirty 1 rollback_registration_dirty
  SetErrorLevel 21
  Goto finished
rollback_registration_dirty:
  SetErrorLevel 27
  Goto finished
quarantine_failed:
  ; A partial payload might still occupy the canonical path.
  SetErrorLevel 23
  Goto finished
rollback_restore_failed:
  ; The old backup could not be restored and verified as canonical.
  SetErrorLevel 24
  Goto finished
rename_failed:
  StrCpy $VerificationDirectory "$INSTDIR"
  Call VerifyPreviewInstallDirectory
  StrCmp $VerificationSucceeded 1 rename_failed_safe rollback_restore_failed
rename_failed_safe:
  SetErrorLevel 22
  Goto finished
finished:
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  SetRegView 64
  StrCmp $INSTDIR "$LOCALAPPDATA\Programs\${INSTALL_DIRECTORY_NAME}" +3
    SetErrorLevel 30
    Quit
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i.r0'
  IntOp $0 $0 & 0x400
  IntCmp $0 0 +3
    SetErrorLevel 31
    Quit
  IfFileExists "$INSTDIR\.preview-instance-id" +3
    SetErrorLevel 31
    Quit
  FileOpen $0 "$INSTDIR\.preview-instance-id" r
  FileRead $0 $ExistingIdentity
  FileClose $0
  StrCmp $ExistingIdentity "${INSTANCE_ID}" +3
    SetErrorLevel 31
    Quit
  SetOutPath "$TEMP"
  StrCpy $BackupDirectory "$INSTDIR.uninstalled-${RELEASE_ID}"
  StrCpy $OperationSuffix 0
uninstall_choose_backup:
  IfFileExists "$BackupDirectory\*" uninstall_next_backup uninstall_backup_ready
uninstall_next_backup:
  IntOp $OperationSuffix $OperationSuffix + 1
  StrCpy $BackupDirectory "$INSTDIR.uninstalled-${RELEASE_ID}-$OperationSuffix"
  Goto uninstall_choose_backup
uninstall_backup_ready:
  ClearErrors
  Rename "$INSTDIR" "$BackupDirectory"
  IfErrors uninstall_failed
  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  Delete "$SMPROGRAMS\${DISPLAY_NAME}.lnk"
  Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
  Delete "$SMPROGRAMS\${SHORTCUT_NAME}\${SHORTCUT_NAME}.lnk"
  RMDir "$SMPROGRAMS\${SHORTCUT_NAME}"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_REGISTRY_KEY}"
  DeleteRegKey HKCU "Software\Classes\${PROTOCOL_SCHEME}"
  DeleteRegKey HKCU "Software\Classes\CLSID\${TOAST_ACTIVATOR_CLSID}"
  SetRegView 32
  DeleteRegKey HKCU "Software\Classes\CLSID\${TOAST_ACTIVATOR_CLSID}"
  SetRegView 64
  Call un.VerifyRegistrationRemoved
  StrCmp $RegistrationCleanupSucceeded 1 uninstall_cleanup_confirmed uninstall_cleanup_failed
uninstall_cleanup_confirmed:
  SetErrorLevel 0
  Goto uninstall_finished
uninstall_failed:
  SetErrorLevel 32
  Goto uninstall_finished
uninstall_cleanup_failed:
  ; Registration removal can fail after the payload has left its canonical path.
  ; Verify that exact instance before moving it back, then verify the restored
  ; canonical path. Exit 33 still requires registration repair, but never strands
  ; a verified payload solely because shell cleanup was partial.
  StrCpy $VerificationDirectory "$BackupDirectory"
  Call un.VerifyPreviewInstallDirectory
  StrCmp $VerificationSucceeded 1 uninstall_restore_payload uninstall_rollback_failed
uninstall_restore_payload:
  StrCpy $RenameSource "$BackupDirectory"
  StrCpy $RenameDestination "$INSTDIR"
  Call un.RetryRenameDirectory
  StrCmp $RenameSucceeded 1 uninstall_verify_restored_payload uninstall_rollback_failed
uninstall_verify_restored_payload:
  StrCpy $VerificationDirectory "$INSTDIR"
  Call un.VerifyPreviewInstallDirectory
  StrCmp $VerificationSucceeded 1 uninstall_cleanup_failed_rolled_back uninstall_rollback_failed
uninstall_cleanup_failed_rolled_back:
  SetErrorLevel 33
  Goto uninstall_finished
uninstall_rollback_failed:
  ; The verified payload could not be restored and reverified at the canonical
  ; path. Delete neither location; distinguish this manual-recovery state from 33.
  SetErrorLevel 34
uninstall_finished:
SectionEnd
