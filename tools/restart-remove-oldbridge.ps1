# 重启以卸载旧 QQ 桥（dsh-qq-bridge）与第三方 TTS 插件，只保留 dsh-fish-message
$ErrorActionPreference = 'Continue'
$inner = 'C:\Users\Administrator\.dsh\_restart\dsh-restart.ps1'
if (-not (Test-Path -LiteralPath $inner)) { throw "找不到重启脚本：$inner" }

$wake = @'
【旧桥已从 bundles 移除】DSH 已重启。请验证重复发送是否消失：
1) curl 本机 /dsh-fish-message/health 与 /state（当前 DSH 端口），确认 ok、outbox pending 0；
2) 确认旧桥路由已 404：/dsh-qq-bridge/state；确认 bundles 里已没有 dsh-qq-bridge 与 @memef1f1y/dsh-plugin-tts；
3) 看 ~/.dsh/fish-message.log 最近 20 行：应有且只有一份「桥已启动」，出站每次只有一条「已发 QQ 私聊」；
4) 在 QQ 里用 [QQ] 块发一条**分三段**的消息给主人，说明：重复的根因是旧桥插件又被重新激活、两个插件在同时发；现已只保留 dsh-fish-message，请他确认这次是否只收到一条完整消息；
5) 若还有重复：用 get_friend_msg_history 对比消息条数与日志里的发送次数，记录到块外。
'@

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $inner `
  -SessionId 'session-a3e56af2-2285-44e6-b32d-863efb9e7d8b' `
  -WakeText $wake `
  -DelaySeconds 20 `
  -WakeAfterSeconds 45
