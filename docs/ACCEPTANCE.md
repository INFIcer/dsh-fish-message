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

## 4. 入站语音（只落盘，不转写）

用主人 QQ 发一条 2–5 秒语音，说：

```text
这是语音验收。
```

期望 DSH 会话收到的是**路径 + 时长**，不是文字：

```text
（语音：C:\Users\<你>\.dsh\fish-message-inbox\qq-voice-xxx.wav，3.2 秒）
```

同时：

- `<家目录>\fish-message-inbox\qq-voice-*` 有原文件；
- 日志里**没有** `/asr`、没有声纹相关记录；
- 想验证「不调网络」：断掉本地 AI 服务（7880）再发一条，这条消息仍应正常落到会话；
- 时长读不出来时只显示 `（语音：<路径>）`，不影响消息投递。

需要识别 / 声纹时用 ops：

```text
fish_voice_note_analyze(qq="<主人QQ>")
```

---

## 5. 出站语音

### 5.1 `[语音]文字[/语音]`：应被拒绝（TTS 已移走）

在 DSH 会话里发：

```text
[QQ][语音]【验收 3】这是 DSH 发出来的语音。[/语音][/QQ]
```

期望：

- **QQ 什么也收不到**（不合成、不发文字、不发语音）；
- 日志/状态里能看到 `code: 'tts_moved_to_ops'`，提示改用 `fish_say_and_send`；
- `fish-message.log` 有对应 warn，不产生新的出站队列条目。

### 5.2 合成并发送（现在走 ops）

在 DSH 里调：

```text
fish_say_and_send(text="【验收 3】这是 DSH 发出来的语音。")
```

期望：

- QQ 收到一条语音条，点开是 TTS 声音；
- 返回 `{ok:true, wavPath, qq, sent|queued, pending}`；
- 失败时按 `fish.message` 的出站队列语义入队（`queued:true`）。

### 5.3 `[语音:路径]`：照常发已有音频

先在会话里拿到一个存在的 wav 路径，再发：

```text
[QQ][语音:D:\audio\a.wav][/QQ]
```

- QQ 收到语音条；
- 文件不存在时该条入队，补发时判死并记「语音文件不存在」。

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

### 9.2 语音（已解耦，不再有 test-voice）

鱼讯不再提供 `/dsh-fish-message/test-voice`，也没有 `record_text` 补发。
验证解耦：

```powershell
# 1) 设置页「鱼讯」里应看不到「入站语音转写 / 出站语音合成 / TTS 地址 / ASR 地址」等区块
# 2) 旧 config.json 里如果残留 ttsVoice 等键，加载后会被静默清掉（文件仍在）
Get-Content "$env:USERPROFILE\.dsh\fish-message-config.json" -Raw
# 3) 发一条语音：会话应收到「（语音：<路径>，N 秒）」
```

`[语音]文字[/语音]` 现在返回 `tts_moved_to_ops`，不会入队；要发合成语音请用
`fish_say_and_send`。

### 9.3 设置页

- 「出站队列」卡片显示「出站积压 N 条 / 最老 X 秒」，有「立即补发」「清空」；
- 点「保存设置」只提示保存/重连，没有额外能力探测提示。

### 9.4 表情包（本轮新增）

1. 设置页「表情包」分区显示统计（条数 / 占用 MB / 上限）、搜索框、标签筛选、排序；
2. 点「从默认表情库导入」→ 应提示新增 8 条（`D:\dsh_ws\表情库` 现有 8 条），再点一次应全部合并、不重复；
3. 上传一张 GIF + 一张 PNG（多选）→ 网格出现两张，GIF 预览会动；再传同一张应只合并标签、不新增；
4. 拿到某条表情的文件名，在 DSH 里发 `[QQ][表情:文件名][/QQ]` → QQ 收到动图，设置页该条「用 N 次」+1；
5. 发 `[QQ][表情:根本没有这个][/QQ]` → 当前 DSH 会话收到「找不到表情」提示，日志有记录；
6. 最近收到的图片：用主人 QQ 发一张图 → 设置页「最近收到的图片」出现，可填标签后「存为表情」；
7. 取图防穿越：`GET /dsh-fish-message/stickers/file?path=../../secret.png` 应返回 403；
8. 清理：「删未使用」只删 `used_count=0` 的条目；「去重」后同 sha 只留一条；「清空最近图片」只删 `qq-image-*`。

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

- 全部 93 项单测 + mock 集成测试通过；
- 出站队列：落盘/重启恢复、fingerprint 去重、TTL、1000 条上限、退避/20 次放弃、
  离线入队→恢复补发、路径失效丢弃、队列接口；
- 解耦：入站语音只落盘并递路径（有 fetch 调用计数断言）、`[语音]文字` 返回
  `tts_moved_to_ops` 且不发消息、`[语音:路径]` 照常发、旧 ASR/TTS 配置字段被静默清理；
- 真实 NapCat `send_private_msg` 文字 1 条，已回读历史确认；
- 真实 NapCat 的 `get_friend_msg_history`、`get_login_info` 均验证。

### 留给父 agent（需要重启 DSH / 用主人 QQ 发消息）

- 重启 DSH，确认设置页「鱼讯」里 ASR/TTS 区块消失；
- 按第 9 节做「出站队列断网→恢复补发」真机验收；
- 主人 QQ → DSH 文字；
- 主人 QQ → DSH 语音：会话应收到「语音：路径」而不是转写；
- DSH 里调 `fish_say_and_send` → QQ 真收到语音；
- DSH → QQ `[语音]文字[/语音]` → 返回 `tts_moved_to_ops`，QQ 无消息；
- DSH → QQ `[语音:路径]` → 收到语音条；
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

