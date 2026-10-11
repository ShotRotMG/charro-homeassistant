@echo off
REM  Double-click this to cut a release.
REM
REM  It shows you what it would do first, then asks. Nothing leaves the
REM  machine until you say yes, and the window stays open afterwards so
REM  you can read what happened.
REM
REM  All the real work is in tools\release.py - this only finds Python,
REM  makes sure it runs from the repo folder however it was launched, and
REM  keeps the console from vanishing.

setlocal
cd /d "%~dp0"
title Charro - release

REM  The py launcher if it is installed, plain python otherwise.
set "PY=python"
where py >nul 2>&1 && set "PY=py -3"

%PY% --version >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Python isn't on PATH, so this can't run.
  echo   Install it, or run tools\release.py yourself with whatever
  echo   Python you use.
  echo.
  pause
  exit /b 1
)

echo.
%PY% tools\release.py --dry-run
if errorlevel 1 (
  echo.
  echo   Stopped. Nothing was pushed.
  echo.
  pause
  exit /b 1
)

echo.
choice /c YN /n /m "   Push and publish this release?  [Y/N] "
if errorlevel 2 goto :cancelled

echo.
%PY% tools\release.py
if errorlevel 1 (
  echo.
  echo   Release did not finish. Read the message above - the push may
  echo   already have happened, in which case only the release is left.
  echo.
)
pause
exit /b 0

:cancelled
echo.
echo   Cancelled. Nothing was pushed.
echo.
pause
exit /b 0
