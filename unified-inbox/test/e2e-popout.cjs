// 独立窗口、表情面板、粘贴发文件的界面自动化测试（不联网，用模拟连接）。
// 用法：先 npm start，然后 node test/e2e-popout.cjs [截图目录]
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const SHOTS = process.argv[2] || null;
const PASSWORD = 'Kehu-2026-gongying';
const UID = 800000011;

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const problems = [];
  const watch = (p, name) => {
    p.on('console', (m) => m.type() === 'error' && problems.push(`[${name}] ${m.text()}`));
    p.on('pageerror', (e) => problems.push(`[${name}] ${e.message}`));
  };
  const page = await ctx.newPage();
  watch(page, 'main');
  await page.goto(`${BASE}/?mock`);
  await page.fill('input[type=password] >> nth=0', PASSWORD);
  await page.fill('input[type=password] >> nth=1', PASSWORD);
  await page.check('input[type=checkbox]');
  await page.click('button[type=submit]');
  await page.fill('.api-setup input >> nth=0', '1234567');
  await page.fill('.api-setup input >> nth=1', '0123456789abcdef0123456789abcdef');
  await page.click('.api-setup button[type=submit]');
  await page.click('.modal .method:not(.primary)');
  await page.fill('.modal input[type=tel]', '+8613800000011');
  await page.click('.modal button[type=submit]');
  await page.fill('.modal input[autocomplete=one-time-code]', '12345');
  await page.click('.modal button[type=submit]');
  await page.fill('.modal input[placeholder*="客户号"]', '客户号');
  await page.click('.modal button[type=submit]');
  await page.waitForFunction(() => document.querySelectorAll('.dialog').length === 2);

  const popup = async (action, name) => {
    const [p] = await Promise.all([ctx.waitForEvent('page'), action()]);
    watch(p, name);
    await p.waitForSelector('.app.popout');
    return p;
  };

  // 1. 双击会话 → 在独立窗口打开；主窗口不再占着这个会话，列表里有「已在独立窗口」标记
  const w1 = await popup(() => page.dblclick('.dialog:has-text("测试联系人甲")'), 'w1');
  await w1.waitForSelector('.msg.in:has-text("你好，在吗")');
  assert.match(await w1.title(), /测试联系人甲 · 客户号/);
  assert.match(await w1.textContent('.chat-head .via'), /客户号/);
  await page.waitForSelector('.chat.placeholder');
  await page.waitForSelector('.dialog:has-text("测试联系人甲") [title="已在独立窗口打开"]');
  // 样式在独立窗口里生效（不是没加载样式的白板）
  assert.equal(await w1.evaluate(() => getComputedStyle(document.querySelector('.bubble')).borderRadius !== '0px'), true);

  // 2. 在独立窗口里回复：从正确的账号发出
  await w1.fill('.composer textarea', '独立窗口里回的');
  await w1.keyboard.press('Enter');
  await w1.waitForSelector('.msg.out:has-text("独立窗口里回的")');
  assert.deepEqual(await page.evaluate(() => window.__mockNet.sent.at(-1)), { userId: UID, chatId: 1, text: '独立窗口里回的' });

  // 3. 独立窗口开着并在前台时来新消息：直接出现在窗口里，不计未读
  await w1.bringToFront();
  await page.evaluate((u) => window.__mockNet.deliver(u, 1, '窗口里能实时看到吗'), UID);
  await w1.waitForSelector('.msg.in:has-text("窗口里能实时看到吗")');
  assert.equal(await page.locator('.dialog:has-text("测试联系人甲") .badge').count(), 0);

  // 4. 从聊天标题栏的按钮把另一个会话也弹出去 → 同时开着两个独立窗口
  await page.click('.dialog:has-text("测试联系人乙")');
  await page.waitForSelector('.chat-head');
  const w2 = await popup(() => page.click('.chat-head button[title="在独立窗口打开这个会话"]'), 'w2');
  await w2.waitForSelector('.msg.in:has-text("报价发我一下")');
  await page.waitForSelector('.chat.placeholder');

  // 5. 表情面板：点一下插入到输入框，可以连续点
  await w2.click('.input-row button[title="表情"]');
  await w2.waitForSelector('.emoji-panel');
  await w2.fill('.composer textarea', '好的');
  await w2.click('.emoji[aria-label="表情 👍"]');
  await w2.click('.emoji[aria-label="表情 🙏"]');
  assert.equal(await w2.inputValue('.composer textarea'), '好的👍🙏');
  if (SHOTS) await w2.screenshot({ path: `${SHOTS}/20-popout-emoji.png` });
  await w2.click('.send');
  await w2.waitForSelector('.msg.out:has-text("好的👍🙏")');

  // 6. 直接粘贴文件（截图、复制的文件）→ 确认后发出
  await w2.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['报价内容'], '报价单.txt', { type: 'text/plain' }));
    document.querySelector('.composer textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await w2.waitForSelector('.modal:has-text("报价单.txt")');
  await w2.click('.modal button:has-text("发送")');
  await w2.waitForSelector('.msg.out:has-text("[文件] 报价单.txt")');
  assert.deepEqual(await page.evaluate(() => window.__mockNet.files.at(-1)), { userId: UID, chatId: 2, name: '报价单.txt', bytes: 12, asPhoto: false });

  // 7. 两个窗口互不干扰：给甲发的消息不会出现在乙的窗口
  await page.evaluate((u) => window.__mockNet.deliver(u, 1, '只发给甲的'), UID);
  await w1.waitForSelector('.msg.in:has-text("只发给甲的")');
  assert.equal(await w2.locator('.msg:has-text("只发给甲的")').count(), 0);

  // 8. 账号独立窗口：双击左侧账号 → 单独一个窗口只显示这个账号的会话，可以在里面切换会话和回复
  const wa = await popup(() => page.dblclick('.rail-item[title^="客户号"]'), 'account');
  await wa.waitForFunction(() => document.querySelectorAll('.dialog').length === 2);
  assert.match(await wa.title(), /客户号 · 聚信/);
  assert.equal(await wa.locator('.rail').count(), 0);
  // 先把 w1 关掉，再在账号窗口里打开甲
  await w1.close();
  await page.waitForFunction(() => !document.querySelector('.dialog [title="已在独立窗口打开"]') || document.querySelectorAll('.dialog [title="已在独立窗口打开"]').length === 1);
  await wa.click('.dialog:has-text("测试联系人甲")');
  await wa.waitForSelector('.msg.in:has-text("只发给甲的")');
  await wa.fill('.composer textarea', '账号窗口里回的');
  await wa.keyboard.press('Enter');
  await wa.waitForSelector('.msg.out:has-text("账号窗口里回的")');
  if (SHOTS) await wa.screenshot({ path: `${SHOTS}/21-account-window.png` });

  // 9. 关掉账号窗口后，甲再来消息 → 主窗口恢复计未读
  await wa.close();
  await page.waitForFunction(() => document.querySelectorAll('.dialog:has(.dialog-title) [title="已在独立窗口打开"]').length === 1);
  await page.evaluate((u) => window.__mockNet.deliver(u, 1, '窗口关了以后'), UID);
  await page.waitForSelector('.dialog:has-text("测试联系人甲") .badge');
  assert.equal(await page.textContent('.dialog:has-text("测试联系人甲") .badge'), '1');

  // 10. 同一个会话再次双击：不会开出第二个窗口，而是切到已有的那个
  const before = ctx.pages().length;
  await page.dblclick('.dialog:has-text("测试联系人乙")');
  await page.waitForTimeout(400);
  assert.equal(ctx.pages().length, before);

  // 11. 主窗口上锁：所有独立窗口一起关闭，桌面上不会留着还在显示消息的窗口
  assert.equal(w2.isClosed(), false);
  await page.click('.rail-tools button[title="立即上锁"]');
  await page.waitForSelector('.gate-card:has-text("已上锁")');
  await w2.waitForEvent('close', { timeout: 5000 }).catch(() => {});
  assert.equal(w2.isClosed(), true);
  assert.equal(ctx.pages().length, 1);

  await browser.close();
  assert.deepEqual(problems, []);
  console.log('独立窗口测试通过');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
