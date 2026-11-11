import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hub, SEND_LIMIT_PER_MINUTE, SEND_LIMIT_PER_MINUTE_IMPORTANT, dialogKey } from '../src/core/hub.ts';
import { AppError } from '../src/core/types.ts';
import { Vault } from '../src/core/vault.ts';
import { HOUR, PASSWORD, advance, flush, login, setup } from './helpers.ts';

const A = '+8613800000011';
const B = '+8613800000033';

async function twoAccounts() {
  const ctx = await setup();
  const { net, hub } = ctx;
  const ua = net.ensureUser(A, '甲');
  const ub = net.ensureUser(B, '乙');
  net.addChat(ua.self.userId, 101, '王老板');
  net.addChat(ua.self.userId, 102, '李小姐');
  net.addChat(ub.self.userId, 101, '顺丰供应商'); // 故意和甲的会话编号相同
  net.addChat(ub.self.userId, -1000000000555, '行业频道', 'channel');
  net.seed(ua.self.userId, 101, '在吗', { ago: 3000, unread: true });
  net.seed(ua.self.userId, 102, '价格多少', { ago: 2000, unread: true });
  net.seed(ub.self.userId, 101, '货到了', { ago: 1000, unread: true });
  const a = await login(hub, A, '客户号');
  const b = await login(hub, B, '供应商号');
  return { ...ctx, a, b, ua: ua.self.userId, ub: ub.self.userId };
}

test('多个账号的会话汇总到一个列表，按时间排序并标明来自哪个账号', async () => {
  const { hub, a, b } = await twoAccounts();
  const list = hub.dialogs();
  assert.deepEqual(
    list.filter((d) => d.last).map((d) => [d.title, hub.account(d.accountId)?.label]),
    [
      ['顺丰供应商', '供应商号'],
      ['李小姐', '客户号'],
      ['王老板', '客户号'],
    ],
  );
  assert.equal(hub.totalUnread(), 3);
  const views = hub.accounts();
  assert.equal(views.find((v) => v.id === a)?.unread, 2);
  assert.equal(views.find((v) => v.id === b)?.unread, 1);
});

test('两个账号里编号相同的会话不会串：回复从收到消息的那个账号发出', async () => {
  const { hub, net, a, b, ua, ub } = await twoAccounts();
  await hub.send(dialogKey(b, 101), '好的，已签收');
  await hub.send(dialogKey(a, 101), '在的，您说');
  assert.deepEqual(net.sent, [
    { userId: ub, chatId: 101, text: '好的，已签收' },
    { userId: ua, chatId: 101, text: '在的，您说' },
  ]);
  assert.equal(hub.messages(dialogKey(a, 101)).at(-1)?.text, '在的，您说');
  assert.equal(hub.messages(dialogKey(b, 101)).at(-1)?.text, '好的，已签收');
});

test('实时来消息：未读加一、排到最前、触发通知回调并带上账号', async () => {
  const { hub, net, a, ua } = await twoAccounts();
  const seen: string[] = [];
  hub.onIncoming = (account, dialog, msg) => seen.push(`${account.label}|${dialog.title}|${msg.text}`);
  net.deliver(ua, 101, '还在吗？');
  await flush();
  assert.equal(hub.dialogs()[0]?.key, dialogKey(a, 101));
  assert.equal(hub.dialog(dialogKey(a, 101))?.unread, 2);
  assert.deepEqual(seen, ['客户号|王老板|还在吗？']);
});

test('打开会话会加载历史并标为已读；正在看的会话来新消息不计未读', async () => {
  const { hub, net, a, ua } = await twoAccounts();
  const key = dialogKey(a, 101);
  await hub.openChat(key);
  assert.equal(hub.dialog(key)?.unread, 0);
  assert.equal(hub.messages(key).length, 1);
  assert.equal(net.users.get(ua)?.chats.get(101)?.info.unread, 0);
  net.deliver(ua, 101, '新消息');
  await flush();
  assert.equal(hub.dialog(key)?.unread, 0);
  assert.equal(hub.messages(key).length, 2);
  // 服务器那边也要标为已读，否则下次打开又变回未读
  assert.equal(net.users.get(ua)?.chats.get(101)?.info.unread, 0);
});

test('页面不在前台时，即使会话开着，新消息也算未读', async () => {
  const { hub, net, a, ua } = await twoAccounts();
  const key = dialogKey(a, 101);
  await hub.openChat(key);
  hub.isVisible = () => false;
  net.deliver(ua, 101, '人呢');
  await flush();
  assert.equal(hub.dialog(key)?.unread, 1);
});

test('翻看更早的历史：分页加载、不重复、到头后不再请求', async () => {
  const { hub, net, a, ua } = await twoAccounts();
  for (let i = 0; i < 90; i++) net.seed(ua, 102, `第${i}条`);
  const key = dialogKey(a, 102);
  await hub.openChat(key);
  assert.equal(hub.messages(key).length, 40);
  assert.equal(hub.history(key).hasMore, true);
  await hub.loadOlder(key);
  await hub.loadOlder(key);
  assert.equal(hub.messages(key).length, 91);
  assert.equal(hub.history(key).hasMore, false);
  const ids = hub.messages(key).map((m) => m.id);
  assert.deepEqual(ids, [...new Set(ids)].sort((x, y) => x - y));
});

test('对方已读我方消息后，会话的已读位置更新', async () => {
  const { hub, net, a, ua } = await twoAccounts();
  const key = dialogKey(a, 101);
  const sent = await hub.send(key, '好的');
  assert.ok((hub.dialog(key)?.readOutboxMaxId ?? 0) < sent.id);
  net.peerRead(ua, 101);
  await flush();
  assert.equal(hub.dialog(key)?.readOutboxMaxId, sent.id);
});

test('不能在没有发言权限的频道里发消息', async () => {
  const { hub, b } = await twoAccounts();
  await assert.rejects(hub.send(dialogKey(b, -1000000000555), '你好'), (e: unknown) => e instanceof AppError && e.code === 'forbidden');
});

test('修改和删除自己发出的消息', async () => {
  const { hub, a } = await twoAccounts();
  const key = dialogKey(a, 101);
  const sent = await hub.send(key, '报价 100');
  await hub.edit(key, sent.id, '报价 120');
  assert.equal(hub.messages(key).find((m) => m.id === sent.id)?.text, '报价 120');
  assert.equal(hub.dialog(key)?.last?.text, '报价 120');
  await hub.remove(key, sent.id);
  assert.equal(hub.messages(key).some((m) => m.id === sent.id), false);
});

test('凭据保存在加密保险库里：重新解锁后所有账号自动上线', async () => {
  const { store, net } = await twoAccounts();
  const vault2 = await Vault.unlock(store, PASSWORD);
  assert.equal(vault2.data.accounts.length, 2);
  const hub2 = new Hub(vault2, net.factory());
  await hub2.startAll();
  assert.deepEqual(hub2.accounts().map((v) => [v.label, v.status]), [
    ['客户号', 'online'],
    ['供应商号', 'online'],
  ]);
  assert.equal(hub2.dialogs().length, 4);
});

test('两步验证账号：密码错误被拒绝，正确后登录成功', async () => {
  const { hub, net } = await setup();
  net.ensureUser('+8613800000022', '丙');
  const flow = hub.beginLogin();
  await flow.sendCode('+86 138 0000 0022');
  await assert.rejects(flow.submitCode('00000'), (e: unknown) => e instanceof AppError && e.code === 'bad_code');
  assert.equal(await flow.submitCode('12345'), 'password');
  await assert.rejects(flow.submitPassword('wrong'), (e: unknown) => e instanceof AppError && e.code === 'bad_password');
  await flow.submitPassword('mima1234');
  await flow.finish('两步号', null);
  assert.equal(hub.accounts()[0]?.label, '两步号');
});

test('同一个账号重复登录不会出现两份，只替换凭据', async () => {
  const { hub, vault, a } = await twoAccounts();
  const before = vault.data.accounts.find((x) => x.id === a)!.session;
  const again = await login(hub, A, '');
  assert.equal(again, a);
  assert.equal(vault.data.accounts.length, 2);
  assert.notEqual(vault.data.accounts.find((x) => x.id === a)!.session, before);
  assert.equal(hub.account(a)?.label, '客户号');
});

test('登录到一半取消：已登录成功但没保存的，会在服务器上退出', async () => {
  const { hub, net, vault } = await setup();
  net.ensureUser(A, '甲');
  const flow = hub.beginLogin();
  await flow.sendCode(A);
  await flow.submitCode('12345');
  await flow.cancel();
  assert.equal(vault.data.accounts.length, 0);
  assert.equal(net.revoked.size, 1);
});

test('移除账号：服务器上的登录作废、保险库里的凭据删除、会话从列表消失', async () => {
  const { hub, net, vault, store, a, b } = await twoAccounts();
  const session = vault.data.accounts.find((x) => x.id === a)!.session;
  await hub.openChat(dialogKey(a, 101));
  const r = await hub.removeAccount(a);
  assert.equal(r.loggedOut, true);
  assert.ok(net.revoked.has(session));
  assert.equal(hub.activeKey, null);
  assert.ok(hub.dialogs().every((d) => d.accountId === b));
  const reopened = await Vault.unlock(store, PASSWORD);
  assert.deepEqual(reopened.data.accounts.map((x) => x.id), [b]);
});

test('登录在别处被下线：账号标为失效，发送被拒绝并给出明确提示，其他账号不受影响', async () => {
  const { hub, net, vault, a, b } = await twoAccounts();
  net.revoke(vault.data.accounts.find((x) => x.id === a)!.session);
  await flush();
  assert.equal(hub.account(a)?.status, 'revoked');
  assert.equal(hub.account(b)?.status, 'online');
  await assert.rejects(hub.send(dialogKey(a, 101), '你好'), (e: unknown) => e instanceof AppError && e.code === 'revoked' && e.message.includes('客户号'));
  await hub.send(dialogKey(b, 101), '收到');
});

test('启动时凭据已失效的账号标为失效，不影响其他账号上线', async () => {
  const { store, net, vault, a } = await twoAccounts();
  net.revoked.add(vault.data.accounts.find((x) => x.id === a)!.session);
  const hub2 = new Hub(await Vault.unlock(store, PASSWORD), net.factory());
  await hub2.startAll();
  assert.deepEqual(hub2.accounts().map((v) => v.status), ['revoked', 'online']);
});

test('上锁（销毁）后内存里不再有任何会话和消息，也不再响应新消息', async () => {
  const { hub, net, a, ua } = await twoAccounts();
  await hub.openChat(dialogKey(a, 101));
  let calls = 0;
  hub.subscribe(() => calls++);
  await flush();
  calls = 0;
  await hub.destroy();
  net.deliver(ua, 101, '锁了以后来的消息');
  await flush();
  assert.equal(hub.dialogs().length, 0);
  assert.equal(hub.messages(dialogKey(a, 101)).length, 0);
  assert.equal(hub.accounts().length, 0);
  assert.equal(calls, 0);
  assert.equal(net.users.get(ua)?.listeners.size, 0);
});

test('改备注名和颜色会保存', async () => {
  const { hub, store, a } = await twoAccounts();
  await hub.updateAccount(a, { label: 'VIP 客户号', color: '#123456' });
  const reopened = await Vault.unlock(store, PASSWORD);
  const acc = reopened.data.accounts.find((x) => x.id === a)!;
  assert.equal(acc.label, 'VIP 客户号');
  assert.equal(acc.color, '#123456');
});

test('静音会话的未读不计入角标，也不触发通知', async () => {
  const { hub, net, ub, b } = await twoAccounts();
  const before = hub.totalUnread();
  net.addChat(ub, 300, '闲聊群', 'group', { muted: true });
  await hub.refreshDialogs(b);
  let notified = 0;
  hub.onIncoming = () => notified++;
  net.deliver(ub, 300, '哈哈哈', '路人');
  await flush();
  assert.equal(hub.dialog(dialogKey(b, 300))?.unread, 1);
  assert.equal(hub.totalUnread(), before);
  assert.equal(notified, 0);
});

test('发送限速：同一账号 1 分钟内超过上限会被拦下，过了时间窗恢复；不同账号互不影响', async () => {
  const { hub, net, a, b } = await twoAccounts();
  const key = dialogKey(a, 101);
  for (let i = 0; i < SEND_LIMIT_PER_MINUTE; i++) await hub.send(key, `第${i}条`);
  await assert.rejects(hub.send(key, '多出来的一条'), (e: unknown) => e instanceof AppError && e.code === 'flood' && e.message.includes('客户号'));
  assert.equal(net.sent.length, SEND_LIMIT_PER_MINUTE);
  await hub.send(dialogKey(b, 101), '另一个账号不受影响');
  advance(hub, 61_000);
  await hub.send(key, '过一分钟又可以了');
  assert.equal(net.sent.length, SEND_LIMIT_PER_MINUTE + 2);
});

test('重要账号的发送上限更严', async () => {
  const { hub, a } = await twoAccounts();
  await hub.updateAccount(a, { important: true });
  const key = dialogKey(a, 101);
  for (let i = 0; i < SEND_LIMIT_PER_MINUTE_IMPORTANT; i++) await hub.send(key, `第${i}条`);
  await assert.rejects(hub.send(key, '多出来的一条'), (e: unknown) => e instanceof AppError && e.code === 'flood');
});

test('登录节奏提醒：刚登录完要等 10 分钟；一天内登录的个数会被统计', async () => {
  const { hub } = await setup();
  assert.deepEqual(hub.loginPacing(), { last24h: 0, waitMinutes: 0 });
  await login(hub, A, '客户号');
  assert.deepEqual(hub.loginPacing(), { last24h: 1, waitMinutes: 10 });
  advance(hub, 4 * 60_000);
  assert.equal(hub.loginPacing().waitMinutes, 6);
  advance(hub, 7 * 60_000);
  assert.deepEqual(hub.loginPacing(), { last24h: 1, waitMinutes: 0 });
  await login(hub, B, '供应商号');
  assert.equal(hub.loginPacing().last24h, 2);
  advance(hub, 25 * HOUR);
  assert.deepEqual(hub.loginPacing(), { last24h: 0, waitMinutes: 0 });
});

test('新登录的账号有 24 小时保护期；「重要」标记会保存，重新登录也不会丢', async () => {
  const { hub, store, a } = await twoAccounts();
  assert.ok(hub.account(a)?.protectedUntil);
  assert.match(hub.batchBlock(a)!, /24 小时/);
  await hub.updateAccount(a, { important: true });
  advance(hub, 25 * HOUR);
  assert.equal(hub.account(a)?.protectedUntil, null);
  assert.match(hub.batchBlock(a)!, /重要账号/);
  await login(hub, A, ''); // 重新登录：保护期重新开始，重要标记保留
  assert.ok(hub.account(a)?.protectedUntil);
  const reopened = await Vault.unlock(store, PASSWORD);
  assert.equal(reopened.data.accounts.find((x) => x.id === a)?.important, true);
});

function qrHandlers(log: string[], passwords: string[] = []) {
  return {
    onUrl: (url: string) => log.push(`url:${url.slice(0, 22)}`),
    onScanned: () => log.push('scanned'),
    askPassword: async (_hint: string | null, wrong: boolean) => {
      log.push(wrong ? 'ask-again' : 'ask');
      return passwords.shift() ?? '';
    },
  };
}

test('扫码登录：显示二维码 → 手机扫码 → 登录成功并开始收消息，不需要手机号和验证码', async () => {
  const { hub, net, vault } = await setup();
  const u = net.ensureUser(A, '甲').self.userId;
  net.addChat(u, 101, '王老板');
  net.seed(u, 101, '在吗', { unread: true });
  const log: string[] = [];
  const flow = hub.beginLogin();
  const pending = flow.startQr(qrHandlers(log));
  await flush();
  assert.deepEqual(log, ['url:tg://login?token=MOCK-']);
  assert.equal(vault.data.accounts.length, 0);
  assert.equal(net.scanQr(A), true);
  await pending;
  assert.deepEqual(log.slice(1), ['scanned']);
  const id = await flow.finish('客户号', null, true);
  assert.equal(hub.account(id)?.phone, A);
  assert.equal(hub.account(id)?.important, true);
  assert.equal(hub.dialogs().length, 1);
  net.deliver(u, 101, '还在吗');
  await flush();
  assert.equal(hub.dialog(dialogKey(id, 101))?.unread, 2);
});

test('扫码登录遇到两步验证：密码输错会再问一次，输对后登录成功', async () => {
  const { hub, net } = await setup();
  net.ensureUser('+8613800000022', '丙');
  const log: string[] = [];
  const flow = hub.beginLogin();
  const pending = flow.startQr(qrHandlers(log, ['wrong', 'mima1234']));
  await flush();
  net.scanQr('+8613800000022');
  await pending;
  assert.deepEqual(log.slice(1), ['scanned', 'ask', 'ask-again']);
  await flow.finish('两步号', null);
  assert.equal(hub.accounts()[0]?.label, '两步号');
});

test('二维码还没人扫就取消：不留下任何账号，之后再扫也无效', async () => {
  const { hub, net, vault } = await setup();
  net.ensureUser(A, '甲');
  const flow = hub.beginLogin();
  const pending = flow.startQr(qrHandlers([]));
  await flush();
  await flow.cancel();
  await assert.rejects(pending, (e: unknown) => e instanceof AppError && e.code === 'cancelled');
  assert.equal(net.scanQr(A), false);
  assert.equal(vault.data.accounts.length, 0);
  assert.equal(net.revoked.size, 0);
});

test('扫码成功但没保存就取消：会在服务器上退出这份登录', async () => {
  const { hub, net, vault } = await setup();
  net.ensureUser(A, '甲');
  const flow = hub.beginLogin();
  const pending = flow.startQr(qrHandlers([]));
  await flush();
  net.scanQr(A);
  await pending;
  await flow.cancel();
  assert.equal(vault.data.accounts.length, 0);
  assert.equal(net.revoked.size, 1);
});

test('独立窗口：会话开在独立窗口里并且有人在看时，新消息不计未读并会通知服务器已读', async () => {
  const { hub, net, a, ua } = await twoAccounts();
  const key = dialogKey(a, 101);
  let watching = true;
  await hub.attachViewer('w1', key, () => watching);
  assert.equal(hub.messages(key).length, 1); // 历史已加载
  assert.equal(hub.dialog(key)?.unread, 0);
  assert.equal(hub.activeKey, null); // 不占用主窗口
  assert.ok(hub.poppedOutKeys().has(key));
  net.deliver(ua, 101, '看得到吗');
  await flush();
  assert.equal(hub.dialog(key)?.unread, 0);
  assert.equal(net.users.get(ua)?.chats.get(101)?.info.unread, 0);
  // 窗口被别的窗口挡住、没人看：新消息要算未读
  watching = false;
  net.deliver(ua, 101, '人呢');
  await flush();
  assert.equal(hub.dialog(key)?.unread, 1);
});

test('独立窗口：可以同时开多个会话，各自独立；主窗口照常使用', async () => {
  const { hub, net, a, b, ua, ub } = await twoAccounts();
  await hub.attachViewer('w1', dialogKey(a, 101), () => true);
  await hub.attachViewer('w2', dialogKey(b, 101), () => true);
  await hub.openChat(dialogKey(a, 102));
  net.deliver(ua, 101, '甲1');
  net.deliver(ub, 101, '乙1');
  net.deliver(ua, 102, '甲2');
  await flush();
  assert.equal(hub.totalUnread(), 0);
  await hub.send(dialogKey(b, 101), '从独立窗口回复');
  assert.deepEqual(net.sent.at(-1), { userId: ub, chatId: 101, text: '从独立窗口回复' });
  // 关掉一个窗口后，那个会话的新消息恢复计未读，另一个不受影响
  hub.detachViewer('w1');
  net.deliver(ua, 101, '甲3');
  net.deliver(ub, 101, '乙2');
  await flush();
  assert.equal(hub.dialog(dialogKey(a, 101))?.unread, 1);
  assert.equal(hub.dialog(dialogKey(b, 101))?.unread, 0);
});

test('独立窗口：同一个窗口换会话后，原来的会话不再算「在看」', async () => {
  const { hub, net, a, ua } = await twoAccounts();
  await hub.attachViewer('acct', dialogKey(a, 101), () => true);
  await hub.attachViewer('acct', dialogKey(a, 102), () => true);
  assert.equal(hub.isOpen(dialogKey(a, 101)), false);
  net.deliver(ua, 101, '旧会话的新消息');
  await flush();
  assert.equal(hub.dialog(dialogKey(a, 101))?.unread, 1);
  assert.equal(hub.dialog(dialogKey(a, 102))?.unread, 0);
});

test('独立窗口：移除账号或上锁后，不再有任何窗口被当作「在看」', async () => {
  const { hub, a, b } = await twoAccounts();
  await hub.attachViewer('w1', dialogKey(a, 101), () => true);
  await hub.attachViewer('w2', dialogKey(b, 101), () => true);
  await hub.removeAccount(a);
  assert.deepEqual([...hub.poppedOutKeys()], [dialogKey(b, 101)]);
  await hub.destroy();
  assert.equal(hub.poppedOutKeys().size, 0);
});

test('只订阅一个会话的窗口：别的会话来消息不会被通知，自己的会话和账号级变化才会', async () => {
  const { hub, net, a, b, ua, ub } = await twoAccounts();
  const mine = dialogKey(a, 101);
  let keyCalls = 0;
  let globalCalls = 0;
  const off = hub.subscribeKey(mine, () => keyCalls++);
  hub.subscribe(() => globalCalls++);
  await flush();
  keyCalls = 0;
  globalCalls = 0;
  net.deliver(ub, 101, '别的账号');
  net.deliver(ua, 102, '同账号的别的会话');
  await flush();
  assert.equal(keyCalls, 0);
  assert.ok(globalCalls >= 1);
  net.deliver(ua, 101, '我的会话');
  await flush();
  assert.equal(keyCalls, 1);
  // 同一时刻来一大批消息，只通知一次（合并刷新）
  for (let i = 0; i < 50; i++) net.deliver(ua, 101, `连发${i}`);
  await flush();
  assert.equal(keyCalls, 2);
  // 账号级变化（比如改备注名）会通知到
  await hub.updateAccount(b, { label: '新名字' });
  await flush();
  assert.equal(keyCalls, 3);
  off();
  net.deliver(ua, 101, '退订以后');
  await flush();
  assert.equal(keyCalls, 3);
});

test('发文件：可以不带说明文字；从收到消息的账号发出；计入发送限速', async () => {
  const { hub, net, a, ua } = await twoAccounts();
  const key = dialogKey(a, 101);
  const data = new TextEncoder().encode('报价内容');
  const doc = await hub.sendFile(key, { name: '报价单.txt', type: 'text/plain', data, asPhoto: false }, '');
  assert.equal(doc.media, '[文件] 报价单.txt');
  const pic = await hub.sendFile(key, { name: 'a.jpg', type: 'image/jpeg', data, asPhoto: true }, '  新款  ');
  assert.equal(pic.hasPhoto, true);
  assert.equal(pic.text, '新款');
  assert.deepEqual(net.files.map((f) => [f.userId, f.chatId, f.name, f.bytes, f.asPhoto]), [
    [ua, 101, '报价单.txt', data.byteLength, false],
    [ua, 101, 'a.jpg', data.byteLength, true],
  ]);
  assert.equal(hub.dialog(key)?.last?.id, pic.id);
  for (let i = 2; i < SEND_LIMIT_PER_MINUTE; i++) await hub.send(key, `第${i}条`);
  await assert.rejects(hub.sendFile(key, { name: 'b.txt', type: '', data, asPhoto: false }, ''), (e: unknown) => e instanceof AppError && e.code === 'flood');
});

// —— 下载、头像、转发、贴纸、建群 ——

test('下载收到的文件：拿到内容、文件名和类型，并能看到进度', async () => {
  const { hub, net, a, ua } = await twoAccounts();
  const key = dialogKey(a, 101);
  net.seed(ua, 101, '', { file: { name: '合同.pdf', mime: 'application/pdf', size: 2048 } });
  await hub.openChat(key);
  const msg = hub.messages(key).at(-1)!;
  assert.deepEqual([msg.attachment?.kind, msg.attachment?.name, msg.media], ['file', '合同.pdf', '[文件] 合同.pdf']);
  const progress: number[] = [];
  const file = await hub.loadAttachment(key, msg.id, (done, total) => progress.push(done / total));
  assert.equal(file?.name, '合同.pdf');
  assert.equal(file?.mime, 'application/pdf');
  assert.ok((file?.data.byteLength ?? 0) > 0);
  assert.deepEqual(progress, [0.5, 1]);
  // 没有附件的消息返回空
  assert.equal(await hub.loadAttachment(key, hub.messages(key)[0]!.id), null);
});

test('超过 200MB 的文件不在软件里下载，给出明确提示', async () => {
  const { hub, net, a, ua } = await twoAccounts();
  const key = dialogKey(a, 101);
  net.seed(ua, 101, '', { file: { name: '大视频.mp4', kind: 'video', mime: 'video/mp4', size: 300 * 1024 * 1024 } });
  await hub.openChat(key);
  await assert.rejects(hub.loadAttachment(key, hub.messages(key).at(-1)!.id), /200MB/);
});

test('头像：有头像的会话才去取，同一个会话只取一次', async () => {
  const { hub, net, a, ua } = await twoAccounts();
  net.addChat(ua, 500, '有头像的人', 'user', { hasAvatar: true });
  await hub.refreshDialogs(a);
  net.avatarLoads = 0;
  assert.equal(await hub.loadAvatar(dialogKey(a, 101)), null); // 没设头像
  assert.equal(net.avatarLoads, 0);
  const first = await hub.loadAvatar(dialogKey(a, 500));
  const again = await hub.loadAvatar(dialogKey(a, 500));
  assert.ok(first && first.byteLength > 0);
  assert.equal(again, first);
  assert.equal(net.avatarLoads, 1);
});

test('转发：在同一个账号内把多条消息转到另一个会话，内容和附件都带上', async () => {
  const { hub, net, a, ua } = await twoAccounts();
  const from = dialogKey(a, 101);
  const to = dialogKey(a, 102);
  net.seed(ua, 101, '报价单见附件', { file: { name: '报价.xlsx' } });
  await hub.openChat(from);
  const ids = hub.messages(from).map((m) => m.id);
  const n = await hub.forward(from, ids, to);
  assert.equal(n, 2);
  assert.deepEqual(net.forwards, [{ userId: ua, from: 101, to: 102, ids }]);
  const last = hub.dialog(to)?.last;
  assert.equal(last?.text, '报价单见附件');
  assert.equal(last?.attachment?.name, '报价.xlsx');
  assert.equal(last?.out, true);
});

test('转发：不能跨账号；不能转到没有发言权限的会话；对方禁止转发时给出提示；有数量上限', async () => {
  const { hub, net, a, b } = await twoAccounts();
  const from = dialogKey(a, 101);
  await hub.openChat(from);
  const id = hub.messages(from)[0]!.id;
  await assert.rejects(hub.forward(from, [id], dialogKey(b, 101)), /同一个账号/);
  await assert.rejects(hub.forward(dialogKey(b, 101), [1], dialogKey(b, -1000000000555)), (e: unknown) => e instanceof AppError && e.code === 'forbidden');
  net.protectedChats.add(101);
  await assert.rejects(hub.forward(from, [id], dialogKey(a, 102)), /禁止转发/);
  await assert.rejects(hub.forward(from, Array.from({ length: 31 }, (_, i) => i + 1), dialogKey(a, 102)), /最多转发 30 条/);
  await assert.rejects(hub.forward(from, [], dialogKey(a, 102)), AppError);
  assert.equal(net.forwards.length, 0);
});

test('多选删除：只删自己发的，别人发的会被跳过', async () => {
  const { hub, a } = await twoAccounts();
  const key = dialogKey(a, 101);
  await hub.openChat(key);
  const theirs = hub.messages(key)[0]!.id;
  const m1 = await hub.send(key, '第一条');
  const m2 = await hub.send(key, '第二条');
  assert.equal(await hub.removeMany(key, [theirs, m1.id, m2.id]), 2);
  assert.deepEqual(hub.messages(key).map((m) => m.id), [theirs]);
  assert.equal(hub.dialog(key)?.last?.id, theirs);
});

test('贴纸：列出这个账号的贴纸包和贴纸，发出去后显示为贴纸消息', async () => {
  const { hub, net, a, ua } = await twoAccounts();
  const sets = await hub.listStickerSets(a);
  assert.deepEqual(sets.map((s) => [s.title, s.count]), [['生意常用', 3], ['日常', 2]]);
  const stickers = await hub.listStickers(a, sets[0]!.id);
  assert.equal(stickers.length, 3);
  assert.ok((await hub.loadStickerImage(a, stickers[0]!.id))?.data.byteLength);
  const key = dialogKey(a, 101);
  const msg = await hub.sendSticker(key, stickers[0]!.id);
  assert.deepEqual(msg.attachment?.sticker, { emoji: '👌', format: 'static' });
  assert.deepEqual(net.sent.at(-1), { userId: ua, chatId: 101, text: '[贴纸:biz-ok]' });
  assert.equal(hub.dialog(key)?.last?.id, msg.id);
  // 收到的贴纸可以取到图片
  assert.ok((await hub.loadAttachment(key, msg.id))?.data.byteLength);
});

test('建群：选联系人建群，新群出现在列表里；被拉的人不允许时会告知人数', async () => {
  const { hub, net, a, ua } = await twoAccounts();
  advance(hub, 25 * HOUR);
  net.noInvite.add(102);
  const { key, notAdded } = await hub.createGroup(a, '  华东客户群  ', [dialogKey(a, 101), dialogKey(a, 102)]);
  assert.equal(notAdded, 1);
  const d = hub.dialog(key);
  assert.deepEqual([d?.title, d?.kind, d?.canManage, d?.accountId], ['华东客户群', 'group', true, a]);
  assert.equal(hub.dialogs()[0]?.key, key); // 排在最前
  assert.deepEqual(net.groupLog, [{ userId: ua, action: 'create', chatId: d!.chatId, members: [101, 102] }]);
  assert.deepEqual(await hub.groupInfo(key), { members: 2 });
  // 改名、邀请链接、发消息
  await hub.renameGroup(key, '华东 VIP 群');
  assert.equal(hub.dialog(key)?.title, '华东 VIP 群');
  assert.match(await hub.inviteLink(key), /^https:\/\/t\.me\/\+/);
  await hub.send(key, '大家好');
  // 退群后从列表消失
  await hub.leaveGroup(key);
  assert.equal(hub.dialog(key), null);
});

test('建群和拉人的保护：刚登录不满 24 小时不行；一次最多 10 人；只能拉本账号的联系人', async () => {
  const { hub, net, a, b, ua } = await twoAccounts();
  await assert.rejects(hub.createGroup(a, '新群', [dialogKey(a, 101)]), /24 小时内不能建群/);
  advance(hub, 25 * HOUR);
  for (let i = 0; i < 12; i++) net.addChat(ua, 600 + i, `联系人${i}`);
  net.addChat(ua, 700, '已有的群', 'group');
  await hub.refreshDialogs(a);
  const many = Array.from({ length: 11 }, (_, i) => dialogKey(a, 600 + i));
  await assert.rejects(hub.createGroup(a, '大群', many), /最多选 10 个人/);
  await assert.rejects(hub.createGroup(a, '串号群', [dialogKey(b, 101)]), /已有私聊的联系人/);
  await assert.rejects(hub.createGroup(a, '群拉群', [dialogKey(a, 700)]), /已有私聊的联系人/);
  await assert.rejects(hub.createGroup(a, '   ', [dialogKey(a, 101)]), /群名/);
  await assert.rejects(hub.createGroup(a, '空群', []), /至少要选一个人/);
  assert.equal(net.groupLog.length, 0);
  // 往已有的群里加人同样受限
  assert.deepEqual(await hub.addMembers(dialogKey(a, 700), [dialogKey(a, 600), dialogKey(a, 601)]), { notAdded: 0 });
  await assert.rejects(hub.addMembers(dialogKey(a, 700), many), /最多选 10 个人/);
  await assert.rejects(hub.addMembers(dialogKey(a, 101), [dialogKey(a, 600)]), /只有群才能加人/);
  assert.deepEqual(net.groupLog.map((g) => g.action), ['add']);
});
