@echo off
cd /d "C:\Users\PRIMA\agy-integration-hub\agy-project-manager"
node server.js >> "%~dp0server.log" 2>&1
