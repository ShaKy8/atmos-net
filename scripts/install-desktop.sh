#!/usr/bin/env bash
#
# Wire ATMOS//NET into the desktop:
#   - run the server as a systemd user service (starts on login)
#   - SUPER + SHIFT + W opens the portal fullscreen
#   - the desktop background becomes the live sky, refreshed every 20 minutes
#   - desktop notifications for severe weather and incoming rain
#
# Every file this touches is backed up first. scripts/uninstall-desktop.sh
# reverses all of it.
set -euo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="$(command -v node)"
UNITS="${HOME}/.config/systemd/user"
BINDINGS="${HOME}/.config/hypr/bindings.lua"
STAMP="$(date +%s)"
MARK_BEGIN="-- >>> ATMOS//NET (managed) >>>"
MARK_END="-- <<< ATMOS//NET (managed) <<<"

say() { printf '  %s\n' "$*"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn(){ printf '  \033[33m!\033[0m %s\n' "$*"; }

printf '\n\033[36mATMOS//NET desktop integration\033[0m\n\n'

[ -n "${NODE}" ] || { echo "node not found on PATH"; exit 1; }
say "project : ${PROJECT}"
say "node    : ${NODE}"
echo

# ---------------------------------------------------------------- systemd
mkdir -p "${UNITS}"
for u in atmos-net.service atmos-wallpaper.service atmos-wallpaper.timer \
         atmos-notify.service atmos-notify.timer; do
  [ -f "${UNITS}/${u}" ] && cp "${UNITS}/${u}" "${UNITS}/${u}.bak.${STAMP}"
  sed -e "s|__PROJECT__|${PROJECT}|g" -e "s|__NODE__|${NODE}|g" \
      "${PROJECT}/systemd/${u}" > "${UNITS}/${u}"
done
systemctl --user daemon-reload
systemctl --user enable --now atmos-net.service >/dev/null 2>&1
ok "server enabled (systemctl --user status atmos-net)"

systemctl --user enable --now atmos-notify.timer >/dev/null 2>&1
ok "notification watcher enabled (every 5 min)"

if [ "${ATMOS_SKIP_WALLPAPER:-0}" = "1" ]; then
  warn "wallpaper timer skipped (ATMOS_SKIP_WALLPAPER=1)"
else
  systemctl --user enable --now atmos-wallpaper.timer >/dev/null 2>&1
  ok "live wallpaper enabled (every 20 min)"
fi

# --------------------------------------------------------------- keybinding
#
# SUPER + W is Omarchy's "close window" and is deliberately left alone;
# SUPER + SHIFT + W is unbound, so that is what the portal gets.
if [ -f "${BINDINGS}" ]; then
  if grep -qF -- "${MARK_BEGIN}" "${BINDINGS}"; then
    warn "keybinding block already present, leaving it as is"
  else
    cp "${BINDINGS}" "${BINDINGS}.bak.${STAMP}"
    cat >> "${BINDINGS}" <<LUA

${MARK_BEGIN}
-- SUPER + W stays bound to "Close window"; the portal takes SUPER + SHIFT + W.
o.bind("SUPER + SHIFT + W", "Weather portal", "${PROJECT}/scripts/atmos-portal")
${MARK_END}
LUA
    ok "SUPER + SHIFT + W bound (backup: bindings.lua.bak.${STAMP})"
  fi
else
  warn "no ~/.config/hypr/bindings.lua found; skipped the keybinding"
fi

if command -v hyprctl >/dev/null 2>&1; then
  hyprctl reload >/dev/null 2>&1 || true
  errs="$(hyprctl configerrors 2>/dev/null || true)"
  if [ -n "${errs}" ] && [ "${errs}" != "no errors" ]; then
    warn "hyprctl reported config errors:"
    printf '%s\n' "${errs}" | sed 's/^/      /'
  else
    ok "hyprland config reloaded cleanly"
  fi
fi

# --------------------------------------------------------------- first run
echo
say "rendering the first wallpaper (this takes ~20s)…"
if "${PROJECT}/scripts/atmos-wallpaper"; then
  ok "wallpaper set"
else
  warn "wallpaper render failed; the timer will retry"
fi

printf '\n\033[32mDone.\033[0m\n'
printf '  Portal      \033[36mhttp://localhost:7777\033[0m  or  SUPER + SHIFT + W\n'
printf '  Uninstall   %s/scripts/uninstall-desktop.sh\n\n' "${PROJECT}"
