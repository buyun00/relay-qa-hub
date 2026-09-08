Unicode true
RequestExecutionLevel user
SetCompressor /SOLID lzma
Name "QA Hub Project Preview"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\RelayQaHubPreview"
Icon "${ICON_FILE}"
VIProductVersion "0.2.0.${BUILD_NUMBER}"
VIAddVersionKey /LANG=1033 "ProductName" "QA Hub Project Preview"
VIAddVersionKey /LANG=1033 "FileDescription" "Independent QA Hub preview installer"
VIAddVersionKey /LANG=1033 "FileVersion" "${APP_VERSION}"
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Var BackupDirectory
Var ExistingIdentity
Var OperationSuffix

Function .onInit
  SetShellVarContext current
  StrCmp $INSTDIR "$LOCALAPPDATA\Programs\RelayQaHubPreview" +3
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
  ClearErrors
  Rename "$INSTDIR" "$BackupDirectory"
  IfErrors rename_failed
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
  CreateShortCut "$DESKTOP\QA Hub Project Preview.lnk" "$INSTDIR\RelayQaHubPreview.exe"
  CreateDirectory "$SMPROGRAMS\QA Hub Project Preview"
  CreateShortCut "$SMPROGRAMS\QA Hub Project Preview\QA Hub Project Preview.lnk" "$INSTDIR\RelayQaHubPreview.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RelayQaHubPreview" "DisplayName" "QA Hub Project Preview"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RelayQaHubPreview" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RelayQaHubPreview" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RelayQaHubPreview" "UninstallString" '$\"$INSTDIR\Uninstall-Preview.exe$\"'
  WriteRegStr HKCU "Software\Classes\qa-hub-preview" "" "URL:QA Hub Preview"
  WriteRegStr HKCU "Software\Classes\qa-hub-preview" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\qa-hub-preview\shell\open\command" "" '$\"$INSTDIR\RelayQaHubPreview.exe$\" $\"%1$\"'
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
  StrCmp $INSTDIR "$LOCALAPPDATA\Programs\RelayQaHubPreview" +3
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
  Delete "$DESKTOP\QA Hub Project Preview.lnk"
  Delete "$SMPROGRAMS\QA Hub Project Preview\QA Hub Project Preview.lnk"
  RMDir "$SMPROGRAMS\QA Hub Project Preview"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RelayQaHubPreview"
  DeleteRegKey HKCU "Software\Classes\qa-hub-preview"
  SetErrorLevel 0
  Goto uninstall_finished
uninstall_failed:
  SetErrorLevel 32
uninstall_finished:
SectionEnd
