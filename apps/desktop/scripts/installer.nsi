Unicode true
SetCompressor zlib
RequestExecutionLevel user

!include "MUI2.nsh"

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
!define MUI_FINISHPAGE_RUN_TEXT "启动 Relay QA Hub"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "Relay QA Hub" MainSection
  SetShellVarContext current
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM RelayQaHub.exe'
  Sleep 500
  RMDir /r "$INSTDIR"
  SetOutPath "$INSTDIR"
  File /r "${SOURCE_DIR}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateShortCut "$DESKTOP\Relay QA Hub.lnk" "$INSTDIR\RelayQaHub.exe" "" "$INSTDIR\RelayQaHub.exe" 0
  CreateDirectory "$SMPROGRAMS\Relay QA Hub"
  CreateShortCut "$SMPROGRAMS\Relay QA Hub\Relay QA Hub.lnk" "$INSTDIR\RelayQaHub.exe" "" "$INSTDIR\RelayQaHub.exe" 0
  CreateShortCut "$SMPROGRAMS\Relay QA Hub\卸载 Relay QA Hub.lnk" "$INSTDIR\Uninstall.exe"

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Relay QA Hub" '$\"$INSTDIR\RelayQaHub.exe$\" --hidden'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RelayQaHub" "DisplayName" "Relay QA Hub"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RelayQaHub" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RelayQaHub" "DisplayIcon" "$INSTDIR\RelayQaHub.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RelayQaHub" "Publisher" "Relay QA Hub Team"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RelayQaHub" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RelayQaHub" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RelayQaHub" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RelayQaHub" "NoRepair" 1
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
