@echo off
setlocal DisableDelayedExpansion
pushd "%~dp0" || exit /b 1
where.exe node.exe >nul 2>&1
if errorlevel 1 goto missing_node
node.exe bridge.js %*
set "bridge_exit=%errorlevel%"
popd
if not "%bridge_exit%"=="0" pause
exit /b %bridge_exit%

:missing_node
echo Node.js 22 or later is required. https://nodejs.org/
popd
pause
exit /b 1
