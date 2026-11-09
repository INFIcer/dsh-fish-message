# 重启 DSH 让 dsh-fish-message 出站队列生效；唤醒后做一次自检并在 QQ 里约验收
$ErrorActionPreference = 'Continue'
$inner = 'C:\Users\Administrator\.dsh\_restart\dsh-restart.ps1'
if (-not (Test-Path -LiteralPath $inner)) { throw "找不到重启脚本：$inner" }

$wake = @'
【dsh-fish-message 出站队列已上线】DSH 已重启完成。请做自检：
1) curl 本机 /dsh-fish-message/health：确认 ok、version 0.1.0、outboxPending 字段存在；再 GET /dsh-fish-message/outbox?limit=5 与 /state，确认 outbox 统计（pending/oldestAgeSec/sentTotal/failedTotal/droppedTotal）齐全；
2) 看 C:\Users\Administrator\.dsh\fish-message.log 最近 30 行有无异常；确认 /dsh-qq-bridge/* 仍是 404；
3) 用 [QQ] 块在 QQ 里汇报：出站队列已生效、当前积压 0 条；然后请主人做手动验收——他**手动关掉 QQ 机器人**后回一句「关了」，我再用 /test-send 发 2 条（应返回 queued=true、pending 变成 1→2），等他**手动重开机器人**并说一声，我再 POST /outbox/flush 并把补发结果（条数、顺序、延迟）汇报给他。注意：机器人启停一律由主人手动操作，不要用程序停/起 NapCat。
'@

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $inner `
  -SessionId 'session-a3e56af2-2285-44e6-b32d-863efb9e7d8b' `
  -WakeText $wake `
  -DelaySeconds 25 `
  -WakeAfterSeconds 45
