@echo off
setlocal
set "dashboard_python=%~dp0..\drug-inventory\.runtime\python.exe"
if not exist "%dashboard_python%" (
    echo Open index.html in a browser and choose the JSON files from the data folder.
    pause
    exit /b 1
)
"%dashboard_python%" "%~dp0serve.py"
if errorlevel 1 pause
