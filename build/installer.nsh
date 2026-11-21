; Extra install/uninstall steps for Frosted-AIO.

; The installer already runs as administrator, so:
;  1. If the app's earlier version "My Kanali" is installed, uninstall it quietly (its settings stay in
;     %APPDATA%\my-kanali and Frosted-AIO copies them on first start).
;  2. Register the "Frosted-AIO (open)" task (and carry over / repoint the sign-in task). That's what lets
;     Frosted-AIO.exe start as administrator with no prompt, including the very first time.
!macro customInstall
  ; Remember whether My Kanali started at sign-in before its uninstaller deletes that task ($R9 = "0" if so).
  nsExec::Exec 'schtasks /Query /TN "My Kanali"'
  Pop $R9
  IfFileExists "$PROGRAMFILES64\My Kanali\Uninstall My Kanali.exe" 0 +3
    DetailPrint "Removing the earlier version (My Kanali)..."
    ExecWait '"$PROGRAMFILES64\My Kanali\Uninstall My Kanali.exe" /S _?=$PROGRAMFILES64\My Kanali'
  RMDir /r "$PROGRAMFILES64\My Kanali"
  StrCmp $R9 "0" 0 +3
    nsExec::ExecToLog '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --register-tasks --enable-autostart'
    Goto +2
  nsExec::ExecToLog '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --register-tasks'
!macroend

; On a real uninstall (not during an upgrade), remove both scheduled tasks. Settings in
; %APPDATA%\frosted-aio are kept.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::Exec 'schtasks /Delete /TN "Frosted-AIO" /F'
    nsExec::Exec 'schtasks /Delete /TN "Frosted-AIO (open)" /F'
  ${endIf}
!macroend
