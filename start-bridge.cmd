@echo off
title WhatsApp Bridge (read-only)
cd /d "%~dp0"
echo Keep this window open. Close it to disconnect.
echo.
node bridge.js %*
pause
