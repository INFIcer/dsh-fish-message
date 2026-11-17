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
   ├─ 语音：record → VoiceService → inbox 落盘 → 「语音：路径，N 秒」（可选附情感/背景音/转写）
   ├─ 图片：image → inbox → 图库（按 sha256 命中描述就不附原图）→ 本地识图 / DSH 附件
   ├─ 记忆扩展：图片/语音 → memory.library 只读比对 → 正文附「记忆：…」（可选，默认关）
   ├─ 表情：[表情:名字/#标签/id] → StickerStore → image 段
   ├─ 出站：session/event → [QQ] 解析 → 发送锁 → text / image / record / file
   │    └─ 失败 → Outbox（fish-message-outbox.json）→ 心跳/恢复/手动补发
   └─ 可选能力：AiService → fish.service（TTS / ASR / 识图；没有就降级）
   │
   ▼
Delivery（lib/delivery.js）
   │  agent.followup({ role:'user', source:{ kind:'qq' } })
   ▼
DSH 会话（模型照常开一轮）
```

对上提供 `fish.message` Cordis 服务（`lib/service.js`；含 `images` 图库门面，
供别的插件按需取用），设置页/诊断走 `/dsh-fish-message/*` 本地路由；
表情库另有 `lib/stickers.js`（纯磁盘逻辑）和 `lib/sticker-routes.js`（HTTP 门面）两层；
收图图库是 `lib/image-library.js`（纯磁盘逻辑）+ `lib/vision-cache.js`（识图策略）；
图库弹窗的数据路由在 `lib/gallery-routes.js`（收图图库列表/出图/改描述/打开原图）。

**职责边界：鱼讯只做 QQ 传输。** 语音和图片的基础链路（落盘、发送、补发）始终可用；
语音识别 / 合成 / 本地识图是**可选能力**，由本地 AI 插件提供的 `fish.service` 支持。
鱼讯不直连本地 AI 服务，也不把它当硬依赖：没装插件时，收发文字/图片/文件、表情、
离线补投等原有功能照常，语音相关设置灰掉，发语音时只回一句提示。

记忆扩展是另一个可选依赖：记忆插件提供的 `memory.library` 服务，只读比对入站图片与语音。
没装、抛错或超时都只跳过附注，不改变消息收发；两个底层库（收图图库、表情库）不受影响。

```text
dsh-fish-service（可选） ── fish.service.tts / asr / visionDescribe
        ▲
        │ ctx.get('fish.service') 运行时探测
        │
鱼讯 AiService（lib/ai.js） ── bridge 的入站分析 / 识图、出站合成
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
| `lib/voice.js` | 入站语音 get_record / 落盘 / 读时长；图片落盘 | 不做 ASR / TTS / 转码 |
| `lib/ai.js` | 可选本地 AI 门面：能力探测、参数校验、错误转人话 | 不实现 AI，不直连服务端口 |
| `lib/split-voice-text.js` | 长语音按句切段（纯函数） | 不改写原文、不调服务、不读配置 |
| `lib/outbox.js` | 持久化出站队列：去重、FIFO、退避、TTL、计数 | 不做网络发送 |
| `lib/delivery.js` | `agent.followup` + 附件 | 不拼消息格式 |
| `lib/stickers.js` | 表情库：索引、sha256 去重、标签、搜索、导入、清理 | 不碰 HTTP / DSH |
| `lib/sticker-routes.js` | `/stickers*` 路由：参数校验、multipart、取图防穿越 | 不实现存储算法 |
| `lib/gallery-routes.js` | 设置页图库弹窗的数据路由：收图图库列表/出图/改描述/打开原图 | 不实现存储算法，不碰记忆插件 |
| `lib/image-library.js` | 收图图库：按 sha256 存原图与描述、命中计数、上限淘汰 | 不碰 HTTP / DSH，也不认识「识图」 |
| `lib/vision-cache.js` | 入站图片的识别缓存策略：查库 / 本地识图 / 交给模型看 | 不存盘、不拼消息正文 |
| `lib/memory-extension.js` | 记忆扩展策略：开关判定、调 `memory.library` 只读比对、附注格式、超时降级 | 不写记忆库、不碰收图图库/表情库、不 import 记忆插件 |
| `lib/tools.js` | `fish_sticker_list` / `fish_sticker_send` / `fish_sticker_save` 工具定义与注册 | 不直接读写索引 |
| `lib/image-tools.js` | `fish_image_get` / `fish_image_note` 工具定义与注册 | 不直接读写索引（走 `fish.message`） |
| `lib/service.js` | `fish.message` 门面（发送/历史/语音/表情/图库） | 不重新实现发送 |

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

### 3.6 语音入站（落盘 + 可选分析）

```text
record 段
  → transport.getRecord(file, out_format=wav)
  → 拿不到则 transport.download(url) / base64:// / 本地文件
  → 存 <家目录>\fish-message-inbox\qq-voice-*
  → 读 wav 头拿时长（读不到就省略秒数）
  → "（语音：<绝对路径>，N 秒）" 交给会话
  → 可选：fish.service.asr → 同一行按顺序追加 "；情感：<短中文>；背景：<短中文>；转写：<文字>"
```

分析默认开启（`transcribeInbound`），语言由 `asrLanguage` 决定（默认 `auto`）。
服务不可用或分析失败时只记 debug 日志，路径那条消息照常递，**不会因此丢消息**。
`emotion` 映射成「中性/开心/…」短词，`events` 里挑一个非 `Speech` 的（笑声/掌声/音乐）写成「背景」，
上游没给就整段省略——旧版插件下消息与之前完全一致。
落盘失败会降级成 `[语音（保存失败：…）]`，也不会把整条消息丢掉。

### 3.7 图片入站

```text
image / mface 段
  → url 下载 / base64:// / 本地路径
  → 存 <家目录>\fish-message-inbox\qq-image-*（文件名按内容 sha16 寻址）
  → 收图图库（imageLibraryEnabled 默认开）：按 sha256 查缓存
       ├─ 命中且有描述 → 正文只用描述，不附原图
       ├─ 没有可用描述 + 表情库有同图描述 → 借用并写回收图图库
       ├─ 命中但描述为空 → 按本地识图设置重新识图，补写描述并提醒
       ├─ 未命中 + 本地识图开 → 识图成功后「原图 + 描述」入库
       ├─ 未命中 + 本地识图关 → 原图交给模型，正文提醒用 fish_image_note 写回
       └─ 识图失败 → 退回原图，不写库（下次重试）
  → 文字里附本地路径
  → delivery 用 ctx.attachments.admitPromptContent 递给会话
```

最多 4 张；超过 `maxImageMB` 跳过。

入站识图是设置项 `describeInboundImages`，取值 `inherit`（默认，跟随本地 AI 插件的
识图开关）/ `on` / `off`（强制）。开启后先调
`fish.service.visionDescribe(path, { mode:'caption', prompt })`，提示词来自设置项
`inboundImagePrompt`（空串时用内置默认），用「（图片：<描述>；已存到 <路径>）」代替
base64 附件，省会话 token。提示词只用于鱼讯自己的入站识图，作为显式覆盖参数传下去，
与本地 AI 插件的会话识图、工具识图提示词相互独立。
插件没装、没有 `visionPrefs` 或识图失败时保持「图片附件 + 路径」，不丢图。

### 3.8 收图图库（缓存语义）

```text
VoiceService.fetchImage → (buffer, path, mime, ext)
        │
        ▼
VisionCache.resolve（策略层）
        │  sha256 = sha256(buffer)
        │
        ├─ lookup 命中 + 有描述 → noteHit → { source:'cache', desc }
        ├─ 无可用描述 + 表情库有同图描述 → remember(写回描述) + noteHit → { source:'sticker', desc }
        ├─ lookup 命中 + 空描述 → 本地识图开着？setDesc + noteMiss : noteMiss，附原图
        ├─ 未命中 + 本地识图开 → remember(原图+描述) + noteMiss
        ├─ 未命中 + 本地识图关 → remember(原图+空描述) + noteMiss，附原图
        └─ 本地识图失败 → noteMiss 也不记，附原图（不写库）
        │
        ▼
ImageLibrary（存储层）
   index.json                     原子写（fs-util.writeJsonAtomic）
   img/<sha 前两位>/<sha>.<ext>   原图（imageLibraryKeepFiles 默认开）
        │
        ▼
Bridge.buildInbound：desc 非空就只写文字，空就塞图片附件 + 提醒
```

索引条目字段：`sha256 / file / ext / mime / bytes / width / height / desc / descSource /
descModel / descAt / descFirstAt / firstSeenAt / lastSeenAt / hits / misses`。
`hits` 是「拿旧描述直接用」的次数，`misses` 是「没有可用描述、只能重新认」的次数
（首次看到也算一次），两者相加就是「第几次见到」。

约束：

- **缓存语义**：超过 `imageLibraryMaxItems` / `imageLibraryMaxMB` 时按 `lastSeenAt`
  从旧到新静默淘汰，不报错、不提示。表情库是收藏语义（有标签、到上限报错、绝不静默删），
  两者刻意不合并、不共用底层。分工是：**每一张收到的图都进收图图库**（缓存），
  只有开了自动保存 `autoSaveStickers` 或被手动存下的图才进表情库（长期保存）；
  两套目录、两套索引，任一方的淘汰/删除都不影响另一方。
- **不依赖本地 AI**：图库只管「按指纹存取图 + 存取描述」，识图是可选能力。
  没装本地 AI 时，已有描述的图照常命中；只是没描述的图认不出来。
- **命中不给原图**：省 token，也避免同一张图反复占上下文。要细节时由模型主动调
  `fish_image_get`（有附件服务就返回图片块，否则给本机路径）。
- **缺描述要提醒**：入库时没有描述会写进正文提醒补；模型疏忽没填的，下次同一张图再来
  仍然没有描述，于是再次识图 / 再次提醒，不会把「空描述」当成命中。
- **回执写明来源库**：命中时 note 写「来自收图图库（缓存）…」；收图图库没有可用描述、
  而表情库里同一张图带描述时，借那条描述（只读表情库），note 写「来自表情库（这张图已存为
  表情包）…」，并把它写回收图图库，下次直接命中。两个库仍是两套存储，分工不变。
- **两份图库代码，不做抽象层**：鱼讯这份服务「QQ 收图 / 表情包」场景；记忆插件以后
  另有一份服务「用户形象 / 用户照片 / 梗图」场景。允许代码重复，不为此抽公共底层。

### 3.9 记忆扩展（可选，只读）

```text
入站图片（收图图库 / 识图之后）
  → memory.library.images.match({ buffer })      // 只算 sha256，不发图
       ├─ 命中且有描述 → 正文追加「（记忆：<描述>｜标签：a、b）」
       ├─ 命中但无描述 → 追加「（记忆：这张图在图库里〔标签：a〕，还没写描述）」
       └─ 未命中 / 服务缺失 / 抛错 / 超时 → 不追加

入站语音（recordToFile 之后）
  → memory.library.voices.identify({ wavPath })   // 音频只发给本机记忆服务
       ├─ 认出 → 追加「（记忆：声音来自<名字>，相似度 0.83）」
       └─ 认不出 / ok:false / 抛错 / 超时 → 只记日志，正文不变
```

接入方式：`host.js` 用一个惰性取值函数 `() => ctx.get('memory.library')` 把服务传给
`Bridge`，不 import 记忆插件、也不加进 `inject`；插件晚加载时下次消息仍能取到。
`MemoryExtension`（`lib/memory-extension.js`）负责开关判定、调用、格式化与超时（5 秒）。
两个分支分别受 `memoryCompareImages` / `memoryCompareVoices` 控制；总开关
`memoryExtension` 为假时连取值函数都不调用。

约束：

- **只读**：`match` / `identify` 都不写记忆库；登记图片、写描述、加声纹样本由记忆插件自己的工具完成。
- **不影响收发**：服务缺失、抛错、超时都只跳过附注，消息正文回到现状；每进程首次探测缺失只 warn 一次。
- **不共用底层**：不收图、不写鱼讯收图图库、不写表情库，也不缓存比对结果，与两者完全解耦。
- **开销**：图片只在本机算内容指纹；语音要把音频交给本机记忆服务（本地 AI），不上外网。
- **状态**：`/state` 的 `memory` 字段给设置页两条状态行（`service` / `localAI`），不另开轮询。

---

## 4. 出站流程

### 4.1 触发

`host.js` 监听 `session/event`：

- `assistant/message`：按产生顺序累积这一轮每个模型步的 assistant 正文和图片块
  （同一步重复投递按消息 id 去重；图片按内容寻址的 `attachmentId` 去重）；
- `turn/end` 且 `reason.kind === 'completed'`：如果这一轮属于绑定会话，调用
  `bridge.deliverAssistantTurn`。各步正文分别解析后再按顺序发，避免某步未闭合的
  `[QQ]` 把下一步的内部文字粘进块里。

按「会话 key + turn」去重，同一轮不会发两次。被中断（`interrupted`）的轮不发送，
已累积的内容一起丢弃（半段话可能只写了一半，也可能是被叫停的方向）。

### 4.2 解析

```text
extractOutbound(text, onlyInsideMarkers)
  ├─ parseQQBlock：转义扫描 → 块内反转义 → 多块拼接 / 未闭合容错
  └─ parseDirectives：text / tts / image / voiceFile / file / sticker 有序 token
```

`[语音]文字[/语音]` 解析成 `tts` token。发送时由 `lib/split-voice-text.js` 按 200 字
一句切成多段，原文逐段调 `fish.service.tts` 合成（朗读化由服务端统一负责）；每段的
`wavPath` 走一个 `record` 段，按顺序发出。服务不可用或能力缺失时只回一句提示，
不抛错刷屏；任意一段合成失败则整条语音都不发，不会只发出半段。

详细语法见 [`FORMAT.md`](FORMAT.md)。

### 4.3 发送

| token | 行为 |
|---|---|
| `text` | `send_private_msg`，`text` 段 |
| `image` | 本地图读 base64；网络图交 URL |
| `tts` | 按句切段 → 原文逐段调 `fish.service.tts`（朗读化由服务端做），每段转一个 `record` 段；失败只提示，同轮其它 token 照发 |
| `voiceFile` | 直接 `record` 段（已有音频文件） |
| `file` | `file` 段（NapCat 支持时） |
| `sticker` | 发送时查 `StickerStore` → 本地图片 → `image` 段；带 `stickerId` 供成功计数 |

语音发送按「本地路径 → `file:///` → `base64://`」重试，最多 3 次。

**任何 token 最终发送失败都不再丢弃**：`Bridge.sendOneItem` 把内部消息段写进持久化出站队列，
同一轮后续 token 也按顺序入队（避免后发先至），并记日志/事件。
只有「发送失败 **且** 队列写盘也失败」才会在会话里投错误提示（同一会话 60 秒最多一次）。

### 4.4 持久化出站队列

```text
正常发送 / 补发
        │
        ├─ 成功 ──────────────────────────────► 发到 QQ
        │
        └─ 失败（网络 / 5xx / retcode!=0 / 传输停止 / 补发中）
                 │
                 ▼
        Outbox.enqueue（原子写 fish-message-outbox.json）
                 │  fingerprint 去重（默认 10 分钟）
                 │  超过 1000 条丢最旧
                 ▼
        补发触发：启动 0.8s / WS 恢复 / 每 10s 心跳 / POST /outbox/flush
                 │
                 ▼
        按 createdAt FIFO，拿发送锁逐条派发
                 │
        ┌────────┴─────────┐
        │                  │
      成功               失败
        │                  │
   删除 + sentTotal++   attempts++ + failedTotal++
   日志「补发成功（积压 N 条，延迟 X 秒）」  退避 min(5s×1.8^attempts, 300s)
                           │
                    20 次 / TTL 24h / 路径失效
                           ▼
                    丢弃 + droppedTotal++ + 错误日志
```

关键约束：

- `fingerprint = sha256(qq + 规范化 segments)`；同一条消息重试不会变成多条。
- 语音只入队**已有文件路径**（`record`），不再存 `record_text`；旧版本遗留的
  `record_text` 条目补发时直接判死并提示改用 `[语音]文字[/语音]` 重新发送。
- 补发与正常发送共用 `this.sendChain`（Promise 串行锁）；补发期间或已有积压时，新消息直接入队，保持顺序。
- 补发失败一条就停，下一轮再试；不会因为积压把正常发送永久卡死（新消息仍会持久化受理，等前面的发完/丢弃后继续）。
- 队列计数写进 `fish-message-state.json` 的 `stats.outbox*`，`/state` 的 `outbox` 只读汇总。

队列状态机就是本节；`/state` 的 `outbox` 字段和设置页卡片都只是这里的只读汇总。
程序调用走 `fish.message` 服务；HTTP 路由只给设置页/诊断。

### 4.5 表情包链路

```text
入库（上传 / 入站图 / 导入 / 服务 / 工具）
        │  读图片头（GIF/PNG/JPEG/WebP/BMP）→ 宽高/帧数/时长
        │  sha256 → 已存在？只合并标签/描述
        │  否则检查上限（条数 + 总字节）→ 写 gif/ 或 img/ → 原子写 index.json
        ▼
StickerStore（index.json + 文件）
        │
        ├─ 设置页：/stickers* 路由（列表/搜索/编辑/删除/取图/最近/导入/清理）
        └─ 出站：[表情:名字] → resolve（id/文件名/#标签/模糊）
                 → image 段（data.stickerId）
                 → Bridge.dispatch（base64 发 NapCat，GIF 不动画转码）
                 → 成功后 bump(used_count++, last_used_at)
                 → 失败入 Outbox；补发成功时同样 bump
```

约束：

- 表情查询只在**发送时**发生，所以增删改表情不需要改指令；
- 找不到表情**不静默**：记日志/状态，并在会话里投提示；
- 标签命中多个时按 `used_count` 升序 + `last_used_at` 升序轮换；
- 上限到顶只报错（`sticker_limit`），不自动淘汰；
- URL 取图只允许 `stickerDir` 内、扩展名在白名单里的文件（路径穿越返回 403）。

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
- 表情取图路由只接受 `stickerDir` 内的路径（`..`、绝对路径越界一律 403）、只允许图片扩展名；
  最近图片路由只接受文件名，不接受路径；
- 图库弹窗的出图路由只接受内容指纹，文件位置由收图图库存储层按索引解析（前端不传路径）；
- 不修改本地 AI 服务、ComfyUI、`D:\dsh_ws\qq-voice`、旧桥数据文件。

---

## 8. 失败语义

| 失败点 | 行为 |
|---|---|
| WS 连不上 | 降级 HTTP 轮询；后台继续重连 |
| 历史接口失败 | 记日志/状态；下一轮重试；WS 事件仍可收 |
| DSH 会话没开 | 不推进水位；消息留在队列，下一轮重试 |
| followup 失败 | 同上，并记错误 |
| 语音落盘失败 | 消息降级为 `[语音（保存失败）]`，不丢整条；分析跳过 |
| `[语音]文字[/语音]` | 服务缺失/能力缺时只提示一句，不发语音；同轮其它内容照发 |
| 入站语音分析失败 | 只递「语音：路径」，不影响消息投递 |
| 入站图片识图失败 | 退回图片附件 + 路径，不丢图；图库不写，下次这张图重新识图 |
| 图库读写失败 | 记 warn，本次按「不复用缓存」处理（照常识图/递原图），不影响收消息 |
| 图库索引损坏 | 整份留档 `index.json.bad-*` 后从空索引继续；单条坏条目丢弃并 warn |
| 记忆服务缺失 | 记忆扩展跳过比对；每进程首次探测 warn 一次，消息照常收发 |
| 记忆比对失败 / 超时 | 记 debug，正文不加记忆附注；消息照常收发 |
| 声纹服务不可用 | 只跳过声纹比对，图像比对照常 |
| 文字/图片/文件发送失败 | 入持久化出站队列；恢复后按 FIFO 补发 |
| `record` 发送失败 | 三种 file 形态重试 3 次；仍失败存路径入队 |
| 出站队列写盘失败 | 日志报错；本次消息可能丢（磁盘满等硬故障） |
| 补发失败 | `attempts++`，退避重试；20 次或 TTL 到期丢弃并记统计 |
| 补发时音频/图片/文件已不存在 | 直接丢弃该条，报错，不重试 20 次 |
| 图片下载失败 | 文字里标 `[图片（下载失败）]`，不影响其它段 |
| 表情找不到 | 记日志/状态；会话里投「找不到表情」提示；该 token 跳过，其它 token 照发 |
| 表情库超上限 | 入库/导入返回 `sticker_limit`，提示清理；已有条目和文件不动 |
| 状态文件写失败 | 日志记错；内存继续，重启可能重投（已知风险） |

---

## 9. 可选扩展：本地 AI

### 9.1 探测方式

- **不是硬依赖**：模块顶层没有 `inject: ['fish.service']`，也没有 `requires`；
- `host.js` 在 `apply` 里创建 `AiService`，但只在真正用到能力时才调
  `ctx.get('fish.service')`；插件晚加载、服务重启都能重新取到；
- 鱼讯不直连本地 AI 服务的端口，只通过 `fish.service` 的公开方法；
- 取不到服务时 `AiService` 返回 `installed:false`，所有能力判定为不可用。

### 9.2 能力判定

`AiService` 的方法存在、且 `capabilities` 里对应项没有被标成 `available:false`，
才算可用：

| 能力 | 服务方法 | 能力键 |
|---|---|---|
| 语音合成 | `tts(text, { voice, speed })` | `capabilities.tts` |
| 语音识别 | `asr(path, { language })` | `capabilities.asr` |
| 本地识图 | `visionDescribe(path, { mode:'caption', prompt? })` | `capabilities.vision` |

`visionDescribe` 用 `typeof 服务.visionDescribe === 'function'` 防御；没有这个方法
就按「不识图」处理，不影响其它能力。`capabilities` 子项既可以是布尔，也可以是
`{ available, ready, reason }`。`status()` 汇总成
`{ installed, online, tts, asr, vision, hint }` 给设置页。

入站识图还要读插件自己的开关：`visionPrefs() → { localDescribe }`（契约 v0.4）。
同样用 `typeof` 防御；插件没装、没有这个方法、抛错或返回值不认识时一律当作
「没有偏好」（`{known:false}`），由 `inboundImageEnabled()` 按「开」兜底。
`emotion` 经 `emotionText()` 映射成短中文（未知名与缺失都是空串），`events` 经 `backgroundText()`
按「笑声 > 掌声 > 音乐」挑一个，同样以空串表示没有。
入站识图还会带上 `inboundImagePrompt`（空串用内置默认）作为显式 prompt 覆盖；
这个提示词是鱼讯自己的设置，不会改动本地 AI 插件的会话识图/工具识图提示词。

### 9.3 降级策略

| 情况 | 行为 |
|---|---|
| 没装插件 / 没启动 | 设置页「本地 AI 服务」分区顶部一行提示，控件禁用；发语音只回一句提示 |
| 服务在但能力缺失 | 只禁用对应控件；该能力调用前就返回 `not_supported`/原因码 |
| `tts`/`asr` 返回 `{ok:false}` | 取 `code` 和 `hint`，转成用户能懂的一句话，不抛原始错误 |
| 服务抛错、`lastError` 有码 | 按 `code`、`httpStatus` 映射（507 → 显存不足，503 → 模型未就绪） |
| 入站语音分析失败 | 只递语音路径，消息照常进会话 |
| 入站识图失败 | 退回「图片附件 + 路径」，不丢图 |
| 本地 AI 没装但在用收图图库 | 已有描述的图照常命中缓存；没描述的新图退回原图并提醒补描述 |
| 插件的 `visionPrefs` 调不到 | 当作没偏好，入站识图按「开」；识图失败仍退附件 |

所有能力调用都包在 `try/catch` 里，失败返回 `{ ok:false, code, hint }`。发送语音失败
时，同一轮其它内容照发；只有整轮都没发出去才在会话里投一次提示（同一会话 60 秒节流），
不会刷屏。

### 9.4 设置项

| 键 | 默认值 | 说明 |
|---|---|---|
| `sayVoice` | `dafeiyu` | 发送语音的音色；有 `voices()` 时给下拉，否则文本输入 |
| `saySpeed` | `1` | 发送语音的语速，0.5~2 |
| `transcribeInbound` | `true` | 收到语音后自动分析（文字、情感） |
| `asrLanguage` | `auto` | 分析语言：auto/zh/en/ja/ko/yue |
| `describeInboundImages` | `inherit` | 入站识图：inherit 跟随本地 AI 插件，on/off 强制；旧布尔值 true→on、false→off |
| `inboundImagePrompt` | 空串 | 入站图片/表情包识图提示词；空串用内置默认，最长 4000 字，非字符串/超长回退默认 |
| `imageLibraryEnabled` | `true` | 收图图库总开关；关掉完全退回「每次按识图设置重新识别，不查库不写库」 |
| `imageLibraryMaxItems` | `1000` | 图库条数上限，1~100000；超了淘汰最久没见到的 |
| `imageLibraryMaxMB` | `512` | 图库原图总大小上限（MB），1~102400 |
| `imageLibraryKeepFiles` | `true` | 是否在图库里存原图；关掉只留描述与尺寸 |

`sayVoice` 是鱼讯自己的发送音色，与本地 AI 插件「朗读音色」是两套独立设置，互不覆盖。
`inboundImagePrompt` 只影响鱼讯的入站识图，与本地 AI 插件的会话识图/工具识图提示词互不覆盖。
图库落在 `<DSH 家目录>/fish-message-images/`（目录固定，四个设置项都不改目录）。

---

## 10. 图库弹窗（客户端：一份模板 + 两个变体）

图库管理不是独立主面板。`client.js` 只注册一个 slot：

| slot | 注册内容 | 作用 |
|---|---|---|
| `settings.section` | `{ name: 'settings.section', id: 'fish-message', order: 56, label: () => '鱼讯 QQ' }` | 设置页分区 |

客户端 `inject` 声明 `['slots']`（package.json 的 `dsh.client.inject` 同步），不依赖
`layout.selectPanel`。设置页里「表情包」与「收图图库」两块相邻，各有「打开图库管理」；
点击只把 `Section` 的 `gallery` 设成 `'stickers'` 或 `'images'`，并且只在打开时挂载
对应的那个弹窗。两个弹窗互斥，没有页签，也不能互相跳转；关闭时把焦点还给触发按钮。

模板与变体：

| 层 | 函数 / 组件 | 职责 |
|---|---|---|
| 模板 | `GalleryModal` | 遮罩、限高面板、标题与关闭、Esc、遮罩点击、焦点、二次确认挂载；正文由 `children({ askConfirm })` 注入 |
| 模板基础组件 | `Toolbar` / `CardGrid` / `CardBody` / `DetailShell` / `GalleryBody` / `ConfirmDialog` / `StatusLine` / `EmptyState` / `LoadingState` | 工具条、卡片网格、卡片内容、详情壳、正文骨架、确认框、状态行、空态/加载态，全库共用一份 |
| 变体 | `StickerGallery` | 表情库的数据、卡片字段、详情字段与动作、库级操作 |
| 变体 | `ImageGallery` | 收图图库的数据、卡片字段、详情字段与动作、库级操作 |
| 入口弹窗 | `StickerGalleryModal` / `ImageGalleryModal` | 把标题、关闭标签和变体正文交给模板，各自只显示自己的库 |

基础交互（弹窗结构、工具条、网格、详情、确认、Esc、遮罩、焦点、空态/加载态）只改模板层
一处；变体只写差异，不复制模板代码。

数据来源与写操作：

| 弹窗 | 数据来源 | 写操作 |
|---|---|---|
| 表情库 | `/stickers*`（`lib/sticker-routes.js`） | 上传、改标签与描述、删除、发送、删除未使用、清理重复、打开文件夹 |
| 收图图库 | `GET /images`、`GET /images/file`（`lib/gallery-routes.js` → `ImageLibrary.list/lookup`） | `POST /images/note` 改描述；`POST /images/open` 打开原图；`POST /stickers/save` 存为表情；`POST /images/clear` 清空；`POST /open-folder` 打开文件夹 |

约定：

- **弹窗只有两个库**：记忆图库与声纹库的页面归记忆插件（`memory.library` 服务仍只用于
  入站记忆扩展比对，见 3.9）；鱼讯不再注册 `/memory/*` 路由，客户端也不引用记忆服务。
- **没有页签**：两个库各是一个弹窗，入口按钮只开自己那个；弹窗不显示另一个库，也不能互跳。
- **Esc 与遮罩**：Esc 在 document 捕获阶段拦截并 `preventDefault` / `stopPropagation` /
  `stopImmediatePropagation`，只关当前弹窗，不触发宿主设置弹窗的 Esc；二次确认打开时只关确认框。
- **出图只认指纹**：`/images/file` 只接受 `sha256`，文件位置由收图图库存储层按索引解析，
  前端不传路径，不会越出图库目录。
- **配置只有一份**：表情包与收图图库的配置项留在设置页；弹窗里的收图图库不重复一份配置，
  只展示数据并提供清空 / 打开文件夹。
- **缓存与收藏互不影响**：「存为表情」固定用条目原图绝对路径 + `source=qq-inbox` 调
  `/stickers/save`，同图已在表情库时只合并描述；删缓存条目不碰表情库，反之亦然。
- **旧入口已删**：「最近收到的图片」列表与「清空最近图片」按钮不再出现在客户端；
  `/stickers/recent` 与入站缓存清理仍保留给后端诊断/清理使用。
