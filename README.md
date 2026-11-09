# dsh-fish-message

DSH 的 QQ 私聊桥。v1 只做私聊：**QQ 私聊 ↔ 一间 DSH 会话**，支持文字、图片、语音、离线补投和转义标记。

- 插件名：`dsh-fish-message`
- 版本：`0.1.0`
- 传输：NapCat / OneBot 11（WebSocket 优先，HTTP 轮询兜底）
- 本地 AI：`127.0.0.1:7880` 的 `/asr`、`/tts`、`/media/to_wav`
- 代码目录：`E:\dsh-fish-message`
- 家目录文件：`<DSH 家目录>\fish-message-*`（默认 `C:\Users\Administrator\.dsh`）

> 本插件替换第三方 `dsh-qq-bridge`。两个插件不要同时启用，否则同一条 QQ 消息会被转两次。

---

## 1. 它解决的两个老问题

1. **能发语音**：旧桥只有入站语音转写，没有出站 `record` 段。本插件支持
   `[语音]文字[/语音]` 调本地 TTS 发语音条，也支持 `[语音:路径]` 直接发已有音频。
2. **消息不漏**：旧桥只看「上次时间」，机器人/DSH 没启动期间收到的消息不会补。
   本插件给每个私聊维护 `last_message_id` / `last_timestamp` 水位，并持久化到状态文件；
   启动、WS 重连、定时器、HTTP 轮询都会从历史补齐，按时间升序、按 `message_id` 去重。

---

## 2. 目录结构

```text
E:\dsh-fish-message
├─ package.json            # DSH 插件声明（dsh.bundle.patch / dsh.client.inject）
├─ cordis.patch.yml        # 把插件插进 profile 的 loader patch
├─ client.js               # 设置页（纯原生 JS + 平台自带 React）
├─ lib
│  ├─ host.js              # 宿主入口：组装、路由、session/event 监听
│  ├─ bridge.js            # 收/发核心：队列、去重、水位、补投、出站
│  ├─ format.js            # [QQ] 块、反斜杠转义、显式图片/语音/文件指令
│  ├─ config.js            # 默认配置、旧桥迁移、范围钳制、schemastery schema
│  ├─ storage.js           # 水位 / 已处理 id / 统计 / 最近事件
│  ├─ queue.js             # 每个聊天的乱序缓冲队列
│  ├─ voice.js             # ASR / TTS / to_wav / 图片落盘
│  ├─ delivery.js          # agent.followup + 图片附件
│  ├─ logger.js            # 内存日志环 + 滚动文件
│  ├─ fs-util.js           # 原子写 JSON
│  └─ transport
│     ├─ base.js           # Transport 适配器接口
│     └─ napcat-onebot.js  # v1 的 NapCat / OneBot 11 实现
├─ docs
│  ├─ FORMAT.md            # 语法、转义、代码块约定
│  ├─ ARCHITECTURE.md      # 数据流、补投算法、扩展点
│  └─ ACCEPTANCE.md        # 真机验收清单与命令
└─ tests                   # 单测 + mock OneBot HTTP/WS 集成测试
```

---

## 3. 安装到 DSH profile

### 3.1 先备份

```powershell
$profileDir = 'C:\Users\Administrator\.dsh\profiles\desktop'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item "$profileDir\package.json" "$profileDir\package.json.bak-fish-message-$stamp"
Copy-Item "$profileDir\cordis.patch.yml" "$profileDir\cordis.patch.yml.bak-fish-message-$stamp"
```

### 3.2 安装插件

在 `E:\dsh-fish-message` 已经 `pnpm install` 过（依赖 `ws`、`@deepseek-ai/schemastery`）的前提下：

```powershell
dsh plugin --profile desktop add E:\dsh-fish-message
```

这会做两件事：

- 在 profile 的 `package.json` 写入 `dsh-fish-message` 依赖；
- 把声明了 `dsh.bundle.patch` 的包追加到 `dsh.profile.bundles`。

### 3.3 禁用旧桥

编辑 `C:\Users\Administrator\.dsh\profiles\desktop\package.json`，从 `dsh.profile.bundles` 里删掉：

```json
"dsh-qq-bridge"
```

**保留** `dependencies` 里的 `dsh-qq-bridge`，这样回滚时不用重新下载。旧桥的数据文件
`~/.dsh/qq-bridge-config.json`、`qq-bridge-state.json` 也全部保留、不改、不删。

### 3.4 重启 DSH

**注意：如果你此刻正在 DSH 会话里，重启会杀掉当前会话。** 不要在会话里直接执行；
让父 agent / 另一个终端执行：

```powershell
pwsh -NoProfile -File C:\Users\Administrator\.dsh\_restart\dsh-restart.ps1 `
  -SessionId session-a3e56af2-2285-44e6-b32d-863efb9e7d8b `
  -WakeText '【dsh-fish-message 已启用】检查 /dsh-fish-message/health，并按 docs/ACCEPTANCE.md 做真机验收。'
```

或者用本仓库的薄包装（参数会转给上面那个脚本）：

```powershell
pwsh -NoProfile -File E:\dsh-fish-message\tools\restart-dsh.ps1
```

重启后打开 **DSH 设置 → 鱼讯 QQ**。

---

## 4. 配置

配置文件：`<DSH 家目录>\fish-message-config.json`。设置页保存的也是它。

| 字段 | 默认 | 说明 |
|---|---|---|
| `napcatBaseUrl` | `http://127.0.0.1:3000` | OneBot 11 HTTP 根地址 |
| `napcatToken` | 空 | OneBot access_token；没有就留空 |
| `wsEnabled` | `true` | 优先 WebSocket |
| `wsUrl` | 自动推导 | http→ws，https→wss |
| `bindings` | `[]` | `[{ qq, session, name, enabled }]`，v1 只支持私聊 |
| `onlyInsideMarkers` | `true` | 只发 `[QQ]…[/QQ]` 块内 |
| `transcriptionEnabled` | `true` | 入站语音调本地 `/asr` |
| `asrBaseUrl` | `http://127.0.0.1:7880` | 本地 ASR 根地址 |
| `asrCommand` | 空 | 留空走本地 `/asr`；填了走外部命令，必须包含 `{file}` |
| `asrTimeoutMs` | `180000` | 转写超时 |
| `ttsEnabled` | `true` | 出站 `[语音]` 调本地 `/tts` |
| `ttsBaseUrl` | `http://127.0.0.1:7880` | 本地 TTS 根地址 |
| `ttsVoice` | `dafeiyu` | 音色名 |
| `ttsTimeoutMs` | `180000` | 合成超时（首次加载模型可能 1 分钟以上） |
| `backfillWindowHours` | `24` | 补投窗口；超过只发摘要 |
| `pollIntervalMs` | `2000` | WS 不可用时的 HTTP 轮询间隔 |
| `historyIntervalMs` | `60000` | 即使 WS 连着也定期拉历史兜底 |
| `reorderBufferMs` | `1500` | 乱序缓冲 |
| `historyCount` | `100` | 每次拉多少条历史 |
| `maxImageMB` | `10` | 图片上限 |
| `maxVoiceMB` | `20` | 语音上限（base64 兜底也受它限制） |
| `requestTimeoutMs` | `15000` | OneBot HTTP 超时 |
| `logLevel` | `info` | `debug` / `info` / `warn` / `error` |

旧桥配置会在第一次启动时被读取并迁移到内存（`NapCat`、`绑定`、`只发标记内`、
`语音转写`、`轮询间隔毫秒` 等）。保存设置后才会写新的 `fish-message-config.json`。

---

## 5. 消息语法

完整语法和例子见 [`docs/FORMAT.md`](docs/FORMAT.md)，这里只列最常用的：

```text
这句只留在 DSH，不会发出去。

[QQ]这句会发到 QQ。[/QQ]

[QQ]第一段[/QQ]
[QQ]第二段（两段会拼成一条，中间换行）[/QQ]

[QQ]我想发字面量 \[\/QQ] 结束[/QQ]
```

- 标记只认**未转义**、且**不在代码块 / 行内代码**里的 `[QQ]` / `[/QQ]`。
- `\[` → `[`，`\]` → `]`，`\\` → `\`；额外认 `\/` → `/`，所以 `\[\/QQ]` 也能发字面量 `[/QQ]`。
- 只写 `[QQ]` 没写 `[/QQ]`：按「`[QQ]` 之后全是要发的」处理。
- 多个块按出现顺序用换行拼接。
- 关掉「只发标记内」：整条发，但标记本身会剥掉；代码块里的标记不剥。

显式指令：

```text
[图片:C:\pics\a.png]
[图片:https://example.com/a.png]
[语音]晚安，主人[/语音]
[语音:C:\audio\a.wav]
[文件:D:\docs\a.pdf]
```

> `[文件:…]` 依赖 NapCat 版本是否支持 `file` 段；不支持时会在日志和状态里报错，
> 不会静默假装成功。

---

## 6. 语音

### 入站

1. 收到 `record` 段；
2. 调 OneBot `get_record(file, out_format=wav)` 拿 wav；失败则下载 `url` / 解 `base64://`；
3. 原文件保存到 `<家目录>\fish-message-inbox\`（保留给声纹登记）；
4. 非 wav 时调本地 `/media/to_wav` 转 16k 单声道 wav；
5. 调 `/asr?speaker=1`，把 `（语音｜声纹：主人）转写文字` 递进会话。

如果 ASR 失败，消息不会丢：会变成 `[语音（转写失败：…）]`，错误同时进日志/状态。

### 出站

```text
[QQ][语音]晚安，主人[/语音][/QQ]
[QQ][语音:C:\audio\a.wav][/QQ]
```

发送顺序：本地绝对路径（正斜杠）→ `file:///` → `base64://`，失败自动重试，最多 3 次；
仍失败会在会话里收到一条 `（dsh-fish-message）语音发送失败：…` 提示。

---

## 7. 离线补投（核心）

每个绑定维护：

```json
{
  "watermarks": {
    "1696117435": { "timestamp": 1794200000, "messageId": "123456" }
  },
  "seen": ["123456", "123457"]
}
```

逻辑：

1. 启动时先从旧桥 `qq-bridge-state.json` 搬一次水位和已转 id（只读，不修改旧文件）；
2. 每次同步拉 `get_friend_msg_history`；
3. 只保留对方发来的私聊消息（`user_id == 绑定 QQ`），过滤自己发出去的；
4. 过滤已处理 `message_id` 和水位之前的历史；
5. 按 `time` / `message_seq` / `message_id` 升序；
6. 在补投窗口内逐条 `agent.followup`；超过窗口的只发一条「离线补投摘要」；
7. 只有**真正投进 DSH** 才推进水位；会话没开/投递失败会保留，下一轮重试；
8. 水位在每次成功后原子落盘，重启不丢。

WS 连接、WS 重连、每 60 秒、HTTP 轮询都会触发这个同步；同步是串行的，不会并发重复拉。

---

## 8. HTTP 接口和日志

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/dsh-fish-message/state` | 在线状态、配置、绑定、水位、统计、最近 200 行日志 |
| GET | `/dsh-fish-message/health` | 轻量健康检查，桥在跑返回 200 |
| POST | `/dsh-fish-message/save` | 保存配置（设置页用） |
| POST | `/dsh-fish-message/test-send` | 发一条固定测试文字 |
| POST | `/dsh-fish-message/test-voice` | 合成并发送一条测试语音 |
| GET | `/dsh-fish-message/logs` | 最近 200 行日志 |

日志：

- 内存环：设置页显示最近 200 行；
- 落盘：`<DSH 家目录>\fish-message.log`，超过 5 MB 滚动为 `fish-message.log.1`。

---

## 9. 测试

```powershell
cd E:\dsh-fish-message
pnpm install
npm test
```

测试不需要连 QQ，也不需要 DSH：

- `tests/format.test.js`：块、转义、多个块、未闭合、代码块、显式指令；
- `tests/core.test.js`：补投排序/去重、水位持久化、窗口摘要、WS 乱序、出站、语音重试；
- `tests/integration.test.js`：Node 内起 mock OneBot HTTP + WS，验证收/发/补投/轮询/重启；
- `tests/host.test.js`：假 ctx 下验证 DSH 路由、状态、`session/event` 出站。

---

## 10. 真机验收与回滚

真机验收步骤、命令、预期结果见 [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md)。
其中「停掉 NapCat → 发 2 条 → 启动 NapCat → 自动补投」是关键项。

### 回滚到旧桥

1. 从 profile 的 `dsh.profile.bundles` 里删掉 `dsh-fish-message`；
2. 把 `dsh-qq-bridge` 加回 `dsh.profile.bundles`（依赖和代码一直保留着）；
3. 保留 `fish-message-config.json` / `fish-message-state.json` 以便以后切回来；
4. 重启 DSH。

旧桥的 `qq-bridge-config.json` / `qq-bridge-state.json` 全程未被修改，可直接继续用。

---

## 11. 已知限制 / 风险

- v1 **只做私聊**；群聊、其它 IM 只留 `Transport` 接口和文档，不实现。
- `[文件:…]` 是否可用取决于 NapCat 版本/权限；不可用会明确报错。
- 出站语音是「TTS 或已有文件」，不做变声、不做自动长文本切分；QQ 语音条有时长上限。
- 首次 `/tts` 要加载模型，实测可能 70 秒左右；默认超时 180 秒。
- 入站语音的声纹名来自本地 `/asr`；未登记的人会显示 `未知-N`。
- 水位之前的旧历史会被静默标记为已处理，不会补投（避免刚装好就灌几年历史）。
- 插件只监听绑定会话的 assistant 消息；群聊和未绑定会话不会外发。
- 2026-11-09 本机实测：`ws://127.0.0.1:3000` 握手超时（NapCat 当前只开了 HTTP），
  插件自动降级为 2 秒 HTTP 轮询，`/state` 里 `transport.mode = "http"`；
  WS 服务一旦在 NapCat 里启用，插件会按指数退避自动连回去。
