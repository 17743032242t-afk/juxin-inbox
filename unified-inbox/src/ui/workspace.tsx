import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { batchCandidates, batchExclusions } from '../core/batch.ts';
import type { AccountView, Hub, InboxDialog } from '../core/hub.ts';
import type { Vault } from '../core/vault.ts';
import { ChatView } from './chat.tsx';
import { AccountsModal, AddAccountModal, BatchModal, QuickRepliesModal, SettingsModal } from './modals.tsx';
import { APP_NAME, ApiSetup } from './screens.tsx';
import { AccountChip, Avatar, Icon, listTime, useHub } from './util.tsx';

/** 嵌在别的页面里展示（单文件演示）时为 true：不碰浏览器的前进后退记录 */
declare const __EMBED__: boolean;

const LIST_PAGE = 200;

type ModalState =
  | { kind: 'none' }
  | { kind: 'add'; relogin?: AccountView }
  | { kind: 'accounts' }
  | { kind: 'quick' }
  | { kind: 'batch' }
  | { kind: 'settings' };

function preview(d: InboxDialog): string {
  const m = d.last;
  if (!m) return '';
  const body = m.text || m.media || '';
  if (m.out) return `我：${body}`;
  if (m.sender) return `${m.sender}：${body}`;
  return body;
}

function DialogRow(props: { d: InboxDialog; account: AccountView | undefined; active: boolean; onOpen: () => void }): JSX.Element {
  const { d, account } = props;
  return (
    <li>
      <button class={`dialog${props.active ? ' active' : ''}${d.unread > 0 ? ' unread' : ''}`} onClick={props.onOpen} style={{ '--acct': account?.color ?? 'transparent' }}>
        <Avatar title={d.title} badgeColor={account?.color} />
        <span class="dialog-main">
          <span class="dialog-top">
            <span class="dialog-title">{d.title}</span>
            {d.muted ? <span class="muted-mark"><Icon name="mute" size={14} /></span> : null}
            <time>{d.last ? listTime(d.last.date) : ''}</time>
          </span>
          <span class="dialog-bottom">
            {account ? <AccountChip label={account.label} color={account.color} small /> : null}
            <span class="dialog-preview">{preview(d)}</span>
            {d.unread > 0 ? <span class={`badge${d.muted ? ' quiet' : ''}`}>{d.unread > 99 ? '99+' : d.unread}</span> : null}
          </span>
        </span>
      </button>
    </li>
  );
}

export interface WorkspaceProps {
  vault: Vault;
  hub: Hub;
  demo: boolean;
  onLock: () => void;
  onWipe: () => Promise<void>;
}

export function Workspace(props: WorkspaceProps): JSX.Element {
  const { vault, hub } = props;
  useHub(hub);
  const [, bump] = useState(0);
  const rerender = () => bump((n) => n + 1);
  const [filter, setFilter] = useState<string | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(LIST_PAGE);
  const [modal, setModal] = useState<ModalState>({ kind: 'none' });
  const lastActive = useRef(Date.now());

  const accounts = hub.accounts();
  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [hub.version]);
  const all = hub.dialogs();
  const active = hub.activeKey ? hub.dialog(hub.activeKey) : null;
  const activeAccount = active ? accountMap.get(active.accountId) : undefined;
  const totalUnread = hub.totalUnread();

  // 筛选的账号被移除后回到「全部」
  useEffect(() => {
    if (filter && !accountMap.has(filter)) setFilter(null);
  }, [filter, accountMap]);

  const needle = search.trim().toLowerCase();
  const filtered = all.filter(
    (d) =>
      (filter === null || d.accountId === filter) &&
      (!unreadOnly || d.unread > 0 || d.key === hub.activeKey) &&
      (!needle || d.title.toLowerCase().includes(needle) || (d.last?.text.toLowerCase().includes(needle) ?? false)),
  );
  const shown = filtered.slice(0, limit);
  const waiting = batchCandidates(hub, filter).length;
  // 有账号因为保护而没列入时，按钮仍然可点，点开后会说明原因
  const guarded = batchExclusions(hub, filter).length;

  // 标题栏显示未读数
  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) ${APP_NAME}` : APP_NAME;
    return () => {
      document.title = APP_NAME;
    };
  }, [totalUnread]);

  // 前台/后台：不在前台时不自动标已读；回到前台时把正在看的会话标为已读
  useEffect(() => {
    hub.isVisible = () => document.visibilityState === 'visible';
    const onVisible = () => {
      if (document.visibilityState === 'visible' && hub.activeKey) void hub.markRead(hub.activeKey);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [hub]);

  // 新消息通知
  useEffect(() => {
    hub.onIncoming = (account, dialog, msg) => {
      const s = vault.data.settings;
      if (!s.notify || document.visibilityState === 'visible') return;
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      const title = `【${account.label}】${dialog.title}`;
      const options: NotificationOptions = {
        body: s.notifyPreview ? msg.text || msg.media || '新消息' : '发来一条新消息',
        tag: dialog.key,
        icon: './icon-192.png',
      };
      try {
        const n = new Notification(title, options);
        n.onclick = () => {
          window.focus();
          void hub.openChat(dialog.key);
          n.close();
        };
      } catch {
        // 安卓浏览器不允许页面直接弹通知，要交给后台服务来弹
        void navigator.serviceWorker
          ?.getRegistration()
          .then((reg) => reg?.showNotification(title, options))
          .catch(() => {});
      }
    };
    return () => {
      hub.onIncoming = null;
    };
  }, [hub, vault]);

  // 自动上锁：一段时间没有任何操作就上锁
  useEffect(() => {
    const touch = () => {
      lastActive.current = Date.now();
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const ev of events) window.addEventListener(ev, touch, { passive: true });
    const check = () => {
      const minutes = vault.data.settings.autoLockMinutes;
      if (minutes > 0 && Date.now() - lastActive.current > minutes * 60_000) props.onLock();
    };
    const timer = setInterval(check, 10_000);
    // 手机切回前台时，定时器可能被系统暂停过，回来立刻补查一次
    document.addEventListener('visibilitychange', check);
    return () => {
      for (const ev of events) window.removeEventListener(ev, touch);
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, [vault, props.onLock]);

  // 手机上按系统返回键：从聊天退回列表，而不是退出软件
  useEffect(() => {
    const onPop = () => {
      if (hub.activeKey) void hub.openChat(null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [hub]);

  const open = (key: string) => {
    if (!hub.activeKey && !__EMBED__) {
      try {
        history.pushState({ chat: true }, '');
      } catch {
        /* 个别内嵌环境不允许改历史记录，不影响使用 */
      }
    }
    void hub.openChat(key);
  };
  const back = () => {
    if (!__EMBED__ && history.state?.chat) history.back();
    else void hub.openChat(null);
  };

  if (!vault.data.api) {
    return (
      <main class="gate">
        <div class="gate-card wide">
          <ApiSetup
            initial={null}
            onSave={async (api) => {
              vault.data.api = api;
              await vault.save();
              rerender();
              setModal({ kind: 'add' });
            }}
          />
        </div>
      </main>
    );
  }

  const filterAccount = filter ? accountMap.get(filter) : undefined;
  const tools = (
    <>
      <button class="icon-btn" onClick={() => setModal({ kind: 'accounts' })} title="账号管理" aria-label="账号管理">
        <Icon name="users" />
      </button>
      <button class="icon-btn" onClick={() => setModal({ kind: 'settings' })} title="设置与安全" aria-label="设置与安全">
        <Icon name="settings" />
      </button>
      <button class="icon-btn" onClick={props.onLock} title="立即上锁" aria-label="立即上锁">
        <Icon name="lock" />
      </button>
    </>
  );

  const problem = accounts.filter((a) => a.status === 'revoked' || a.status === 'error');

  return (
    <div class={`app${active ? ' has-chat' : ''}`}>
      <nav class="rail" aria-label="账号">
        <button class={`rail-item${filter === null ? ' on' : ''}`} onClick={() => setFilter(null)} title="全部账号">
          <span class="rail-icon all">
            <Icon name="inbox" size={22} />
            {totalUnread > 0 ? <span class="badge">{totalUnread > 99 ? '99+' : totalUnread}</span> : null}
          </span>
          <span class="rail-label">全部</span>
        </button>
        <div class="rail-accounts">
          {accounts.map((a) => (
            <button key={a.id} class={`rail-item${filter === a.id ? ' on' : ''}`} onClick={() => setFilter(filter === a.id ? null : a.id)} title={`${a.label}（${a.name}）`}>
              <span class="rail-icon" style={{ background: a.color }}>
                {[...a.label][0]}
                {a.unread > 0 ? <span class="badge">{a.unread > 99 ? '99+' : a.unread}</span> : null}
                <span class={`dot dot-${a.status}`} />
              </span>
              <span class="rail-label">{a.label}</span>
            </button>
          ))}
          <button class="rail-item" onClick={() => setModal({ kind: 'add' })} title="添加账号">
            <span class="rail-icon add">
              <Icon name="plus" size={22} />
            </span>
            <span class="rail-label">添加</span>
          </button>
        </div>
        <div class="rail-tools">{tools}</div>
      </nav>

      <aside class="list-pane">
        <header class="list-head">
          <div class="list-title">
            <h1>{filterAccount ? filterAccount.label : '全部消息'}</h1>
            {props.demo ? <span class="demo-tag">演示模式 · 数据为虚构</span> : null}
            <span class="head-tools">{tools}</span>
          </div>
          <div class="search">
            <Icon name="search" size={18} />
            <input type="search" value={search} onInput={(e) => { setSearch(e.currentTarget.value); setLimit(LIST_PAGE); }} placeholder="搜索联系人或消息" aria-label="搜索" />
          </div>
          <div class="list-tools">
            <div class="tabs" role="tablist">
              <button role="tab" aria-selected={!unreadOnly} class={unreadOnly ? '' : 'on'} onClick={() => setUnreadOnly(false)}>全部</button>
              <button role="tab" aria-selected={unreadOnly} class={unreadOnly ? 'on' : ''} onClick={() => setUnreadOnly(true)}>
                未读{totalUnread > 0 ? ` ${filterAccount ? filterAccount.unread : totalUnread}` : ''}
              </button>
            </div>
            <button class="btn small" onClick={() => setModal({ kind: 'batch' })} disabled={waiting === 0 && guarded === 0} title="把同一段话回给多个未读会话">
              <Icon name="batch" size={16} /> 批量回复{waiting > 0 ? `（${waiting}）` : ''}
            </button>
          </div>
        </header>

        {problem.length > 0 ? (
          <button class="banner warn as-button" onClick={() => setModal({ kind: 'accounts' })}>
            {problem.map((a) => `「${a.label}」`).join('、')} 需要处理：{problem[0]!.status === 'revoked' ? '登录已失效' : '连接出错'}。点这里查看。
          </button>
        ) : null}

        {accounts.length === 0 ? (
          <div class="empty">
            <p>还没有添加账号。</p>
            <button class="btn primary" onClick={() => setModal({ kind: 'add' })}>
              <Icon name="plus" size={16} /> 添加第一个账号
            </button>
          </div>
        ) : shown.length === 0 ? (
          <div class="empty">
            {accounts.some((a) => a.status === 'connecting') && all.length === 0 ? '正在连接各账号并同步会话…' : unreadOnly ? '没有未读消息，全部回完了。' : needle ? '没有找到匹配的会话。' : '还没有会话。'}
          </div>
        ) : (
          <ul class="dialogs">
            {shown.map((d) => (
              <DialogRow key={d.key} d={d} account={accountMap.get(d.accountId)} active={d.key === hub.activeKey} onOpen={() => open(d.key)} />
            ))}
            {filtered.length > shown.length ? (
              <li>
                <button class="btn more" onClick={() => setLimit(limit + LIST_PAGE)}>
                  显示更多（还有 {filtered.length - shown.length} 个）
                </button>
              </li>
            ) : null}
          </ul>
        )}
      </aside>

      {active && activeAccount ? (
        <ChatView
          hub={hub}
          dialog={active}
          account={activeAccount}
          quickReplies={vault.data.quickReplies}
          settings={vault.data.settings}
          onBack={back}
          onManageQuick={() => setModal({ kind: 'quick' })}
        />
      ) : (
        <section class="chat placeholder">
          <Icon name="shield" size={54} />
          <p>从左边选一个会话开始回复</p>
          <small>
            已登录 {accounts.length} 个账号
            {accounts.length > 0 ? ` · ${accounts.filter((a) => a.status === 'online').length} 个在线` : ''}
          </small>
        </section>
      )}

      {modal.kind === 'add' ? (
        <AddAccountModal hub={hub} usedColors={accounts.map((a) => a.color)} relogin={modal.relogin} onClose={() => setModal({ kind: 'none' })} />
      ) : null}
      {modal.kind === 'accounts' ? (
        <AccountsModal hub={hub} onClose={() => setModal({ kind: 'none' })} onAdd={() => setModal({ kind: 'add' })} onRelogin={(a) => setModal({ kind: 'add', relogin: a })} />
      ) : null}
      {modal.kind === 'quick' ? <QuickRepliesModal vault={vault} onChanged={rerender} onClose={() => setModal({ kind: 'none' })} /> : null}
      {modal.kind === 'batch' ? <BatchModal hub={hub} accountId={filter} quickReplies={vault.data.quickReplies} onClose={() => setModal({ kind: 'none' })} /> : null}
      {modal.kind === 'settings' ? <SettingsModal vault={vault} hub={hub} onChanged={rerender} onClose={() => setModal({ kind: 'none' })} onWipe={props.onWipe} /> : null}
    </div>
  );
}
