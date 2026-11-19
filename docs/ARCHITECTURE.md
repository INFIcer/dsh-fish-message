# 架构：dsh-fish-message

## 1. 总览

```text
QQ 客户端 ──QQ 协议──► NapCat（OneBot 11）
                          │  HTTP send_private_msg / get_friend_msg_history / get_record
                          │  WebSocket 事件推送
微信（iLink / ClawBot）──► 微信适配器（wechat-ilink）
                          │  扫码登录 + getupdates 长轮询 + sendmessage
                          ▼
RouterTransport（lib/transport/router.js）
   │  按 channel 路由：qq → napcat-onebot，wechat → wechat-ilink（见 2.1）
   │  对外仍是一个 transport：start / stop / sendMessage / fetchHistory / download / getRecord
   ▼
Bridge（lib/bridge.js）
   ├─ 入站：过滤私聊 → 编辑窗口（合并批次 / 撤回）→ 去重 → 水位 → 补投
   ├─ 语音：record → VoiceService → inbox 落盘 → 「语音：路径，N 秒」（可选附情感/背景音/转写）
   ├─ 图片：image → inbox → 图库（按 sha256 命中描述就不附原图）→ 本地识图 / DSH 附件
   ├─ 记忆扩展：图片/语音 → memory.library 只读比对 → 正文附「记忆：…」（可选，默认关）
   ├─ 峰时（可选）：fish.token 报峰时 → 这一批不投会话，收进非紧要任务队列（见 3.10）
   ├─ 表情：[表情:名字/#标签/id] → StickerStore → image 段
   ├─ 出站：session/event → [MSG] 解析 → 发送锁 → 待发记录落盘 → 节奏等待 → text / image / record / file
   │    ├─ 成功 → 删除待发记录
   │    ├─ 失败 → Outbox（fish-message-outbox.json）→ 心跳/恢复/手动补发
   │    └─ 进程在等待中退出 → Inflight（fish-message-inflight.json）→ 启动时回放
   ├─ 可选能力：AiService → fish.service（TTS / ASR / 识图；没有就降级）
   └─ 余额提醒（可选）：fish.token.subscribe(balance-low) → 当前送信渠道（见 4.6）
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

**职责边界：鱼讯只做消息通道的传输。** 目前两条：QQ（NapCat / OneBot 11）与微信
（iLink / ClawBot，单聊）。微信受协议限制：必须先收到过对方的消息拿到 `context_token`
才能回复、不能主动开始会话、没有历史消息接口。语音和图片的基础链路（落盘、发送、补发）始终可用；
语音识别 / 合成 / 本地识图是**可选能力**，由本地 AI 插件提供的 `fish.service` 支持。
鱼讯不直连本地 AI 服务，也不把它当硬依赖：没装插件时，收发文字/图片/文件、表情、
离线补投等原有功能照常，语音相关设置灰掉，发语音时只回一句提示。

记忆扩展是另一个可选依赖：记忆插件提供的 `memory.library` 服务，只读比对入站图片与语音。
没装、抛错或超时都只跳过附注，不改变消息收发；两个底层库（收图图库、表情库）不受影响。

计价与余额是第三个可选依赖：fish-token 插件提供的 `fish.token` 服务（契约版本 1）。
鱼讯只按契约调用，不 import 对方代码、不加 `inject`：峰时把入站消息收进对方的非紧要
任务队列并发一条渠道提醒；余额跌破阈值时把提醒转发到当前送信渠道。服务不存在时这两项
完全不可用，收发行为与没装之前一模一样（见 3.10、4.6、13）。

```text
dsh-LocalAIService（可选） ── fish.service.tts / asr / visionDescribe
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
| `lib/bridge.js` | 队列、编辑窗口、合并投递、撤回、去重、水位、补投、出站解析调度 | 不直接碰 DSH API（通过 delivery） |
| `lib/transport/base.js` | 适配器接口定义 | 不实现协议 |
| `lib/transport/napcat-onebot.js` | OneBot HTTP/WS、断线重连、历史 | 不做业务去重 |
| `lib/format.js` | `[MSG]` 块、转义、显式指令 | 不发送 |
| `lib/queue.js` | 每个聊天的入站缓冲：乱序排序、编辑窗口、按 id 撤回删除 | 不做持久化，不合并正文 |
| `lib/pacing.js` | 出站节奏：字数口径、最小间隔、可注入的 sleep/now | 不发消息、不改顺序、不读网络 |
| `lib/storage.js` | 水位 / seen / 统计 / 最近事件 / 送信渠道 | 不做网络 |
| `lib/voice.js` | 入站语音 get_record / 落盘 / 读时长；图片落盘 | 不做 ASR / TTS / 转码 |
| `lib/ai.js` | 可选本地 AI 门面：能力探测、参数校验、错误转人话 | 不实现 AI，不直连服务端口 |
| `lib/split-voice-text.js` | 长语音按句切段（纯函数） | 不改写原文、不调服务、不读配置 |
| `lib/outbox.js` | 持久化出站队列：去重、FIFO、退避、TTL、计数 | 不做网络发送 |
| `lib/inflight.js` | 「发送前等待」期间的待发记录：落盘、按 token/段收敛、启动回放、TTL | 不做网络发送，不做退避（失败转 Outbox） |
| `lib/delivery.js` | `agent.followup` + 附件 | 不拼消息格式 |
| `lib/stickers.js` | 表情库：索引、sha256 去重、标签、搜索、导入、清理 | 不碰 HTTP / DSH |
| `lib/sticker-routes.js` | `/stickers*` 路由：参数校验、multipart、取图防穿越 | 不实现存储算法 |
| `lib/gallery-routes.js` | 设置页图库弹窗的数据路由：收图图库列表/出图/改描述/打开原图 | 不实现存储算法，不碰记忆插件 |
| `lib/image-library.js` | 收图图库：按 sha256 存原图与描述、命中计数、上限淘汰 | 不碰 HTTP / DSH，也不认识「识图」 |
| `lib/vision-cache.js` | 入站图片的识别缓存策略：查库 / 本地识图 / 交给模型看 | 不存盘、不拼消息正文 |
| `lib/memory-extension.js` | 记忆扩展策略：开关判定、调 `memory.library` 只读比对、附注格式、超时降级 | 不写记忆库、不碰收图图库/表情库、不 import 记忆插件 |
| `lib/token-link.js` | 计价/余额的可选接入层：惰性取 `fish.token`、峰时判定、任务入队、提醒冷却、余额提醒转发 | 不自己算峰谷、不发消息（走 Bridge）、不 import fish-token |
| `lib/tools.js` | `fish_sticker_list` / `fish_sticker_send` / `fish_sticker_save` 工具定义与注册 | 不直接读写索引 |
| `lib/image-tools.js` | `fish_image_get` / `fish_image_note` 工具定义与注册 | 不直接读写索引（走 `fish.message`） |
| `lib/service.js` | `fish.message` 门面（发送/历史/语音/表情/图库） | 不重新实现发送 |
| `lib/transport/router.js` | 通道路由：按 channel 分发到各适配器、聚合连接状态、运行时增删通道 | 不实现任何协议，不改消息内容 |
| `lib/transport/wechat-ilink.js` | 微信 iLink：扫码登录、长轮询收消息、加密上传与发送 | 不做业务去重（交给 Bridge），不做 SILK 编解码 |
| `lib/peer.js` | 通道维度的对端标识：规整、校验、`channel:peer` 键、水位键 | 不认识具体协议 |

### 2.1 通道维度（qq / wechat）

内部键统一是 `${channel}:${peer}`（`lib/peer.js`）。同一段对端字符串在两条通道下是两个人：
QQ 的 `10086` 与微信的 `10086` 必须分别排队、去重、记水位、绑定会话。键里不带通道，
共用一份 seen / 水位 / 队列就会串聊。对端键同时决定绑定索引（`Bridge.byPeer`）与水位键
（qq 沿用裸号以兼容老状态文件，微信带 `wechat:` 前缀）。

路由由 `RouterTransport` 做，规则是**按调用方给的 channel 显式路由**：

- Bridge 的每个发送/补拉调用都带 `{ channel }`（绑定时就知道是哪条通道）；
- 没给 channel 才按对端形态兜底：纯数字 → qq，其它形态找非 qq 的通道；
- 路由不到就抛明确错误（说明哪条通道没启用），不静默成功——静默成功等于消息丢了还被算作送达。

为什么不按对端形态当主路由：wxid / openid 与 QQ 号都没有可判别的类型标记，猜错就是把消息
发给另一个人。形态兜底只留给「调用方确实不知道通道」的旧接口。

三条来自微信协议的约束（不是实现偷懒）：

- **没有历史接口**：iLink 只给一个不透明游标 `get_updates_buf`，掉线期间的消息由服务端在
  游标之后重投（at-least-once），所以 `fetchHistory` 恒返回空数组。Bridge 的 HTTP 补拉因此
  只对 QQ 有意义（`transportNeedsPoll()` 只看 QQ 那一路是否在线）。
- **能不能发 ≠ 连接在不在**：`sendmessage` 必须带最近一次入站消息里的 `context_token`。
  没有锚点（从没收到过对方的消息）就是发不出去，适配器明确抛错，消息进 Outbox 等能发时再补。
- **语音方向不对称**：微信语音是 SILK，出站 v1 不支持（明确报错）；入站不解码，用服务端
  已给的 `voice_item.text` 转写。所以 `getRecord` 只转给 QQ，`record` 段里的 `data.file`
  只可能来自 QQ。

聚合状态口径（`RouterTransport.getStatus()`）：`connected` = 任一通道在线；`mode` =
只有一路活着时透出它的 mode、多路为 `multi`、全停为 `stopped`。Bridge 靠 `mode === 'stopped'`
判断「传输层停了，先入队」，靠 `connected` 与各通道分项判断要不要停 HTTP 补拉，这两个口径不能改。

---

## 3. 入站流程

### 3.1 事件来源

- **WebSocket**：NapCat 推 `post_type=message`、`message_type=private`；
  同一条连接也推 `post_type=notice`（好友撤回 `friend_recall`，见 3.3.1）；
- **HTTP 轮询**：WS 不可用时，Bridge 每 `pollIntervalMs` 调 `fetchHistory`；
- **定时补投**：即使 WS 连着，每 `historyIntervalMs` 也拉一次历史；
- **WS 重连后**：立即补一次历史；
- **微信通道**：没有 WS、没有历史接口，消息由适配器自己的长轮询拉回来，直接走 `onEvent`
  交给 Bridge，不进 HTTP 补拉（见 2.1）。

### 3.2 过滤

只保留：

- `message_type === 'private'`（v1 不处理群）；
- `user_id === 绑定 QQ`（过滤自己发出去的消息、过滤别人）；
- 有 `message_id`。

### 3.3 队列、编辑窗口与合并投递

`MessageQueue` 按聊天分组，收到消息后先暂存、按 `time → message_seq → message_id`
升序排好，等**最后一条消息的编辑窗口**过去后再交给上层。

编辑窗口（`inboundEditWindowMs`，默认 15000 毫秒，范围 0~120000；0 = 关闭）：

- **静默期的计时基准是消息自带的发送时间戳**（OneBot 的 `time`，秒），不是「拉到这
  条消息的时刻」。离线补拉的历史可能已经很旧：按拉到时刻算，会把早该过期的消息当成
  新消息压住窗口；按发送时间算，窗口已经过期的旧消息会立刻投递。
- 每来一条新消息，静默期从「这一条的发送时间」重新往后算；乱序到达的旧消息不会把
  窗口往回拉（基准只往前走）。时间戳缺失（0）时才退回到达时刻。
- 窗口开着时**没有最长等待上限**：旧的 `maxWaitMs`（6 秒）会把 15 秒窗口截断。
- 窗口关掉（0）时完全退回旧行为：等 `reorderBufferMs`（默认 1.5 秒）后投，并保留
  `maxWaitMs`（默认 6 秒）防止有人一直发导致永远不 flush。

窗口到点后，这一批消息再按**消息时间**切成若干组：相邻两条时间差 `< 窗口` 同组，
`>= 窗口` 另起一组；每组合并成**一条**递进 DSH：

```text
A(10:00:00) → 撤回 A                  → 队列空，窗口到期什么也不投
A(10:00:00) → B(10:00:01) → 撤回 A    → 只投 B

离线 → 发 A、B（同一分钟）→ 发 C（十分钟后）→ 上线
  → 历史里 A 已被撤回、不存在；B 与 C 的时间差 >= 窗口 → 分两批投
  → 「B 的正文」「C 的正文」各一条，不丢消息
```

合并口径：

- 正文按时间顺序用换行 `\n` 拼接（空正文不占行）；图片按顺序汇总进同一条消息的附件；
- 合并只发生在「投递」这一层：每条消息的 `seen`、水位、统计（received/delivered）、
  `recordEvent` 仍逐条处理；
- 合并批次 `meta.messageId` 取**最后一条**（也是水位停在那一条），文档与测试都按这个口径；
- 暂停转发时**按条**存进待转发队列（待转发队列按条限 4 张图，合并会把多图批次截掉），
  恢复后逐条补投。

投递失败时整组（连同后面还没投的组）重新入队，下一轮重试；重排队时至少再等一个
窗口（`notBefore`），否则按旧发送时间算早已过期，会立刻重试、空转。

同一 `message_id` 在队列里只留一份；已处理的 id 进入持久化 `seen` 集合。

#### 3.3.1 撤回（仅 WebSocket 可见）

- 事件：`post_type="notice"`、`notice_type="friend_recall"`；`user_id` 是对方 QQ，
  `message_id` 是被撤回的那条，载荷里没有正文；
- 只处理已绑定 peer；`group_recall` 等其它撤回本期不处理（v1 只有私聊）；
- 还在队列里（编辑窗口内）→ 直接从待投队列删掉；删空就清定时器、不产生空批次；
- 已经在投递中或已投递 → 撤不回来，只记日志；
- 被撤回的消息从未投递，所以不进 `seen`、不推进水位；
- **HTTP 历史接口拿不到撤回通知**（被撤回的消息直接从历史里消失），所以撤回识别
  必须开 WebSocket；NapCat 侧要开「WS 正向服务器」（见 5）。WS 连不上时编辑窗口
  逻辑照常按轮询数据工作，只是识别不了撤回。

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
4. 在 `backfillWindowHours` 内的走入站队列：按消息时间戳判断编辑窗口，早已过期的
   立刻投；一次补多批时按「相邻时间差 >= 编辑窗口」分组，各组合并成一条投（见 3.3）；
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
       ├─ 命中且有描述 → 正文只用描述，不附原图（noteHit）
       ├─ 没有可用描述 + 表情库有同图描述 → 借用并写回收图图库（noteHit）
       ├─ 第一次见到（图库里没有这条）→ 只登记原图（空描述）+ noteMiss，附原图，不识图
       ├─ 第二次及以后 + 本地识图开 → noteHit，识图成功 setDesc 后只给描述；失败附原图
       ├─ 第二次及以后 + 本地识图关 → noteHit，附原图，不要求补描述
       └─ 图库总开关关 → 每次按设置识图，不查库也不写库
  → 文字里附本地路径
  → delivery 用 ctx.attachments.admitPromptContent 递给会话
```

最多 4 张；超过 `maxImageMB` 跳过。

入站识图是设置项 `describeInboundImages`，取值 `inherit`（默认，跟随本地 AI 插件的
识图开关）/ `on` / `off`（强制）。它只在同一张图第二次及以后出现、且图库里还没有描述时
才生效：调 `fish.service.visionDescribe(path, { mode:'caption', prompt })`，提示词来自设置项
`inboundImagePrompt`（空串时用内置默认），用「（图片：<描述>；已存到 <路径>）」代替
base64 附件，省会话 token。第一次见到不调识图。提示词只用于鱼讯自己的入站识图，作为显式
覆盖参数传下去，与本地 AI 插件的会话识图、工具识图提示词相互独立。
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
        ├─ 未命中 → remember(原图 + 空描述, descSource:'deferred') + noteMiss
        │              → { source:'deferred', 附原图 }（第一次只登记，不识图）
        ├─ 命中 + 空描述 → noteHit
        │    ├─ 本地识图开 → 识图成功 setDesc(descSource:'local') → { source:'local', desc }
        │    ├─ 本地识图关 → { source:'deferred', 附原图 }
        │    └─ 本地识图失败 → { source:'none', 附原图 }（命中已记，下次再试）
        │
        ▼
ImageLibrary（存储层）
   index.json                     原子写（fs-util.writeJsonAtomic）
   img/<sha 前两位>/<sha>.<ext>   原图（imageLibraryKeepFiles 默认开）
        │
        ▼
Bridge.buildInbound：desc 非空就只写文字，空就塞图片附件 + 一句状态说明（不催补描述）
```

索引条目字段：`sha256 / file / ext / mime / bytes / width / height / desc / descSource /
descModel / descAt / descFirstAt / firstSeenAt / lastSeenAt / hits / misses`。
计数不变式：每次「见到」恰好让 `hits` 或 `misses` 其中之一 +1。
`misses` 是第一次登记的次数（真正第一次见到这张图）；`hits` 是之后每次见到的次数，
包括已有描述直接命中、缺描述等下次再识别。两者相加就是「第几次见到」，从 1 开始、每次 +1。
界面上的「命中 N 次」读 `hits`，就是真实复用次数（第一次见到不算命中）。
唯一例外是表情库兜底：第一次见就借到描述时描述当场可用，那一次记 `hits`。

约束：

- **缓存语义**：超过 `imageLibraryMaxItems` / `imageLibraryMaxMB` 时按 `lastSeenAt`
  从旧到新静默淘汰，不报错、不提示。表情库是收藏语义（有标签、到上限报错、绝不静默删），
  两者刻意不合并、不共用底层。分工是：**每一张收到的图都进收图图库**（缓存），
  只有开了自动保存 `autoSaveStickers` 或被手动存下的图才进表情库（长期保存）；
  两套目录、两套索引，任一方的淘汰/删除都不影响另一方。表情库/表情包照旧：
  存表情时仍要求填描述，不套用收图图库「第一次只登记、不识别」的策略。
- **不依赖本地 AI**：图库只管「按指纹存取图 + 存取描述」，识图是可选能力。
  没装本地 AI 时，已有描述的图照常命中；没描述的图第二次出现时也只能直接看图。
- **命中不给原图**：省 token，也避免同一张图反复占上下文。要细节时由模型主动调
  `fish_image_get`（有附件服务就返回图片块，否则给本机路径）。
- **第一次只登记**：收图大多不会反复使用，第一次见到不调识图、不写描述，也不在正文里
  要求补描述；同一张图第二次出现时才按设置补描述。本地识图关着就一直直接给原图。
  这样不会为每张新图都付一次识图成本，描述只在这张图真正复用时才产生。
- **命中次数即复用次数**：首次登记记 `misses`，之后每次见到记 `hits`；图库详情里的
  「命中 N 次」随重复出现增长，第一次见到不算命中。
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

### 3.10 峰时转任务队列（可选，fish.token）

峰时收到的消息不投进会话，而是收进 fish-token 的非紧要任务队列，谷时再处理。
**只改「转入会话」这一步**：队列、编辑窗口、合并、撤回、去重、水位、多通道、
粘性送信渠道全部照旧。

```text
入站一批（合并后）→
  ├─ forwardPaused → 待转发队列（旧逻辑，优先级更高）
  ├─ peakDeferEnabled=false / fish.token 不存在 → 直接投递进会话（旧行为）
  ├─ getPricing() 明确谷时 → 直接投递进会话
  ├─ 正文 trim 后以【紧要】开头 → 去掉标记，直接投递进会话
  └─ 峰时 → enqueueTask({ prompt, sessionKey, channel, peer, source:'fish-message' })
        ├─ ok   → 记 seen / 水位 / received，回一条渠道提醒（受冷却）
        └─ 失败 → 记 warn，退回直接投递进会话（消息绝不丢）
```

判定只来自 `fish.token.getPricing()`：鱼讯**不自己算钟点、周末或节假日**（官方窗口会随
法定节假日 / 调休变化，自己算必然对不上；现行规则见 fish-token 的实现，鱼讯只消费结论）。

- **拿不到怎么算**：服务或方法不存在 = 功能不可用 → 直接投递（旧行为）；服务在但查询
  抛错、返回形状不对（拿不到时段）→ 按最保守的**峰时**处理（走入队，入队失败再退回投递）。
- **【紧要】只认开头**：`text.trim().startsWith('【紧要】')`，去掉这三个字后投递；正文
  只剩标记时保留原文（否则变成空消息投不进会话）。服务不可用时标记原样保留，与旧版一致。
- **提醒**：默认文案见 `lib/config.js` 的 `defaultPeakNotice`；`peakNoticeTemplate` 可改，
  支持 `{offPeakStart}` / `{offPeakEnd}`（填 fish.token 给的下一段谷时起止时刻；
  拿不到就整段回退内置默认，默认文案不含占位符）。提醒走正常出站链路（失败进 Outbox 补发）。
- **冷却**：同一 `channel:peer` 的提醒按 `peakNoticeCooldownMinutes`（默认 30 分钟，0 = 不冷却）
  冷却，从**发出提醒的时刻**起算；冷却期内消息照样入队，只是不再重复提醒。
- **没进会话的那一批**：`seen` / 水位 / `received` / `recordEvent`（文本前缀 `[峰时转任务]`）
  仍按每条记，`delivered` 不计；`received` 事件带 `deferred:true`。
  同时把送信渠道设为这条 —— 任务稍后跑起来时，回复要回到同一个渠道。
- **图片**：`enqueueTask` 只有正文参数，这一批的图片附件不会转交；正文里仍有图片的本地路径
  / 描述（见 3.7），所以信息不会凭空消失。
- **超时**：入队等 `tokenTimeoutMs`（默认 800ms，见 `lib/token-link.js`），超时按入队失败处理。

---

## 4. 出站流程

### 4.1 触发

`host.js` 监听 `session/event`：

- `assistant/message`：按产生顺序累积这一轮每个模型步的 assistant 正文和图片块
  （同一步重复投递按消息 id 去重；图片按内容寻址的 `attachmentId` 去重）；
- `turn/end` 且 `reason.kind === 'completed'`：如果这一轮属于绑定会话，调用
  `bridge.deliverAssistantTurn`。各步正文分别解析后再按顺序发，避免某步未闭合的
  `[MSG]` 把下一步的内部文字粘进块里；一步里的多个 `[MSG]` 块也各自独立，
  一块 = 一条（组）消息，不会被拼成一段。

按「会话 key + turn」去重，同一轮不会发两次。被中断（`interrupted`）的轮不发送，
已累积的内容一起丢弃（半段话可能只写了一半，也可能是被叫停的方向）。

一间会话可以挂多条绑定，但一轮回复只发一条：`deliverAssistantTurn` 用
`pickSessionBinding` 选唯一目标，而目标由**这间会话的送信渠道**决定。

送信渠道是粘性的，落在状态文件的 `replyTargets` 里（会话键 → `{channel, peer, at}`，
最多 200 条、按 `at` 淘汰最旧），所以跨回合、跨进程重启都保持。只有两种事件改变它
（`Bridge.setReplyTarget` / `clearReplyTarget` / `replyTargetFor`）：

1. **渠道消息投递成功**（正常入站投递与暂停转发后的补发都算）→ 设为这条 `(channel, peer)`；
2. **用户在 Web GUI 里直接发言**（`user/message` 且 `source.kind === 'user'`）→ 清空，
   之后这一轮及后续都不往任何渠道发，直到渠道里再来消息。

其它一切输入都不改变渠道，回复继续走上一次渠道：定时提醒 / 重启通知（`schedule`）、
子代理消息（`agent-message`、`subagent-settled`）、上下文注入（`runtime-context`、
`compact-checkpoint`、`cordis-host-runner`、`session-reference`、`plan-mode`、`goal`、
`webhook`、`skill-invocation`、`ptc-mode`、`user-question-reply`、`retry`、`action-cards`、
`model` / `tool` / `system-prompt` 等）。「QQ 来消息 → 回 QQ；随后一条重启通知 →
仍回 QQ；再来微信消息 → 回微信」就是预期行为。

回合开始（创建 `currentTurn`）时把当时的渠道快照进这一轮，`turn/end` 用快照出站：
生成期间另一条渠道进来，也不会把这一轮的回复改发到新渠道。

**没有渠道 = 从没收到过渠道消息，或已被直接发言清空**：整轮跳过、不进 Outbox，只记一行
日志「本轮没有送信渠道，跳过发送」。渠道还在、但对应绑定已被删或改得对不上，同样跳过。
**绝不广播、也不退回默认渠道**。

### 4.2 解析

```text
extractOutboundBlocks(text, onlyInsideMarkers)
  ├─ parseQQBlock：转义扫描 → 块内反转义 → 按出现顺序逐块返回 / 未闭合容错
  └─ 每块单独 parseDirectives：text / tts / image / voiceFile / file / sticker 有序 token
```

块与块之间不合并文字、也不共享指令解析：一块就是一条（组）消息，块序就是发送顺序。
关掉「只发块内」时整条正文算一块。assistant 图片附件不属于任何块，各自单独成组追加在最后。

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

发送按「块顺序 → 块内 token 顺序」逐条进行；每个 token 是一条独立 QQ 消息（一个块里有
文字 + 图片时就是多条，顺序不变）。

语音发送按「本地路径 → `file:///` → `base64://`」重试，最多 3 次。

**发送节奏**（`outboxPerMessageDelayMs` 默认 2000、`outboxPerCharDelayMs` 默认 100）：
每个 QQ 消息段（= 一个聊天气泡）发出前与「上一条真正发出的时刻」比一次——距上一条
已经隔够「固定间隔 + 字数 × 逐字间隔」就立刻发，不够只补等差的那一段。

- 字数口径在 `lib/pacing.js`：中文/日文/韩文每字 1；英文等拼音文字连续一串算 1 个词；
  连续数字串算 1；标点、空格、符号、emoji 各 0.2；图片、文件、语音文件段算 0；
  语音文本（`record_text`）按文本算。字数按「十分之一个字」整数累计，避免浮点尾巴。
- 间隔基准是 `OutboundPacer.lastSentAt`：所有绑定共用一条发送串行锁，所以是进程内的
  一条流；`Bridge.dispatch` 每段发送成功后 `markSent()` 刷新。它是「发出时刻」而不是
  「开始发」：图片上传这类慢发送也算在上一条的时间点里。进程重启归零，重启后的第一条
  不再等——停机本身已经把间隔拉开了。
- 等待发生在发送串行锁里（`Bridge.dispatch`）：顺序不变，也不阻塞收消息；
  正常回复、补发、语音、图片都走这里，节奏一致。
- 进等待前先把「还没发出去的这条消息」写进待发记录（见 4.4.1），`dueAt` 就是这条的
  最早可发时刻（距上一条已隔够时就是当时），发送成功后立刻删。
- 等待按「段」计：多个 `[MSG]` 块 = 多条消息 = 分开算间隔，各自按自己块内的字数算，
  不会按合并后的整段字数只等一次。
- 两个设置都给 0 就完全不等，也不写待发记录（行为与旧版一致）；
  `sleep` / `now` 可注入，测试不会真等。

**任何 token 最终发送失败都不再丢弃**：`Bridge.sendOneItem` 把内部消息段写进持久化出站队列，
同一轮后续 token 也按顺序入队（避免后发先至），并记日志/事件。入队只包含**还没发出去的**
段落：`Bridge.dispatch` 在错误上记下已送达的段数，已经发出去的气泡不会在补发时重发。
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

#### 4.4.1 发送前等待与重启恢复

出站节奏的等待发生在**落盘之前**是丢消息的根源：等待期间消息只在内存里，进程被杀后
既不在 QQ 上，也不在 Outbox 里。所以正常发送多了一步：

```text
正常发送 / 一轮多段
        │
        ├─ 进入节奏等待前 → Inflight.add（原子写 fish-message-inflight.json）
        │       │  dueAt = 最早可发时刻（距上一条已隔够时就是当时）；一轮多段时记录剩余 token
        │       ▼
        │   等待 → 发送 → 成功后立刻删记录
        │
        └─ 发送失败 → 删记录 + 剩余部分进 Outbox（退避/去重照旧，不在两边各留一份）
```

记录有两种形状：

| 形状 | 谁写 | 回放时 |
|---|---|---|
| `tokens: [...]` | `deliverAssistantTurn`：一轮里还没解析的 `[MSG]` token | 按原顺序逐个解析、发送；每完成一个就把记录缩到剩余 token |
| `segments: [...]` | `sendOutbound` 直发：已经解析好的消息段 | 按 dueAt 等到点，发完后删除；失败仍转 Outbox |

一轮里当前 token 的 `segments` 可以与后半轮 token 的 `tokens` 同时存在：先补当前消息
还没发出的段（每段发送前收敛一次），再继续后面的 token。语音合成多段时，崩溃也就只补
剩下的语音条，而不是整条重来。

启动流程（`Bridge.start`）：

1. 启动约 800ms 后先 `replayInflight('startup')`，再 `flushOutbox('startup', { force: true })`；
2. 回放按 `seq` 顺序逐条处理，遵守记录里的 `dueAt`：只补等剩余时间，不把已经等过的
   时间再等一遍；
3. 整个回放阶段拿一把发送锁，期间新消息排队，不会插到旧消息前面；Outbox 已有积压时，
   待发记录直接排到队尾；
4. 发送失败仍走 `sendOneItem` 的入队逻辑，然后删待发记录；入队也失败时保留记录，
   下次启动再试；
5. 超过 TTL（与 Outbox 同一个 `outboxTtlHours`，默认 24 小时）的记录丢弃并计入
   `droppedTotal`。

语义是**至少一次投递**：真正发送成功、删除记录两步之间进程被杀时，重启会重发这一条。
窗口只落在「已实际发出、尚未删除记录」这一小段；正常路径和优雅停止不会重复发送。
一条消息多段时，`dispatch` 每段发送前把记录收敛成「从当前段开始的剩余段」，
所以崩溃后只补发没发出去的气泡。两个间隔都是 0 时不写记录，行为与旧版完全一致。

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

### 4.6 余额提醒转发（可选，fish.token）

装配时 `ctx.get('fish.token')`，有 `subscribe` 就订上（返回的取消函数交给 `ctx.effect` 保存，
卸载时调用）；没有服务、没有 `subscribe` 就只记一条 debug，什么都不做。

```text
event { type:'balance-low', threshold, balance } →
  ├─ 两个开关都关 → 什么都不发
  ├─ 同一阈值 30 分钟内已转过 → 跳过（防刷屏）
  ├─ 当前送信渠道（replyTargets 里最近更新的一条）不存在 → 跳过，绝不退回默认渠道
  ├─ 文字开 → Bridge.sendText → 失败自动进 Outbox 补发
  └─ 表情开 → 走 fish_sticker_send 同一条路（StickerStore → Bridge.sendOutbound）
       └─ 名字空 / 发送失败 → 文字已先发出就不重复补；文字关着只记 warn
```

- 目标只看**粘性送信渠道**：状态文件 `replyTargets` 里 `at` 最大的那条
  （`StateStore.latestReplyTarget` → `Bridge.latestReplyTarget`）；没有就跳过。
- 两个开关互相独立：`balanceAlertMessageEnabled`（默认开）发文字、`balanceAlertStickerEnabled`
  （默认关）发表情；两个都关 = 不提醒。都开时顺序固定「先文字、后表情」，任一失败不影响
  另一项，日志分别记。
- 旧配置只有 `balanceAlertMode` 时按迁移表展开：`off` → 都关、`message` → 只文字、
  `sticker` → 只表情；配置里一旦出现任一新键，旧键就不再参与。
- 文案：`balanceAlertTemplate`（`{balance}` 换成两位小数），留空用 `defaultBalanceAlert`。
- 表情：`balanceAlertSticker` 是名字 / `#标签` / id；留空时本次只发文字。
- 去重窗口固定 30 分钟（`balanceAlertDedupMs`），与峰时提醒的冷却互不相干。
- 时段切换事件（`period-switch`）本插件不转发，只认 `balance-low`。

---

## 5. 连接与重连

### WebSocket

- 启动时若 `wsEnabled`，连 `wsUrl`（留空时从 HTTP 地址推导）。NapCat 的「WS 正向
  服务器」通常和 HTTP 端口分开（例如 HTTP `127.0.0.1:3000`、WS 正向服务器
  `127.0.0.1:3001`），这时要把「实时接收地址」显式填成 `ws://127.0.0.1:3001`；
- WS 只用来**消费事件**：`post_type=message` 与 notice 里的撤回；发消息、拉历史
  等 API 调用仍走 HTTP，HTTP 轮询保持原样；
- 断开后指数退避：1s → 2s → 4s … 最多 30s，加 0–500ms 抖动，连上后立即
  `sync('ws-connected')`；
- WS 连接期间也会每 `historyIntervalMs` 拉一次历史兜底；WS 事件与历史补投可能拿到
  同一条消息，按 `message_id` 去重（`seen` + 队列内去重 + 处理中集合），不会重复投递；
- 撤回识别依赖 WS：`wsEnabled=false` 时编辑窗口照常工作，只是识别不了撤回。

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
   `message_id/time/user_id/message[]`），并填 `channel` 标记；
3. 在 `lib/peer.js` 的 `PEER_CHANNELS` 里登记通道，补上该通道的对端规整与校验——
   **只写 transport 不够**：同一段对端字符串在两条通道下是两个人，键、水位、去重、
   绑定索引都靠 `channel:peer` 分桶，身份归一化必须按通道走（见 2.1）；
4. 在 `host.js` 里把适配器接到 `RouterTransport` 的 resolve（按配置决定建不建），
   需要运行时增删通道（扫码登录这类）走 `router.attach / detach`；
5. `Bridge`、去重、水位、补投、DSH 投递完全不用改。

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
- 出站默认只发 `[MSG]` 块内，块外解释/路径/思考留在本地；
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
| 入站图片识图失败 | 退回图片附件 + 路径，不丢图；描述不写，命中计数照记，下次再试 |
| 图库读写失败 | 记 warn，本次按「不复用缓存」处理（照常识图/递原图），不影响收消息 |
| 图库索引损坏 | 整份留档 `index.json.bad-*` 后从空索引继续；单条坏条目丢弃并 warn |
| 记忆服务缺失 | 记忆扩展跳过比对；每进程首次探测 warn 一次，消息照常收发 |
| 记忆比对失败 / 超时 | 记 debug，正文不加记忆附注；消息照常收发 |
| 声纹认不出（低于阈值） | 正文标「声音没认出来，标为陌生人」；日志记最高分、阈值、最像的人 |
| 声纹服务不可用 | 只跳过声纹比对（不标身份），图像比对照常 |
| 文字/图片/文件发送失败 | 入持久化出站队列；恢复后按 FIFO 补发 |
| 发送前节奏等待期间进程退出 | 待发记录还在磁盘；下次启动按 `dueAt` 和顺序回放 |
| 发送成功、待删记录之间进程退出 | 重启可能重发这一条（至少一次投递的已知窗口） |
| `record` 发送失败 | 三种 file 形态重试 3 次；仍失败存路径入队 |
| 出站队列写盘失败 | 日志报错；本次消息可能丢（磁盘满等硬故障） |
| 待发记录写盘失败 | 日志报错，本次照常发送；只是等待期间重启仍会丢这一条 |
| 补发失败 | `attempts++`，退避重试；20 次或 TTL 到期丢弃并记统计 |
| 补发时音频/图片/文件已不存在 | 直接丢弃该条，报错，不重试 20 次 |
| 图片下载失败 | 文字里标 `[图片（下载失败）]`，不影响其它段 |
| 表情找不到 | 记日志/状态；会话里投「找不到表情」提示；该 token 跳过，其它 token 照发 |
| 表情库超上限 | 入库/导入返回 `sticker_limit`，提示清理；已有条目和文件不动 |
| 状态文件写失败 | 日志记错；内存继续，重启可能重投（已知风险） |
| fish.token 不存在 | 峰时转任务与余额提醒都不可用；入站照旧直接投递，收发与没装之前一致，只记一条 debug |
| 计价时段查不到（抛错 / 形状不对） | 按最保守的峰时处理：先尝试入队；入队失败即退回直接投递 |
| enqueueTask 失败 / 抛错 / 超时 800ms | 记 warn，这一批照常直接投进会话；消息不丢 |
| 峰时提醒发不出去 | 只记 warn；消息已经进任务队列，不受影响 |
| 余额提醒没有送信渠道 | 跳过，不往任何渠道发（绝不退回默认渠道） |
| 余额提醒发送失败 | 文字进 Outbox 按 FIFO 补发；表情失败时文字已先发出就不重复补、文字关着只记 warn；同一阈值 30 分钟内不重复转 |

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
| 本地 AI 没装但在用收图图库 | 已有描述的图照常命中缓存；没描述的图直接给原图，不提醒补描述 |
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

图库管理不是独立主面板。`client.js` 注册两个 slot：

| slot | 注册内容 | 作用 |
|---|---|---|
| `settings.section` | `{ name: 'settings.section', id: 'fish-message', order: 56, label: () => '鱼讯' }` | 设置页分区（含两个图库弹窗） |
| `conversation.input.right` | `{ name: 'conversation.input.right', id: 'fish-bind', order: 200, label: () => '收发渠道' }` | 模型选择器左侧的渠道胶囊按钮（见 11） |

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

## 11. 会话级绑定入口（模型选择器左侧胶囊按钮）

绑定不再只能在设置页改。客户端在 `conversation.input.right` 槽位注册一枚胶囊按钮与自定义
多选菜单（order 200 排在该簇末尾，紧挨模型选择器；颜色全走 `--dsw-alias-*` 变量），组件
props 带当前 `sessionId`，按会话显示和勾选渠道；设置页的绑定编辑器保持原样，两条入口写
同一份配置。按钮高度与字号对齐模型选择器触发器那一排，窗口变窄时允许压缩。

| 项 | 内容 |
|---|---|
| 槽位 | `conversation.input.right`：`{ id: 'fish-bind', order: 200, label: () => '收发渠道' }` |
| 数据 | `GET /state` 的 `bindings`；挂载、会话变化、打开菜单时各拉一次，不做轮询 |
| 写操作 | `POST /bindings/assign`，body `{ sessionId, bindings: [{ channel, peer }] }`；数组为空表示清空这间会话的绑定 |
| 兼容 | 旧的单条形状 `{ sessionId, qq, channel? }` 仍收：只绑一条，`qq` 为空串表示清空 |
| 注册容错 | 槽位不存在或注册失败只少一个入口，设置页与收发照常 |

按钮只显示摘要（一条时「称呼 QQ」、多条时「N 条渠道」、一条都没有时「不绑定」），
明细在菜单项与 `title` 里：称呼用 `--dsw-alias-label-secondary`（与模型选择器的模型名同色），
通道用 `--dsw-alias-label-caption`（与档位 High 和箭头同色），箭头也取 caption。

接口语义（`lib/host.js`）：

- `bindings` 数组是**集合语义**：「这间会话就该绑这些」。数组里的渠道从别处移到本会话
  （每条渠道只能绑一间会话，原来那间会话自动少一条）；本会话里没列出的渠道置
  `session=''`（渠道保留，不删除）；数组为空 = 清空本会话的绑定。
- 每一对 `(channel, peer)` 都必须已在 `bindings` 里，按 `channel:peer` 键匹配（不能只比
  对端字符串）；缺任何一条返回 400，配置不动。
- 单条形状只把这一条挂到本会话，**不清空**同会话的其它绑定；旧的 `qq` 为空串仍表示「清空这间会话」。
- 保存沿用 `/save` 的链路：`configStore.save` → `config = save` → `bridge.updateConfig()`
  → `bridge.ensureBaselines({ at: Date.now() })` → `resetGuard()`。连接参数不变，不重启传输层。
- 返回 `{ ok, message, ...status() }`；客户端先本地反映勾选结果，再用返回的 `bindings` 校准。

## 12. 绑定模型

一条绑定 = 一个渠道，即 `(channel, peer)`；`peer` 唯一 → **一个对端只能绑一间会话**。

- 反向不限制：**同一间会话可以挂多条绑定**（多个渠道、多个对端），它们都参与收消息；
  出站每轮只发一条，发给这间会话当前「送信渠道」对应的那条，见 4.1。
- `normalizeBindings` 按 `peerKey`（`channel:peer`）去重，重复的对端保留第一条；
  `session` 允许为空（渠道保留、暂不挂会话）。
- `Bridge.rebuildIndexes` 用 `bySession: Map<sessionKey, binding[]>` 记「会话 → 多条绑定」，
  空 session 不进这张表（避免 `''` 变成能被任一会话命中的键）；`byPeer: Map<peerKey, binding>`
  仍是一条渠道一条，照常按对端收消息、推进水位。
- 未绑定渠道的消息不投递，但会标记已读并推进水位；重新绑定时不会补投未绑定期间的消息。
- `GuardMonitor.setBindings` 忽略空 session，不占防失联监控名额。

---

## 13. 可选扩展：fish.token（计价与余额）

fish-token 插件通过 `ctx.provide('fish.token')` 注册；鱼讯按下面这份冻结契约惰性调用
（`lib/token-link.js`），不 import 对方代码、不加 `inject`、不等它加载。

| 方法 | 鱼讯怎么用 |
|---|---|
| `api.getPricing(at?)` | 同步读「现在峰时还是谷时」；纯本地计算，不抛错 |
| `await api.enqueueTask({ prompt, sessionKey, channel, peer, source })` | 峰时把这一批收进非紧要任务队列；等 800ms |
| `api.subscribe(handler)` | 只订 `balance-low`；返回的取消函数在卸载时调用 |
| `getBalance` / `getStatus` / `listTasks` / `updateTask` / `removeTask` / `runTaskNow` | 本插件不用 |

配置键（都在 `lib/config.js` 的 `DEFAULT_CONFIG` 与 schema 里；旧配置缺这些键时全部落默认）：

| 键 | 默认 | 说明 |
|---|---|---|
| `peakDeferEnabled` | `true` | 峰时把入站消息转进任务队列；关掉 = 旧行为 |
| `peakNoticeTemplate` | `''` | 峰时提醒文案；留空用 `defaultPeakNotice`，`{offPeakStart}` / `{offPeakEnd}` 填服务给的下一段谷时 |
| `peakNoticeCooldownMinutes` | `30` | 同一对端的提醒冷却（分钟，0~1440）；0 = 每次都提醒 |
| `balanceAlertMessageEnabled` | `true` | 余额提醒发文字；与表情开关互相独立 |
| `balanceAlertStickerEnabled` | `false` | 余额提醒发表情；表情发不出去时文字开着就只留文字 |
| `balanceAlertTemplate` | `''` | 余额提醒文案；留空用 `defaultBalanceAlert`，`{balance}` 换成两位小数 |
| `balanceAlertSticker` | `''` | 表情名字 / `#标签` / id；空串时本次只发文字 |

设置页在「计价与余额」卡片里读写这七个键，并从 `/state` 的 `token` 字段显示服务是否连上、
当前是峰时还是谷时（老版本 `/state` 没有这个字段时显示「未检测到」）。

