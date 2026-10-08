@echo off
cd /d "%~dp0"
echo starting m's games and stuff...
python serve.py --open
if errorlevel 1 (
  py serve.py --open
)
if errorlevel 1 (
  echo.
  echo could not start - python was not found on this computer.
  pause
)
