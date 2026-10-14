@echo off
rem Sell-in report: fetch NetSuite, rebuild encrypted data and publish to GitHub (logic in build\publish.py)
cd /d "%~dp0"
python build\publish.py %*
if errorlevel 1 (
    echo.
    echo FAILED - see the messages above.
)
pause
