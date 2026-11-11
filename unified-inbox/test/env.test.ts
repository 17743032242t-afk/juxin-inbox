import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeClient } from '../src/core/env.ts';

const UA = {
  chromeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  edgeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
};

test('如实上报真实的浏览器和系统', () => {
  assert.deepEqual(describeClient(UA.chromeWin, 'zh-CN'), { deviceModel: 'Chrome 131', systemVersion: 'Windows', appVersion: '0.1.0', systemLangCode: 'zh-CN', langCode: 'zh' });
  assert.equal(describeClient(UA.edgeWin, 'zh-CN').deviceModel, 'Edge 131');
  assert.deepEqual([describeClient(UA.chromeAndroid, 'zh-CN').deviceModel, describeClient(UA.chromeAndroid, 'zh-CN').systemVersion], ['Chrome 131', 'Android 14']);
  assert.deepEqual([describeClient(UA.safariIphone, 'zh-Hans-CN').deviceModel, describeClient(UA.safariIphone, 'zh-Hans-CN').systemVersion], ['Safari 17', 'iOS 17.5']);
  assert.deepEqual([describeClient(UA.safariMac, 'en-US').deviceModel, describeClient(UA.safariMac, 'en-US').systemVersion], ['Safari 17', 'macOS']);
  assert.deepEqual([describeClient(UA.firefoxLinux, 'en').deviceModel, describeClient(UA.firefoxLinux, 'en').systemVersion], ['Firefox 128', 'Linux']);
});

test('同一台设备每次上报的内容完全一致（稳定，不随机）', () => {
  assert.deepEqual(describeClient(UA.chromeWin, 'zh-CN'), describeClient(UA.chromeWin, 'zh-CN'));
});

test('不冒充官方客户端：上报内容里不出现官方客户端的名字', () => {
  for (const ua of Object.values(UA)) {
    const env = describeClient(ua, 'zh-CN');
    assert.ok(!/telegram|tdesktop|webk|weba/i.test(JSON.stringify(env)));
  }
});

test('认不出的环境和不合规的语言会退回到保守的默认值，不会把奇怪的字符串发出去', () => {
  assert.deepEqual(describeClient('', '<script>'), { deviceModel: 'Browser', systemVersion: 'Unknown', appVersion: '0.1.0', systemLangCode: 'en', langCode: 'en' });
});
