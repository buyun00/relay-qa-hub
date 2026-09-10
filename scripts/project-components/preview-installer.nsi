Unicode true
RequestExecutionLevel user
SetCompressor /SOLID lzma
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
!ifndef DISPLAY_NAME
  !error "DISPLAY_NAME is required"
!endif
; The updater waits for the main PID, but a child can retain an image or directory
; handle briefly. Each rename phase is bounded to 40 attempts and 9.75s asleep.
!define INSTALL_RENAME_MAX_ATTEMPTS 40
!define INSTALL_RENAME_RETRY_DELAY_MS 250
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
Var ExistingIdentity
Var FailedDirectory
Var HadExistingInstall
Var OperationSuffix
Var RenameAttemptsRemaining
Var RenameDestination
Var RenameSource
Var RenameSucceeded
Var VerificationDirectory
Var VerificationSucceeded

Function .onInit
  SetShellVarContext current
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
  IfFileExists "$INSTDIR\*" 0 validated
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i.r0'
  IntOp $0 $0 & 0x400
  IntCmp $0 0 +3
    SetErrorLevel 11
    Quit
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

Section "QA Hub Preview"
  StrCpy $HadExistingInstall 0
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
  IfFileExists "$INSTDIR\*.*" 0 install_files
  StrCpy $HadExistingInstall 1
  SetOutPath "$TEMP"
  StrCpy $RenameSource "$INSTDIR"
  StrCpy $RenameDestination "$BackupDirectory"
  Call RetryRenameDirectory
  StrCmp $RenameSucceeded 1 install_files rename_failed
install_files:
  SetOutPath "$INSTDIR"
  ClearErrors
  File /r "${PACKAGE_DIR}\*"
  IfErrors install_failed
  IfFileExists "$BackupDirectory\preview-instance.json" 0 write_registration
  ClearErrors
  CopyFiles /SILENT "$BackupDirectory\preview-instance.json" "$INSTDIR\preview-instance.json"
  IfErrors install_failed
write_registration:
  FileOpen $0 "$INSTDIR\.preview-instance-id" w
  FileWrite $0 "${INSTANCE_ID}"
  FileClose $0
  WriteUninstaller "$INSTDIR\Uninstall-Preview.exe"
  CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$INSTDIR\${EXECUTABLE_BASENAME}.exe"
  CreateDirectory "$SMPROGRAMS\${SHORTCUT_NAME}"
  CreateShortCut "$SMPROGRAMS\${SHORTCUT_NAME}\${SHORTCUT_NAME}.lnk" "$INSTDIR\${EXECUTABLE_BASENAME}.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_REGISTRY_KEY}" "DisplayName" "${DISPLAY_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_REGISTRY_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_REGISTRY_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_REGISTRY_KEY}" "UninstallString" '$\"$INSTDIR\Uninstall-Preview.exe$\"'
  WriteRegStr HKCU "Software\Classes\${PROTOCOL_SCHEME}" "" "URL:${DISPLAY_NAME}"
  WriteRegStr HKCU "Software\Classes\${PROTOCOL_SCHEME}" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\${PROTOCOL_SCHEME}\shell\open\command" "" '$\"$INSTDIR\${EXECUTABLE_BASENAME}.exe$\" $\"%1$\"'
  SetErrorLevel 0
  Goto finished
install_failed:
  SetOutPath "$TEMP"
  IfFileExists "$INSTDIR\*.*" choose_failed_directory no_failed_payload_to_isolate
choose_failed_directory:
  StrCpy $FailedDirectory "$INSTDIR.failed-${RELEASE_ID}"
  StrCpy $OperationSuffix 0
find_unique_failed_directory:
  IfFileExists "$FailedDirectory" next_failed_directory
  IfFileExists "$FailedDirectory\*.*" next_failed_directory failed_directory_ready
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
  IfFileExists "$FailedDirectory\*.*" failed_payload_ready quarantine_failed
no_failed_payload_to_isolate:
failed_payload_ready:
  StrCmp $HadExistingInstall 1 restore_backup verify_fresh_failure
verify_fresh_failure:
  IfFileExists "$INSTDIR" quarantine_failed
  IfFileExists "$INSTDIR\*.*" quarantine_failed fresh_failure_confirmed
fresh_failure_confirmed:
  ; A fresh install has no old backup; the failed payload is off the canonical path.
  SetErrorLevel 25
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
  ; Payload failed, but the verified old installation is canonical again.
  SetErrorLevel 21
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
  Delete "$SMPROGRAMS\${SHORTCUT_NAME}\${SHORTCUT_NAME}.lnk"
  RMDir "$SMPROGRAMS\${SHORTCUT_NAME}"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_REGISTRY_KEY}"
  DeleteRegKey HKCU "Software\Classes\${PROTOCOL_SCHEME}"
  SetErrorLevel 0
  Goto uninstall_finished
uninstall_failed:
  SetErrorLevel 32
uninstall_finished:
SectionEnd
