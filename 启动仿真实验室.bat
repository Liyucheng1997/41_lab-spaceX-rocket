@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动本地服务器：http://localhost:8765/lab/
start "" "http://localhost:8765/lab/"
python lab\tools\serve.py 8765
