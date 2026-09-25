# ==============================================================
#  Download every deployed edge function into supabase/functions/
#
#  Asks Supabase for the live function list rather than using a
#  hardcoded one, so it stays correct as functions are added or
#  removed. Re-run any time to re-sync.
#
#  Does NOT need Docker (the CLI warns and continues).
#  Overwrites local copies with what is actually deployed -- that
#  is the point: the repo should match production, not the other way.
#
#  Usage, from the repo root:
#      powershell -ExecutionPolicy Bypass -File supabase\download-all-functions.ps1
# ==============================================================

$ErrorActionPreference = 'Continue'
Set-Location (Join-Path $PSScriptRoot '..')

Write-Host "Asking Supabase for the deployed function list..." -ForegroundColor Cyan
$raw = npx supabase functions list --output json 2>$null
if (-not $raw) { Write-Host "Could not list functions. Are you linked? Try: npx supabase link --project-ref cyrgzvnjvevwbjqxgfxd" -ForegroundColor Red; exit 1 }

$fns = $raw | ConvertFrom-Json
$slugs = $fns | Where-Object { $_.status -eq 'ACTIVE' } | ForEach-Object { $_.slug } | Sort-Object
Write-Host ("Found {0} active functions." -f $slugs.Count) -ForegroundColor Cyan

$ok = @(); $failed = @(); $i = 0
foreach ($slug in $slugs) {
    $i++
    Write-Host ("[{0}/{1}] {2}" -f $i, $slugs.Count, $slug) -ForegroundColor Yellow
    npx supabase functions download $slug 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { $ok += $slug } else { $failed += $slug; Write-Host "   FAILED" -ForegroundColor Red }
}

Write-Host ""
Write-Host ("Downloaded {0} of {1}." -f $ok.Count, $slugs.Count) -ForegroundColor Green
if ($failed.Count) {
    Write-Host "Failed:" -ForegroundColor Red
    $failed | ForEach-Object { Write-Host "   $_" -ForegroundColor Red }
    Write-Host "Re-run the script to retry, or download those individually." -ForegroundColor Red
}
Write-Host ""
Write-Host "Review before committing:  git status --short supabase/functions/" -ForegroundColor Cyan
