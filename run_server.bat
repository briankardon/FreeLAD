@echo off
REM Start the FreeLAD server using the local virtual environment.

cd /d "%~dp0"

if not exist venv\Scripts\python.exe (
    echo.
    echo The virtual environment is missing. Run setup.bat first.
    echo.
    pause
    exit /b 1
)

call venv\Scripts\activate.bat
echo Starting FreeLAD ...
echo Press Ctrl+C in this window to stop the server.
echo.
python server.py
echo.
echo Server stopped.
pause
