# dsh-fish-message · DSH 重启薄包装
#
# ⚠️ 这个脚本会结束所有 DeepSeek Harness 进程，然后重新拉起，并塞一条唤醒事件。
#    如果你正在 DSH 会话里跑，执行它 = 杀掉自己。让父 agent / 另一个终端执行。
#
# 真正的逻辑复用 C:\Users\Administrator\.dsh\_restart\dsh-restart.ps1（不改它），
# 这里只把参数默认值换成 dsh-fish-message 验收需要的。

param(
  [string]$SessionId = $env:DSH_SESSION_ID,
  [string]$WakeText = '【dsh-fish-message 已启用】检查 /dsh-fish-message/health，并按 docs/ACCEPTANCE.md 做真机验收。',
  [int]$DelaySeconds = 15,
  [int]$WakeAfterSeconds = 45
)

$ErrorActionPreference = 'Stop'
$inner = 'C:\Users\Administrator\.dsh\_restart\dsh-restart.ps1'

if (-not (Test-Path -LiteralPath $inner)) {
  throw "找不到重启脚本：$inner"
}

Write-Host '⚠️ 即将结束所有 DeepSeek Harness 进程并重新拉起。' -ForegroundColor Yellow
Write-Host '   如果你就在 DSH 里，这一下会杀掉当前会话。' -ForegroundColor Yellow
Write-Host "   目标会话：$SessionId"
Write-Host "   唤醒文案：$WakeText"
Write-Host ''

& pwsh -NoProfile -File $inner `
  -SessionId $SessionId `
  -WakeText $WakeText `
  -DelaySeconds $DelaySeconds `
  -WakeAfterSeconds $WakeAfterSeconds

exit $LASTEXITCODE
