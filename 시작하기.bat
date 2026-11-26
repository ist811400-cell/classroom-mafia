@echo off
chcp 65001 > nul
title 교실 마피아 서버
cd /d "%~dp0"

where node > nul 2> nul
if errorlevel 1 (
  echo.
  echo [!] Node.js가 설치되어 있지 않아요.
  echo     https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo 처음 실행이라 필요한 부품을 설치하고 있어요. 잠시만 기다려 주세요...
  call npm install
  if errorlevel 1 (
    echo.
    echo [!] 설치에 실패했어요. 인터넷 연결을 확인하고 다시 실행하세요.
    pause
    exit /b 1
  )
)

rem 서버가 켜지면 선생님 화면이 자동으로 열리고, 학생용 인터넷 주소(터널)도 자동으로 만들어집니다
node server.js
pause
