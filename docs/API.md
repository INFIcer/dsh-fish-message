# API：底层原样收发 + 高级语音能力 + 持久化出站队列

本文是 `dsh-fish-message` 对外 HTTP 接口的完整说明。所有接口都挂在 DSH 自己的本地 Web 服务上，
前缀固定为 `/dsh-fish-message`，默认只在 `127.0.0.1` 可访问，没有额外鉴权。

- 请求体：除 `send-image` 的 multipart 外，都是 `application/json; charset=utf-8`。
- 响应体：统一 JSON；成功都有 `"ok": true`，失败都有 `"ok": false` 和 `error`、`detail`。
- `qq` 省略时使用配置里**第一条启用中的绑定**；显式传 `qq` 时允许发给任意 QQ（底层 API 不校验绑定关系）。
- 底层 API **不解析** `[QQ]…[/QQ]` 标记，也不做转写/合成，发什么就是什么。
  走 DSH 会话回复的自动出站仍然按 `onlyInsideMarkers` 解析，两条路径互不影响。

---

## 1. 底层 API（始终可用，不依赖 7880）

底层 API 只做 OneBot 原样收发。QQ 发不出去时自动进[出站队列](#4-持久化出站队列)，
返回 `202` 和 `queued: true`，消息不会丢。

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/dsh-fish-message/api/send-text` | 发纯文字 |
| POST | `/dsh-fish-message/api/send-image` | 发图片（本地路径 / URL / multipart 上传） |
| POST | `/dsh-fish-message/api/send-record` | 发已有音频文件（`record` 段） |
| POST | `/dsh-fish-message/api/send-file` | 发文件（`file` 段，取决于 NapCat 版本） |
| GET | `/dsh-fish-message/api/history` | 透传 `get_friend_msg_history` |

### 1.1 `POST /api/send-text`

```json
{ "qq": "1696117435", "text": "你好，这条是原样发送的 [QQ] 不会被解析" }
```

- `text` 必填，去空白后不能为空，最长 10000 字。
- 不会剥掉/解释 `[QQ]`、`[/QQ]`、`[语音]` 等标记。
- 成功：`200`，`sent: true`；QQ 不可用：`202`，`queued: true`，带 `id` 和 `pending`。

```bash
curl -s -X POST http://127.0.0.1:8519/dsh-fish-message/api/send-text \
  -H 'content-type: application/json' \
  -d '{"qq":"1696117435","text":"你好，底层 API 原样发送"}'
```

真实响应样例（成功）：

```json
{"ok":true,"kind":"text","qq":"1696117435","sent":true,"queued":false,"id":null,"pending":0}
```

真实响应样例（QQ 离线，已入队）：

```json
{"ok":true,"kind":"text","qq":"1696117435","sent":false,"queued":true,"id":"0f8e0f5e-...","pending":3,"detail":"send_private_msg 失败：模拟发送失败：机器人离线"}
```

### 1.2 `POST /api/send-image`

两种写法，二选一。

JSON：

```bash
curl -s -X POST http://127.0.0.1:8519/dsh-fish-message/api/send-image \
  -H 'content-type: application/json' \
  -d '{"qq":"1696117435","path":"C:\\pics\\a.png"}'
```

也接受 `http(s)://` 图片 URL（交给 NapCat 拉取）。

multipart：

```bash
curl -s -X POST http://127.0.0.1:8519/dsh-fish-message/api/send-image \
  -F 'qq=1696117435' \
  -F 'file=@C:\pics\a.png'
```

- 表单字段名认 `file` / `image`，`qq` 可放在表单里。
- 上传文件落到 `<DSH 家目录>\fish-message-inbox\api-upload-*`。
- 大小上限跟 `maxImageMB` 走（默认 10MB，另加 2MB multipart 余量）。

### 1.3 `POST /api/send-record`

```json
{ "qq": "1696117435", "path": "C:\\audio\\a.wav" }
```

- 必须是本地文件；路径不存在返回 `400 file_not_found`。
- 发送策略和自动出站语音一致：本地路径 → `file:///` → `base64://`，最多 3 次。
- 失败入队时存的是**路径**；补发前会检查路径，文件没了就直接丢弃并记错。

### 1.4 `POST /api/send-file`

```json
{ "qq": "1696117435", "path": "C:\\docs\\a.pdf", "name": "报告.pdf" }
```

- `name` 省略时用文件名。
- `file` 段是否可用取决于 NapCat 版本/权限；失败会入队，补发仍失败会按重试/TTL 丢弃并记日志。

### 1.5 `GET /api/history`

```bash
curl -s 'http://127.0.0.1:8519/dsh-fish-message/api/history?qq=1696117435&count=20'
```

- `count` 范围 1–500，默认 `historyCount`（100）。
- 返回 OneBot 原始消息数组，不裁剪、不转写。
- NapCat 不可用返回 `502 onebot_error`。

```json
{
  "ok": true,
  "qq": "1696117435",
  "count": 1,
  "messages": [
    {
      "message_id": 123456,
      "time": 1794200000,
      "user_id": 1696117435,
      "message_type": "private",
      "message": [{ "type": "text", "data": { "text": "在吗" } }],
      "raw_message": "在吗"
    }
  ]
}
```

---

## 2. 高级 API（依赖服务地址，留空 = 不可用）

高级 API 把「取音频 → ASR」和「文字 → TTS」封装好，同时保留 `501/502` 的明确失败语义。
服务地址来自配置：

| 配置 | 控制的高级能力 |
|---|---|
| `asrBaseUrl` | `transcribe`、`voiceAnalyze` |
| `ttsBaseUrl` | `synthesize`、`voiceReply` |

- 地址留空：返回 `501 advanced_api_disabled`，JSON 里带 `missing`（`asrBaseUrl` / `ttsBaseUrl`）。
- 地址填了但服务不通/超时/返回非 2xx：返回 `502 advanced_api_upstream_error`，`detail` 带原因。
- 高级 API 的 `synthesize`/`voiceReply` 不受 `ttsEnabled` 开关影响（开关只控制自动出站 `[语音]`），
  但 `ttsBaseUrl` 为空一定不可用。

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/dsh-fish-message/api/transcribe` | 本地音频或 QQ 语音消息 → 文字 + 声纹 |
| POST | `/dsh-fish-message/api/synthesize` | 文字 → 本地 wav，不碰 QQ |
| POST | `/dsh-fish-message/api/voice-reply` | 合成后发 QQ 语音；失败入队文字 |
| POST | `/dsh-fish-message/api/voice-analyze` | 取 QQ 语音 → 转写，一次返回文字 + 声纹 |
| GET | `/dsh-fish-message/api/capabilities` | 调用方判断哪层/哪项可用 |

### 2.1 `POST /api/transcribe`

```json
{ "qq": "1696117435", "path": "C:\\audio\\a.wav" }
```

或者按 QQ 消息 id：

```json
{ "qq": "1696117435", "messageId": 123456 }
```

- `path` 与 `messageId` 二选一；同时给时 `path` 优先。
- `messageId` 会在最近 10 页历史里找（每页 `historyCount` 条），找到 `record` 段后走 `get_record` / 下载 / 本机路径。
- 返回字段：`text`、`speaker`（`{name, known}`）、`speakerName`、`engine`、`ms`、`audioPath`、`source`。

```bash
curl -s -X POST http://127.0.0.1:8519/dsh-fish-message/api/transcribe \
  -H 'content-type: application/json' \
  -d '{"path":"C:\\audio\\a.wav"}'
```

```json
{
  "ok": true,
  "text": "这是 Mock ASR 转写出来的文字",
  "speaker": { "name": "主人", "known": true },
  "speakerName": "主人",
  "engine": "mock-asr",
  "ms": 6,
  "audioPath": "C:\\Users\\Administrator\\.dsh\\fish-message-inbox\\qq-voice-...wav",
  "source": "path"
}
```

### 2.2 `POST /api/synthesize`

```json
{ "text": "晚安，主人", "voice": "dafeiyu" }
```

- `voice` 省略用 `ttsVoice`。
- 只把 wav 写到 `<DSH 家目录>\fish-message-outbox\tts-*.wav`，**不会发 QQ**。
- 返回 `path`、`ms`、`voice`。

```json
{"ok":true,"path":"C:\\Users\\Administrator\\.dsh\\fish-message-outbox\\tts-dafeiyu-1794200000000.wav","ms":420,"voice":"dafeiyu"}
```

### 2.3 `POST /api/voice-reply`

```json
{ "qq": "1696117435", "text": "晚安，主人", "voice": "dafeiyu" }
```

1. 先调 `/tts` 合成；
2. 尝试直接发 `record`；
3. QQ 发不出去 → 把**文字**（`record_text`）放进持久化出站队列，恢复后重新合成再发；
4. 合成本身失败 → `502`，不会入队一段无效音频。

返回 `sent` / `queued` / `id` / `pending` / `path` / `ms` / `voice`。

离线时（`202`）：

```json
{"ok":true,"qq":"1696117435","sent":false,"queued":true,"id":"...","pending":2,"path":"...wav","ms":380,"voice":"dafeiyu"}
```

### 2.4 `POST /api/voice-analyze`

```json
{ "qq": "1696117435", "messageId": 123456 }
```

等价于「按 messageId 取音频 → 转写」，一次返回文字 + 声纹。`messageId` 必填。
响应在 `transcribe` 基础上固定 `source: "message"`，并带 `messageId`。

### 2.5 `GET /api/capabilities`

```bash
curl -s http://127.0.0.1:8519/dsh-fish-message/api/capabilities
```

```json
{
  "ok": true,
  "lowLevel": true,
  "advanced": {
    "transcribe": true,
    "synthesize": true,
    "voiceReply": true,
    "voiceAnalyze": true
  },
  "services": {
    "asr": { "url": "http://127.0.0.1:7880", "enabled": true },
    "tts": { "url": "http://127.0.0.1:7880", "enabled": true }
  }
}
```

地址留空时：

```json
{
  "ok": true,
  "lowLevel": true,
  "advanced": {
    "transcribe": false,
    "synthesize": false,
    "voiceReply": false,
    "voiceAnalyze": false
  },
  "services": {
    "asr": { "url": "", "enabled": false },
    "tts": { "url": "", "enabled": false }
  }
}
```

### 2.6 501 响应（地址留空）

```json
{
  "ok": false,
  "error": "advanced_api_disabled",
  "detail": "高级 API 未启用：请在设置里填写 asr 服务地址",
  "missing": "asrBaseUrl",
  "service": "asr"
}
```

TTS 对应 `missing: "ttsBaseUrl"`、`service: "tts"`、`detail` 里写 `tts 服务地址`。

---

## 3. 错误码

| HTTP | `error` | 场景 |
|---|---|---|
| 200 | — | 成功（直发成功、或队列操作成功） |
| 202 | — | 消息已入队（`ok:true, queued:true`） |
| 400 | `bad_request` | 缺参数、文字为空、multipart 解析失败 |
| 400 | `file_not_found` | 本地图片/音频/文件不存在，或该接口只收本地路径 |
| 400 | `no_binding` | `qq` 省略且没有可用绑定 |
| 400 | `message_not_found` | `messageId` 在最近历史里找不到 |
| 400 | `no_audio_segment` | 找到消息了，但里面没有 `record` 段 |
| 404 | `not_found` | 出站队列里没有这个 id |
| 405 | `method_not_allowed` | 方法不对 |
| 413 | `payload_too_large` | multipart 上传超过上限 |
| 501 | `advanced_api_disabled` | asr/tts 地址留空，高级 API 未启用 |
| 502 | `advanced_api_upstream_error` | ASR/TTS 服务不通、超时、返回错误 |
| 502 | `onebot_error` | 拉 OneBot 历史失败 |
| 502 | `audio_fetch_failed` | 从 QQ 消息取音频失败 |
| 502 | `send_failed` | 发送失败且写持久化队列也失败 |
| 503 | — | 桥未启动，手动补发不可用 |

所有失败响应都有 `ok: false`、`error`、`detail`；高级 API 的失败不会静默返回空结果。

---

## 4. 持久化出站队列

### 4.1 文件与结构

`<DSH 家目录>\fish-message-outbox.json`（默认 `C:\Users\Administrator\.dsh\fish-message-outbox.json`），原子写：

```json
{
  "version": 1,
  "items": [
    {
      "id": "0f8e0f5e-...",
      "qq": "1696117435",
      "segments": [
        { "type": "record_text", "data": { "text": "晚安，主人", "voice": "dafeiyu" } }
      ],
      "createdAt": 1794200000000,
      "attempts": 2,
      "nextAttemptAt": 1794200038000,
      "expiresAt": 1794286400000,
      "reason": "turn:voice",
      "fingerprint": "9f2c...（sha256）"
    }
  ]
}
```

- 最多 1000 条；超出丢最旧并记日志/`droppedTotal`。
- `segments` 是内部段，不直接等于 OneBot 段：
  - `text`：文字；
  - `image`：`data.path` 或 `data.url`；
  - `record_text`：**要重新 TTS 的文字**（队列里绝不存音频字节）；
  - `record`：已有音频路径；
  - `file`：文件路径 + 文件名。
- 统计计数写在 `fish-message-state.json` 的 `stats.outboxSent / outboxFailed / outboxDropped / outboxLastError`，
  出站队列文件本身只放条目。

### 4.2 什么时候入队

正常发送（会话自动回复、底层 API、测试按钮）先尝试直发；以下情况进队列：

- 网络错误、连接拒绝、请求超时；
- OneBot HTTP 非 2xx；
- `retcode != 0` / `status != ok`；
- 传输层已停止（`mode === "stopped"`）；
- 补发正在进行，或队列里已有积压：新消息按顺序排到队尾。

> 注意：本机 NapCat 目前 WS 不可用，实际走 HTTP 轮询，`transport.connected` 恒为 `false`。
> 因此不能用 `connected === false` 直接判断离线，否则 HTTP 模式下所有消息都会只入队不发。
> 插件的判断标准是「实际发送有没有成功」。

### 4.3 fingerprint 去重

```
fingerprint = sha256(qq + "\n" + 规范化(segments))
```

- 规范化时对象键排序，`image` 取 path/url，`record_text` 取 text+voice，`record`/`file` 取路径。
- 同 QQ、同内容在 `outboxDedupMinutes`（默认 10 分钟）内只保留一条；
  重试/重复调用不会把同一条消息变成多条。
- 补发成功并从队列删除后，再发同样内容是**新消息**（不会永久去重）。

### 4.4 补发时机与顺序

- 传输恢复在线（WS 重新连上）立即补一次；
- 每 `outboxFlushIntervalMs`（默认 10 秒）心跳补一次；
- 插件启动 0.8 秒后补一次；
- `POST /outbox/flush` 手动立即补（忽略退避）。

补发按 `createdAt` 从旧到新 FIFO；失败一条就停，后面的不插队，等下一轮。

### 4.5 重试、退避、TTL

- 单条最多 20 次尝试；
- 失败后 `attempts++`，下次时间 = 现在 + `min(5s × 1.8^attempts, 300s)`；
- 默认 TTL 24 小时（`outboxTtlHours`），过期丢弃并记日志/统计；
- 手动删除、清空、路径失效、尝试耗尽都计入 `droppedTotal`；
- 补发成功日志固定格式：`补发成功（积压 N 条，延迟 X 秒）`。

### 4.6 语音的特殊处理

| 入队时 | 队列里存什么 | 补发时 |
|---|---|---|
| `[语音]文字[/语音]` / `voice-reply` 合成后发失败 | 文字 `record_text` | 重新调 `/tts` 合成再发 |
| `[语音:路径]` / `send-record` | 本地路径 `record` | 先检查文件；不存在直接丢弃并报错 |
| 图片路径 | 路径 `image` | 先检查文件；不存在丢弃 |
| 文件 | 路径 + 文件名 `file` | 先检查文件；不存在丢弃 |

### 4.7 并发与顺序

- 正常发送和补发共用一条发送锁（Promise 串行链）；
- 补发期间新消息直接入队，不抢跑，保证「积压 → 新消息」的先后顺序；
- 补发失败会立刻释放锁，正常发送不会被一条坏消息永久卡死；
- 同一轮回复的多段消息在锁内顺序发送；前一段入队后，后面的也入队，避免后发先至。

### 4.8 队列接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-fish-message/outbox?limit=50` | 列表 + 统计；`limit` 默认 50，最大 1000 |
| POST | `/dsh-fish-message/outbox/flush` | 立即补发（忽略退避） |
| POST | `/dsh-fish-message/outbox/clear` | 清空整个队列 |
| DELETE | `/dsh-fish-message/outbox/{id}` | 丢弃单条 |

`GET /outbox` 样例：

```json
{
  "ok": true,
  "pending": 1,
  "oldestAgeSec": 42,
  "sentTotal": 7,
  "failedTotal": 2,
  "droppedTotal": 1,
  "lastError": "send_private_msg 失败：请求超时（15 秒）",
  "items": [
    {
      "id": "0f8e0f5e-...",
      "qq": "1696117435",
      "segments": [{ "type": "text", "data": { "text": "离线时发的" } }],
      "createdAt": 1794200000000,
      "attempts": 1,
      "nextAttemptAt": 1794200009000,
      "expiresAt": 1794286400000,
      "reason": "api:text",
      "fingerprint": "..."
    }
  ]
}
```

`POST /outbox/flush` 样例：

```json
{"ok":true,"reason":"manual","sent":2,"failed":0,"dropped":0,"pending":0}
```

`DELETE /outbox/{id}` 样例：

```json
{"ok":true,"deleted":true,"id":"0f8e0f5e-...","pending":0,"oldestAgeSec":0,"sentTotal":7,"failedTotal":2,"droppedTotal":2,"lastError":"..."}
```

`/state` 里的出站摘要：

```json
{
  "outbox": {
    "pending": 1,
    "oldestAgeSec": 42,
    "sentTotal": 7,
    "failedTotal": 2,
    "droppedTotal": 1,
    "lastError": "..."
  }
}
```

---

## 5. 配置项（与 API/队列相关）

| 字段 | 默认 | 说明 |
|---|---|---|
| `asrBaseUrl` | `http://127.0.0.1:7880` | 留空 = 关闭 `transcribe` / `voiceAnalyze` |
| `ttsBaseUrl` | `http://127.0.0.1:7880` | 留空 = 关闭 `synthesize` / `voiceReply` |
| `asrCommand` | 空 | 外部转写命令，必须含 `{file}`；仅影响转写实现，不改变高级 API 的 501 判定 |
| `asrTimeoutMs` | `180000` | ASR 超时，超时映射 502 |
| `ttsTimeoutMs` | `180000` | TTS 超时，超时映射 502 |
| `outboxTtlHours` | `24` | 出站队列 TTL |
| `outboxDedupMinutes` | `10` | 相同 fingerprint 去重窗口 |
| `outboxFlushIntervalMs` | `10000` | 心跳补发间隔 |
| `maxImageMB` | `10` | 图片上限（含 multipart 上传） |
| `maxVoiceMB` | `20` | 语音上限（base64 兜底也受限） |

设置页「鱼讯 QQ」里有对应输入框；TTS/ASR 地址清空保存后立即生效，不需要重启。

---

## 6. 调用建议

- **只想让 DSH 说一句话/发一张图**：用底层 API，失败会入队，调用方看 `202` 即可认为「已受理」。
- **想判断高级能力是否可用**：先 `GET /api/capabilities`，不要靠猜。
- **语音回复**：优先 `voice-reply`，它会把「合成成功但 QQ 离线」降级成文字入队，恢复后重新合成。
- **补发状态**：轮询 `GET /state` 的 `outbox.pending`，或 `GET /outbox` 看明细。
- 所有接口都只在本机 Web 服务上，没有远程鉴权；不要把 DSH Web 端口暴露到公网。
