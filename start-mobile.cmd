@echo off
setlocal
set "dashboard_python=%~dp0..\drug-inventory\.runtime\python.exe"
if not exist "%dashboard_python%" (
    echo Portable Python was not found.
    pause
    exit /b 1
)
"%dashboard_python%" "%~dp0serve.py" --host 172.18.77.27 --no-open
if errorlevel 1 pause
