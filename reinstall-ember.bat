@echo off
rem ---------------------------------------------------------------------------
rem  reinstall-ember.bat - replace the Electron-era Ember (1.x) with the latest
rem  Tauri build (2.x).
rem
rem  Order of operations:
rem    1. pick the newest Ember_<version>_x64-setup.exe it can find
rem    2. close a running Ember
rem    3. copy %APPDATA%\Ember\*.json to a temp backup (settings, usage caches,
rem       quota ledger - the history that cannot be re-derived from logs)
rem    4. run the electron-builder uninstaller ("Uninstall Ember.exe") silently
rem    5. run the Tauri installer silently, then launch Ember
rem
rem  %APPDATA%\Ember is left in place on purpose: Ember 2.x migrates settings,
rem  usage caches and the quota ledger out of it on first launch
rem  (migrate_legacy_data in src-tauri/src/lib.rs), so deleting it would throw
rem  away usage history for logs that no longer exist.
rem
rem  Usage:
rem    reinstall-ember.bat [installer.exe] [/y] [/build] [/gui] [/nolaunch]
rem                        [/nobackup]
rem ---------------------------------------------------------------------------

setlocal EnableExtensions EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
set "REPO_DIR=%SCRIPT_DIR:~0,-1%"
set "BUNDLE_DIR=%REPO_DIR%\src-tauri\target\release\bundle\nsis"
set "BACKUP_DIR=%TEMP%\ember-data-backup"
set "LEGACY_DATA=%APPDATA%\Ember"

set "SETUP="
set "ASSUME_YES=0"
set "DO_BUILD=0"
set "SILENT=1"
set "LAUNCH=1"
set "BACKUP=1"
set "IS_ADMIN=0"
set "NEED_ADMIN=0"
set "UN_COUNT=0"
set "RC=0"

fltmc >nul 2>&1 && set "IS_ADMIN=1"

rem ---------------------------------------------------------------- arguments
:parse
if "%~1"=="" goto parsed
set "ARG=%~1"
set "KNOWN=0"
if /i "!ARG!"=="/y"        ( set "ASSUME_YES=1" & set "KNOWN=1" )
if /i "!ARG!"=="/build"    ( set "DO_BUILD=1"   & set "KNOWN=1" )
if /i "!ARG!"=="/gui"      ( set "SILENT=0"     & set "KNOWN=1" )
if /i "!ARG!"=="/nolaunch" ( set "LAUNCH=0"     & set "KNOWN=1" )
if /i "!ARG!"=="/nobackup" ( set "BACKUP=0"     & set "KNOWN=1" )
if /i "!ARG!"=="/?"    goto usage
if /i "!ARG!"=="-h"    goto usage
if /i "!ARG!"=="/help" goto usage
if "!KNOWN!"=="0" (
    if exist "!ARG!" ( set "SETUP=%~f1" ) else ( goto bad_arg )
)
shift
goto parse
:parsed

echo(
echo   Ember - replace the Electron install with the latest Tauri build
echo   ---------------------------------------------------------------
echo(

rem ------------------------------------------------------ locate the installer
if "%DO_BUILD%"=="1" call :build
if not defined SETUP call :find_setup

if not defined SETUP (
    echo   no Ember_^<version^>_x64-setup.exe found in:
    echo     !BUNDLE_DIR!
    echo     !REPO_DIR!
    echo     %USERPROFILE%\Downloads
    echo(
    if "%ASSUME_YES%"=="1" goto no_setup
    if not exist "%REPO_DIR%\package.json" goto no_setup
    set "ANSWER="
    set /p "ANSWER=  Build one now with npm run dist? [y/N] "
    if /i not "!ANSWER!"=="y" goto no_setup
    call :build
    call :find_setup
)
if not defined SETUP goto no_setup

for %%A in ("!SETUP!") do set "SETUP_NAME=%%~nxA"
echo   installer : !SETUP_NAME!
echo               !SETUP!

rem ---------------------------------------------- find the Electron install(s)
rem electron-builder names its uninstaller "Uninstall <ProductName>.exe"; the
rem Tauri one is a plain "uninstall.exe", which is how the two are told apart.
call :add_candidate "%LOCALAPPDATA%\Programs\Ember\Uninstall Ember.exe"
call :add_candidate "%LOCALAPPDATA%\Programs\ai-usage-widget\Uninstall ai-usage-widget.exe"
call :add_candidate "%ProgramFiles%\Ember\Uninstall Ember.exe"

for %%H in (
    "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall"
    "HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall"
    "HKLM\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
) do (
    for %%N in ("Ember" "ai-usage-widget") do call :scan_hive %%H %%N
)

if "%UN_COUNT%"=="0" (
    echo   electron  : none installed - installing the Tauri build only
) else (
    for /l %%I in (1,1,%UN_COUNT%) do echo   electron  : !UN_%%I!
)

if "%NEED_ADMIN%"=="1" if "%IS_ADMIN%"=="0" (
    echo(
    echo   One of those is a per-machine install, so its uninstaller needs
    echo   elevation. Re-run this script from an administrator prompt.
    set "RC=1"
    goto end
)

rem ------------------------------------------------------------------ confirm
echo(
echo   %APPDATA%\Ember is kept - Ember 2.x migrates settings, usage caches
echo   and the quota ledger out of it on first launch.
if "%ASSUME_YES%"=="0" (
    echo(
    set "ANSWER="
    set /p "ANSWER=  Proceed? [y/N] "
    if /i not "!ANSWER!"=="y" (
        echo   cancelled.
        set "RC=1"
        goto end
    )
)
echo(

rem -------------------------------------------------------------- close Ember
tasklist /fi "imagename eq Ember.exe" 2>nul | findstr /i "Ember.exe" >nul && (
    echo   closing the running Ember...
    taskkill /f /im Ember.exe >nul 2>&1
    call :sleep 3
)

rem ------------------------------------------------------------- back up data
if "%BACKUP%"=="1" if exist "%LEGACY_DATA%" (
    echo   backing up !LEGACY_DATA!\*.json
    if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%" >nul 2>&1
    copy /y "%LEGACY_DATA%\*.json" "%BACKUP_DIR%\" >nul 2>&1
    echo               -^> !BACKUP_DIR!
)

rem ----------------------------------------------------------- uninstall 1.x
if not "%UN_COUNT%"=="0" (
    for /l %%I in (1,1,%UN_COUNT%) do call :uninstall_one "!UN_%%I!"
)

rem --------------------------------------------------------- install the 2.x
echo   installing !SETUP_NAME!...
if "%SILENT%"=="1" (
    start "" /wait "!SETUP!" /S
) else (
    start "" /wait "!SETUP!"
)

set "EMBER_EXE="
call :wait_exists "%LOCALAPPDATA%\Ember\Ember.exe" 60
if exist "%LOCALAPPDATA%\Ember\Ember.exe" set "EMBER_EXE=%LOCALAPPDATA%\Ember\Ember.exe"
if not defined EMBER_EXE if exist "%ProgramFiles%\Ember\Ember.exe" set "EMBER_EXE=%ProgramFiles%\Ember\Ember.exe"

if not defined EMBER_EXE (
    echo   the installer ran, but Ember.exe is not where it was expected
    echo   ^(%LOCALAPPDATA%\Ember^). Check the Start menu shortcut.
    set "RC=1"
    goto end
)

echo   installed : !EMBER_EXE!

if "%LAUNCH%"=="1" (
    echo   launching...
    start "" "!EMBER_EXE!"
)

echo(
echo   Done. First launch carries 1.x settings, usage history and the quota
echo   ledger over from %APPDATA%\Ember.
if "%BACKUP%"=="1" if exist "%BACKUP_DIR%" echo   Backup kept at !BACKUP_DIR!
echo(
goto end

rem ===========================================================================
rem  subroutines
rem ===========================================================================

:build
echo   building ^(npm run dist^)...
pushd "%REPO_DIR%" >nul || exit /b 1
call npm run dist
set "BUILD_RC=!ERRORLEVEL!"
popd >nul
if not "!BUILD_RC!"=="0" echo   build failed ^(exit !BUILD_RC!^)
exit /b 0

rem Newest Ember_<version>_x64-setup.exe wins. The Electron installers are named
rem "Ember Setup 1.4.0.exe", so the underscore pattern cannot pick one up.
:find_setup
for %%D in (
    "%BUNDLE_DIR%"
    "%REPO_DIR%"
    "%USERPROFILE%\Downloads"
) do (
    if not defined SETUP (
        for /f "usebackq delims=" %%F in (`dir /b /a-d /o-d "%%~fD\Ember_*setup.exe" 2^>nul`) do (
            if not defined SETUP set "SETUP=%%~fD\%%F"
        )
    )
)
exit /b 0

rem %1 = an electron-builder uninstaller path; queued when it exists.
:add_candidate
if exist "%~1" (
    set /a UN_COUNT+=1
    set "UN_!UN_COUNT!=%~1"
)
exit /b 0

rem %1 = uninstall hive, %2 = DisplayName to match exactly.
:scan_hive
set "CURKEY="
for /f "usebackq delims=" %%L in (`reg query "%~1" /s /f "%~2" /d /e 2^>nul`) do (
    set "LINE=%%L"
    if /i "!LINE:~0,5!"=="HKEY_" (
        set "CURKEY=!LINE!"
    ) else (
        if not "!LINE:DisplayName=!"=="!LINE!" (
            if defined CURKEY call :from_key "!CURKEY!"
        )
    )
)
exit /b 0

rem %1 = uninstall registry key. Queues its UninstallString when it looks like
rem an electron-builder uninstaller ("...\Uninstall <ProductName>.exe").
:from_key
set "KEYPATH=%~1"
set "US="
for /f "usebackq tokens=2,*" %%A in (`reg query "!KEYPATH!" /v UninstallString 2^>nul ^| findstr /i "REG_"`) do set "US=%%B"
if not defined US exit /b 0
call :dequote US !US!
if not exist "!US!" exit /b 0
if "!US:\Uninstall =!"=="!US!" exit /b 0
set /a UN_COUNT+=1
set "UN_!UN_COUNT!=!US!"
if not "!KEYPATH:HKEY_LOCAL_MACHINE=!"=="!KEYPATH!" set "NEED_ADMIN=1"
exit /b 0

rem %1 = variable name, %2 = value (quotes stripped by %~2).
:dequote
set "%~1=%~2"
exit /b 0

rem %1 = path to an electron-builder uninstaller.
:uninstall_one
set "UNINS=%~1"
if not exist "!UNINS!" exit /b 0
for %%A in ("!UNINS!") do set "UDIR=%%~dpA"
set "UDIR=!UDIR:~0,-1!"
echo   uninstalling !UNINS!
start "" /wait "!UNINS!" /S
rem /S makes the NSIS uninstaller copy itself to %TEMP% and return early, so
rem watch the app payload rather than the process.
call :wait_gone "!UDIR!\resources" 120
if exist "!UDIR!\resources" (
    echo   ^^!^^! app files remain in !UDIR! - the uninstall did not finish
    echo      run "!UNINS!" by hand, then re-run this script
    set "RC=1"
    exit /b 0
)
if exist "!UDIR!" (
    for %%A in ("!UDIR!") do set "UNAME=%%~nxA"
    if /i "!UNAME!"=="Ember" rd /s /q "!UDIR!" 2>nul
    if /i "!UNAME!"=="ai-usage-widget" rd /s /q "!UDIR!" 2>nul
)
echo   removed.
exit /b 0

rem %1 = path, %2 = timeout in seconds.
:wait_gone
for /l %%S in (1,1,%~2) do (
    if not exist "%~1" exit /b 0
    call :sleep 1
)
exit /b 1

rem %1 = path, %2 = timeout in seconds.
:wait_exists
for /l %%S in (1,1,%~2) do (
    if exist "%~1" exit /b 0
    call :sleep 1
)
exit /b 1

rem %1 = seconds. ping, so it also works with no console attached.
:sleep
set /a PINGS=%~1+1
ping -n !PINGS! 127.0.0.1 >nul 2>&1
exit /b 0

:bad_arg
echo   unknown option or missing file: !ARG!
set "RC=2"
goto end

:no_setup
echo   Nothing to install. Pass the setup exe as the first argument, drop it
echo   next to this script, or re-run with /build to compile it.
set "RC=2"
goto end

:usage
echo(
echo   reinstall-ember.bat [installer.exe] [/y] [/build] [/gui] [/nolaunch] [/nobackup]
echo(
echo     installer.exe  explicit path to Ember_^<version^>_x64-setup.exe
echo     /y             no prompts
echo     /build         run "npm run dist" first ^(needs Node + Rust^)
echo     /gui           show the installer wizard instead of installing silently
echo     /nolaunch      do not start Ember afterwards
echo     /nobackup      skip the %%APPDATA%%\Ember\*.json backup
echo(
echo   With no arguments it uses the newest Ember_*setup.exe from
echo   src-tauri\target\release\bundle\nsis, the repo root, or Downloads.
echo(
goto end

:end
endlocal & exit /b %RC%
