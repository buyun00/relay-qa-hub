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
; handle briefly. Keep the retry bounded: 40 total attempts and at most 9.75s asleep.
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
Var OperationSuffix
Var RenameAttemptsRemaining

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

Section "QA Hub Preview"
  StrCpy $BackupDirectory "$INSTDIR.backup-${RELEASE_ID}"
  StrCpy $OperationSuffix 0
choose_backup:
  IfFileExists "$BackupDirectory\*" next_backup backup_ready
next_backup:
  IntOp $OperationSuffix $OperationSuffix + 1
  StrCpy $BackupDirectory "$INSTDIR.backup-${RELEASE_ID}-$OperationSuffix"
  Goto choose_backup
backup_ready:
  IfFileExists "$INSTDIR\*" 0 install_files
  SetOutPath "$TEMP"
  StrCpy $RenameAttemptsRemaining ${INSTALL_RENAME_MAX_ATTEMPTS}
rename_install_directory:
  ClearErrors
  Rename "$INSTDIR" "$BackupDirectory"
  IfErrors rename_retry install_files
rename_retry:
  IntOp $RenameAttemptsRemaining $RenameAttemptsRemaining - 1
  IntCmp $RenameAttemptsRemaining 0 rename_failed rename_failed rename_retry_wait
rename_retry_wait:
  Sleep ${INSTALL_RENAME_RETRY_DELAY_MS}
  Goto rename_install_directory
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
  Rename "$INSTDIR" "$INSTDIR.failed-${RELEASE_ID}"
  Rename "$BackupDirectory" "$INSTDIR"
  SetErrorLevel 21
  Goto finished
rename_failed:
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
