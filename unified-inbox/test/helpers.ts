import { MockNetwork } from '../src/core/mock-backend.ts';
import { Hub } from '../src/core/hub.ts';
import { MemoryStore, Vault } from '../src/core/vault.ts';

/** 测试里用很少的迭代次数，避免每个用例都等半秒 */
export const TEST_ITER = 1000;
export const PASSWORD = 'Test-password-01';

export async function setup(): Promise<{ net: MockNetwork; store: MemoryStore; vault: Vault; hub: Hub }> {
  const net = new MockNetwork();
  const store = new MemoryStore();
  const vault = await Vault.create(store, PASSWORD, TEST_ITER);
  vault.data.api = { id: 12345, hash: 'abcdef' };
  await vault.save();
  const hub = new Hub(vault, net.factory());
  return { net, store, vault, hub };
}

export async function login(hub: Hub, phone: string, label: string): Promise<string> {
  const flow = hub.beginLogin();
  await flow.sendCode(phone);
  const r = await flow.submitCode('12345');
  if (r === 'password') await flow.submitPassword('mima1234');
  return flow.finish(label, null);
}

export const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** 把汇总中心的时钟往后拨（用来跳过「新登录保护期」等） */
export function advance(hub: Hub, ms: number): void {
  const prev = hub.now;
  hub.now = () => prev() + ms;
}

export const HOUR = 3_600_000;
