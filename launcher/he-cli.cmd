@echo off
rem ============================================================
rem he-cli.cmd - agent-shell (H/E) CLI/TUI launcher (v0.26).
rem NOTE: keep this file pure ASCII. cmd.exe parses batch files
rem in the ANSI/OEM codepage (GBK on zh-CN systems); UTF-8
rem Chinese comments get misread, swallow the CRLF of the line
rem they end on, and turn following lines into bogus commands
rem - a batch syntax error aborts the whole script (skipping
rem the trailing pause), which shows up as an instant
rem flash-close when double-clicked.
rem
rem Double-click friendly: cd to the repo root, then run the
rem TUI via tsx (all args pass through). Without ARK_KEY or
rem providers.json it auto-falls back to the mock LLM (scripted
rem conversation, full approval loop demo). First run asks for
rem the workspace directory (it must already exist).
rem
rem Manual equivalent (repo root): npx tsx cli/main.ts --workdir <path>
rem ============================================================
cd /d "%~dp0.."
npx tsx cli/main.ts %*
pause
