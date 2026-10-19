@echo off
chcp 65001 >nul
setlocal
set "HERE=%~dp0"
set "PYEXE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\pythonw.exe"
if not exist "%PYEXE%" set "PYEXE=pythonw"
start "" "%PYEXE%" "%HERE%app.py"
exit /b 0
