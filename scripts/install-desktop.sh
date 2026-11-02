#!/usr/bin/env bash
# Installs the built AppImage into ~/.local/bin and adds Echo Manager to the Linux Mint menu (no sudo).
set -euo pipefail
cd "$(dirname "$0")/.."
img=$(ls -t release/EchoManager-*.AppImage 2>/dev/null | head -1 || true)
[ -n "$img" ] || { echo "Nenhum AppImage em release/. Rode: npm run dist" >&2; exit 1; }
mkdir -p ~/.local/bin ~/.local/share/applications ~/.local/share/icons/hicolor/512x512/apps
install -m 755 "$img" ~/.local/bin/EchoManager.AppImage
install -m 644 build/icons/512x512.png ~/.local/share/icons/hicolor/512x512/apps/echo-manager.png
cat > ~/.local/share/applications/echo-manager.desktop <<DESK
[Desktop Entry]
Name=Echo Manager
Comment=Saúde, Docker, logs, alarme e SSH do seu Echo
Exec=$HOME/.local/bin/EchoManager.AppImage %U
Icon=echo-manager
Terminal=false
Type=Application
Categories=System;Monitor;
Keywords=echo;ssh;docker;alpine;penguin;
StartupWMClass=echo-manager
DESK
update-desktop-database ~/.local/share/applications 2>/dev/null || true
gtk-update-icon-cache ~/.local/share/icons/hicolor 2>/dev/null || true
echo "Instalado: ~/.local/bin/EchoManager.AppImage (procure 'Echo Manager' no menu)"
