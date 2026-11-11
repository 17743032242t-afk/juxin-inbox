/**
 * 独立窗口：把某个会话、或某个账号的全部会话，放到单独的窗口里。
 *
 * 所有独立窗口和主窗口共用同一份连接和数据（都在主窗口里），独立窗口只是多出来的「显示屏」。
 * 这样做的好处：
 * - 每个账号始终只有一条连接，开多少个窗口都不会让同一份登录被重复使用；
 * - 主窗口上锁或关闭时，所有独立窗口一起关闭，不会有窗口留在桌面上继续显示消息。
 */
import { render, type JSX } from 'preact';
import { useCallback, useLayoutEffect, useState } from 'preact/hooks';
import type { Hub } from '../core/hub.ts';
import type { Vault } from '../core/vault.ts';
import { ChatView } from './chat.tsx';
import { DialogRow } from './dialog-row.tsx';
import { AccountChip, Icon, useChat, useHub } from './util.tsx';

export type PopoutSpec = { kind: 'chat'; key: string } | { kind: 'account'; accountId: string };

interface PopoutContext {
  hub: Hub;
  vault: Vault;
  /** 独立窗口里有操作时调用（用于「自动上锁」的计时） */
  onActivity: () => void;
  /** 在主窗口打开「快捷回复」管理 */
  onManageQuick: () => void;
}

interface Entry {
  win: Window;
  root: HTMLElement;
}

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

function specId(spec: PopoutSpec): string {
  return spec.kind === 'chat' ? `chat:${spec.key}` : `account:${spec.accountId}`;
}

/** 这个窗口现在是否正被人看着：没最小化，而且是当前操作的窗口 */
function watching(win: Window): boolean {
  return !win.closed && win.document.visibilityState === 'visible' && win.document.hasFocus();
}

export class PopoutManager {
  private ctx: PopoutContext;
  private entries = new Map<string, Entry>();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private onMainHide = () => this.closeAll();

  constructor(ctx: PopoutContext) {
    this.ctx = ctx;
    window.addEventListener('pagehide', this.onMainHide);
  }

  get count(): number {
    return this.entries.size;
  }

  /** 打开（或切到已打开的）独立窗口。浏览器拦截了新窗口时返回 false。 */
  open(spec: PopoutSpec): boolean {
    const id = specId(spec);
    const existing = this.entries.get(id);
    if (existing && !existing.win.closed) {
      existing.win.focus();
      return true;
    }
    const [w, h] = spec.kind === 'chat' ? [480, 720] : [900, 720];
    // 每开一个往右下错开一点，避免完全叠在一起
    const offset = (this.entries.size % 8) * 28;
    const win = window.open('', '_blank', `popup=yes,width=${w},height=${h},left=${window.screenX + 80 + offset},top=${window.screenY + 60 + offset}`);
    if (!win) return false;

    const doc = win.document;
    doc.documentElement.lang = 'zh-CN';
    const theme = document.documentElement.getAttribute('data-theme');
    if (theme) doc.documentElement.setAttribute('data-theme', theme);
    const viewport = doc.createElement('meta');
    viewport.name = 'viewport';
    viewport.content = 'width=device-width, initial-scale=1';
    const css = doc.createElement('link');
    css.rel = 'stylesheet';
    css.href = new URL('./app.css', document.baseURI).href;
    doc.head.append(viewport, css);
    doc.title = '聚信';
    const root = doc.createElement('div');
    root.id = 'root';
    doc.body.append(root);

    this.entries.set(id, { win, root });
    for (const ev of ACTIVITY_EVENTS) win.addEventListener(ev, this.ctx.onActivity, { passive: true });
    win.addEventListener('pagehide', () => this.dispose(id));

    const close = () => this.close(id);
    render(
      spec.kind === 'chat' ? (
        <ChatWindow ctx={this.ctx} viewerId={id} chatKey={spec.key} win={win} onClose={close} />
      ) : (
        <AccountWindow ctx={this.ctx} viewerId={id} accountId={spec.accountId} win={win} onClose={close} manager={this} />
      ),
      root,
    );

    // 有些情况下窗口被关掉却收不到事件，这里每秒兜底检查一次
    this.watchdog ??= setInterval(() => {
      for (const [key, e] of [...this.entries]) if (e.win.closed) this.dispose(key);
    }, 1000);
    return true;
  }

  close(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.dispose(id);
    if (!e.win.closed) e.win.close();
  }

  /** 卸载窗口里的界面，并告诉汇总中心「这个窗口不再显示任何会话」 */
  private dispose(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    try {
      render(null, e.root);
    } catch {
      /* 窗口已经没了 */
    }
    this.ctx.hub.detachViewer(id);
    if (this.entries.size === 0 && this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  /** 上锁、关闭主窗口时调用：所有独立窗口一起关掉 */
  closeAll(): void {
    for (const id of [...this.entries.keys()]) this.close(id);
  }

  destroy(): void {
    this.closeAll();
    window.removeEventListener('pagehide', this.onMainHide);
  }
}

/** 把「这个窗口正在显示哪个会话」登记到汇总中心，并在窗口被点到前台时标为已读 */
function useViewer(hub: Hub, viewerId: string, key: string | null, win: Window): void {
  useLayoutEffect(() => {
    if (!key) {
      hub.detachViewer(viewerId);
      return;
    }
    void hub.attachViewer(viewerId, key, () => watching(win));
    const onFront = () => {
      if (watching(win)) void hub.markRead(key);
    };
    win.addEventListener('focus', onFront);
    win.document.addEventListener('visibilitychange', onFront);
    return () => {
      win.removeEventListener('focus', onFront);
      win.document.removeEventListener('visibilitychange', onFront);
    };
  }, [hub, viewerId, key, win]);
}

function ChatWindow(props: { ctx: PopoutContext; viewerId: string; chatKey: string; win: Window; onClose: () => void }): JSX.Element {
  const { hub, vault } = props.ctx;
  useChat(hub, props.chatKey);
  useViewer(hub, props.viewerId, props.chatKey, props.win);
  const dialog = hub.dialog(props.chatKey);
  const account = dialog ? hub.account(dialog.accountId) : null;
  const gone = !dialog || !account;

  // 账号被移除后，这个窗口没有内容可显示，自动关闭
  useLayoutEffect(() => {
    if (gone) props.onClose();
  }, [gone]);

  const title = dialog && account ? `${dialog.unread > 0 ? `(${dialog.unread}) ` : ''}${dialog.title} · ${account.label}` : '聚信';
  useLayoutEffect(() => {
    props.win.document.title = title;
  }, [title]);

  return (
    <div class="app popout">
      <ChatView hub={hub} chatKey={props.chatKey} quickReplies={vault.data.quickReplies} settings={vault.data.settings} onBack={props.onClose} onManageQuick={props.ctx.onManageQuick} />
    </div>
  );
}

function AccountWindow(props: { ctx: PopoutContext; viewerId: string; accountId: string; win: Window; onClose: () => void; manager: PopoutManager }): JSX.Element {
  const { hub, vault } = props.ctx;
  useHub(hub);
  const [key, setKey] = useState<string | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [search, setSearch] = useState('');
  useViewer(hub, props.viewerId, key, props.win);
  const account = hub.account(props.accountId);

  useLayoutEffect(() => {
    if (!account) props.onClose();
  }, [!account]);

  const title = account ? `${account.unread > 0 ? `(${account.unread}) ` : ''}${account.label} · 聚信` : '聚信';
  useLayoutEffect(() => {
    props.win.document.title = title;
  }, [title]);

  const open = useCallback((k: string) => setKey(k), []);
  const popout = useCallback((k: string) => void props.manager.open({ kind: 'chat', key: k }), [props.manager]);
  const back = useCallback(() => setKey(null), []);

  if (!account) return <div class="app popout" />;
  const needle = search.trim().toLowerCase();
  const popped = hub.poppedOutKeys();
  const list = hub
    .dialogs()
    .filter(
      (d) =>
        d.accountId === props.accountId &&
        (!unreadOnly || d.unread > 0 || d.key === key) &&
        (!needle || d.title.toLowerCase().includes(needle) || (d.last?.text.toLowerCase().includes(needle) ?? false)),
    )
    .slice(0, 300);

  return (
    <div class={`app popout popout-account${key ? ' has-chat' : ''}`}>
      <aside class="list-pane">
        <header class="list-head">
          <div class="list-title">
            <AccountChip label={account.label} color={account.color} />
            <h1>{account.name}</h1>
          </div>
          <div class="search">
            <Icon name="search" size={18} />
            <input type="search" value={search} onInput={(e) => setSearch(e.currentTarget.value)} placeholder="搜索联系人或消息" aria-label="搜索" />
          </div>
          <div class="list-tools">
            <div class="tabs" role="tablist">
              <button role="tab" aria-selected={!unreadOnly} class={unreadOnly ? '' : 'on'} onClick={() => setUnreadOnly(false)}>全部</button>
              <button role="tab" aria-selected={unreadOnly} class={unreadOnly ? 'on' : ''} onClick={() => setUnreadOnly(true)}>
                未读{account.unread > 0 ? ` ${account.unread}` : ''}
              </button>
            </div>
          </div>
        </header>
        {list.length === 0 ? (
          <div class="empty">{unreadOnly ? '没有未读消息，全部回完了。' : needle ? '没有找到匹配的会话。' : '还没有会话。'}</div>
        ) : (
          <ul class="dialogs">
            {list.map((d) => (
              <DialogRow key={d.key} hub={hub} d={d} accountLabel={null} accountColor={account.color} active={d.key === key} popped={popped.has(d.key) && d.key !== key} onOpen={open} onPopout={popout} />
            ))}
          </ul>
        )}
      </aside>
      {key ? (
        <ChatView hub={hub} chatKey={key} quickReplies={vault.data.quickReplies} settings={vault.data.settings} onBack={back} onManageQuick={props.ctx.onManageQuick} />
      ) : (
        <section class="chat placeholder">
          <p>选一个会话开始回复</p>
          <small>这个窗口只显示「{account.label}」的消息</small>
        </section>
      )}
    </div>
  );
}
