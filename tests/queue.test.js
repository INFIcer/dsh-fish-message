// MessageQueue 单测：编辑窗口的计时基准、最长等待的取舍、撤回删除。
//
// 时间全部用注入的假时钟/假定时器推进，不会真等 15 秒。
// 注意：窗口的计时基准是消息自带的发送时间戳（秒），所以用例里的 time
// 要跟假时钟对齐，否则会被当成「早就过期的历史」。

import test from 'node:test'
import assert from 'node:assert/strict'
import { MessageQueue, sortMessages } from '../lib/queue.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))

/** 可推进的假定时器 + 假时钟。 */
function fakeClock() {
  let now = 0
  let nextId = 1
  const tasks = new Map()
  const timers = {
    setTimeout(fn, ms) {
      const id = nextId
      nextId += 1
      tasks.set(id, { at: now + Math.max(0, Number(ms) || 0), fn })
      return id
    },
    clearTimeout(id) { tasks.delete(id) },
  }
  async function advance(ms) {
    const target = now + ms
    for (;;) {
      const due = [...tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      const [id, task] = due
      tasks.delete(id)
      now = task.at
      task.fn()
      await tick()
    }
    now = target
  }
  return { now: () => now, timers, advance, pendingTimers: () => tasks.size }
}

function makeQueue(clock, options = {}) {
  const batches = []
  const queue = new MessageQueue({
    now: clock.now,
    timers: clock.timers,
    onBatch: (key, batch) => batches.push({ key, ids: batch.map((m) => m.message_id) }),
    ...options,
  })
  return { queue, batches }
}

/** 在假时钟的当前时刻发一条消息：time 与时钟对齐（OneBot 的 time 是秒）。 */
const messageAt = (clock, id, extra = {}) => ({ message_id: id, time: Math.floor(clock.now() / 1000), ...extra })

test('队列：编辑窗口按「最后一条消息时间戳 + 静默期」计时，每来一条就往后延', async () => {
  const clock = fakeClock()
  const { queue, batches } = makeQueue(clock, { bufferMs: 1500, editWindowMs: 15000 })
  queue.enqueue('qq', messageAt(clock, 1))
  await clock.advance(14000)
  assert.equal(batches.length, 0, '窗口还没到，不能投')

  queue.enqueue('qq', messageAt(clock, 2))
  await clock.advance(14000)
  assert.equal(batches.length, 0, '新消息把静默计时往后延了')

  await clock.advance(1000)
  assert.deepEqual(batches, [{ key: 'qq', ids: [1, 2] }])
  queue.clear()
})

test('队列：计时基准是消息时间戳，不是拉到消息的时刻——旧历史立刻投', async () => {
  const clock = fakeClock()
  await clock.advance(100 * 1000)
  const { queue, batches } = makeQueue(clock, { bufferMs: 10, editWindowMs: 15000 })
  // 90 秒前的离线消息：它的窗口早就过期了，不该再压 15 秒。
  queue.enqueue('qq', { message_id: 1, time: 10 })
  await clock.advance(1)
  assert.deepEqual(batches, [{ key: 'qq', ids: [1] }])
  queue.clear()
})

test('队列：离线消息时间戳相近时仍按窗口排队（后发的要等自己的窗口）', async () => {
  const clock = fakeClock()
  await clock.advance(100 * 1000)
  const { queue, batches } = makeQueue(clock, { bufferMs: 10, editWindowMs: 15000 })
  // 5 秒前刚发的 B：窗口还剩 10 秒。
  queue.enqueue('qq', { message_id: 2, time: 95 })
  await clock.advance(5000)
  assert.equal(batches.length, 0, 'B 自己的窗口还没到')
  await clock.advance(5000)
  assert.deepEqual(batches, [{ key: 'qq', ids: [2] }])
  queue.clear()
})

test('队列：编辑窗口开着时不受 maxWaitMs 截断（默认 15 秒 > 旧上限 6 秒）', async () => {
  const clock = fakeClock()
  const { queue, batches } = makeQueue(clock, { bufferMs: 20, maxWaitMs: 6000, editWindowMs: 15000 })
  assert.equal(queue.quietMs(), 15000)
  assert.equal(queue.maxWaitMs, 0, '窗口开着时不要最长等待上限')

  queue.enqueue('qq', messageAt(clock, 1))
  await clock.advance(6000)
  assert.equal(batches.length, 0, '旧的 6 秒上限不能把 15 秒窗口截断')

  await clock.advance(9000)
  assert.deepEqual(batches, [{ key: 'qq', ids: [1] }])
  queue.clear()
})

test('队列：窗口关掉（0）时退回旧行为——缓冲后投，且保留最长等待', async () => {
  const clock = fakeClock()
  const { queue, batches } = makeQueue(clock, { bufferMs: 1500, maxWaitMs: 6000, editWindowMs: 0 })
  assert.equal(queue.quietMs(), 1500)
  assert.equal(queue.maxWaitMs, 6000)

  queue.enqueue('qq', messageAt(clock, 1))
  await clock.advance(1500)
  assert.deepEqual(batches, [{ key: 'qq', ids: [1] }])

  // 一直发也最多等 6 秒：到点必须 flush，不能永远等下去。
  for (let i = 0; i < 5; i++) {
    queue.enqueue('qq', messageAt(clock, 10 + i))
    await clock.advance(1000)
  }
  await clock.advance(6000)
  assert.equal(batches.length, 2, '最长等待到点后 flush 一次')
  assert.deepEqual(batches[1].ids, [10, 11, 12, 13, 14])
  queue.clear()
})

test('队列：同一次 flush 里按 时间 → 序号 → id 排序；重复 id 只留一份', async () => {
  const clock = fakeClock()
  const { queue, batches } = makeQueue(clock, { bufferMs: 10, editWindowMs: 100 })
  queue.enqueue('qq', { message_id: 3, message_seq: 3, time: 3 })
  queue.enqueue('qq', { message_id: 1, message_seq: 1, time: 1 })
  queue.enqueue('qq', { message_id: 2, message_seq: 2, time: 2 })
  queue.enqueue('qq', { message_id: 2, message_seq: 2, time: 2 })
  await clock.advance(4000)
  assert.deepEqual(batches, [{ key: 'qq', ids: [1, 2, 3] }])
  queue.clear()
})

test('队列：remove 只删指定 id，删空时清定时器且不触发 onBatch', async () => {
  const clock = fakeClock()
  const { queue, batches } = makeQueue(clock, { bufferMs: 10, editWindowMs: 100 })
  queue.enqueue('qq', messageAt(clock, 1))
  queue.enqueue('qq', messageAt(clock, 2))

  assert.equal(queue.remove('qq', 1), true)
  assert.equal(queue.size(), 1)
  assert.equal(queue.remove('qq', 1), false, '已经删掉的不算删成功')

  assert.equal(queue.remove('qq', 2), true)
  assert.equal(queue.size(), 0)
  assert.equal(clock.pendingTimers(), 0, '删空要清掉定时器')

  await clock.advance(500)
  assert.equal(batches.length, 0, '删空后不能投出空批次')

  // 删空之后还能继续收：重新计时。
  queue.enqueue('qq', messageAt(clock, 3))
  await clock.advance(150)
  assert.deepEqual(batches, [{ key: 'qq', ids: [3] }])
  queue.clear()
})

test('队列：configure 热更新窗口，开关同步切换最长等待策略', () => {
  const queue = new MessageQueue({ bufferMs: 1500, maxWaitMs: 6000, editWindowMs: 0 })
  assert.equal(queue.quietMs(), 1500)
  assert.equal(queue.maxWaitMs, 6000)

  queue.configure({ editWindowMs: 15000 })
  assert.equal(queue.quietMs(), 15000)
  assert.equal(queue.maxWaitMs, 0)

  queue.configure({ editWindowMs: 0, bufferMs: 500 })
  assert.equal(queue.quietMs(), 500)
  assert.equal(queue.maxWaitMs, 6000)
  queue.clear()
})

test('sortMessages：时间相同再按序号、id 兜底', () => {
  const list = [
    { message_id: 9, message_seq: 5, time: 100 },
    { message_id: 4, message_seq: 7, time: 100 },
    { message_id: 5, message_seq: 5, time: 100 },
    { message_id: 2, message_seq: 1, time: 99 },
  ]
  assert.deepEqual([...list].sort(sortMessages).map((m) => m.message_id), [2, 5, 9, 4])
})
