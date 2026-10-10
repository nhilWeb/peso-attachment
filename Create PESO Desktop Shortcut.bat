@echo off
setlocal
set "APP_DIR=%~dp0"
set "APP_HTML=%APP_DIR%PESO-San-Miguel-Attachment-System.html"
set "APP_ICON=%APP_DIR%PESO-Logo.ico"

if not exist "%APP_HTML%" (
  echo The system HTML file was not found.
  echo Keep this shortcut creator in the same folder as the system.
  pause
  exit /b 1
)

if not exist "%APP_ICON%" (
  echo The PESO icon file was not found.
  echo Keep PESO-Logo.ico in the same folder as the system.
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$shell = New-Object -ComObject WScript.Shell; $shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'PESO San Miguel Attachment System.lnk'; $shortcut = $shell.CreateShortcut($shortcutPath); $shortcut.TargetPath = '%APP_HTML%'; $shortcut.WorkingDirectory = '%APP_DIR%'; $shortcut.IconLocation = '%APP_ICON%,0'; $shortcut.Description = 'PESO San Miguel Attachment System'; $shortcut.Save()"

if errorlevel 1 (
  echo The Desktop shortcut could not be created.
) else (
  echo PESO San Miguel Attachment System shortcut created on the Desktop.
)
pause
