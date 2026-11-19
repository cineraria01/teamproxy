@echo off
rem teamclaude for Windows (cineraria01/teamproxy). Install and use: docs/install/INSTALL-ALL.md section 9-5.
rem Runs src\teamclaude-win32.js from this checkout with node on PATH. Argument rule (as the sh wrapper):
rem no args or -options open Claude Code, -- passes a Claude subcommand, any other word is a teamclaude command.
setlocal
set "TEAMCLAUDE_CONFIG=%USERPROFILE%\.config\teamclaude.json"
rem One line: cmd re-reads this file after node returns, and git pull may have rewritten it meanwhile.
node "%~dp0..\..\src\teamclaude-win32.js" %* & exit /b
