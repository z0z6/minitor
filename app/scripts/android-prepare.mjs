// Przygotowuje projekt Androida (Capacitor) do budowy APK.
// Folder app/android nie jest w repozytorium: powstaje tu z szablonu Capacitor i dostaje nasze ikony, wersję i podpis.
//
// Zmienne środowiskowe (opcjonalne):
//   VERSION_CODE              numer kompilacji (w GitHub Actions: github.run_number)
//   ANDROID_KEYSTORE_FILE     ścieżka do pliku .jks/.keystore (podpis wydania)
//   ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD  (czytane przez Gradle przy budowie)
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const android = path.join(root, 'android');
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });

if (!existsSync(android)) run('npx cap add android');
run('npx cap sync android');

// ikony, ikona powiadomień i ekran startowy
cpSync(path.join(root, 'android-res'), path.join(android, 'app', 'src', 'main', 'res'), { recursive: true });

// wersja
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const gradleFile = path.join(android, 'app', 'build.gradle');
let gradle = readFileSync(gradleFile, 'utf8');
const code = Math.max(1, parseInt(process.env.VERSION_CODE || '1', 10));
gradle = gradle.replace(/versionCode \d+/, `versionCode ${code}`).replace(/versionName "[^"]*"/, `versionName "${pkg.version}"`);

// Bezpieczeństwo: dane i klucze API nie trafiają do kopii zapasowej Google ani do `adb backup`,
// a aplikacja nie łączy się po nieszyfrowanym HTTP.
const manifestFile = path.join(android, 'app', 'src', 'main', 'AndroidManifest.xml');
let manifest = readFileSync(manifestFile, 'utf8');
manifest = manifest
  .replace(/android:allowBackup="true"/, 'android:allowBackup="false"')
  .replace(/<application(?![^>]*android:usesCleartextTraffic)/, '<application android:usesCleartextTraffic="false"')
  .replace(/<application(?![^>]*android:fullBackupContent)/, '<application android:fullBackupContent="false"')
  .replace(/<application(?![^>]*android:dataExtractionRules)/, '<application android:dataExtractionRules="@xml/data_extraction_rules"');
if (!/android:allowBackup="false"/.test(manifest)) manifest = manifest.replace('<application', '<application android:allowBackup="false"');
writeFileSync(manifestFile, manifest);
mkdirSync(path.join(android, 'app', 'src', 'main', 'res', 'xml'), { recursive: true });
writeFileSync(path.join(android, 'app', 'src', 'main', 'res', 'xml', 'data_extraction_rules.xml'), `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
  <cloud-backup><exclude domain="root" /><exclude domain="file" /><exclude domain="database" /><exclude domain="sharedpref" /><exclude domain="external" /></cloud-backup>
  <device-transfer><exclude domain="root" /><exclude domain="file" /><exclude domain="database" /><exclude domain="sharedpref" /><exclude domain="external" /></device-transfer>
</data-extraction-rules>
`);

// podpis wydania (gdy podano klucz). Hasła czyta Gradle ze zmiennych środowiskowych, więc nie trafiają do plików projektu.
const ks = process.env.ANDROID_KEYSTORE_FILE;
if (ks && existsSync(ks) && !gradle.includes('signingConfigs {')) {
  gradle = gradle.replace(/(\n\s*buildTypes \{)/, `
    signingConfigs {
        release {
            storeFile file(System.getenv("ANDROID_KEYSTORE_FILE"))
            storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
            keyAlias System.getenv("ANDROID_KEY_ALIAS")
            keyPassword System.getenv("ANDROID_KEY_PASSWORD")
        }
    }$1`);
  gradle = gradle.replace(/(release \{\s*\n\s*minifyEnabled false)/, '$1\n            signingConfig signingConfigs.release');
  console.log('Android: podpis wydania z podanego klucza');
} else {
  console.log('Android: brak klucza podpisu, zbuduj wersję debug (assembleDebug)');
}
writeFileSync(gradleFile, gradle);
console.log(`Android: wersja ${pkg.version} (${code})`);
