import { render } from 'preact';
import { MockNetwork } from './core/mock-backend.ts';
import type { BackendFactory } from './core/types.ts';
import { KDF_ITERATIONS, LocalStore, MemoryStore, Vault } from './core/vault.ts';
import { seedDemo, startDemoTraffic } from './demo.ts';
import { App, type AppEnv } from './ui/app.tsx';
import { APP_NAME } from './ui/screens.tsx';

declare const __REAL_BACKEND__: boolean;

const root = document.getElementById('root')!;

function message(title: string, body: string): void {
  render(
    <main class="gate">
      <div class="gate-card">
        <h2>{title}</h2>
        <p class="hint">{body}</p>
      </div>
    </main>,
    root,
  );
}

async function realFactory(): Promise<BackendFactory> {
  const { MtcuteBackend } = await import('./core/mtcute-backend.ts');
  return (api) => new MtcuteBackend(api);
}

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  // 演示版本（不含真实连接代码）永远只能跑演示模式
  const demo = !__REAL_BACKEND__ || params.has('demo');
  const mock = params.has('mock');

  if (!window.isSecureContext || !crypto?.subtle) {
    return message('无法安全运行', '本软件必须通过 https 网址（或本机 localhost）打开，才能使用浏览器的加密功能。');
  }

  let env: AppEnv;
  if (demo) {
    const net = new MockNetwork();
    const store = new MemoryStore();
    const password = 'demo-1234-demo';
    const vault = await Vault.create(store, password, 1000);
    vault.data.api = { id: 100000, hash: '0'.repeat(32) };
    vault.data.accounts = seedDemo(net);
    vault.data.quickReplies.push({ id: 'qr-3', title: '发货时间', text: '您好，现货 48 小时内发出，定制款 7 天左右。' });
    await vault.save();
    startDemoTraffic(net);
    env = { store, factory: net.factory(), iter: 1000, demo: true, initialVault: vault, unlockHint: `演示模式的主密码是：${password}` };
  } else if (mock) {
    // 界面自动化测试用：完整走一遍真实的设置流程，但不联网
    const net = new MockNetwork();
    net.autoRestore = true;
    net.onNewUser = (userId) => {
      net.addChat(userId, 1, '测试联系人甲');
      net.addChat(userId, 2, '测试联系人乙');
      net.seed(userId, 1, '你好，在吗', { ago: 60_000, unread: true });
      net.seed(userId, 2, '报价发我一下', { ago: 30_000, unread: true });
    };
    (window as unknown as { __mockNet: MockNetwork }).__mockNet = net;
    env = { store: new LocalStore('ui-mock:'), factory: net.factory(), iter: KDF_ITERATIONS, demo: false };
  } else {
    env = { store: new LocalStore('ui:'), factory: await realFactory(), iter: KDF_ITERATIONS, demo: false };
  }

  // 同一份登录同时在两个窗口里使用会被官方作废，所以只允许开一个窗口
  if (!demo && 'locks' in navigator) {
    const held = await new Promise<boolean>((resolve) => {
      void navigator.locks.request(`unified-inbox${mock ? '-mock' : ''}`, { ifAvailable: true }, (lock) => {
        resolve(lock !== null);
        return lock ? new Promise<void>(() => {}) : undefined;
      });
    });
    if (!held) {
      return message(`${APP_NAME} 已经在另一个窗口打开`, '为了保护账号安全，同一时间只能开一个窗口。请关闭这个页面，回到已经打开的那个窗口。');
    }
  }

  if (!demo && !mock) {
    void navigator.storage?.persist?.();
    if ('serviceWorker' in navigator) void navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  render(<App env={env} />, root);
}

boot().catch((e: unknown) => {
  message('启动失败', e instanceof Error ? e.message : '未知错误');
});
