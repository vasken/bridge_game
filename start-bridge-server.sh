#!/bin/bash
set -e
cd "$(dirname "$0")"

OS_NAME="$(uname -s)"

echo ""
echo "============================================"
echo "  Bridge Server Launcher"
echo "============================================"
echo ""

# Check for Node.js
if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: Node.js was not found on this system."
    echo ""
    if [ "$OS_NAME" = "Darwin" ]; then
        echo "Install it with one of these, then run this script again:"
        echo "  - Download the macOS installer: https://nodejs.org/en/download"
        echo "  - Or, if you have Homebrew:      brew install node"
    else
        echo "Install it with one of these, then run this script again:"
        echo "  - Debian/Ubuntu:  sudo apt install nodejs npm"
        echo "  - Fedora:         sudo dnf install nodejs npm"
        echo "  - Arch:           sudo pacman -S nodejs npm"
        echo "  - Or download from: https://nodejs.org/en/download"
    fi
    echo ""
    read -p "Press Enter to close..."
    exit 1
fi

echo "Found Node.js: $(node -v)"

# Install dependencies if missing
if [ ! -d "node_modules" ]; then
    echo ""
    echo "node_modules not found - installing dependencies first."
    echo "This requires an internet connection and may take a minute..."
    echo ""
    npm install
fi

echo ""
echo "============================================"
echo "  Starting Bridge Server..."
echo ""
echo "  When you see a 'network:' URL below, that"
echo "  is the link to send to the other players"
echo "  and spectators on this same WiFi/network."
echo "============================================"
echo ""

npm run dev:multi

echo ""
echo "------------------------------------------------"
echo "Server has stopped."
read -p "Press Enter to close..."
