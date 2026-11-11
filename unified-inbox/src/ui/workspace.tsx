import type { JSX } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { batchCandidates, batchExclusions } from '../core/batch.ts';
import type { AccountView, Hub } from '../core/hub.ts';
import type { Vault } from '../core/vault.ts';
import { ChatView } from './chat.tsx';
import { DialogRow } from './dialog-row.tsx';
import { NewGroupModal } from './groups.tsx';
import { releaseAvatars } from './media.tsx';
import { PopoutManager } from './popout.tsx';
import { AccountsModal, AddAccountModal, BatchModal, QuickRepliesModal, SettingsModal } from './modals.tsx';
import { APP_NAME, ApiSetup } from './screens.tsx';
import { Icon, useHub } from './util.tsx';

/** 嵌在别的页面里展示（单文件演示）时为 true：不碰浏览器的前进后退记录 */
declare const __EMBED__: boolean;

const LIST_PAGE = 200;

type ModalState =
  | { kind: 'none' }
  | { kind: 'add'; relogin?: AccountView }
  | { kind: 'accounts' }
  | { kind: 'quick' }
  | { kind: 'batch' }
  | { kind: 'group' }
  | { kind: 'settings' };

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
  const [notice, setNotice] = useState<string | null>(null);

  // 独立窗口管理器：跟随这次解锁存在，上锁（本组件卸载）时把所有独立窗口一起关掉
  const popouts = useMemo(
    () =>
      new PopoutManager({
        hub,
        vault,
        onActivity: () => {
          lastActive.current = Date.now();
        },
        onManageQuick: () => {
          window.focus();
          setModal({ kind: 'quick' });
        },
      }),
    [hub, vault],
  );
  useEffect(
    () => () => {
      popouts.destroy();
      // 上锁时把已加载的头像图片也一并清掉
      releaseAvatars();
    },
    [popouts],
  );
  const canPopout = !__EMBED__ && !window.matchMedia('(pointer: coarse)').matches;

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

  const open = useCallback((key: string) => {
    if (!hub.activeKey && !__EMBED__) {
      try {
        history.pushState({ chat: true }, '');
      } catch {
        /* 个别内嵌环境不允许改历史记录，不影响使用 */
      }
    }
    void hub.openChat(key);
  }, [hub]);
  const back = useCallback(() => {
    if (!__EMBED__ && history.state?.chat) history.back();
    else void hub.openChat(null);
  }, [hub]);
  const manageQuick = useCallback(() => setModal({ kind: 'quick' }), []);

  /** 在独立窗口打开一个会话；如果它正开在主窗口，就从主窗口收起，避免同一个会话显示两份 */
  const popoutChat = useCallback(
    (key: string) => {
      if (!popouts.open({ kind: 'chat', key })) {
        setNotice('浏览器拦截了新窗口。请在地址栏右侧允许本网站弹出窗口，然后再试一次。');
        return;
      }
      setNotice(null);
      if (hub.activeKey === key) {
        if (!__EMBED__ && history.state?.chat) history.back();
        else void hub.openChat(null);
      }
    },
    [hub, popouts],
  );
  const popoutAccount = useCallback(
    (accountId: string) => {
      if (popouts.open({ kind: 'account', accountId })) setNotice(null);
      else setNotice('浏览器拦截了新窗口。请在地址栏右侧允许本网站弹出窗口，然后再试一次。');
    },
    [popouts],
  );
  const poppedKeys = hub.poppedOutKeys();

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
            <button
              key={a.id}
              class={`rail-item${filter === a.id ? ' on' : ''}`}
              onClick={() => setFilter(filter === a.id ? null : a.id)}
              onDblClick={canPopout ? () => popoutAccount(a.id) : undefined}
              title={canPopout ? `${a.label}（${a.name}）· 双击在独立窗口打开` : `${a.label}（${a.name}）`}
            >
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
            {filterAccount && canPopout ? (
              <button class="icon-btn head-action" onClick={() => popoutAccount(filterAccount.id)} title="在独立窗口打开这个账号" aria-label="在独立窗口打开这个账号">
                <Icon name="popout" size={18} />
              </button>
            ) : null}
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
            <button class="btn small icon-only" onClick={() => setModal({ kind: 'group' })} disabled={accounts.length === 0} title="新建群" aria-label="新建群">
              <Icon name="group-add" size={16} />
            </button>
            <button class="btn small" onClick={() => setModal({ kind: 'batch' })} disabled={waiting === 0 && guarded === 0} title="把同一段话回给多个未读会话">
              <Icon name="batch" size={16} /> 批量回复{waiting > 0 ? `（${waiting}）` : ''}
            </button>
          </div>
        </header>

        {notice ? (
          <button class="banner warn as-button" onClick={() => setNotice(null)}>
            {notice}
          </button>
        ) : null}
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
              <DialogRow
                key={d.key}
                hub={hub}
                d={d}
                accountLabel={accountMap.get(d.accountId)?.label ?? null}
                accountColor={accountMap.get(d.accountId)?.color ?? null}
                active={d.key === hub.activeKey}
                popped={poppedKeys.has(d.key)}
                onOpen={open}
                onPopout={canPopout ? popoutChat : undefined}
              />
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
          chatKey={active.key}
          quickReplies={vault.data.quickReplies}
          settings={vault.data.settings}
          onBack={back}
          onManageQuick={manageQuick}
          onPopout={canPopout ? popoutChat : undefined}
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
      {modal.kind === 'group' ? (
        <NewGroupModal
          hub={hub}
          accounts={accounts}
          defaultAccountId={filter}
          onClose={() => setModal({ kind: 'none' })}
          onCreated={(key, notAdded) => {
            setModal({ kind: 'none' });
            setNotice(notAdded > 0 ? `群已建好。有 ${notAdded} 个人因为对方的隐私设置没能拉进来，可以在「群管理」里把邀请链接发给他们。` : null);
            open(key);
          }}
        />
      ) : null}
      {modal.kind === 'settings' ? <SettingsModal vault={vault} hub={hub} onChanged={rerender} onClose={() => setModal({ kind: 'none' })} onWipe={props.onWipe} /> : null}
    </div>
  );
}
