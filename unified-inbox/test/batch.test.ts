import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_BATCH, batchCandidates, batchExclusions, runBatch } from '../src/core/batch.ts';
import { dialogKey } from '../src/core/hub.ts';
import { AppError } from '../src/core/types.ts';
import { HOUR, advance, login, setup } from './helpers.ts';

const A = '+8613800000011';
const B = '+8613800000033';
const fast = { delay: () => 0, sleep: async () => {} };

async function world(opts: { fresh?: boolean } = {}) {
  const ctx = await setup();
  const { net, hub } = ctx;
  const ua = net.ensureUser(A, '甲').self.userId;
  const ub = net.ensureUser(B, '乙').self.userId;
  for (let i = 1; i <= 4; i++) {
    net.addChat(ua, i, `客户${i}`);
    net.seed(ua, i, '在吗', { unread: i !== 4 }); // 客户4 没有未读
  }
  net.addChat(ub, 1, '供应商1');
  net.seed(ub, 1, '发货了', { unread: true });
  net.addChat(ub, -1000000000001, '频道', 'channel');
  net.seed(ub, -1000000000001, '公告', { unread: true });
  net.addChat(ub, 9, '机器人', 'bot');
  net.seed(ub, 9, '验证码', { unread: true });
  net.addChat(ub, 10, '静音的群', 'group', { muted: true });
  net.seed(ub, 10, '闲聊', { unread: true, sender: '路人' });
  const a = await login(hub, A, '客户号');
  const b = await login(hub, B, '供应商号');
  if (!opts.fresh) advance(hub, 25 * HOUR); // 默认跳过新登录保护期
  return { ...ctx, a, b, ua, ub };
}

test('候选名单只包含「有未读、能发言、没静音」的私聊和群，不含频道、机器人和静音会话', async () => {
  const { hub, a } = await world();
  assert.deepEqual(batchCandidates(hub).map((d) => d.title).sort(), ['供应商1', '客户1', '客户2', '客户3']);
  assert.deepEqual(batchCandidates(hub, a).map((d) => d.title).sort(), ['客户1', '客户2', '客户3']);
});

test('批量回复：每个会话各发一条，都从各自的账号发出，发完未读清零', async () => {
  const { hub, net, a, b, ua, ub } = await world();
  const keys = batchCandidates(hub).map((d) => d.key);
  const items = await runBatch(hub, keys, '  收到，稍后回复您  ', fast);
  assert.ok(items.every((i) => i.state === 'sent'));
  assert.equal(net.sent.length, 4);
  assert.ok(net.sent.every((s) => s.text === '收到，稍后回复您'));
  assert.equal(net.sent.filter((s) => s.userId === ua).length, 3);
  assert.equal(net.sent.filter((s) => s.userId === ub).length, 1);
  assert.equal(hub.dialog(dialogKey(a, 1))?.unread, 0);
  assert.equal(hub.dialog(dialogKey(b, 1))?.unread, 0);
});

test('不能借批量回复给没有未读的会话、频道、机器人、静音会话发消息', async () => {
  const { hub, net, a, b } = await world();
  const items = await runBatch(hub, [dialogKey(a, 4), dialogKey(b, -1000000000001), dialogKey(b, 9), dialogKey(b, 10), dialogKey(a, 1), 'bogus:1'], '你好', fast);
  assert.deepEqual(items.map((i) => i.state), ['skipped', 'skipped', 'skipped', 'skipped', 'sent', 'skipped']);
  assert.equal(net.sent.length, 1);
});

test('某个账号被限流后，立即停止这个账号后续的发送，其他账号继续', async () => {
  const { hub, net, a, b } = await world();
  net.floodChats.add(2);
  const items = await runBatch(hub, [dialogKey(a, 1), dialogKey(a, 2), dialogKey(a, 3), dialogKey(b, 1)], '收到', fast);
  assert.deepEqual(items.map((i) => i.state), ['sent', 'failed', 'skipped', 'sent']);
  assert.match(items[2]!.error!, /限流/);
  assert.equal(net.sent.length, 2);
});

test('可以中途停止，停止后不再发送', async () => {
  const { hub, net, a } = await world();
  const ctl = new AbortController();
  const items = await runBatch(hub, [dialogKey(a, 1), dialogKey(a, 2), dialogKey(a, 3)], '收到', {
    delay: () => 0,
    sleep: async () => {},
    signal: ctl.signal,
    onProgress: (list) => {
      if (list.some((i) => i.state === 'sent')) ctl.abort();
    },
  });
  assert.deepEqual(items.map((i) => i.state), ['sent', 'skipped', 'skipped']);
  assert.equal(net.sent.length, 1);
});

test('两条之间一定有停顿（第一条之前不等）', async () => {
  const { hub, a } = await world();
  const sleeps: number[] = [];
  await runBatch(hub, [dialogKey(a, 1), dialogKey(a, 2), dialogKey(a, 3)], '收到', {
    delay: () => 2000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.deepEqual(sleeps, [2000, 2000]);
});

test('空内容、空名单、超过上限都会被拒绝，一条都不发', async () => {
  const { hub, net, a } = await world();
  await assert.rejects(runBatch(hub, [dialogKey(a, 1)], '   ', fast), AppError);
  await assert.rejects(runBatch(hub, [], '收到', fast), AppError);
  const many = Array.from({ length: MAX_BATCH + 1 }, (_, i) => `x:${i}`);
  await assert.rejects(runBatch(hub, many, '收到', fast), AppError);
  assert.equal(net.sent.length, 0);
});

test('重复的会话只发一次', async () => {
  const { hub, net, a } = await world();
  await runBatch(hub, [dialogKey(a, 1), dialogKey(a, 1), dialogKey(a, 1)], '收到', fast);
  assert.equal(net.sent.length, 1);
});

test('刚登录不满 24 小时的账号不参与批量回复，硬塞进去也会被跳过；满 24 小时后恢复', async () => {
  const { hub, net, a, b } = await world({ fresh: true });
  assert.deepEqual(batchCandidates(hub), []);
  assert.equal(batchExclusions(hub).length, 2);
  const items = await runBatch(hub, [dialogKey(a, 1), dialogKey(b, 1)], '收到', fast);
  assert.deepEqual(items.map((i) => i.state), ['skipped', 'skipped']);
  assert.match(items[0]!.error!, /24 小时/);
  assert.equal(net.sent.length, 0);
  // 逐条回复不受影响
  await hub.send(dialogKey(a, 1), '在的');
  assert.equal(net.sent.length, 1);
  advance(hub, 25 * HOUR);
  assert.equal(batchCandidates(hub).length, 3);
});

test('重要账号永远不参与批量回复，其他账号照常', async () => {
  const { hub, net, a, b, ub } = await world();
  await hub.updateAccount(a, { important: true });
  assert.deepEqual(batchCandidates(hub).map((d) => d.title), ['供应商1']);
  assert.deepEqual(batchExclusions(hub).map((x) => x.label), ['客户号']);
  const items = await runBatch(hub, [dialogKey(a, 1), dialogKey(b, 1)], '收到', fast);
  assert.deepEqual(items.map((i) => i.state), ['skipped', 'sent']);
  assert.match(items[0]!.error!, /重要账号/);
  assert.deepEqual(net.sent.map((s) => s.userId), [ub]);
});
