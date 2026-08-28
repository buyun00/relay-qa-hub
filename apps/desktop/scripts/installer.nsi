Unicode true
SetCompressor zlib
RequestExecutionLevel user

!include "MUI2.nsh"
!include "FileFunc.nsh"

Var QaHubUpdateMode
Var QaHubBackupPath
Var QaHubRuntimeBackup

Name "Relay QA Hub"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\RelayQaHub"
Icon "${ICON_FILE}"
UninstallIcon "${ICON_FILE}"
VIProductVersion "${PRODUCT_VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "Relay QA Hub"
VIAddVersionKey /LANG=1033 "FileDescription" "Relay QA Hub installer"
VIAddVersionKey /LANG=1033 "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${PRODUCT_VERSION}"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\RelayQaHub.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Launch Relay QA Hub"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "Relay QA Hub" MainSection
  SetShellVarContext current
  ${GetOptions} $CMDLINE "/QA_HUB_UPDATE=" $QaHubUpdateMode
  StrCmp $QaHubUpdateMode "1" update_processes_closed
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM RelayQaHub.exe'
  Sleep 500
update_processes_closed:
  Sleep 500
  StrCmp $QaHubUpdateMode "1" prepare_update fresh_install

prepare_update:
  InitPluginsDir
  StrCpy $QaHubRuntimeBackup "$PLUGINSDIR\desktop-runtime.json"
  IfFileExists "$INSTDIR\desktop-runtime.json" 0 runtime_preserved
  ClearErrors
  CopyFiles /SILENT "$INSTDIR\desktop-runtime.json" "$QaHubRuntimeBackup"
  IfErrors update_backup_failed
runtime_preserved:
  StrCpy $QaHubBackupPath "$INSTDIR.backup-${RELEASE_ID}"
  IfFileExists "$QaHubBackupPath\*.*" update_backup_failed
  ClearErrors
  Rename "$INSTDIR" "$QaHubBackupPath"
  IfErrors update_backup_failed
  Goto install_payload

fresh_install:
  RMDir /r "$INSTDIR"

install_payload:
  ClearErrors
  SetOutPath "$INSTDIR"
  File /r "${SOURCE_DIR}\*.*"
  IfErrors install_failed
  IfFileExists "$QaHubRuntimeBackup" 0 runtime_restored
  CopyFiles /SILENT "$QaHubRuntimeBackup" "$INSTDIR\desktop-runtime.json"
  IfErrors install_failed
runtime_restored:
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  StrCmp $QaHubUpdateMode "1" install_complete

  CreateShortCut "$DESKTOP\Relay QA Hub.lnk" "$INSTDIR\RelayQaHub.exe" "" "$INSTDIR\RelayQaHub.exe" 0
  CreateDirectory "$SMPROGRAMS\Relay QA Hub"
  CreateShortCut "$SMPROGRAMS\Relay QA Hub\Relay QA Hub.lnk" "$INSTDIR\RelayQaHub.exe" "" "$INSTDIR\RelayQaHub.exe" 0
  CreateShortCut "$SMPROGRAMS\Relay QA Hub\Uninstall Relay QA Hub.lnk" "$INSTDIR\Uninstall.exe"

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Relay QA Hub" '$\"$INSTDIR\RelayQaHub.exe$\" --hidden'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RelayQaHub" "DisplayName" "Relay QA Hub"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RelayQaHub" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RelayQaHub" "DisplayIcon" "$INSTDIR\RelayQaHub.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RelayQaHub" "Publisher" "Relay QA Hub Team"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RelayQaHub" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RelayQaHub" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RelayQaHub" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RelayQaHub" "NoRepair" 1

install_complete:
  Goto install_done

install_failed:
  StrCmp $QaHubUpdateMode "1" restore_update install_abort
restore_update:
  RMDir /r "$INSTDIR"
  Rename "$QaHubBackupPath" "$INSTDIR"
install_abort:
  SetErrorLevel 3
  Quit

update_backup_failed:
  SetErrorLevel 2
  Quit

install_done:

SectionEnd

Section "Uninstall"
  SetShellVarContext current
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM RelayQaHub.exe'
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Relay QA Hub"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RelayQaHub"
  Delete "$DESKTOP\Relay QA Hub.lnk"
  RMDir /r "$SMPROGRAMS\Relay QA Hub"
  RMDir /r "$INSTDIR"
SectionEnd
