# 架构：dsh-fish-message

## 1. 总览

```text
QQ 客户端
   │
   │  QQ 协议
   ▼
NapCat（OneBot 11）
   │  HTTP send_private_msg / get_friend_msg_history / get_record
   │  WebSocket 事件推送
   ▼
Transport 适配器（v1：napcat-onebot）
   │  start / stop / sendMessage / onEvent / fetchHistory
   ▼
Bridge（lib/bridge.js）
   ├─ 入站：过滤私聊 → 乱序缓冲 → 去重 → 水位 → 补投
   ├─ 转写：record → VoiceService → 本地 /asr
   ├─ 图片：image → inbox → DSH 附件
   └─ 出站：session/event → [QQ] 解析 → text / image / record / file
   │
   ▼
Delivery（lib/delivery.js）
   │  agent.followup({ role:'user', source:{ kind:'qq' } })
   ▼
DSH 会话（模型照常开一轮）
```

本地 AI 服务只通过 HTTP 调用，插件不 import 它的代码，也不改它：

```text
VoiceService ── POST /asr?speaker=1       （multipart）
             ── POST /tts                 （JSON，返回 audio/wav）
             ── POST /media/to_wav        （multipart）
```

---

## 2. 模块职责

| 模块 | 职责 | 不做什么 |
|---|---|---|
| `lib/host.js` | DSH 生命周期、路由、session/event 监听、组装 | 不实现消息算法 |
| `lib/bridge.js` | 队列、去重、水位、补投、出站解析调度 | 不直接碰 DSH API（通过 delivery） |
| `lib/transport/base.js` | 适配器接口定义 | 不实现协议 |
| `lib/transport/napcat-onebot.js` | OneBot HTTP/WS、断线重连、历史 | 不做业务去重 |
| `lib/format.js` | `[QQ]` 块、转义、显式指令 | 不发送 |
| `lib/queue.js` | 每个聊天的乱序缓冲 | 不做持久化 |
| `lib/storage.js` | 水位 / seen / 统计 / 最近事件 | 不做网络 |
| `lib/voice.js` | ASR / TTS / to_wav / 图片落盘 | 不改 7880 服务 |
| `lib/delivery.js` | `agent.followup` + 附件 | 不拼消息格式 |

---

## 3. 入站流程

### 3.1 事件来源

- **WebSocket**：NapCat 推 `post_type=message`、`message_type=private`；
- **HTTP 轮询**：WS 不可用时，Bridge 每 `pollIntervalMs` 调 `fetchHistory`；
- **定时补投**：即使 WS 连着，每 `historyIntervalMs` 也拉一次历史；
- **WS 重连后**：立即补一次历史。

### 3.2 过滤

只保留：

- `message_type === 'private'`（v1 不处理群）；
- `user_id === 绑定 QQ`（过滤自己发出去的消息、过滤别人）；
- 有 `message_id`。

### 3.3 队列与排序

`MessageQueue` 按聊天分组，收到消息后等 `reorderBufferMs`（默认 1.5 秒），
然后按 `time → message_seq → message_id` 升序处理。最长等待 `maxWaitMs` 防止
有人一直发导致永远不 flush。

同一 `message_id` 在队列里只留一份；已处理的 id 进入持久化 `seen` 集合。

### 3.4 去重与水位

状态文件 `<DSH 家目录>\fish-message-state.json`：

```json
{
  "version": 1,
  "watermarks": {
    "1696117435": { "timestamp": 1794200000, "messageId": "123456", "updatedAt": 1794200001000 }
  },
  "seen": ["123456", "123457"],
  "stats": { "received": 1, "delivered": 1, "skippedOld": 0, "errors": 0 }
}
```

去重有三层：

1. `seen` 集合（持久化，最近 2000 个）；
2. 水位 `timestamp`：小于水位的旧历史直接静默标记，不投；
3. 队列内 `message_id` 去重 + 处理中集合，防止 WS/轮询同时到达时重复。

**只有 `delivery.deliver()` 返回 `ok` 才推进水位和 `seen`。**
会话没开、followup 失败时，当前消息和它后面的消息会重新入队，下一轮重试，
不会出现「先跳过后面的、结果顺序乱掉」。

### 3.5 离线补投

1. 启动时读旧桥 `qq-bridge-state.json`，把 `上次["私聊:<QQ>"]` 和 `已转` 搬过来（只读）；
2. 第一次运行没有水位：设成「插件启动时间 - 60 秒」，避免灌几年历史；
3. 每次同步拉历史；如果整页都比水位新，用最早一条的 `message_id` 继续向前翻页（最多 10 页），
   避免离线消息超过一页时漏掉；
4. 在 `backfillWindowHours` 内的逐条投；
5. 超过窗口的只投一条摘要，包含条数、最早/最近时间；
6. 摘要投失败只记日志（这些消息已经太旧，不阻塞新消息）。

### 3.6 语音入站

```text
record 段
  → transport.getRecord(file, out_format=wav)
  → 拿不到则 transport.download(url) / base64:// / 本地文件
  → 存 <家目录>\fish-message-inbox\qq-voice-*.wav
  → 非 wav 再走 /media/to_wav
  → /asr?speaker=1
  → "（语音｜声纹：主人）文字"
```

原文件保留，供以后做声纹登记；转写失败会降级成 `[语音（转写失败：…）]`，
不会把整条消息丢掉。

### 3.7 图片入站

```text
image / mface 段
  → url 下载 / base64:// / 本地路径
  → 存 <家目录>\fish-message-inbox\qq-image-*
  → 文字里附本地路径
  → delivery 用 ctx.attachments.admitPromptContent 递给会话
```

最多 4 张；超过 `maxImageMB` 跳过。

---

## 4. 出站流程

### 4.1 触发

`host.js` 监听 `session/event`：

- `assistant/message`：记这一轮最后一段 assistant 正文和图片块；
- `turn/end` 且 `reason.kind === 'completed'`：如果这一轮属于绑定会话，调用
  `bridge.deliverAssistantTurn`。

按「会话 key + turn」去重，同一轮不会发两次。被中断（`interrupted`）的轮不发送。

### 4.2 解析

```text
extractOutbound(text, onlyInsideMarkers)
  ├─ parseQQBlock：转义扫描 → 块内反转义 → 多块拼接 / 未闭合容错
  └─ parseDirectives：text / voice / image / file 有序 token
```

详细语法见 [`FORMAT.md`](FORMAT.md)。

### 4.3 发送

| token | 行为 |
|---|---|
| `text` | `send_private_msg`，`text` 段 |
| `image` | 本地图读 base64；网络图交 URL |
| `voice` | `/tts` → 本地 wav → `record` 段 |
| `voiceFile` | 直接 `record` 段 |
| `file` | `file` 段（NapCat 支持时） |

语音发送按「本地路径 → `file:///` → `base64://`」重试，最多 3 次。
全部失败：日志/状态记错，并在会话里投一条错误提示（同一会话 60 秒最多一次）。

---

## 5. 连接与重连

### WebSocket

- 启动时若 `wsEnabled`，连 `wsUrl`（默认从 HTTP 地址推导）；
- 断开后指数退避：1s → 2s → 4s … 最多 30s，加 0–500ms 抖动；
- 连上后立即 `sync('ws-connected')`；
- WS 连接期间也会每 `historyIntervalMs` 拉一次历史兜底。

### HTTP 轮询

- WS 不可用（关闭 / 连接失败 / 断开）时，按 `pollIntervalMs` 调历史；
- WS 一恢复就停轮询；
- 轮询和定时补投共用 `sync()` 的串行锁，不会并发重复处理。

### 超时

所有 OneBot HTTP 请求都有 `requestTimeoutMs`（默认 15 秒）超时；`get_record` 30 秒。
NapCat 没开时不会把 DSH 卡死。

---

## 6. 多平台扩展点

`lib/transport/base.js` 定义：

```js
class Transport {
  get name()
  async start({ onEvent, onStatus })
  onEvent(handler)                 // 也可以单独注册
  async stop()
  async sendMessage(peer, segments)
  async fetchHistory(peer, { count, beforeMessageId })
  getStatus()
}
```

接新 IM 时：

1. 新写一个 `lib/transport/xxx.js`，实现上述五个方法；
2. 把 IM 的「收到消息」转成 OneBot 风格的 `message` 事件（至少含
   `message_id/time/user_id/message[]`）；
3. 在 `host.js` 里按配置选适配器；
4. `Bridge`、去重、水位、补投、DSH 投递完全不用改。

v1 不实现群聊。将来要加群：

- `Bridge` 的 key 从 QQ 号扩展成 `private:<qq>` / `group:<gid>`；
- 绑定结构加 `type`；
- 入站过滤、出站目标、`seen` 键、水位键都要带上类型；
- `sendMessage` 增加 `send_group_msg`。

当前 `bindings` 刻意只接受私聊，避免半成品群聊误发。

---

## 7. 安全边界

- v1 只调 `send_private_msg`，没有群发逻辑；
- 只处理绑定列表里的 QQ 号；陌生人私聊不会进 DSH；
- 出站默认只发 `[QQ]` 块内，块外解释/路径/思考留在本地；
- 令牌只存在配置文件和内存，不写日志；设置页显示 `***已设置***`；
- 状态/日志/HTTP 路由由 DSH 的本地 Web 服务提供，默认只在 `127.0.0.1` 访问；
- 不修改本地 AI 服务、ComfyUI、`D:\dsh_ws\qq-voice`、旧桥数据文件。

---

## 8. 失败语义

| 失败点 | 行为 |
|---|---|
| WS 连不上 | 降级 HTTP 轮询；后台继续重连 |
| 历史接口失败 | 记日志/状态；下一轮重试；WS 事件仍可收 |
| DSH 会话没开 | 不推进水位；消息留在队列，下一轮重试 |
| followup 失败 | 同上，并记错误 |
| ASR 失败 | 消息降级为 `[语音（转写失败）]`，不丢整条 |
| TTS 失败 | 语音 token 报错；会话收到错误提示 |
| `record` 发送失败 | 三种 file 形态重试，最多 3 次；仍失败报错 |
| 图片下载失败 | 文字里标 `[图片（下载失败）]`，不影响其它段 |
| 状态文件写失败 | 日志记错；内存继续，重启可能重投（已知风险） |
