@echo off
title PESO San Miguel Travel Attachment System - Manual GitHub Sync
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Auto Sync to GitHub.ps1" -Once
echo.
echo Sync finished. Review the messages above for the result.
pause
