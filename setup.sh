#!/usr/bin/env bash
# FreeLAD one-time setup for Mac / Linux.
# Creates a Python virtual environment and installs dependencies.
set -e

cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
    echo
    echo "ERROR: python3 was not found on your PATH."
    echo "Install Python 3.10+ (e.g. 'brew install python' on Mac)."
    echo
    exit 1
fi

if [ ! -d venv ]; then
    echo "Creating virtual environment in ./venv ..."
    python3 -m venv venv
else
    echo "Virtual environment already exists, skipping creation."
fi

echo "Installing dependencies ..."
# shellcheck disable=SC1091
source venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt

echo
echo "==============================================="
echo "Setup complete! Run ./run_server.sh to start FreeLAD."
echo "==============================================="
