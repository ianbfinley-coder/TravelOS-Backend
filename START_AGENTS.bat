@echo off
REM TravelOS AI Agent Startup Script
REM This script will:
REM 1. Update .env.local with COST_ALERT_THRESHOLD
REM 2. Start the server with all 10 agents

cd /d "C:\Users\ianbf\Documents\TravelOS"

echo.
echo ========================================
echo 🚀 TravelOS AI Agent Startup
echo ========================================
echo.

REM Update .env.local if needed
echo Configuring environment...
powershell -NoProfile -Command ^
    "$envPath='C:\Users\ianbf\Documents\TravelOS\.env.local'; " ^
    "if (Test-Path $envPath) { " ^
    "  $content = Get-Content $envPath -Raw; " ^
    "  if ($content -notmatch 'COST_ALERT_THRESHOLD') { " ^
    "    Add-Content $envPath \"`n# Cost Optimization Agents`nCOST_ALERT_THRESHOLD=500\"; " ^
    "    Write-Host '✅ Added COST_ALERT_THRESHOLD to .env.local'; " ^
    "  } else { Write-Host '✅ COST_ALERT_THRESHOLD already configured'; } " ^
    "} else { " ^
    "  '# TravelOS Environment Configuration' | Out-File $envPath -Encoding UTF8; " ^
    "  '# Cost Optimization Agents' | Add-Content $envPath; " ^
    "  'COST_ALERT_THRESHOLD=500' | Add-Content $envPath; " ^
    "  Write-Host '✅ Created .env.local with COST_ALERT_THRESHOLD=500'; " ^
    "}"

echo.
echo ========================================
echo 📦 Starting server with agents...
echo ========================================
echo.

npm run dev

pause
