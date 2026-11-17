# Monitor prawa: aplikacja (Windows, Linux, Android)

Samodzielna wersja monitora prawa oświatowego. Aplikacja sama pobiera nowe akty z tych samych źródeł co silnik w GitHub Actions (`../src`),
filtruje je, analizuje przez AI, nadaje priorytety i przypisuje zadania rolom. Wszystko dzieje się na urządzeniu: nie potrzeba Supabase, Brevo ani serwera.

| Platforma | Plik | Jak działa skan |
|---|---|---|
| Windows | `Monitor-prawa-<wersja>-portable.exe` (bez instalacji, dane w folderze obok .exe) | codziennie od ustawionej godziny, także gdy okno jest schowane w zasobniku |
| Linux | `Monitor-prawa-<wersja>-linux-x86_64.AppImage` | jw. |
| Android | `Monitor-prawa-<wersja>.apk` | po otwarciu aplikacji, jeśli tego dnia skanu jeszcze nie było, albo przyciskiem „Skanuj teraz” |

## Analiza AI

| Sposób | Gdzie | Koszt |
|---|---|---|
| Konto Claude (Claude Code) | komputer | w ramach planu Claude (Pro/Max). Aplikacja instaluje oficjalny program Claude Code i otwiera stronę logowania Claude; nie widzi hasła ani tokenów |
| Klucz API Claude | komputer i telefon | za zużycie (platform.claude.com) |
| Klucz API Gemini | komputer i telefon | darmowy poziom Google AI Studio |
| Bez AI | wszędzie | 0 zł, tylko słowa kluczowe |

Klucze API na komputerze są szyfrowane systemowo (safeStorage) i nie trafiają do okna aplikacji. Na Androidzie są w pamięci aplikacji.

## Budowa

Pliki budują się same w GitHub Actions (workflow **Aplikacja (Windows, Linux, Android)**) po każdej zmianie w `app/`, `src/` lub `config/`.
Gotowe pliki są w zakładce Actions → przebieg → *Artifacts*. Tag `v*` (np. `v1.0.0`) dodatkowo tworzy wydanie (Release) ze wszystkimi plikami.

### Podpis APK (zalecany)
Bez klucza powstaje wersja `-debug.apk`, podpisana kluczem jednorazowym: kolejnej wersji nie da się wtedy zainstalować „na” poprzednią
(trzeba odinstalować starą, a dane znikną, więc najpierw zrób kopię w Ustawieniach → Ogólne). Stały klucz rozwiązuje to na zawsze:

```bash
keytool -genkeypair -v -keystore monitor.keystore -alias monitor -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 monitor.keystore   # wynik wklej jako sekret ANDROID_KEYSTORE_BASE64
```
Sekrety repozytorium (Settings → Secrets and variables → Actions): `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (np. `monitor`), `ANDROID_KEY_PASSWORD`.
Plik `monitor.keystore` przechowuj bezpiecznie poza repozytorium.

### Lokalnie
```bash
cd app
npm install
npm test            # testy silnika w wersji aplikacji (dane testowe z ../test/fixtures)
npm start           # uruchomienie na komputerze
npm run dist:linux  # AppImage
npm run dist:win    # portable .exe (na Windows)
npm run android:prepare && (cd android && ./gradlew assembleDebug)   # APK, wymaga JDK 21 i Android SDK
```

## Budowa kodu
- `www/`: wspólny interfejs (styl macOS/iOS, tryb jasny i ciemny, na telefonie pasek kart na dole).
- `engine/`: łączy silnik z `../src` z aplikacją (magazyn lokalny, klient HTTP, analizator Claude Code). `npm run build:engine` składa go w `www/engine.js`.
- `electron/`: proces główny na komputer (pobieranie stron bez blokad CORS, zapis plików, klucze, Claude Code, zasobnik, autostart).
- Android: Capacitor. Projekt `android/` powstaje w CI ze skryptu `scripts/android-prepare.mjs` (ikony z `android-res/`).

## Czego aplikacja (jeszcze) nie robi
- Nie wysyła e-maili i nie ma linków dla pracowników ani szkiców dokumentów: to nadal robi wersja z GitHub Actions + panel.
- Dane z aplikacji i z panelu (Supabase) nie synchronizują się.
- Na Androidzie system nie pozwala na niezawodny skan w tle bez otwierania aplikacji, dlatego skan rusza przy jej otwarciu.
