import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '../src/core/types.ts';
import { MemoryStore, Vault, checkPasswordStrength, throttleDelaySeconds } from '../src/core/vault.ts';
import { PASSWORD, TEST_ITER } from './helpers.ts';

test('新建后能用正确的主密码解锁并读回数据', async () => {
  const store = new MemoryStore();
  const v = await Vault.create(store, PASSWORD, TEST_ITER);
  v.data.api = { id: 1, hash: 'h' };
  v.data.accounts.push({ id: 'a', label: '客户号', color: '#000', phone: '+1', userId: 7, name: 'n', username: null, session: 'SECRET-SESSION' });
  await v.save();
  const again = await Vault.unlock(store, PASSWORD);
  assert.equal(again.data.accounts[0]?.session, 'SECRET-SESSION');
  assert.equal(again.data.api?.id, 1);
});

test('存到本机的内容是密文，看不到凭据、手机号和备注', async () => {
  const store = new MemoryStore();
  const v = await Vault.create(store, PASSWORD, TEST_ITER);
  v.data.accounts.push({ id: 'a', label: '供应商号', color: '#000', phone: '+8613800001111', userId: 7, name: '张三', username: null, session: 'SECRET-SESSION' });
  await v.save();
  const raw = store.get('vault')!;
  for (const secret of ['SECRET-SESSION', '13800001111', '供应商号', '张三']) {
    assert.ok(!raw.includes(secret), `不应出现明文：${secret}`);
    assert.ok(!raw.includes(Buffer.from(secret).toString('base64').slice(0, 12)), `不应出现 base64 明文：${secret}`);
  }
});

test('主密码错误时解不开，并且不泄露任何内容', async () => {
  const store = new MemoryStore();
  await Vault.create(store, PASSWORD, TEST_ITER);
  await assert.rejects(Vault.unlock(store, 'Wrong-password-01'), (e: unknown) => e instanceof AppError && e.code === 'bad_password');
});

test('每次保存都换新的随机 IV，同样内容的密文也不同', async () => {
  const store = new MemoryStore();
  const v = await Vault.create(store, PASSWORD, TEST_ITER);
  const a = JSON.parse(store.get('vault')!);
  await v.save();
  const b = JSON.parse(store.get('vault')!);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
  assert.equal(a.salt, b.salt);
});

test('密文被改动一个字节就拒绝解锁（防篡改）', async () => {
  const store = new MemoryStore();
  await Vault.create(store, PASSWORD, TEST_ITER);
  const file = JSON.parse(store.get('vault')!);
  const bytes = Buffer.from(file.ct, 'base64');
  bytes[5] = bytes[5]! ^ 1;
  file.ct = bytes.toString('base64');
  store.set('vault', JSON.stringify(file));
  await assert.rejects(Vault.unlock(store, PASSWORD), AppError);
});

test('把迭代次数改小（降级攻击）会导致解锁失败', async () => {
  const store = new MemoryStore();
  await Vault.create(store, PASSWORD, TEST_ITER);
  const file = JSON.parse(store.get('vault')!);
  file.iter = 1;
  store.set('vault', JSON.stringify(file));
  await assert.rejects(Vault.unlock(store, PASSWORD), AppError);
});

test('连续输错会被要求等待，等待期间连正确密码也不接受；输对后清零', async () => {
  const store = new MemoryStore();
  await Vault.create(store, PASSWORD, TEST_ITER);
  let now = 1_000_000;
  for (let i = 0; i < 3; i++) {
    await assert.rejects(Vault.unlock(store, 'Wrong-password-01', now));
  }
  assert.equal(Vault.lockedForSeconds(store, now), 5);
  await assert.rejects(Vault.unlock(store, PASSWORD, now), (e: unknown) => e instanceof AppError && e.code === 'flood');
  now += 6000;
  const v = await Vault.unlock(store, PASSWORD, now);
  assert.ok(v);
  assert.equal(Vault.lockedForSeconds(store, now), 0);
  assert.equal(store.get('unlock-throttle'), null);
});

test('等待时间逐次翻倍，最多 5 分钟', () => {
  assert.equal(throttleDelaySeconds(2), 0);
  assert.equal(throttleDelaySeconds(3), 5);
  assert.equal(throttleDelaySeconds(4), 10);
  assert.equal(throttleDelaySeconds(5), 20);
  assert.equal(throttleDelaySeconds(30), 300);
});

test('修改主密码：要验证旧密码；改完旧密码失效、新密码可用', async () => {
  const store = new MemoryStore();
  const v = await Vault.create(store, PASSWORD, TEST_ITER);
  v.data.api = { id: 9, hash: 'x' };
  await v.save();
  await assert.rejects(v.changePassword('Wrong-password-01', 'New-password-02'), AppError);
  // 上面输错了一次，不影响接下来用正确的旧密码
  await v.changePassword(PASSWORD, 'New-password-02');
  await assert.rejects(Vault.unlock(store, PASSWORD), AppError);
  const again = await Vault.unlock(store, 'New-password-02');
  assert.equal(again.data.api?.id, 9);
});

test('弱密码被拒绝', async () => {
  assert.ok(checkPasswordStrength('1234567'));
  assert.ok(checkPasswordStrength('12345678'));
  assert.ok(checkPasswordStrength('aaaaaaaaaa'));
  assert.ok(checkPasswordStrength('password'));
  assert.equal(checkPasswordStrength('Kehu-2026-gongying'), null);
  await assert.rejects(Vault.create(new MemoryStore(), '123456', TEST_ITER), AppError);
});

test('并发保存按顺序落盘，最后一次的内容生效', async () => {
  const store = new MemoryStore();
  const v = await Vault.create(store, PASSWORD, TEST_ITER);
  const saves: Promise<void>[] = [];
  for (let i = 0; i < 10; i++) {
    v.data.settings.autoLockMinutes = i;
    saves.push(v.save());
  }
  await Promise.all(saves);
  const again = await Vault.unlock(store, PASSWORD);
  assert.equal(again.data.settings.autoLockMinutes, 9);
});

test('清空后保险库不存在', async () => {
  const store = new MemoryStore();
  await Vault.create(store, PASSWORD, TEST_ITER);
  assert.equal(Vault.exists(store), true);
  Vault.wipe(store);
  assert.equal(Vault.exists(store), false);
});
