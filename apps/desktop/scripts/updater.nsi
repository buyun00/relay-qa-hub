Unicode true
SilentInstall silent
AutoCloseWindow true
RequestExecutionLevel user
SetCompressor zlib

!include "FileFunc.nsh"

Name "Relay QA Hub Updater"
OutFile "${OUTPUT_FILE}"
Icon "${ICON_FILE}"
VIProductVersion "${PRODUCT_VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "Relay QA Hub Updater"
VIAddVersionKey /LANG=1033 "FileDescription" "Relay QA Hub native updater"
VIAddVersionKey /LANG=1033 "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${PRODUCT_VERSION}"

Var PackagePath
Var AppPath
Var UserDataPath
Var ParentPid
Var ResultPath
Var ReleaseId
Var Version
Var LogPath
Var InstallerExitCode
Var FailureCode
Var InstallRoot

Function AppendLog
  Exch $9
  ClearErrors
  FileOpen $8 "$LogPath" a
  IfErrors append_log_done
  FileSeek $8 0 END
  FileWriteUTF16LE $8 "$9$\r$\n"
  FileClose $8
append_log_done:
  Pop $9
FunctionEnd

Function WriteResult
  Exch $9
  ${GetTime} "" "LS" $0 $1 $2 $3 $4 $5 $6
  IntFmt $4 "%02u" $4
  StrCpy $7 "$2-$1-$0T$4:$5:$6.000Z"
  ClearErrors
  FileOpen $8 "$ResultPath" w
  IfErrors write_result_done
  FileWriteUTF16LE $8 '{$\"schemaVersion$\":1,$\"status$\":$\"$9$\",$\"releaseId$\":$\"$ReleaseId$\",$\"version$\":$\"$Version$\",$\"recordedAt$\":$\"$7$\"}$\r$\n'
  FileClose $8
write_result_done:
  Pop $9
FunctionEnd

Section
  StrCpy $LogPath "$EXEDIR\update.log"
  Push "native updater started"
  Call AppendLog

  ReadINIStr $PackagePath "$EXEDIR\update.ini" "Update" "PackagePath"
  ReadINIStr $AppPath "$EXEDIR\update.ini" "Update" "AppPath"
  ReadINIStr $UserDataPath "$EXEDIR\update.ini" "Update" "UserDataPath"
  ReadINIStr $ParentPid "$EXEDIR\update.ini" "Update" "ParentPid"
  ReadINIStr $ResultPath "$EXEDIR\update.ini" "Update" "ResultPath"
  ReadINIStr $ReleaseId "$EXEDIR\update.ini" "Update" "ReleaseId"
  ReadINIStr $Version "$EXEDIR\update.ini" "Update" "Version"

  StrCmp $PackagePath "" invalid_config
  StrCmp $AppPath "" invalid_config
  StrCmp $ParentPid "" invalid_config
  StrCmp $ResultPath "" invalid_config
  StrCmp $ReleaseId "" invalid_config
  StrCmp $Version "" invalid_config
  IfFileExists "$PackagePath" package_exists
  Goto invalid_config
package_exists:
  IfFileExists "$AppPath" app_exists
  Goto invalid_config
app_exists:
  ${GetParent} "$AppPath" $InstallRoot
  StrCmp $InstallRoot "" invalid_config

  ClearErrors
  FileOpen $0 "$EXEDIR\ready.flag" w
  IfErrors updater_not_ready
  FileWriteUTF16LE $0 "ready:$ReleaseId"
  FileClose $0
  Push "handoff validated"
  Call AppendLog

  System::Call 'kernel32::OpenProcess(i 0x00100000, i 0, i $ParentPid) p.r0'
  StrCmp $0 "0" parent_exited
  System::Call 'kernel32::WaitForSingleObject(p r0, i 60000) i.r1'
  System::Call 'kernel32::CloseHandle(p r0)'
  StrCmp $1 "0" parent_exited
  StrCpy $FailureCode "UPDATE_PARENT_EXIT_TIMEOUT"
  Goto update_failed

parent_exited:
  Sleep 1000
  Push "main process exited; starting installer"
  Call AppendLog
  ExecWait '$\"$PackagePath$\" /S /QA_HUB_UPDATE=1 /D=$InstallRoot' $InstallerExitCode
  IntCmp $InstallerExitCode 0 install_succeeded install_failed install_failed

install_succeeded:
  IfFileExists "$AppPath" app_installed
  StrCpy $FailureCode "UPDATE_APP_MISSING_AFTER_INSTALL"
  Goto update_failed
app_installed:
  Push "installed"
  Call WriteResult
  Push "update installed; relaunching application"
  Call AppendLog
  StrCmp $UserDataPath "" relaunch_default_profile
  Exec '$\"$AppPath$\" --updated --user-data-dir=$\"$UserDataPath$\"'
  Goto relaunch_finished
relaunch_default_profile:
  Exec '$\"$AppPath$\" --updated'
relaunch_finished:
  SetErrorLevel 0
  Quit

install_failed:
  StrCpy $FailureCode "UPDATE_INSTALLER_FAILED_$InstallerExitCode"
  Goto update_failed

invalid_config:
  StrCpy $FailureCode "UPDATE_CONFIG_INVALID"
  Goto update_failed

updater_not_ready:
  StrCpy $FailureCode "UPDATE_READY_MARKER_FAILED"

update_failed:
  Push "$FailureCode"
  Call AppendLog
  StrCmp $ResultPath "" skip_failure_result
  Push "failed"
  Call WriteResult
skip_failure_result:
  IfFileExists "$AppPath" relaunch_previous_app updater_exit_failed
relaunch_previous_app:
  StrCmp $UserDataPath "" relaunch_previous_default_profile
  Exec '$\"$AppPath$\" --update-failed --user-data-dir=$\"$UserDataPath$\"'
  Goto updater_exit_failed
relaunch_previous_default_profile:
  Exec '$\"$AppPath$\" --update-failed'
updater_exit_failed:
  SetErrorLevel 1
SectionEnd
