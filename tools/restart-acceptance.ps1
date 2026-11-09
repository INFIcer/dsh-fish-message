# dsh-fish-message 验收用重启：关掉 DSH → 重启 → 塞唤醒事件 → 唤醒后自检
$ErrorActionPreference = 'Continue'
$inner = 'C:\Users\Administrator\.dsh\_restart\dsh-restart.ps1'
if (-not (Test-Path -LiteralPath $inner)) { throw "找不到重启脚本：$inner" }

$wake = @'
【dsh-fish-message 已启用】DSH 已重启完成。请做验收：
1) curl 本机 /dsh-fish-message/health 与 /state（端口用当前 DSH_WEB_URL），确认 version 0.1.0、transport mode、绑定 1 条、queue 0、outbox.pending 0；
2) GET /dsh-fish-message/outbox?limit=10 与 /state，确认出站队列统计字段齐全、pending 与设置页一致；
3) 停 NapCat → POST /test-send（应返回 queued=true）→ POST /test-voice（应返回 queued=true，队列里是 record_text）→ 启动 NapCat → POST /outbox/flush，确认按顺序补发、各一次；
4) 看 C:\Users\Administrator\.dsh\fish-message.log 最近 30 行有无异常，确认出现「补发成功（积压 N 条，延迟 X 秒）」；
5) 确认 /dsh-qq-bridge/* 返回 404（旧桥已下线）；
6) 在浏览器设置里确认「设置 → 鱼讯 QQ」页存在，出站队列卡片（积压/最老/立即补发/清空）正常；
7) 用 [QQ] 块回一条带转义字面量的消息（正文里含 \[/QQ] 字面量），并在 QQ 里向主人汇报：验收结果、请主人发一条文字和一条 2~5 秒语音做双向测试。
'@

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $inner `
  -SessionId 'session-a3e56af2-2285-44e6-b32d-863efb9e7d8b' `
  -WakeText $wake `
  -DelaySeconds 12 `
  -WakeAfterSeconds 45
