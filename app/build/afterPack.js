'use strict';
// Linux: część dystrybucji (np. Ubuntu 23.10+) blokuje nieuprzywilejowane przestrzenie nazw użytkownika (AppArmor),
// przez co piaskownica Chromium w AppImage nie startuje. Podmieniamy plik wykonywalny na skrypt, który wyłącza
// piaskownicę WYŁĄCZNIE na takich systemach; wszędzie indziej aplikacja działa z pełną piaskownicą.
// Wymuszenie: MONITOR_NO_SANDBOX=1. Okno aplikacji wczytuje wyłącznie lokalne pliki (bez treści z internetu).
const fs = require('fs');
const path = require('path');

// Bezpieczniki Electrona (wbudowane w plik programu): bez trybu „uruchom jako Node”, bez NODE_OPTIONS
// i --inspect, aplikacja tylko z archiwum asar. Zamyka to proste drogi wstrzyknięcia kodu do podpisanej aplikacji.
// Ustawiamy je tutaj (a nie w `electronFuses`), bo na Linuksie zaraz podmieniamy plik programu na skrypt.
async function flipFuses(context) {
  const { FuseV1Options, FuseVersion } = await import('@electron/fuses');
  const fuses = {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  };
  // Sprawdzanie integralności asar działa w Electronie tylko na macOS i Windows.
  if (context.electronPlatformName === 'win32') fuses[FuseV1Options.EnableEmbeddedAsarIntegrityValidation] = true;
  await context.packager.addElectronFuses(context, fuses);
}

exports.default = async function afterPack(context) {
  await flipFuses(context);
  if (context.electronPlatformName !== 'linux') return;
  const exe = context.packager.executableName;
  const dir = context.appOutDir;
  const bin = path.join(dir, exe);
  const real = path.join(dir, exe + '.bin');
  if (!fs.existsSync(bin) || fs.existsSync(real)) return;
  fs.renameSync(bin, real);
  fs.writeFileSync(bin, `#!/bin/bash
HERE="$(dirname "$(readlink -f "$0")")"
NS=""
rd() { cat "$1" 2>/dev/null; }
if [ "$MONITOR_NO_SANDBOX" = "1" ] || [ "$(rd /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" = "1" ] \\
   || [ "$(rd /proc/sys/kernel/unprivileged_userns_clone)" = "0" ] || [ "$(rd /proc/sys/user/max_user_namespaces)" = "0" ]; then
  NS="--no-sandbox"
fi
exec "$HERE/${exe}.bin" $NS "$@"
`, { mode: 0o755 });
};
