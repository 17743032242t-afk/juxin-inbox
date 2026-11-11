// 下载文件、播放语音、贴纸、转发、多选、头像、建群和群管理的界面自动化测试（不联网，用模拟连接）。
// 用法：先 npm start，然后 node test/e2e-features.cjs [截图目录]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const SHOTS = process.argv[2] || null;
const PASSWORD = 'Kehu-2026-gongying';
const UID = 800000011;

async function main() {
  // 测试机如果没设语言环境，浏览器会把中文文件名存成 "download"；这里固定为 UTF-8，和真实电脑一致
  const browser = await chromium.launch({ env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  const problems = [];
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  page.on('pageerror', (e) => problems.push(e.message));
  const shot = (name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : null);
  await page.clock.install();
  await page.goto(`${BASE}/?mock`);
  await page.evaluate(() => {
    const net = window.__mockNet;
    net.onNewUser = (u) => {
      net.addChat(u, 1, '客户甲', 'user', { hasAvatar: true });
      net.addChat(u, 2, '客户乙');
      net.addChat(u, 3, '客户丙');
      net.addChat(u, 10, '老群', 'group');
      net.seed(u, 2, '你好', { ago: 90000 });
      net.seed(u, 3, '在吗', { ago: 80000 });
      net.seed(u, 10, '群里的消息', { ago: 70000, sender: '老王' });
      net.seed(u, 1, '合同发你了，看一下', { ago: 60000 });
      net.seed(u, 1, '', { ago: 50000, file: { name: '合同.pdf', mime: 'application/pdf', size: 204800 } });
      net.seed(u, 1, '', { ago: 40000, file: { kind: 'voice', name: '语音.ogg', mime: 'audio/ogg', size: 9000, duration: 12 } });
      net.seed(u, 1, '', { ago: 30000, file: { kind: 'sticker', name: '贴纸', mime: 'image/webp', sticker: { emoji: '👌', format: 'static' } } });
      net.seed(u, 1, '', { ago: 20000, file: { kind: 'sticker', name: '贴纸', mime: 'application/x-tgsticker', sticker: { emoji: '🎉', format: 'animated' } } });
      net.seed(u, 1, '没问题的话今天签', { ago: 10000, unread: true });
    };
  });
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
  await page.waitForFunction(() => document.querySelectorAll('.dialog').length === 4);

  // 1. 真实头像：设了头像的显示图片，没设的仍显示首字
  await page.waitForSelector('.dialog:has-text("客户甲") img.avatar-img');
  assert.equal(await page.locator('.dialog:has-text("客户乙") img.avatar-img').count(), 0);

  // 2. 下载收到的文件：浏览器按「文件下载」保存，文件名正确、内容完整
  await page.click('.dialog:has-text("客户甲")');
  await page.waitForSelector('.file-card:has-text("合同.pdf")');
  assert.match(await page.textContent('.file-card'), /200 KB/);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('.file-card button:has-text("下载")')]);
  assert.equal(download.suggestedFilename(), '合同.pdf');
  assert.equal(fs.readFileSync(await download.path(), 'utf8'), '模拟文件内容：合同.pdf');
  await page.waitForSelector('.file-card:has-text("已保存")');

  // 3. 语音：点播放后出现播放器
  assert.match(await page.textContent('.playable'), /语音.*0:12/s);
  await page.click('.playable .play-btn');
  await page.waitForSelector('audio.audio[src^="blob:"]');

  // 4. 贴纸：静态贴纸显示本体；动画贴纸显示它的静态预览
  await page.waitForFunction(() => document.querySelectorAll('.msg.sticker-msg img.sticker[src^="blob:"]').length === 2);
  await shot('30-attachments');

  // 5. 贴纸面板：列出这个账号的贴纸包，点一下直接发出
  await page.click('.input-row button[title="表情"]');
  await page.click('.panel-tabs button:has-text("贴纸")');
  await page.waitForSelector('.sticker-panel .quick:has-text("生意常用")');
  await page.waitForSelector('.sticker-thumb img');
  assert.equal(await page.locator('.sticker-thumb').count(), 3);
  await shot('31-sticker-panel');
  await page.click('.sticker-thumb >> nth=0');
  await page.waitForFunction(() => document.querySelectorAll('.msg.out.sticker-msg').length === 1);
  assert.deepEqual(await page.evaluate(() => window.__mockNet.sent.at(-1)), { userId: UID, chatId: 1, text: '[贴纸:biz-ok]' });
  await page.click('.sticker-panel .quick:has-text("日常")');
  await page.waitForFunction(() => document.querySelectorAll('.sticker-thumb').length === 2);
  await page.click('.input-row button[title="表情"]');

  // 6. 转发一条：目标列表只有本账号里别的会话
  await page.click('.msg.in:has-text("合同发你了") .bubble');
  await page.click('.msg-actions button:has-text("转发")');
  await page.waitForSelector('.modal:has-text("转发 1 条消息")');
  assert.deepEqual(await page.locator('.modal .pick-row b').allTextContents(), ['老群', '客户丙', '客户乙']);
  await page.click('.modal .pick-row:has-text("客户乙")');
  await page.waitForSelector('.chat > .banner:has-text("已转发 1 条给「客户乙」")');
  await page.waitForSelector('.dialog:has-text("客户乙"):has-text("我：合同发你了")');

  // 7. 多选：勾三条（文字、文件、文字）一起转发，附件也带过去
  await page.click('.msg.in:has-text("合同发你了") .bubble');
  await page.click('.msg-actions button:has-text("多选")');
  await page.click('.msg:has(.file-card) .bubble');
  await page.click('.msg.in:has-text("没问题的话今天签") .bubble');
  assert.match(await page.textContent('.select-bar'), /已选 3 条/);
  assert.equal(await page.locator('.msg.selected').count(), 3);
  await shot('32-multiselect');
  await page.click('.select-bar button:has-text("转发")');
  await page.click('.modal .pick-row:has-text("客户丙")');
  await page.waitForSelector('.chat > .banner:has-text("已转发 3 条给「客户丙」")');
  const fwd = await page.evaluate(() => window.__mockNet.forwards);
  assert.deepEqual(fwd.map((f) => [f.from, f.to, f.ids.length]), [[1, 2, 1], [1, 3, 3]]);
  assert.equal(await page.locator('.select-bar').count(), 0); // 转发完自动退出多选

  // 8. 多选删除：只删自己发的，要点两次确认
  await page.fill('.composer textarea', '发错的第一条');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.msg.out:has-text("发错的第一条")');
  await page.fill('.composer textarea', '发错的第二条');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.msg.out:has-text("发错的第二条")');
  await page.click('.msg.out:has-text("发错的第一条") .bubble');
  await page.click('.msg-actions button:has-text("多选")');
  await page.click('.msg.out:has-text("发错的第二条") .bubble');
  await page.click('.msg.in:has-text("没问题的话今天签") .bubble');
  await page.click('.select-bar button:has-text("删除（2）")');
  assert.equal(await page.locator('.msg.out:has-text("发错的第一条")').count(), 1); // 第一下只是询问
  await page.click('.select-bar button:has-text("确认删除 2 条")');
  await page.waitForSelector('.chat > .banner:has-text("已删除 2 条自己发的消息")');
  assert.equal(await page.locator('.msg:has-text("发错的")').count(), 0);
  assert.equal(await page.locator('.msg.in:has-text("没问题的话今天签")').count(), 1);

  // 9. 建群保护：刚登录不满 24 小时不能建群
  await page.click('.list-tools button[title="新建群"]');
  await page.fill('.modal input[placeholder*="华东客户群"]', '华东客户群');
  await page.check('.modal .pick-row:has-text("客户乙") input');
  await page.click('.modal button[type=submit]');
  await page.waitForSelector('.modal .error:has-text("24 小时内不能建群")');
  await page.click('.modal button:has-text("取消")');
  assert.equal(await page.evaluate(() => window.__mockNet.groupLog.length), 0);

  // 10. 25 小时后：建群成功，新群自动打开
  await page.clock.fastForward('25:00:00');
  await page.waitForSelector('.gate-card:has-text("已上锁")');
  await page.fill('input[type=password]', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForFunction(() => document.querySelectorAll('.dialog').length === 4);
  await page.click('.list-tools button[title="新建群"]');
  await page.fill('.modal input[placeholder*="华东客户群"]', '华东客户群');
  assert.deepEqual((await page.locator('.modal .pick-row b').allTextContents()).sort(), ['客户丙', '客户乙', '客户甲']); // 只列联系人，不列群
  await page.check('.modal .pick-row:has-text("客户乙") input');
  await page.check('.modal .pick-row:has-text("客户丙") input');
  await shot('33-new-group');
  await page.click('.modal button:has-text("建群（2 人）")');
  await page.waitForSelector('.chat-head:has-text("华东客户群")');
  assert.match(await page.textContent('.chat-head .via'), /客户号.*群聊/s);
  assert.deepEqual(await page.evaluate(() => window.__mockNet.groupLog.map((g) => [g.action, g.members])), [['create', [2, 3]]]);

  // 11. 群管理：人数、改名、邀请链接、加人、退群
  await page.click('.chat-head button[title="群管理"]');
  await page.waitForSelector('.modal:has-text("3 人")');
  await page.fill('.modal input[aria-label="群名"]', '华东 VIP 群');
  await page.click('.modal button:has-text("改群名")');
  await page.waitForSelector('.modal .banner:has-text("群名已修改")');
  await page.waitForSelector('.chat-head:has-text("华东 VIP 群")');
  await page.click('.modal .setting:has-text("邀请链接") button:has-text("查看")');
  await page.waitForSelector('.modal code.link-text:has-text("https://t.me/+")');
  await page.click('.modal .setting:has-text("邀请链接") button:has-text("复制")');
  await page.waitForSelector('.modal .banner:has-text("邀请链接已复制")');
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^https:\/\/t\.me\/\+/);
  await page.click('.modal .setting:has-text("加人进群")');
  await page.check('.modal .pick-row:has-text("客户甲") input');
  await page.click('.modal button:has-text("加入 1 人")');
  await page.waitForSelector('.modal .banner:has-text("已拉 1 人进群")');
  await page.waitForSelector('.modal:has-text("4 人")');
  await shot('34-group-manage');
  await page.click('.modal .setting:has-text("退出这个群")');
  await page.click('.modal .danger-box button:has-text("确认退出")');
  await page.waitForSelector('.modal', { state: 'detached' });
  await page.waitForFunction(() => document.querySelectorAll('.dialog').length === 4);
  assert.equal(await page.locator('.dialog:has-text("华东")').count(), 0);
  assert.deepEqual(await page.evaluate(() => window.__mockNet.groupLog.map((g) => g.action)), ['create', 'add', 'leave']);

  await browser.close();
  // 模拟的语音内容不是真的音频，浏览器解码失败属于预期，不算软件的错
  const real = problems.filter((p) => !/Failed to load resource|DEMUXER|MEDIA_ELEMENT|NotSupportedError|no supported source/i.test(p));
  assert.deepEqual(real, []);
  console.log('新功能界面测试通过');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
