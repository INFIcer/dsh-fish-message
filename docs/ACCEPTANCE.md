# 真机验收清单

> 前提：NapCat 在 `http://127.0.0.1:3000`，机器人 QQ `2983830957`，主人 QQ `1696117435`；
> 本地 AI 服务在 `http://127.0.0.1:7880`；DSH profile 是 `desktop`。
>
> **重启 DSH 会杀掉正在跑这个会话的进程。** 如果当前 agent 就在 DSH 里，
> 它只能交付到「可验收状态」，最后的重启和验收由父 agent / 另一个终端执行。

---

## 0. 装机前检查

```powershell
# NapCat 活着
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3000/get_login_info' `
  -ContentType 'application/json' -Body '{}' | ConvertTo-Json -Depth 5

# 本地 AI 活着
Invoke-RestMethod 'http://127.0.0.1:7880/health' | ConvertTo-Json -Depth 4

# 测试全绿
cd E:\dsh-fish-message
npm test
```

期望：`get_login_info` 返回 `user_id=2983830957`；`/health` 返回 `ok=true`；
测试 46 项全部 pass。

---

## 1. 安装 / 启用

```powershell
$profileDir = 'C:\Users\Administrator\.dsh\profiles\desktop'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item "$profileDir\package.json" "$profileDir\package.json.bak-fish-message-$stamp"
Copy-Item "$profileDir\cordis.patch.yml" "$profileDir\cordis.patch.yml.bak-fish-message-$stamp"

dsh plugin --profile desktop add E:\dsh-fish-message

# 从 dsh.profile.bundles 删掉 dsh-qq-bridge（保留 dependencies 里的旧桥，方便回滚）
notepad "$profileDir\package.json"
```

确认 `dsh.profile.bundles` 里：

- 有 `dsh-fish-message`；
- 没有 `dsh-qq-bridge`；
- `dependencies` 里仍然有 `dsh-qq-bridge`（回滚用，不加载）。

---

## 2. 重启并确认加载

**在另一个终端 / 父 agent 执行：**

```powershell
pwsh -NoProfile -File C:\Users\Administrator\.dsh\_restart\dsh-restart.ps1 `
  -SessionId session-a3e56af2-2285-44e6-b32d-863efb9e7d8b `
  -WakeText '【dsh-fish-message 已启用】检查 /dsh-fish-message/health，并按 docs/ACCEPTANCE.md 做真机验收。'
```

重启后：

```powershell
# DSH 的 Web 端口不固定，先从进程实际监听里找；下面以 2968 为例
Invoke-RestMethod 'http://127.0.0.1:2968/dsh-fish-message/health' | ConvertTo-Json -Depth 6
Invoke-RestMethod 'http://127.0.0.1:2968/dsh-fish-message/state' | ConvertTo-Json -Depth 8
```

期望：

- `health.ok = true`；
- `health.transport.connected = true` 或 `transport.mode = "http"`（WS 关闭/连不上时）；
- `state.bindings[0].qq = "1696117435"`；
- `state.bindings[0].活着 = true`；
- `state.config.onlyInsideMarkers = true`；
- 日志里没有 `桥启动失败`。

> 设置页：**DSH 设置 → 鱼讯 QQ**。如果设置页没出现，先看
> `%USERPROFILE%\.dsh\fish-message.log`，再确认 `client.js` 的 `dsh.client.inject`。

---

## 3. 私聊文字双向

### DSH → QQ

在绑定的 DSH 会话里发一轮带块的回复：

```text
这句留本地。

[QQ]【验收 1】DSH → QQ 文字通了。[/QQ]
```

期望：

- QQ 私聊只收到 `【验收 1】DSH → QQ 文字通了。`；
- DSH 会话里仍保留完整两句；
- `state.stats.delivered` 不是这个方向（入站才计），但 `fish-message.log` 有「DSH → QQ」记录。

### QQ → DSH

用主人 QQ 给机器人发：

```text
【验收 2】QQ → DSH 文字通了。
```

期望：

- DSH 会话里出现 `【验收 2】QQ → DSH 文字通了。`；
- `state.bridge.stats.delivered` 增加；
- `state.bridge.watermarks["1696117435"].timestamp` 前进。

---

## 4. 入站语音转写

用主人 QQ 发一条 2–5 秒语音，说：

```text
这是语音验收。
```

期望 DSH 会话收到类似：

```text
（语音｜声纹：主人）这是语音验收。
```

同时：

- `<家目录>\fish-message-inbox\qq-voice-*.wav` 有原文件；
- `state.bridge.stats.lastError` 为空；
- 如果声纹没登记，会显示 `（语音｜声纹：未知-1）…`，文字仍应正确。

如果失败：

```powershell
Invoke-RestMethod 'http://127.0.0.1:7880/asr/status' | ConvertTo-Json -Depth 4
Get-Content "$env:USERPROFILE\.dsh\fish-message.log" -Tail 80
```

---

## 5. 出站语音

在 DSH 会话里发：

```text
[QQ][语音]【验收 3】这是 DSH 发出来的语音。[/语音][/QQ]
```

期望：

- QQ 收到一条语音条，点开是 TTS 声音；
- 不是文件，不是文字；
- `fish-message.log` 有「已发语音到 QQ」；
- 第一次可能等 30–70 秒（TTS 模型加载），设置页显示「正在合成…」是正常的。

失败时：

- 会话里会出现 `（dsh-fish-message）语音发送失败：…`；
- 看 `state.bridge.stats.lastError`；
- 确认 `/voices` 里有 `dafeiyu`：
  `Invoke-RestMethod 'http://127.0.0.1:7880/voices' | ConvertTo-Json -Depth 5`。

---

## 6. 转义发送字面量 `[/QQ]`

在 DSH 会话里发：

```text
[QQ]【验收 4】字面量 A 和 B 都该原样出现。[/QQ]
```

把上面块里的 `A` 换成 `\[\/QQ]`，`B` 换成 `\[QQ]`（两个 token 都放在块内，
不要加空格；参见 `docs/FORMAT.md` 第 4.3 节）。

期望 QQ 收到：

```text
【验收 4】字面量 [/QQ] 和 [QQ] 都该原样出现。
```

如果 QQ 只收到前半句，说明 `[/QQ]` 没转义，块提前结束了。

---

## 7. 离线补投（关键）

目的：机器人/NapCat 没启动期间主人发的消息，重启后能从历史补齐。

步骤：

1. 先确认插件在跑、水位已落盘；
2. **停掉 NapCat**（不是停 DSH）；
3. 用主人 QQ 给机器人发 2 条：
   ```text
   【离线 1】这条是机器人离线时发的。
   【离线 2】这条也是。
   ```
4. 等 10 秒；
5. **启动 NapCat**，确认 `get_login_info` 恢复；
6. 等最多 60 秒（或点设置页「刷新」触发状态；插件每 60 秒拉一次历史）；
7. 观察 DSH 会话。

期望：

- 两条消息按原顺序进入 DSH（先 `离线 1`，再 `离线 2`）；
- 不重复；
- `state.bridge.watermarks["1696117435"]` 前进到最新；
- 日志有「QQ … → DSH」两条。

如果只看到一条：看 `fish-message.log` 是否有 followup 失败；会话没开时不会推进水位，下一轮会重试。

### 超过窗口的摘要（可选）

把 `backfillWindowHours` 临时改成 `1`，构造一条 2 小时前的历史（测试环境可用 mock；
真机不好构造），期望只收到：

```text
（离线补投摘要）机器人离线期间有 N 条消息，超过 1 小时补投窗口，已跳过。
```

---

## 8. 图片（可选）

DSH → QQ：

```text
[QQ]【验收 5】[图片:C:\pics\test.png][/QQ]
```

QQ → DSH：主人发一张图，期望会话收到图片附件；纯文本模型至少能在文字里看到本地路径。

---

## 9. 出站队列（本轮新增）

### 9.1 断网入队 → 恢复补发

```powershell
$base = 'http://127.0.0.1:8519'   # 换成重启后实际端口

# 1) 停掉 NapCat（或把 napcatBaseUrl 改到一个关闭的端口并保存）
# 2) 发一条测试文字；离线时应入队而不是丢掉
Invoke-RestMethod -Method Post -Uri "$base/dsh-fish-message/test-send" `
  -ContentType 'application/json' -Body '{}'
# 期望：queued=true、pending >= 1

# 3) 看队列
Invoke-RestMethod "$base/dsh-fish-message/outbox?limit=10" | ConvertTo-Json -Depth 8
Invoke-RestMethod "$base/dsh-fish-message/state" | Select-Object -ExpandProperty bridge |
  Select-Object -ExpandProperty outbox | ConvertTo-Json -Depth 4

# 4) 恢复 NapCat，手动补发
Invoke-RestMethod -Method Post -Uri "$base/dsh-fish-message/outbox/flush" | ConvertTo-Json
# 期望：sent >= 1、pending=0；QQ 收到测试文字
```

日志里应出现：`补发成功（积压 N 条，延迟 X 秒）`。

### 9.2 语音文本重合成

```powershell
Invoke-RestMethod -Method Post -Uri "$base/dsh-fish-message/test-voice" `
  -ContentType 'application/json' -Body '{}'
```

断网时期望：`queued=true`；`fish-message-outbox.json` 里该条是
`record_text`（文字），没有 base64 音频；恢复后补发会重新调 `/tts`。
注意：同样文案 10 分钟内会被去重；重复验收前先清空队列或等过去重窗口。

### 9.3 设置页

- 「出站队列」卡片显示「出站积压 N 条 / 最老 X 秒」，有「立即补发」「清空」；
- 点「保存设置」只提示保存/重连，没有额外能力探测提示。

---

## 10. 禁用旧桥 / 回滚

### 确认旧桥没在跑

- `dsh.profile.bundles` 里没有 `dsh-qq-bridge`；
- DSH 重启后日志里没有 `qq-bridge: 已装好`；
- `~/.dsh/qq-bridge-config.json` 和 `qq-bridge-state.json` 还在（没被改）。

### 回滚

```powershell
$profileDir = 'C:\Users\Administrator\.dsh\profiles\desktop'
notepad "$profileDir\package.json"
```

- 从 `dsh.profile.bundles` 删 `dsh-fish-message`；
- 把 `dsh-qq-bridge` 加回去；
- 重启 DSH。

旧桥配置/状态文件全程保留，回滚后直接继续用。

---

## 11. 本轮已做 / 留给父 agent

### 已做（不依赖 DSH 重载）

- 全部 46 项单测 + mock 集成测试通过（新增出站队列 12 项）；
- 出站队列：落盘/重启恢复、fingerprint 去重、TTL、1000 条上限、退避/20 次放弃、
  离线入队→恢复补发、语音文本重合成、路径失效丢弃、队列接口；
- 真实 NapCat `send_private_msg` 文字 1 条，已回读历史确认；
- 真实 `/tts` 合成 `dafeiyu` 语音，真实 `record` 段发送 1 条，已回读历史确认；
- 真实 `get_record` 拿到 wav，真实 `/asr?speaker=1` 转写回 `这是一条测试语音。`；
- 真实 NapCat 的 `get_friend_msg_history`、`get_login_info` 均验证。

### 留给父 agent（需要重启 DSH / 用主人 QQ 发消息）

- 把插件装进 profile 并重启 DSH（本 agent 在 DSH 内，不能自己杀自己）；
- 按第 9 节做「出站队列断网→恢复补发」「语音文本重合成」真机验收；
- 主人 QQ → DSH 文字；
- 主人 QQ → DSH 语音（声纹名）；
- DSH → QQ `[语音]…[/语音]`；
- DSH → QQ 字面量 `[/QQ]`；
- 停 NapCat → 主人发 2 条 → 启动 NapCat → 补投；
- 可选：图片双向、`[文件:…]`。

---

## 12. 快速排障

```powershell
# 端口不固定，找 DSH 监听
$pids = @(Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
Get-NetTCPConnection -State Listen | Where-Object { $pids -contains $_.OwningProcess } |
  Select-Object LocalAddress,LocalPort,OwningProcess

# 日志
Get-Content "$env:USERPROFILE\.dsh\fish-message.log" -Tail 120

# 状态
Invoke-RestMethod 'http://127.0.0.1:2968/dsh-fish-message/state' | ConvertTo-Json -Depth 8

# 旧桥文件是否原样
Get-Item "$env:USERPROFILE\.dsh\qq-bridge-config.json","$env:USERPROFILE\.dsh\qq-bridge-state.json" |
  Select-Object Name,Length,LastWriteTime
```

