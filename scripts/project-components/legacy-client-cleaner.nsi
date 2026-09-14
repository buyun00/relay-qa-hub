Unicode true
RequestExecutionLevel user
SetCompressor /SOLID lzma

!ifndef OUTPUT_FILE
  !error "OUTPUT_FILE is required"
!endif
!ifndef ICON_FILE
  !error "ICON_FILE is required"
!endif
!ifndef FILE_VERSION
  !error "FILE_VERSION is required"
!endif

Name "Relay QA Hub Legacy Client Cleanup"
OutFile "${OUTPUT_FILE}"
Icon "${ICON_FILE}"
VIProductVersion "${FILE_VERSION}"
VIAddVersionKey /LANG=1033 "ProductName" "Relay QA Hub Legacy Client Cleanup"
VIAddVersionKey /LANG=1033 "FileDescription" "Relay QA Hub legacy client cleanup"
VIAddVersionKey /LANG=1033 "FileVersion" "1.0.0"
Page instfiles

Var CleanupFound
Var CleanupRemoved
Var CleanupScheduled
Var CleanupSkipped
Var ExistingIdentity
Var TargetClsid
Var TargetDirectory
Var TargetDisplayName
Var TargetExecutable
Var TargetInstanceId
Var TargetProtocol
Var TargetShortcutName
Var TargetUninstallKey

Function .onInit
  MessageBox MB_ICONQUESTION|MB_YESNO "Remove the obsolete QA Hub LAN/Preview clients? The current Team Edition, daily Relay QA Hub, login, settings, and local drafts will be kept." IDYES cleanup_confirmed
  Abort
cleanup_confirmed:
FunctionEnd

Function CleanupRegistration
  SetRegView 64
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$TargetUninstallKey" "InstallLocation"
  StrCmp $0 "$TargetDirectory" cleanup_delete_uninstall_key cleanup_check_uninstall_string
cleanup_check_uninstall_string:
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$TargetUninstallKey" "UninstallString"
  StrCpy $1 '$\"$TargetDirectory\Uninstall-Preview.exe$\"'
  StrCmp $0 $1 cleanup_delete_uninstall_key cleanup_uninstall_key_finished
cleanup_delete_uninstall_key:
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$TargetUninstallKey"
cleanup_uninstall_key_finished:

  ReadRegStr $0 HKCU "Software\Classes\$TargetProtocol\shell\open\command" ""
  StrCpy $1 '$\"$TargetDirectory\$TargetExecutable.exe$\" $\"%1$\"'
  StrCmp $0 $1 cleanup_delete_protocol cleanup_protocol_finished
cleanup_delete_protocol:
  DeleteRegKey HKCU "Software\Classes\$TargetProtocol"
cleanup_protocol_finished:

  ReadRegStr $0 HKCU "Software\Classes\CLSID\$TargetClsid\LocalServer32" ""
  StrCpy $1 '$\"$TargetDirectory\$TargetExecutable.exe$\"'
  StrCmp $0 $1 cleanup_delete_clsid_64 cleanup_clsid_64_finished
cleanup_delete_clsid_64:
  DeleteRegKey HKCU "Software\Classes\CLSID\$TargetClsid"
cleanup_clsid_64_finished:
  SetRegView 32
  ReadRegStr $0 HKCU "Software\Classes\CLSID\$TargetClsid\LocalServer32" ""
  StrCmp $0 $1 cleanup_delete_clsid_32 cleanup_clsid_32_finished
cleanup_delete_clsid_32:
  DeleteRegKey HKCU "Software\Classes\CLSID\$TargetClsid"
cleanup_clsid_32_finished:
  SetRegView 64

  Delete "$DESKTOP\$TargetShortcutName.lnk"
  Delete "$SMPROGRAMS\$TargetDisplayName.lnk"
  Delete "$SMPROGRAMS\$TargetShortcutName.lnk"
  Delete "$SMPROGRAMS\$TargetShortcutName\$TargetShortcutName.lnk"
  RMDir "$SMPROGRAMS\$TargetShortcutName"
FunctionEnd

Function CleanupTarget
  Call CleanupRegistration
  System::Call 'kernel32::GetFileAttributesW(w "$TargetDirectory") i.r0'
  IntCmp $0 -1 cleanup_target_finished cleanup_target_exists cleanup_target_exists
cleanup_target_exists:
  IntOp $1 $0 & 0x10
  IntCmp $1 0 cleanup_target_invalid cleanup_target_directory cleanup_target_directory
cleanup_target_directory:
  IntOp $1 $0 & 0x400
  IntCmp $1 0 cleanup_target_marker cleanup_target_invalid cleanup_target_invalid
cleanup_target_marker:
  IfFileExists "$TargetDirectory\.preview-instance-id" 0 cleanup_target_invalid
  IfFileExists "$TargetDirectory\$TargetExecutable.exe" 0 cleanup_target_invalid
  ClearErrors
  FileOpen $0 "$TargetDirectory\.preview-instance-id" r
  IfErrors cleanup_target_invalid
  FileRead $0 $ExistingIdentity
  IfErrors cleanup_target_marker_read_failed
  FileClose $0
  StrCmp $ExistingIdentity $TargetInstanceId cleanup_target_verified cleanup_target_invalid
cleanup_target_marker_read_failed:
  FileClose $0
  Goto cleanup_target_invalid
cleanup_target_verified:
  IntOp $CleanupFound $CleanupFound + 1
  DetailPrint "Removing verified legacy instance: $TargetInstanceId"
  ClearErrors
  RMDir /r "$TargetDirectory"
  System::Call 'kernel32::GetFileAttributesW(w "$TargetDirectory") i.r0'
  IntCmp $0 -1 cleanup_target_removed cleanup_target_schedule cleanup_target_schedule
cleanup_target_removed:
  IntOp $CleanupRemoved $CleanupRemoved + 1
  Goto cleanup_target_finished
cleanup_target_schedule:
  ClearErrors
  RMDir /r /REBOOTOK "$TargetDirectory"
  SetRebootFlag true
  IntOp $CleanupScheduled $CleanupScheduled + 1
  DetailPrint "The legacy instance will finish removing after Windows restarts."
  Goto cleanup_target_finished
cleanup_target_invalid:
  IntOp $CleanupSkipped $CleanupSkipped + 1
  DetailPrint "Skipped an unverified path: $TargetDirectory"
cleanup_target_finished:
FunctionEnd

!macro CLEAN_LEGACY_INSTANCE DIRECTORY EXECUTABLE INSTANCE UNINSTALL_KEY SHORTCUT DISPLAY PROTOCOL CLSID
  StrCpy $TargetDirectory "$LOCALAPPDATA\Programs\${DIRECTORY}"
  StrCpy $TargetExecutable "${EXECUTABLE}"
  StrCpy $TargetInstanceId "${INSTANCE}"
  StrCpy $TargetUninstallKey "${UNINSTALL_KEY}"
  StrCpy $TargetShortcutName "${SHORTCUT}"
  StrCpy $TargetDisplayName "${DISPLAY}"
  StrCpy $TargetProtocol "${PROTOCOL}"
  StrCpy $TargetClsid "${CLSID}"
  Call CleanupTarget
!macroend

Section "Legacy QA Hub clients"
  SetShellVarContext current
  SetRegView 64
  StrCpy $CleanupFound 0
  StrCpy $CleanupRemoved 0
  StrCpy $CleanupScheduled 0
  StrCpy $CleanupSkipped 0

  !insertmacro CLEAN_LEGACY_INSTANCE "RelayQaHubLAN-v22-0911" "RelayQaHubLAN-v22-0911" "qa-hub-lan-v22-0911" "RelayQaHubLAN-v22-0911" "QA Hub LAN - v22-0911" "QA Hub LAN (v22-0911)" "qa-hub-lan-v22-0911" "{1E5918C2-6825-53CC-908D-33FE3F49BBAF}"
  !insertmacro CLEAN_LEGACY_INSTANCE "RelayQaHubPreview" "RelayQaHubPreview" "qa-hub-preview-7c86" "RelayQaHubPreview" "QA Hub Project Preview" "QA Hub Project Preview" "qa-hub-preview" "{67209CEA-77EF-5AC8-BC78-C571C64CBAF2}"
  !insertmacro CLEAN_LEGACY_INSTANCE "RelayQaHubPreview-final-sol-0909" "RelayQaHubPreview-final-sol-0909" "qa-hub-preview-final-sol-0909" "RelayQaHubPreview-final-sol-0909" "QA Hub Project Preview - final-sol-0909" "QA Hub Project Preview (final-sol-0909)" "qa-hub-preview-final-sol-0909" "{447C6274-B710-5380-B7A1-1549E1EC5317}"
  !insertmacro CLEAN_LEGACY_INSTANCE "RelayQaHubPreview-v21-e2e-fresh-0910" "RelayQaHubPreview-v21-e2e-fresh-0910" "qa-hub-preview-v21-e2e-fresh-0910" "RelayQaHubPreview-v21-e2e-fresh-0910" "QA Hub Project Preview - v21-e2e-fresh-0910" "QA Hub Project Preview (v21-e2e-fresh-0910)" "qa-hub-preview-v21-e2e-fresh-0910" "{27F8E9AF-5D78-5B08-8ED1-4E810F2046D5}"

  DetailPrint "Verified instances found: $CleanupFound"
  DetailPrint "Removed now: $CleanupRemoved"
  DetailPrint "Pending restart: $CleanupScheduled"
  DetailPrint "Unverified paths skipped: $CleanupSkipped"
  StrCmp $CleanupScheduled 0 cleanup_complete cleanup_restart_required
cleanup_restart_required:
  MessageBox MB_ICONINFORMATION|MB_OK "Some obsolete files are still in use. Restart Windows once to finish removing them."
  Goto cleanup_finished
cleanup_complete:
  MessageBox MB_ICONINFORMATION|MB_OK "Legacy QA Hub client cleanup is complete."
cleanup_finished:
SectionEnd
