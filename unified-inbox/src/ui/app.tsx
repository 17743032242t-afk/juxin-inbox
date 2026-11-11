import type { JSX } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { Hub } from '../core/hub.ts';
import type { BackendFactory } from '../core/types.ts';
import { Vault, type KeyValueStore } from '../core/vault.ts';
import { SetupScreen, UnlockScreen } from './screens.tsx';
import { Workspace } from './workspace.tsx';

export interface AppEnv {
  store: KeyValueStore;
  factory: BackendFactory;
  /** 密钥派生的迭代次数（演示模式用小值，正式使用是 60 万） */
  iter: number;
  demo: boolean;
  /** 演示模式下预先建好的保险库 */
  initialVault?: Vault;
  unlockHint?: string;
}

interface Session {
  vault: Vault;
  hub: Hub;
}

export function App(props: { env: AppEnv }): JSX.Element {
  const { env } = props;
  const [session, setSession] = useState<Session | null>(null);
  const [hasVault, setHasVault] = useState(() => Vault.exists(env.store));
  const current = useRef<Session | null>(null);

  const enter = useCallback(
    (vault: Vault) => {
      const hub = new Hub(vault, env.factory);
      const s = { vault, hub };
      current.current = s;
      setSession(s);
      setHasVault(true);
      if (vault.data.api) void hub.startAll();
    },
    [env],
  );

  /** 上锁：断开所有账号、清掉内存里的消息和密钥引用，回到输入主密码的界面 */
  const lock = useCallback(() => {
    const s = current.current;
    if (!s) return;
    current.current = null;
    setSession(null);
    void s.hub.destroy();
  }, []);

  const wipe = useCallback(async () => {
    const s = current.current;
    if (s) {
      await s.hub.logOutAll();
      await s.hub.destroy();
    }
    current.current = null;
    Vault.wipe(env.store);
    setSession(null);
    setHasVault(false);
  }, [env]);

  useEffect(() => {
    if (env.initialVault) enter(env.initialVault);
  }, []);

  if (session) {
    return <Workspace vault={session.vault} hub={session.hub} demo={env.demo} onLock={lock} onWipe={wipe} />;
  }
  if (!hasVault) return <SetupScreen store={env.store} iter={env.iter} onReady={enter} />;
  return <UnlockScreen store={env.store} hint={env.unlockHint} onReady={enter} onWipe={() => void wipe()} />;
}
