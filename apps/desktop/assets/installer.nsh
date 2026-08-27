!macro customInstall
  ${ifNot} ${isUpdated}
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Relay QA Hub" '$\"$INSTDIR\RelayQaHub.exe$\" --autostart'
  ${endIf}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Relay QA Hub"
  ${endIf}
!macroend
