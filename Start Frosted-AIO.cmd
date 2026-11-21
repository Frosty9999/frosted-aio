@echo off
rem Starts Frosted-AIO as administrator (it talks to the cooler and sensors directly). Double-click this file in File Explorer.
set "APPDIR=%~dp0"
set "APPDIR=%APPDIR:~0,-1%"
if not exist "%APPDIR%\node_modules\electron\dist\electron.exe" (
  echo Electron is missing. Run "npm install" in %APPDIR% first.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%APPDIR%\node_modules\electron\dist\electron.exe' -ArgumentList ('\"' + '%APPDIR%' + '\"') -WorkingDirectory '%APPDIR%' -Verb RunAs"
