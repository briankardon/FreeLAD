@echo off
REM FreeLAD one-time setup for Windows.
REM Creates a Python virtual environment and installs dependencies.

cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
    echo.
    echo ERROR: Python was not found on your PATH.
    echo Please install Python 3.10 or newer from https://www.python.org/downloads/
    echo Make sure to check "Add Python to PATH" during installation.
    echo.
    pause
    exit /b 1
)

if not exist venv (
    echo Creating virtual environment in .\venv ...
    python -m venv venv
    if errorlevel 1 (
        echo Failed to create virtual environment.
        pause
        exit /b 1
    )
) else (
    echo Virtual environment already exists, skipping creation.
)

echo Installing dependencies ...
call venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r requirements.txt
if errorlevel 1 (
    echo.
    echo Dependency install failed. See the messages above.
    pause
    exit /b 1
)

echo.
echo ===============================================
echo Setup complete! Double-click run_server.bat to start FreeLAD.
echo ===============================================
echo.
pause
