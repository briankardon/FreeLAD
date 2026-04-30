#!/usr/bin/env bash
# Start the FreeLAD server using the local virtual environment.
set -e

cd "$(dirname "$0")"

if [ ! -f venv/bin/python ]; then
    echo
    echo "The virtual environment is missing. Run ./setup.sh first."
    echo
    exit 1
fi

# shellcheck disable=SC1091
source venv/bin/activate
echo "Starting FreeLAD ..."
echo "Press Ctrl+C in this window to stop the server."
echo
python server.py
