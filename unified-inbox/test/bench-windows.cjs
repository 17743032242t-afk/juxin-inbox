// 压力测试：同时开很多独立窗口，持续来大量消息，测「消息到达 → 画到窗口上」要多久。
// 用法：先 npm start，然后 node test/bench-windows.cjs [窗口数=30] [消息数=1000]
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const WINDOWS = Number(process.argv[2] || 30);
const MESSAGES = Number(process.argv[3] || 1000);
const CHATS = 40;
const HISTORY = 300;
const UID = 800000011;

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/?mock`);
  // 这个账号有 40 个会话，每个会话 300 条历史消息
  await page.evaluate(({ CHATS, HISTORY }) => {
    const net = window.__mockNet;
    net.onNewUser = (userId) => {
      for (let c = 1; c <= CHATS; c++) {
        net.addChat(userId, c, `客户 ${String(c).padStart(2, '0')}`);
        for (let i = 0; i < HISTORY; i++) net.seed(userId, c, `历史消息 ${i}，内容稍微长一点用来模拟真实聊天`, { out: i % 3 === 0, ago: (HISTORY - i) * 60000 + c });
      }
    };
  }, { CHATS, HISTORY });
  await page.fill('input[type=password] >> nth=0', 'Kehu-2026-gongying');
  await page.fill('input[type=password] >> nth=1', 'Kehu-2026-gongying');
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
  await page.waitForFunction((n) => document.querySelectorAll('.dialog').length === n, CHATS);

  // 用同一套办法测一轮：按顺序往各会话发消息，每条之间让出一次，逼着界面逐条刷新（最不利的情况）
  const burst = (label) =>
    page.evaluate(async ({ MESSAGES, CHATS, UID, label }) => {
      const net = window.__mockNet;
      const yieldTask = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
      let worst = 0;
      const t0 = performance.now();
      for (let i = 0; i < MESSAGES; i++) {
        const s = performance.now();
        net.deliver(UID, (i % CHATS) + 1, `${label} 第 ${i} 条`);
        await yieldTask(); // 到这里，这条消息引起的所有窗口刷新都已完成
        worst = Math.max(worst, performance.now() - s);
      }
      const total = performance.now() - t0;
      return { total, avg: total / MESSAGES, worst };
    }, { MESSAGES, CHATS, UID, label });

  const base = await burst('基线');

  // 打开 N 个独立窗口，每个都加载完 300 条历史并滚到底
  const wins = [];
  const tOpen = Date.now();
  for (let c = 1; c <= WINDOWS; c++) {
    const [w] = await Promise.all([ctx.waitForEvent('page'), page.dblclick(`.dialog:has(.dialog-title:text-is("客户 ${String(c).padStart(2, '0')}"))`)]);
    w.on('pageerror', (e) => errors.push(e.message));
    await w.waitForSelector('.msg');
    wins.push(w);
  }
  const openMs = Date.now() - tOpen;

  const withWindows = await burst('开窗后');

  // 正确性：每个窗口都显示了属于自己的最后一条，而且没有别的会话的消息串进来
  let correct = 0;
  for (let c = 1; c <= WINDOWS; c++) {
    let last = -1;
    for (let i = 0; i < MESSAGES; i++) if ((i % CHATS) + 1 === c) last = i;
    const w = wins[c - 1];
    const texts = await w.locator('.msg.in .text').allTextContents();
    const mine = texts.filter((t) => t.startsWith('开窗后'));
    const expected = Math.floor((MESSAGES - c) / CHATS) + 1;
    if (texts.at(-1) === `开窗后 第 ${last} 条` && mine.length === expected && mine.every((t) => (Number(t.match(/第 (\d+) 条/)[1]) % CHATS) + 1 === c)) correct++;
  }

  // 在最后一个窗口里打字、发送的响应时间（同时别的窗口还在不停收消息）
  const typing = await (async () => {
    const w = wins.at(-1);
    const noise = page.evaluate(async ({ UID, CHATS }) => {
      const net = window.__mockNet;
      for (let i = 0; i < 300; i++) {
        net.deliver(UID, (i % (CHATS - 1)) + 1, `背景消息 ${i}`);
        await new Promise((r) => setTimeout(r, 5));
      }
    }, { UID, CHATS });
    const t = Date.now();
    await w.fill('.composer textarea', '忙的时候回一条');
    await w.keyboard.press('Enter');
    await w.waitForSelector('.msg.out:has-text("忙的时候回一条")');
    const ms = Date.now() - t;
    await noise;
    return ms;
  })();

  const heap = await page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null));
  console.log(JSON.stringify({
    窗口数: WINDOWS,
    会话数: CHATS,
    每会话历史条数: HISTORY,
    连发消息数: MESSAGES,
    打开全部窗口用时秒: +(openMs / 1000).toFixed(1),
    不开窗_每条平均毫秒: +base.avg.toFixed(2),
    不开窗_最慢一条毫秒: +base.worst.toFixed(1),
    开窗后_每条平均毫秒: +withWindows.avg.toFixed(2),
    开窗后_最慢一条毫秒: +withWindows.worst.toFixed(1),
    内容正确的窗口数: `${correct}/${WINDOWS}`,
    边收消息边回复_从输入到显示毫秒: typing,
    内存占用MB: heap,
    页面报错: errors.length,
  }, null, 1));
  await browser.close();
  if (correct !== WINDOWS || errors.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
