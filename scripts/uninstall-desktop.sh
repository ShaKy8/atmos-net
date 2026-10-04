#!/usr/bin/env bash
#
# Reverse everything install-desktop.sh did. Backups it created are left in
# place; this only removes what ATMOS//NET added.
set -euo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNITS="${HOME}/.config/systemd/user"
BINDINGS="${HOME}/.config/hypr/bindings.lua"
MARK_BEGIN="-- >>> ATMOS//NET (managed) >>>"
MARK_END="-- <<< ATMOS//NET (managed) <<<"

ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }

printf '\n\033[36mRemoving ATMOS//NET desktop integration\033[0m\n\n'

for u in atmos-wallpaper.timer atmos-notify.timer atmos-net.service; do
  systemctl --user disable --now "${u}" >/dev/null 2>&1 || true
done
for u in atmos-net.service atmos-wallpaper.service atmos-wallpaper.timer \
         atmos-notify.service atmos-notify.timer; do
  rm -f "${UNITS}/${u}"
done
systemctl --user daemon-reload
ok "systemd units removed"

if [ -f "${BINDINGS}" ] && grep -qF -- "${MARK_BEGIN}" "${BINDINGS}"; then
  cp "${BINDINGS}" "${BINDINGS}.bak.$(date +%s)"
  python3 - "${BINDINGS}" "${MARK_BEGIN}" "${MARK_END}" <<'PY'
import sys
path, begin, end = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(path).read().split('\n')
out, skip = [], False
for ln in lines:
    if ln.strip() == begin.strip():
        skip = True
        # Drop one blank line that preceded the block.
        while out and out[-1].strip() == '':
            out.pop()
        continue
    if ln.strip() == end.strip():
        skip = False
        continue
    if not skip:
        out.append(ln)
open(path, 'w').write('\n'.join(out).rstrip('\n') + '\n')
PY
  ok "keybinding removed from bindings.lua"
  command -v hyprctl >/dev/null 2>&1 && hyprctl reload >/dev/null 2>&1 || true
fi

THEME="$(cat "${HOME}/.local/state/omarchy/current/theme.name" 2>/dev/null || echo default)"
WALLDIR="${HOME}/.local/state/atmos-net/wallpaper"
CURBG="$(readlink -f "${HOME}/.local/state/omarchy/current/background" 2>/dev/null || true)"
OURS=0
case "${CURBG}" in
  "${HOME}/.local/state/atmos-net/"*|*/backgrounds/*/atmos-live.png) OURS=1 ;;
esac
if [ -d "${WALLDIR}" ] || [ -n "$(ls "${HOME}"/.config/omarchy/backgrounds/*/atmos-live.png 2>/dev/null)" ]; then
  rm -rf "${WALLDIR}"
  rm -f "${HOME}"/.config/omarchy/backgrounds/*/atmos-live.png   # pre-A/B versions
  ok "generated wallpapers deleted"
fi
# Deleting the file the symlink points at would leave the desktop pointing at
# nothing, so hand the background back to the theme rather than printing a hint.
if [ "${OURS}" = "1" ]; then
  omarchy-theme-bg-next >/dev/null 2>&1 || omarchy theme bg next >/dev/null 2>&1 || true
  ok "background restored to a theme default"
fi

rm -rf "${HOME}/.local/state/atmos-net"
ok "notification state cleared"

printf '\n\033[32mDone.\033[0m The project directory itself is untouched.\n\n'
