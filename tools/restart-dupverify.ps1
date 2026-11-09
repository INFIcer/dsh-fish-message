# 重启 DSH 让 dsh-fish-message 的重复发送修复生效；唤醒后自检并做一次多段回复验证
$ErrorActionPreference = 'Continue'
$inner = 'C:\Users\Administrator\.dsh\_restart\dsh-restart.ps1'
if (-not (Test-Path -LiteralPath $inner)) { throw "找不到重启脚本：$inner" }

$wake = @'
【dsh-fish-message 重复发送修复已生效】DSH 已重启完成。请做验证：
1) curl 本机 /dsh-fish-message/health 与 /state（端口用当前 DSH_WEB_URL），确认 ok、version、outbox pending 0；
2) 看 C:\Users\Administrator\.dsh\fish-message.log 最近 20 行，确认启动正常、无异常；
3) 用 [QQ] 块在 QQ 里发给主人一条**分三段**的消息（每段之间空一行），告诉他这是重复发送修复的验证：正常应该只收到 1 条完整消息，不会再把后几段单独重发；
4) 然后等他回复确认，若还有重复则检查日志里的「合并 N 段 → 发出 X 字」与「跳过重复发送」记录，并在块外记录排查结论。
'@

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $inner `
  -SessionId 'session-a3e56af2-2285-44e6-b32d-863efb9e7d8b' `
  -WakeText $wake `
  -DelaySeconds 20 `
  -WakeAfterSeconds 45
