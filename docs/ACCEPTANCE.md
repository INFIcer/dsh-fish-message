# 真机验收清单

> 前提：NapCat 在 `http://127.0.0.1:3000`，机器人 QQ `2983830957`，主人 QQ `1696117435`；
> 本地 AI 服务在 `http://127.0.0.1:7880`；DSH profile 是 `desktop`。
>
> **重新加载 DSH 插件会杀掉正在跑这个会话的进程。** 如果当前 agent 就在 DSH 里，
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
`npm test` 全绿。

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
- `state.bindings[0].alive = true`（旧键名 `活着` 仍会一并下发，兼容老前端）；
- `state.config.onlyInsideMarkers = true`；
- 日志里没有 `桥启动失败`。

> 设置页：**DSH 设置 → 鱼讯**。如果设置页没出现，先看
> `%USERPROFILE%\.dsh\fish-message.log`，再确认 `client.js` 的 `dsh.client.inject`。

---

## 3. 私聊文字双向

### 3.0 送信渠道（先读这条）

回复发到哪条渠道是**粘性**的，只有两种事改变它：

- 收到渠道消息：QQ 私聊来消息 → 之后的回合都回 QQ；微信私聊来消息 → 改回微信；
- 你在 DSH 网页端（Web GUI）直接发消息：清空，之后不再往任何渠道发，直到渠道里再来消息。

定时提醒、重启通知、子代理消息、上下文注入都不改变它；重启 DSH 也照旧保持（记在状态文件
`fish-message-state.json` 的 `replyTargets` 里）。余额提醒（fish-token）也发到这条渠道；
一条渠道都没有时直接跳过，不会发到别的对端。

所以下面所有「DSH → QQ / 微信」的验收，都要**在一条渠道消息触发的那一轮里**写 `[MSG]`：
先给机器人发一条私聊，等它回话，在它回话的那一轮里带上块；不要在网页端起头。

### DSH → QQ

先用主人 QQ 给机器人发一条私聊（随便一句，例如 `【验收 1】开始`），在它触发的那一轮里
回复下面这段：

```text
这句留本地。

[MSG]【验收 1】DSH → QQ 文字通了。[/MSG]
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

## 4. 入站语音（落盘 + 可选分析）

用主人 QQ 发一条 2–5 秒语音，说：

```text
这是语音验收。
```

期望 DSH 会话收到**一行**路径 + 时长；本地 AI 可用且开启分析时，同一行后面跟情感、背景音和转写（有哪项写哪项）：

```text
（语音：C:\Users\<你>\.dsh\fish-message-inbox\qq-voice-xxx.wav，3.2 秒；情感：中性；转写：这是语音验收。）
```

上游没给情绪或事件时，「情感」「背景」整段省略，消息与旧版一致。声纹身份不在鱼讯：谁在说话由记忆层判断。

同时：

- `<家目录>\fish-message-inbox\qq-voice-*` 有原文件；
- 分析关掉、或本地 AI 插件没装/没启动时，只收到路径那行，消息不丢；
- 日志里能看到分析失败的原因，但不会刷屏；
- 时长读不出来时只显示 `（语音：<路径>）`，不影响消息投递。

---

## 5. 出站语音

### 5.1 `[语音]文字[/语音]`：本地 AI 正常时合成并发送

在由 QQ 私聊触发的那一轮里回复（见 3.0）：

```text
[MSG][语音]【验收 3】这是 DSH 发出来的语音。[/语音][/MSG]
```

期望：

- QQ 收到一条语音条，点开是 TTS 声音；
- 音色、语速取设置页「本地 AI 服务」里的「发送语音音色 / 发送语音语速」；
- `fish-message.log` 有对应记录，不产生出站队列条目。

### 5.2 本地 AI 不可用时：只提示，不刷屏

停掉本地 AI 插件（或禁用语音能力）后再发同样一句。期望：

- QQ 什么也收不到（不合成、不发文字、不发语音）；
- 当前 DSH 会话收到一句「本地 AI 插件没装或没启动，暂时发不了语音，其它功能不受影响」；
- 返回 `code: 'service_not_installed'`（能力缺失时是对应原因码），不抛原始错误；
- 同一轮里的文字/图片/表情照常发。

### 5.3 `[语音:路径]`：照常发已有音频

先在会话里拿到一个存在的 wav 路径，再发：

```text
[MSG][语音:D:\audio\a.wav][/MSG]
```

- QQ 收到语音条；
- 文件不存在时该条入队，补发时判死并记「语音文件不存在」。

---

## 6. 转义发送字面量 `[/MSG]`

在由 QQ 私聊触发的那一轮里回复（见 3.0）：

```text
[MSG]【验收 4】字面量 A 和 B 都该原样出现。[/MSG]
```

把上面块里的 `A` 换成 `\[\/MSG]`，`B` 换成 `\[MSG]`（两个 token 都放在块内，
不要加空格；参见 `docs/FORMAT.md` 第 4.3 节）。

期望 QQ 收到：

```text
【验收 4】字面量 [/MSG] 和 [MSG] 都该原样出现。
```

如果 QQ 只收到前半句，说明 `[/MSG]` 没转义，块提前结束了。

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
6. 等最多 60 秒（或点设置页「刷新状态」触发状态；插件每 60 秒拉一次历史）；
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

DSH → QQ（同样要在 QQ 私聊触发的那一轮里回复，见 3.0）：

```text
[MSG]【验收 5】[图片:C:\pics\test.png][/MSG]
```

QQ → DSH：主人发一张图，期望会话收到图片附件；纯文本模型至少能在文字里看到本地路径。

---

## 9. 出站队列

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

### 9.2 语音（可选本地 AI，不再有 test-voice）

鱼讯不再提供 `/dsh-fish-message/test-voice`，也没有 `record_text` 补发。
验证可选扩展：

```powershell
# 1) 设置页「鱼讯」→「本地 AI 服务」分区：发送语音音色、发送语音语速、
#    收到语音后自动分析、语音分析语言、收到图片后先在本地识图、图片识别提示词
# 2) 没装本地 AI 插件时，分区顶部有一行提示，控件和识图下拉都置灰，
#    识图旁注明「需先安装本地 AI 插件。」
# 3) 旧 config.json 里残留的 ttsVoice 等键会在加载时静默清掉（文件仍在）
# 4) 旧的 describeInboundImages: true/false 读成 on/off，缺失则 inherit
# 5) 图片识别提示词留空时输入框内显示默认文案；填自定义文本后出现「恢复默认」，
#    点击后回到留空；非字符串或超过 4000 字按留空处理
Get-Content "$env:USERPROFILE\.dsh\fish-message-config.json" -Raw
# 6) 发一条语音：会话应收到一行「（语音：<路径>，N 秒；情感：…；背景：…；转写：…）」；
#    没给情绪/事件时省略对应段，分析关掉时只有路径和时长
```

`[语音]文字[/语音]` 在本地 AI 正常时合成发送；不可用时只提示，不会入队。

### 9.3 设置页

- 「待发消息」卡片显示「待发 N 条 / 最早等待 X 秒」，有「立即重试」「清空待发」；
- 点「保存设置」只提示保存/重连，没有额外能力探测提示。

### 9.4 表情库

1. 设置页「表情包」块显示统计（数量 / 占用 MB / 上限）与「打开图库管理」主按钮，不直接铺开网格；
2. 点「打开图库管理」→ 设置页之上打开「表情库」弹窗；搜索框、刷新、上传、打开表情库文件夹、删除未使用、清理重复都在弹窗的工具条/列表里；
3. 点「打开表情库文件夹」→ 资源管理器打开当前配置的库目录（默认 `C:\Users\Administrator\.dsh\fish-message-stickers\`）；把该目录临时改名后再点一次，应先建回目录再打开；
4. 上传一张 GIF + 一张 PNG（多选）→ 网格出现两张，GIF 预览会动；再传同一张应只合并标签、不新增；
5. 拿到某条表情的文件名，在 DSH 里发 `[MSG][表情:文件名][/MSG]` → QQ 收到动图，管理页该条「已使用 N 次」+1；
6. 发 `[MSG][表情:根本没有这个][/MSG]` → 当前 DSH 会话收到「找不到表情」提示，日志有记录；
7. 取图防穿越：`GET /dsh-fish-message/stickers/file?path=../../secret.png` 应返回 403；
8. 清理：「删除未使用」只删 `used_count=0` 的条目；「清理重复」后同 sha 只留一条；
9. 同一张图连发两次 → 收图图库只多一条、缓存目录只留一个 `qq-image-<sha 前 16 位>.<扩展名>`，入表情库也只一条。

> `POST /dsh-fish-message/stickers/import` 仍保留供脚本/兼容调用，但管理页不再提供「从默认表情库导入」入口。
> 旧的「最近收到的图片」列表与「清空最近图片」按钮已移除，入站图片统一进收图图库（见 9.5）。

### 9.5 图库管理弹窗（表情库与收图图库各自独立）

1. 侧边栏不再出现「图库」入口；设置页「表情包」与「收图图库」两块相邻，中间不夹别的块，各有「打开图库管理」主按钮；
2. 点表情包块的按钮 → 设置页之上打开标题为「表情库」的弹窗，只显示表情库；关掉后再点收图图库块的按钮 → 打开标题为「收图图库」的弹窗。两个弹窗都没有页签，不显示另一个库，也不能互跳；同一时间只开一个；
3. 点右上「×」或遮罩能关闭；按 Esc 只关当前弹窗（二次确认打开时只关确认框），设置页不会被一起关掉；打开时焦点进入面板，关闭后回到刚才的入口按钮；
4. 两个弹窗的工具条/列表结构一致：左搜索框（占位「搜索名称、描述或标签」）、右「刷新」与库级操作；表情库有上传图片、打开文件夹、删除未使用、清理重复，收图图库有清空图库、打开图库文件夹；配置项（收图先查图库、条数上限、空间上限、存原图）仍在设置页，不在弹窗里重复；
5. 卡片网格有缩略图、名称、两行描述、标签；空库显示「图库是空的。」，加载时显示「正在读取图库…」；点卡片进详情，左上「返回」回到网格；
6. 表情库详情可改标签/描述并保存、复制路径、发送、删除；收图图库详情显示预览（没存原图时明确说明）、描述、保存描述、存为表情、打开原图；
7. 删除表情、清空收图图库、删除未使用、清理重复都会在弹窗内弹出二次确认（明确的取消/确认），取消不执行，不再出现浏览器原生 confirm；
8. 用主人 QQ 发一张新图、本地识图关着 → 收图图库弹窗网格出现该条目：缩略图、尺寸/大小、命中 0 次、描述来源「待识别」、加入时间；会话里只有原图和「第一次见到」的说明，没有要求补描述的提示；
9. 同一张图第二次发、本地识图开着 → 识图一次，详情里出现描述、来源「本地识图」、命中 1 次；第三次再发走缓存，命中 2 次，正文标明第 3 次见到，不再附原图；
10. 在收图图库详情里填描述并点「保存描述」→ 提示已保存；重发同一张图，会话正文直接给该描述（命中缓存）；
11. 点「存为表情」→ 提示「已存为表情」，关掉收图图库弹窗、打开表情库弹窗能看到同图；再点一次只合并描述，不重复入库；
12. 点「打开原图」→ 资源管理器用默认程序打开该原图；关掉「在图库里存原图」后新条目没有原图，这两个按钮不可用；
13. 「清空图库」确认后条目清空，同一张图再来重新登记（第一次仍不识别）；
14. Network 里不应再出现 `/dsh-fish-message/memory/*` 请求（记忆图库与声纹库归记忆插件的页面）。

### 9.6 计价与余额（可选 fish-token）

前置：装好并启用 fish-token（Cordis 服务名 `fish.token`）。没装时两块都不可用，收发行为与装之前完全一样。

1. 设置页「鱼讯」出现「计价与余额」卡片；没装 fish-token 时状态行是「计价服务：未检测到（需要安装并启用 fish-token 插件）」，峰时开关置灰，其余照常显示；
2. 装了 fish-token：状态行「计价服务：已连接（当前峰时 / 谷时）」，与 fish-token 自己的判断一致；
3. 峰时给机器人发一条私聊（正文不以【紧要】开头）：
   - 会话里**不出现**这条消息；
   - 手机上收到「当前为峰值计价时段，可留言。谷值计价时段会自动处理。可在留言开头使用【紧要】立即安排处理」；
   - fish-token 的任务列表多一条 pending：sessionKey 是绑定的会话，channel / peer 是这条渠道，source 为 `fish-message`；
   - `state.bridge.stats.delivered` 不增加，日志有「→ 非紧要任务队列」；
4. 峰时 30 分钟内再发两条：都进任务队列，但手机不再重复提醒；把「提醒冷却（分钟）」改成 0 再发，立刻又提醒一次；
5. 峰时发 `【紧要】马上要处理` → 会话立刻收到「马上要处理」（没有【紧要】三个字），不进任务队列；
6. 谷时发消息 → 与原来一样直接进会话；
7. 停掉 / 卸载 fish-token 后发消息：照常直接进会话，没有提醒，日志里只有一条「没有检测到 fish.token 服务」的 debug；
8. 余额提醒：让余额跌破阈值（或直接在测试里触发 `balance-low` 事件）→ 当前渠道收到「当前余额 9.60 元，余额偏低，记得充值。」；同一阈值 30 分钟内再触发不重复；
9. 默认只开「发送文字提醒」；打开「发送表情提醒」并填一个表情名字 → 同一次提醒里先收到文字、再收到那张表情；
10. 只关「发送文字提醒」→ 只收到表情；两个开关都关 → 什么都不发；
11. 表情名字留空或库里找不到时：文字开关开着 → 只收到那一条文字（不会重复发第二条）；文字关着 → 什么都不发，日志里一条 warn；
12. 一次渠道对话都没有（`replyTargets` 为空）时触发余额提醒 → 什么都不发，只在日志留 debug；
13. 旧配置文件：没有这些键的 → 读出来是上面的默认值；只写了旧 `balanceAlertMode` 的 → 按迁移表展开成两个开关（off 都关、message 只文字、sticker 只表情），保存一次后文件里只剩新键。

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
- 让 DSH 重新加载插件。

旧桥配置/状态文件全程保留，回滚后直接继续用。

---

## 11. 本轮已做 / 留给父 agent

### 已做（不依赖 DSH 重载）

- 全部单测 + mock 集成测试通过；
- 出站队列：落盘/重启恢复、fingerprint 去重、TTL、1000 条上限、退避/20 次放弃、
  离线入队→恢复补发、路径失效丢弃、队列接口；
- 可选本地 AI：入站语音分析（文字 + 情感/背景音）、出站 `[语音]文字` 合成、能力缺失/服务缺失降级、
  入站识图三态（inherit/on/off，旧布尔迁移）、音色/语速参数、配置默认值；`[语音:路径]` 照常发；
  入站识图提示词（默认文案、留空即默认、超长/非法回退、prompt 透传、识图失败仍退附件）；
  旧 ASR/TTS 配置字段仍被静默清理；
- 计价与余额（可选 fish-token）：峰时转任务队列、`【紧要】` 放行、提醒冷却、服务缺失 / 入队失败 / 超时的回退、
  余额提醒的两个开关（都开 / 只文字 / 只表情 / 都关、表情失败不重复补）、旧 `balanceAlertMode` 迁移、
  配置规整与旧配置兼容，都有单测；
- 真实 NapCat `send_private_msg` 文字 1 条，已回读历史确认；
- 真实 NapCat 的 `get_friend_msg_history`、`get_login_info` 均验证。

### 留给父 agent（需要重新加载 DSH 插件 / 用主人 QQ 发消息）

- 让 DSH 重新加载插件后，确认设置页「鱼讯」出现「本地 AI 服务」分区；没装本地 AI 时控件和识图下拉置灰、顶部有提示；
- 按第 9 节做「出站队列断网→恢复补发」真机验收；
- 主人 QQ → DSH 文字；
- 主人 QQ → DSH 语音：会话应收到一行「语音：路径，N 秒」；分析可用时同一行再带情感、背景音、转写；
- DSH → QQ `[语音]文字[/语音]` → 本地 AI 正常时收到语音条；停掉后只收到提示；
- DSH → QQ `[语音:路径]` → 收到语音条；
- DSH → QQ 字面量 `[/MSG]`；
- 停 NapCat → 主人发 2 条 → 启动 NapCat → 补投；
- 可选：图片双向、`[文件:…]`、入站识图三态（继承时看插件的开关）；
- 可选：在「图片识别提示词」填自定义内容后发图，描述应符合提示词要求；清空/恢复默认后回到默认文案；
- 装好 fish-token 后按 9.6 验收：峰时转任务 + 提醒 + 紧要放行，余额提醒的文字 / 表情两个开关；
  再把 fish-token 停掉，确认消息照常直接进会话。

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

