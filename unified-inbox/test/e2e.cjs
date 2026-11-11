// 界面全流程自动化测试（不联网，用模拟连接）。
// 用法：先 node build.mjs && node scripts/serve.mjs dist 4173，然后 node test/e2e.cjs [截图目录]
const assert = require('node:assert/strict');
const { chromium, devices } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const SHOTS = process.argv[2] || null;
const PASSWORD = 'Kehu-2026-gongying';

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function addAccount(page, phone, label, { password, tooSoon } = {}) {
  await page.waitForSelector('.modal input[type=tel]');
  await page.fill('.modal input[type=tel]', phone);
  if (tooSoon) {
    // 刚登录完一个账号又来一个：给出风险提醒，不勾选确认就不能继续
    assert.match(await page.textContent('.modal .danger-box'), /建议再等 10 分钟/);
    assert.equal(await page.isDisabled('.modal button[type=submit]'), true);
    await page.check('.modal .danger-box input[type=checkbox]');
  } else {
    assert.equal(await page.locator('.modal .danger-box').count(), 0);
  }
  assert.match(await page.textContent('.modal .tips'), /平时常用的网络/);
  await page.click('.modal button[type=submit]');
  await page.waitForSelector('.modal input[autocomplete=one-time-code]');
  await page.fill('.modal input[autocomplete=one-time-code]', '00000');
  await page.click('.modal button[type=submit]');
  await page.waitForSelector('.modal .error');
  assert.match(await page.textContent('.modal .error'), /验证码不正确/);
  await page.fill('.modal input[autocomplete=one-time-code]', '12345');
  await page.click('.modal button[type=submit]');
  if (password) {
    await page.waitForSelector('.modal input[type=password]');
    await page.fill('.modal input[type=password]', password);
    await page.click('.modal button[type=submit]');
  }
  await page.waitForSelector('.modal input[placeholder*="客户号"]');
  await page.fill('.modal input[placeholder*="客户号"]', label);
  await page.click('.modal button[type=submit]');
  await page.waitForSelector('.modal', { state: 'detached' });
}

let current = null;

async function main() {
  const browser = await chromium.launch();
  const problems = [];
  const watch = (page, name) => {
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`[${name}] console: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`[${name}] pageerror: ${e.message}`));
  };

  // ———— 电脑：完整流程 ————
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  current = page;
  watch(page, 'desktop');
  await page.clock.install(); // 之后可以把时间往后拨，验证「24 小时保护期」
  await page.goto(`${BASE}/?mock`);

  // 1. 设置主密码：弱密码被拒绝
  await page.fill('input[type=password] >> nth=0', '12345678');
  await page.fill('input[type=password] >> nth=1', '12345678');
  await page.check('input[type=checkbox]');
  await page.click('button[type=submit]');
  assert.match(await page.textContent('.error'), /纯数字|太常见/);
  await page.fill('input[type=password] >> nth=0', PASSWORD);
  await page.fill('input[type=password] >> nth=1', PASSWORD);
  await shot(page, '01-setup');
  await page.click('button[type=submit]');

  // 2. 接口参数：格式不对被拒绝
  await page.waitForSelector('.api-setup');
  await page.fill('.api-setup input >> nth=0', '1234567');
  await page.fill('.api-setup input >> nth=1', 'not-a-hash');
  await page.click('.api-setup button[type=submit]');
  assert.match(await page.textContent('.api-setup .error'), /32 位/);
  await shot(page, '02-api');
  await page.fill('.api-setup input >> nth=1', '0123456789abcdef0123456789abcdef');
  await page.click('.api-setup button[type=submit]');

  // 3. 连续添加两个账号（第二个带两步验证）
  await addAccount(page, '+8613800000011', '客户号');
  await page.click('.rail-item[title="添加账号"]');
  await shot(page, '02b-add-account');
  await addAccount(page, '+8613800000022', '供应商号', { password: 'mima1234', tooSoon: true });
  await page.waitForFunction(() => document.querySelectorAll('.dialog').length === 4);
  assert.equal(await page.locator('.rail-accounts .rail-item').count(), 3); // 两个账号 + 添加按钮
  assert.equal(await page.title(), '(4) 聚信');
  await shot(page, '03-inbox');

  // 4. 每条会话都标着来自哪个账号
  const chips = await page.locator('.dialog .chip').allTextContents();
  assert.deepEqual([...new Set(chips)].sort(), ['供应商号', '客户号']);

  // 5. 只看某个账号
  await page.click('.rail-item[title^="供应商号"]');
  assert.deepEqual([...new Set(await page.locator('.dialog .chip').allTextContents())], ['供应商号']);
  assert.equal(await page.textContent('.list-title h1'), '供应商号');
  await page.click('.rail-item[title="全部账号"]');

  // 6. 打开会话、回复；消息从正确的账号发出
  await page.click('.dialog:has(.chip:text("客户号")):has-text("测试联系人甲")');
  await page.waitForSelector('.msg.in');
  assert.match(await page.textContent('.chat-head .via'), /客户号/);
  assert.match(await page.getAttribute('.composer textarea', 'placeholder'), /以「客户号」回复 测试联系人甲/);
  await page.fill('.composer textarea', '在的，您请说');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.msg.out:has-text("在的，您请说")');
  assert.equal(await page.inputValue('.composer textarea'), '');
  let sent = await page.evaluate(() => window.__mockNet.sent);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].userId, 800000011);

  // 7. 一键快捷回复
  await page.click('.quick:has-text("收到")');
  await page.waitForSelector('.msg.out:has-text("收到，马上处理。")');

  // 8. 引用回复、修改、删除
  await page.click('.msg.in .bubble');
  await page.click('.msg-actions button:has-text("回复")');
  await page.waitForSelector('.context-bar:has-text("回复：你好，在吗")');
  await page.fill('.composer textarea', '引用回复测试');
  await page.click('.send');
  await page.waitForSelector('.msg.out:has-text("引用回复测试") .quote');
  await page.click('.msg.out:has-text("引用回复测试") .bubble');
  await page.click('.msg-actions button:has-text("修改")');
  await page.fill('.composer textarea', '改过的内容');
  await page.click('.send');
  await page.waitForSelector('.msg.out:has-text("改过的内容")');
  assert.match(await page.textContent('.msg.out:has-text("改过的内容") .meta'), /已修改/);
  await page.click('.msg.out:has-text("改过的内容") .bubble');
  await page.click('.msg-actions button:has-text("删除")');
  assert.equal(await page.locator('.msg.out:has-text("改过的内容")').count(), 1); // 第一下只是询问
  await page.click('.msg-actions button:has-text("确认删除")');
  await page.waitForSelector('.msg.out:has-text("改过的内容")', { state: 'detached' });
  await shot(page, '04-chat');

  // 9. 恶意内容只会当文字显示，不会被执行
  await page.evaluate(() => window.__mockNet.deliver(800000011, 1, '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script> 看这个 https://example.com/a?b=1'));
  await page.waitForSelector('.msg.in:has-text("看这个")');
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.equal(await page.locator('.messages img[src="x"]').count(), 0);
  const link = page.locator('.msg.in a[href="https://example.com/a?b=1"]');
  assert.equal(await link.getAttribute('rel'), 'noopener noreferrer nofollow');

  // 10. 实时来消息：别的账号的会话未读加一，并排到最前
  await page.evaluate(() => window.__mockNet.deliver(800000022, 2, '货什么时候到？'));
  await page.waitForSelector('.dialog:first-child:has-text("货什么时候到？")');
  assert.equal(await page.textContent('.dialog:first-child .chip'), '供应商号');
  assert.equal(await page.textContent('.dialog:first-child .badge'), '2');

  // 11a. 刚登录的账号处于 24 小时保护期：批量回复名单是空的，并说明原因
  await page.click('button:has-text("批量回复")');
  await page.waitForSelector('.modal .banner:has-text("保护中")');
  assert.match(await page.textContent('.modal .banner'), /「客户号」.*24 小时.*「供应商号」.*24 小时/);
  assert.equal(await page.locator('.batch-list').count(), 0);
  await shot(page, '05a-batch-protected');
  await page.click('.modal button:has-text("取消")');

  // 11b. 25 小时后：期间早已自动上锁，解锁后保护期结束
  await page.clock.fastForward('25:00:00');
  await page.waitForSelector('.gate-card:has-text("已上锁")');
  await page.fill('input[type=password]', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForFunction(() => document.querySelectorAll('.dialog').length === 4);

  // 11c. 批量回复
  await page.click('button:has-text("批量回复")');
  await page.waitForSelector('.batch-list');
  assert.equal(await page.locator('.batch-list input:checked').count(), 3);
  await page.click('.modal .quick:has-text("稍等")');
  await shot(page, '05-batch');
  await page.click('.modal button:has-text("下一步")');
  await page.waitForSelector('.preview');
  await page.click('.modal button:has-text("确认发送")');
  await page.waitForSelector('.modal p[role=status]:has-text("发送结束：成功 3 个")', { timeout: 30000 });
  await shot(page, '06-batch-done');
  await page.click('.modal button:has-text("完成")');
  sent = await page.evaluate(() => window.__mockNet.sent);
  const batch = sent.filter((s) => s.text.startsWith('您好，请稍等'));
  assert.equal(batch.length, 3);
  assert.equal(batch.filter((s) => s.userId === 800000011).length, 1);
  assert.equal(batch.filter((s) => s.userId === 800000022).length, 2);
  assert.equal(await page.title(), '聚信');
  assert.equal(await page.isDisabled('button:has-text("批量回复")'), true);

  // 12. 本机存储里只有密文
  const stored = await page.evaluate(() => JSON.stringify(localStorage));
  for (const secret of ['mock-session', '13800000011', '客户号', '0123456789abcdef0123456789abcdef']) {
    assert.ok(!stored.includes(secret), `本机存储不应出现明文：${secret}`);
  }
  assert.equal(await page.evaluate(() => sessionStorage.length), 0);
  assert.equal(await page.evaluate(async () => (await indexedDB.databases()).length), 0);

  // 13. 第二个窗口打不开
  const page2 = await ctx.newPage();
  await page2.goto(`${BASE}/?mock`);
  await page2.waitForSelector('.gate-card');
  assert.match(await page2.textContent('.gate-card'), /已经在另一个窗口打开/);
  await page2.close();

  // 14. 上锁：界面上不再有任何消息；错误密码进不去；正确密码恢复全部账号
  await page.click('.rail-tools button[title="立即上锁"]');
  await page.waitForSelector('.gate-card:has-text("已上锁")');
  assert.equal(await page.locator('.dialog, .msg').count(), 0);
  assert.ok(!(await page.content()).includes('测试联系人'));
  await page.fill('input[type=password]', 'wrong-password-1');
  await page.click('button[type=submit]');
  await page.waitForSelector('.error:has-text("主密码不正确")');
  await shot(page, '07-locked');
  await page.fill('input[type=password]', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForFunction(() => document.querySelectorAll('.dialog').length === 4);
  assert.equal(await page.locator('.rail .dot-online').count(), 2);

  // 15. 刷新页面后仍需主密码，解锁后账号都在
  await page.reload();
  await page.waitForSelector('.gate-card:has-text("已上锁")');
  await page.fill('input[type=password]', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForSelector('.rail-item[title^="客户号"]');
  await page.waitForSelector('.rail-item[title^="供应商号"]');

  // 16. 账号管理：移除一个账号
  await page.click('.rail-tools button[title="账号管理"]');
  await page.waitForSelector('.account-list');
  // 设为重要账号后出现保护标记
  await page.click('.account-list li:has-text("客户号") button:has-text("设为重要")');
  await page.waitForSelector('.account-list li:has-text("客户号") .guard-tag:has-text("重要账号保护中")');
  await shot(page, '08-accounts');
  await page.click('.account-list li:has-text("供应商号") button:has-text("移除")');
  await page.click('.danger-box button:has-text("确认移除")');
  await page.waitForSelector('.banner:has-text("已移除「供应商号」")');
  await page.click('.modal-head .icon-btn');
  assert.equal(await page.locator('.rail-accounts .rail-item').count(), 2);
  assert.deepEqual([...new Set(await page.locator('.dialog .chip').allTextContents())], ['客户号']);

  // 17. 设置：改主密码，旧密码失效
  await page.click('.rail-tools button[title="设置与安全"]');
  await shot(page, '09-settings');
  await page.click('.setting:has-text("修改主密码")');
  await page.fill('.modal input[autocomplete=current-password]', PASSWORD);
  await page.fill('.modal input[autocomplete=new-password] >> nth=0', 'Xin-mima-2027-ok');
  await page.fill('.modal input[autocomplete=new-password] >> nth=1', 'Xin-mima-2027-ok');
  await page.click('.modal button[type=submit]');
  await page.waitForSelector('.banner:has-text("主密码已修改")');

  // 18. 退出所有账号并清空
  await page.click('.setting:has-text("退出所有账号并清空本机数据")');
  await page.fill('.modal input', '清空');
  await page.click('.modal button:has-text("退出所有账号并清空")');
  await page.waitForSelector('.gate-card:has-text("先设置一个主密码")');
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('ui-mock:')).length), 0);
  await ctx.close();

  // ———— 手机：列表 → 聊天 → 返回 ————
  const mctx = await browser.newContext({ ...devices['Pixel 7'] });
  const m = await mctx.newPage();
  current = m;
  watch(m, 'mobile');
  await m.goto(`${BASE}/?demo`);
  await m.waitForSelector('.dialog');
  assert.equal(await m.locator('.chat').isVisible(), false);
  await shot(m, '10-mobile-list');
  await m.tap('.dialog >> nth=0');
  await m.waitForSelector('.msg');
  assert.equal(await m.locator('.list-pane').isVisible(), false);
  assert.equal(await m.locator('.chat-head .back').isVisible(), true);
  // 手机上回车是换行，不会误发
  await m.fill('.composer textarea', '第一行');
  await m.keyboard.press('Enter');
  assert.equal(await m.locator('.msg.out:has-text("第一行")').count(), 0);
  await m.tap('.send');
  await m.waitForSelector('.msg.out:has-text("第一行")');
  await shot(m, '11-mobile-chat');
  await m.goBack(); // 系统返回键回到列表
  await m.waitForSelector('.list-pane', { state: 'visible' });
  // 手机上工具按钮在标题栏右侧，都点得到
  assert.equal(await m.locator('.head-tools button[title="立即上锁"]').isVisible(), true);
  assert.equal(await m.locator('.rail-tools').isVisible(), false);
  await m.tap('button:has-text("批量回复")');
  await m.waitForSelector('.batch-list');
  // 群聊在名单里但默认不勾选；静音的群不在名单里
  assert.equal(await m.locator('.batch-list li:has-text("华东客户群") input').isChecked(), false);
  assert.equal(await m.locator('.batch-list li:has-text("李小姐") input').isChecked(), true);
  assert.equal(await m.locator('.batch-list li:has-text("原料供应商群")').count(), 0);
  await shot(m, '12-mobile-batch');
  // 页面不能横向滚动
  assert.equal(await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await mctx.close();

  await browser.close();
  assert.deepEqual(problems, []);
  console.log('界面全流程测试通过');
}

main().catch(async (e) => {
  console.error(e);
  if (current) {
    console.error('—— 失败时页面上的文字 ——\n' + (await current.innerText('body').catch(() => '(读不到)')).slice(0, 1500));
    if (SHOTS) await current.screenshot({ path: `${SHOTS}/failure.png` }).catch(() => {});
  }
  process.exit(1);
});
