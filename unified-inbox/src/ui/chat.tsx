import type { JSX } from 'preact';
import { memo } from 'preact/compat';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { AccountView, Hub, InboxDialog } from '../core/hub.ts';
import { errorText, type MessageInfo } from '../core/types.ts';
import type { QuickReply, Settings } from '../core/vault.ts';
import { EMOJI_GROUPS } from './emoji.ts';
import { GroupModal } from './groups.tsx';
import { AttachmentView, ChatAvatar, StickerPanel } from './media.tsx';
import { AccountChip, ErrorNote, Icon, Modal, clockTime, dayLabel, sameDay, useChat, useHub, withPhotoSlot } from './util.tsx';

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const URL_RE = /(https?:\/\/[^\s<>"'，。；！？）】]+)/g;

function isTouch(): boolean {
  return window.matchMedia('(pointer: coarse)').matches;
}

/** 文字里的网址变成可点的链接；其余内容一律当纯文字显示，不会被当成网页代码执行 */
function RichText(props: { text: string }): JSX.Element {
  const parts = props.text.split(URL_RE);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noopener noreferrer nofollow"
            onClick={(e) => {
              // 在链接所在的那个窗口里询问（会话可能开在独立窗口）
              const view = e.currentTarget.ownerDocument.defaultView ?? window;
              if (!view.confirm(`即将在浏览器中打开外部链接：\n\n${part}\n\n请确认这个网址可信。`)) e.preventDefault();
            }}
          >
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}

function Photo(props: { hub: Hub; chatKey: string; messageId: number }): JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [full, setFull] = useState<string | null>(null);
  const [viewing, setViewing] = useState(false);

  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    withPhotoSlot(() => props.hub.loadPhoto(props.chatKey, props.messageId, 'thumb'))
      .then((bytes) => {
        if (!alive) return;
        if (!bytes) return setFailed(true);
        made = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }));
        setUrl(made);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [props.chatKey, props.messageId]);

  useEffect(() => {
    if (!viewing || full) return;
    let alive = true;
    props.hub
      .loadPhoto(props.chatKey, props.messageId, 'full')
      .then((bytes) => {
        if (alive && bytes) setFull(URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' })));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [viewing]);

  useEffect(() => () => { if (full) URL.revokeObjectURL(full); }, [full]);

  if (failed) return <span class="media-label">[图片] 暂时无法显示</span>;
  if (!url) return <span class="photo-loading">图片加载中…</span>;
  return (
    <>
      <button class="photo" type="button" onClick={() => setViewing(true)} aria-label="查看大图">
        <img src={url} alt="图片" />
      </button>
      {viewing ? (
        <div class="viewer" onClick={() => setViewing(false)}>
          <img src={full ?? url} alt="图片" />
          <button class="icon-btn viewer-close" aria-label="关闭">
            <Icon name="close" size={26} />
          </button>
        </div>
      ) : null}
    </>
  );
}

interface BubbleProps {
  hub: Hub;
  chatKey: string;
  msg: MessageInfo;
  read: boolean;
  quoted: MessageInfo | null;
  selected: boolean;
  /** 多选模式：点气泡是勾选，不弹操作菜单 */
  picking: boolean;
  picked: boolean;
  /** 所有气泡共用同一个回调（身份不变），这样没变化的气泡可以整个跳过重画 */
  onAction: (action: BubbleAction, msg: MessageInfo) => void;
}

type BubbleAction = 'select' | 'reply' | 'edit' | 'delete' | 'forward' | 'pick';

/** 单条消息。内容没变就不重画：一个会话里有几百条消息时，来一条新消息只画这一条。 */
const Bubble = memo(function Bubble(props: BubbleProps): JSX.Element {
  const { msg } = props;
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (!props.selected) setConfirmDelete(false);
  }, [props.selected]);
  if (msg.service) {
    return <div class="service">{msg.media ?? '系统消息'}</div>;
  }
  const replyText = msg.replyTo ? msg.replyTo.quote || props.quoted?.text || props.quoted?.media || '一条较早的消息' : null;
  const isSticker = msg.attachment?.kind === 'sticker';
  return (
    <div class={`msg ${msg.out ? 'out' : 'in'}${props.selected || props.picked ? ' selected' : ''}${isSticker ? ' sticker-msg' : ''}`} data-mid={msg.id}>
      <div class="bubble" onClick={() => props.onAction(props.picking ? 'pick' : 'select', msg)} role={props.picking ? 'checkbox' : undefined} aria-checked={props.picking ? props.picked : undefined}>
        {msg.sender ? <div class="sender">{msg.sender}</div> : null}
        {replyText !== null ? <div class="quote">{replyText}</div> : null}
        {msg.hasPhoto ? (
          <Photo hub={props.hub} chatKey={props.chatKey} messageId={msg.id} />
        ) : msg.attachment ? (
          <AttachmentView hub={props.hub} chatKey={props.chatKey} messageId={msg.id} info={msg.attachment} />
        ) : msg.media ? (
          <div class="media-label">{msg.media}</div>
        ) : null}
        {msg.text ? (
          <div class="text">
            <RichText text={msg.text} />
          </div>
        ) : null}
        <div class="meta">
          {msg.edited ? <span>已修改</span> : null}
          <time>{clockTime(msg.date)}</time>
          {msg.out ? (
            <span class={`ticks${props.read ? ' read' : ''}`} title={props.read ? '对方已读' : '已送达'}>
              <Icon name={props.read ? 'checks' : 'check'} size={15} />
            </span>
          ) : null}
        </div>
      </div>
      {props.selected && !props.picking ? (
        <div class="msg-actions">
          <button type="button" onClick={() => props.onAction('reply', msg)}>
            <Icon name="reply" size={16} /> 回复
          </button>
          <button type="button" onClick={() => props.onAction('forward', msg)}>
            <Icon name="forward" size={16} /> 转发
          </button>
          <button type="button" onClick={() => props.onAction('pick', msg)}>
            <Icon name="check" size={16} /> 多选
          </button>
          {msg.text ? (
            <button type="button" onClick={() => void navigator.clipboard?.writeText(msg.text)}>
              <Icon name="copy" size={16} /> 复制
            </button>
          ) : null}
          {msg.out && msg.text && !msg.media ? (
            <button type="button" onClick={() => props.onAction('edit', msg)}>
              <Icon name="edit" size={16} /> 修改
            </button>
          ) : null}
          {msg.out ? (
            <button type="button" class="danger-text" onClick={() => (confirmDelete ? props.onAction('delete', msg) : setConfirmDelete(true))}>
              <Icon name="trash" size={16} /> {confirmDelete ? '确认删除（对方那边也会删）' : '删除'}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

/** 选择转发到哪个会话：只列出同一个账号里能发言的会话 */
function ForwardModal(props: { hub: Hub; fromKey: string; accountId: string; count: number; onClose: () => void; onPick: (toKey: string, title: string) => Promise<void> }): JSX.Element {
  useHub(props.hub);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const account = props.hub.account(props.accountId);
  const needle = search.trim().toLowerCase();
  const targets = props.hub
    .dialogs()
    .filter((d) => d.accountId === props.accountId && d.canSend && d.key !== props.fromKey && (!needle || d.title.toLowerCase().includes(needle)))
    .slice(0, 100);
  const pick = async (toKey: string, title: string) => {
    if (busy) return;
    setBusy(toKey);
    setError(null);
    try {
      await props.onPick(toKey, title);
    } catch (e) {
      setError(errorText(e));
      setBusy(null);
    }
  };
  return (
    <Modal title={`转发 ${props.count} 条消息`} onClose={props.onClose} locked={busy !== null}>
      <p class="hint">
        转发在同一个账号内进行{account ? <>（<AccountChip label={account.label} color={account.color} small />）</> : null}。选一个会话，点一下就转过去。
      </p>
      <div class="search">
        <Icon name="search" size={18} />
        <input type="search" value={search} onInput={(e) => setSearch(e.currentTarget.value)} placeholder="搜索会话" aria-label="搜索会话" autofocus />
      </div>
      <ErrorNote text={error} />
      <ul class="pick-list">
        {targets.map((d) => (
          <li key={d.key}>
            <button type="button" class="pick-row" disabled={busy !== null} onClick={() => void pick(d.key, d.title)}>
              <ChatAvatar hub={props.hub} chatKey={d.key} title={d.title} hasAvatar={d.hasAvatar} size={36} />
              <b>{d.title}</b>
              <small>{busy === d.key ? '正在转发…' : d.kind === 'group' ? '群聊' : d.kind === 'self' ? '' : ''}</small>
            </button>
          </li>
        ))}
        {targets.length === 0 ? <li class="hint">没有可以转发到的会话。</li> : null}
      </ul>
    </Modal>
  );
}

export interface ChatProps {
  hub: Hub;
  chatKey: string;
  quickReplies: QuickReply[];
  settings: Settings;
  onBack: () => void;
  onManageQuick: () => void;
  /** 传了就在标题栏显示「在独立窗口打开」按钮 */
  onPopout?: (key: string) => void;
}

/**
 * 聊天窗口。只订阅自己这个会话：别的会话、别的账号来消息时，它完全不重画。
 * 主窗口和独立窗口用的是同一个组件。
 */
export const ChatView = memo(function ChatView(props: ChatProps): JSX.Element | null {
  useChat(props.hub, props.chatKey);
  const dialog = props.hub.dialog(props.chatKey);
  const account = dialog ? props.hub.account(dialog.accountId) : null;
  if (!dialog || !account) return null;
  return <ChatBody {...props} dialog={dialog} account={account} />;
});

function ChatBody(props: ChatProps & { dialog: InboxDialog; account: AccountView }): JSX.Element {
  const { hub, dialog, account } = props;
  const key = dialog.key;
  const messages = hub.messages(key);
  const history = hub.history(key);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [replyTo, setReplyTo] = useState<MessageInfo | null>(null);
  const [editing, setEditing] = useState<MessageInfo | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<'emoji' | 'sticker'>('emoji');
  const [dragging, setDragging] = useState(false);
  /** 多选模式下勾中的消息；null 表示不在多选模式 */
  const [picked, setPicked] = useState<Set<number> | null>(null);
  /** 等待选择「转发到哪里」的消息 */
  const [forwarding, setForwarding] = useState<number[] | null>(null);
  const [groupOpen, setGroupOpen] = useState(false);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const stick = useRef(true);
  const prevHeight = useRef(0);
  const prevFirstId = useRef<number | null>(null);

  // 换会话时把输入状态清掉，避免把给甲的话发给乙
  useEffect(() => {
    setText('');
    setError(null);
    setSelected(null);
    setReplyTo(null);
    setEditing(null);
    setPendingFile(null);
    setEmojiOpen(false);
    setPicked(null);
    setForwarding(null);
    setGroupOpen(false);
    setNotice(null);
    stick.current = true;
    prevFirstId.current = null;
    if (!isTouch()) input.current?.focus();
  }, [key]);

  // 新消息来了：如果本来就在底部就跟着滚；往上翻历史时保持原来看的位置
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const firstId = messages[0]?.id ?? null;
    if (prevFirstId.current !== null && firstId !== null && firstId < prevFirstId.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevHeight.current = el.scrollHeight;
    prevFirstId.current = firstId;
  }, [messages.length, messages.at(-1)?.id, messages[0]?.id, key]);

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 60 && history.hasMore && !history.loading && history.loaded) void hub.loadOlder(key);
  };

  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    if (sending) return false;
    setSending(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setSending(false);
    }
  };

  const submit = async () => {
    const value = text.trim();
    if (!value) return;
    stick.current = true;
    if (editing) {
      if (await run(() => hub.edit(key, editing.id, value))) {
        setEditing(null);
        setText('');
      }
      return;
    }
    const reply = replyTo;
    // 先清空输入框，发送失败再放回去，这样连续回复更顺手
    setText('');
    setReplyTo(null);
    const ok = await run(() => hub.send(key, value, { replyToId: reply?.id }));
    if (!ok) {
      setText(value);
      setReplyTo(reply);
    }
    if (!isTouch()) input.current?.focus();
  };

  const quick = (q: QuickReply) => {
    if (props.settings.quickSendDirect && !editing) {
      stick.current = true;
      const reply = replyTo;
      setReplyTo(null);
      void run(() => hub.send(key, q.text, { replyToId: reply?.id }));
    } else {
      setText((t) => (t ? `${t}${q.text}` : q.text));
      input.current?.focus();
    }
  };

  const sendFile = async () => {
    const file = pendingFile;
    if (!file) return;
    const caption = text;
    const reply = replyTo;
    const ok = await run(async () => {
      const data = new Uint8Array(await file.arrayBuffer());
      const asPhoto = /^image\/(jpeg|png|webp)$/.test(file.type) && file.size < 10 * 1024 * 1024;
      await hub.sendFile(key, { name: file.name, type: file.type, data, asPhoto }, caption, { replyToId: reply?.id });
    });
    if (ok) {
      setPendingFile(null);
      setText('');
      setReplyTo(null);
      stick.current = true;
    }
  };

  // 气泡上的操作统一从这里走。回调本身的身份永远不变，里面用到的状态通过 ref 取最新值。
  const actionRef = useRef<(action: BubbleAction, m: MessageInfo) => void>(() => {});
  actionRef.current = (action, m) => {
    if (action === 'select') {
      setSelected(selected === m.id ? null : m.id);
      return;
    }
    if (action === 'pick') {
      // 进入多选，或在多选里勾选 / 取消勾选
      const next = new Set(picked ?? []);
      if (next.has(m.id)) next.delete(m.id);
      else next.add(m.id);
      setPicked(next);
      setSelected(null);
      return;
    }
    setSelected(null);
    if (action === 'forward') {
      setForwarding([m.id]);
      return;
    }
    if (action === 'reply') {
      setReplyTo(m);
      setEditing(null);
      input.current?.focus();
    } else if (action === 'edit') {
      setEditing(m);
      setReplyTo(null);
      setText(m.text);
      input.current?.focus();
    } else {
      void run(() => hub.remove(key, m.id));
    }
  };
  const onAction = useCallback((action: BubbleAction, m: MessageInfo) => actionRef.current(action, m), []);

  const takeFile = (f: File | null | undefined) => {
    if (!f || editing) return;
    if (f.size > MAX_FILE_BYTES) return setError('文件超过 50MB，暂时不支持在这里发送。');
    setError(null);
    setPendingFile(f);
  };

  const insertEmoji = (emoji: string) => {
    const el = input.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + emoji + text.slice(end);
    setText(next);
    // 等输入框内容更新后，把光标放回表情后面，方便连续点
    queueMicrotask(() => {
      if (!el) return;
      const pos = start + emoji.length;
      el.setSelectionRange(pos, pos);
      if (!isTouch()) el.focus();
    });
  };

  const byId = new Map(messages.map((m) => [m.id, m]));
  const rows: JSX.Element[] = [];
  let prev: MessageInfo | null = null;
  for (const m of messages) {
    if (!prev || !sameDay(prev.date, m.date)) {
      rows.push(
        <div class="day" key={`d${m.id}`}>
          <span>{dayLabel(m.date)}</span>
        </div>,
      );
    }
    rows.push(
      <Bubble
        key={m.id}
        hub={hub}
        chatKey={key}
        msg={m}
        read={m.out && m.id <= dialog.readOutboxMaxId}
        quoted={m.replyTo ? byId.get(m.replyTo.id) ?? null : null}
        selected={selected === m.id}
        picking={picked !== null}
        picked={picked?.has(m.id) ?? false}
        onAction={onAction}
      />,
    );
    prev = m;
  }

  const pickedMine = picked ? messages.filter((m) => m.out && picked.has(m.id)).length : 0;
  const offline = account.status !== 'online';
  const canSend = dialog.canSend && account.status !== 'revoked';

  return (
    <section
      class={`chat${dragging ? ' dragging' : ''}`}
      style={{ '--acct': account.color }}
      onDragOver={(e) => {
        if (!canSend || !e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        setDragging(false);
        if (!canSend || !e.dataTransfer?.files.length) return;
        e.preventDefault();
        takeFile(e.dataTransfer.files[0]);
      }}
    >
      {dragging ? <div class="drop-hint">松开鼠标，把文件发给 {dialog.title}</div> : null}
      <header class="chat-head">
        <button class="icon-btn back" onClick={props.onBack} aria-label="返回">
          <Icon name="back" />
        </button>
        <ChatAvatar hub={hub} chatKey={key} title={dialog.title} hasAvatar={dialog.hasAvatar} size={40} />
        <div class="chat-title">
          <strong>{dialog.title}</strong>
          <span class="via">
            通过 <AccountChip label={account.label} color={account.color} small /> 收发
            <span class="via-who">
              （{account.name}
              {account.phone ? ` · 尾号 ${account.phone.slice(-4)}` : ''}）
            </span>
            {dialog.kind === 'group' ? ' · 群聊' : dialog.kind === 'channel' ? ' · 频道' : dialog.kind === 'bot' ? ' · 机器人' : ''}
          </span>
        </div>
        {dialog.kind === 'group' ? (
          <button class={`icon-btn head-action${props.onPopout && !isTouch() ? ' pair' : ''}`} onClick={() => setGroupOpen(true)} title="群管理" aria-label="群管理">
            <Icon name="users" />
          </button>
        ) : null}
        {props.onPopout && !isTouch() ? (
          <button class="icon-btn head-action" onClick={() => props.onPopout?.(key)} title="在独立窗口打开这个会话" aria-label="在独立窗口打开这个会话">
            <Icon name="popout" />
          </button>
        ) : null}
      </header>

      {offline ? (
        <div class="banner warn">
          {account.status === 'revoked'
            ? `账号「${account.label}」的登录已失效，需要在「账号管理」里重新登录后才能收发消息。`
            : account.status === 'connecting'
              ? `账号「${account.label}」正在连接…`
              : `账号「${account.label}」当前离线，网络恢复后会自动重连。`}
        </div>
      ) : null}

      <div class="messages" ref={scroller} onScroll={onScroll}>
        {history.loading && messages.length > 0 ? <div class="service">正在加载更早的消息…</div> : null}
        {!history.hasMore && messages.length > 0 ? <div class="service">没有更早的消息了</div> : null}
        {rows}
        {history.loading && messages.length === 0 ? <div class="empty">正在加载消息…</div> : null}
        {history.error ? (
          <div class="empty">
            <p>{history.error}</p>
            <button class="btn" onClick={() => void hub.openChat(key)}>
              重试
            </button>
          </div>
        ) : null}
        {history.loaded && !history.loading && messages.length === 0 ? <div class="empty">还没有消息</div> : null}
      </div>

      {notice ? (
        <button class="banner as-button" onClick={() => setNotice(null)}>
          {notice}
        </button>
      ) : null}
      {picked !== null ? (
        <footer class="composer select-bar">
          <ErrorNote text={error} />
          <span class="select-count">已选 {picked.size} 条</span>
          <button class="btn small" disabled={picked.size === 0 || sending} onClick={() => setForwarding([...picked])}>
            <Icon name="forward" size={15} /> 转发
          </button>
          <button
            class="btn small"
            disabled={picked.size === 0}
            onClick={() => {
              const lines = messages.filter((m) => picked.has(m.id) && m.text).map((m) => m.text);
              void navigator.clipboard?.writeText(lines.join('\n'));
              setNotice(`已复制 ${lines.length} 条文字。`);
              setPicked(null);
            }}
          >
            <Icon name="copy" size={15} /> 复制
          </button>
          <button
            class="btn small danger-outline"
            disabled={pickedMine === 0 || sending}
            onClick={() => {
              if (!confirmBulkDelete) return setConfirmBulkDelete(true);
              setConfirmBulkDelete(false);
              void run(async () => {
                const n = await hub.removeMany(key, [...picked]);
                setNotice(`已删除 ${n} 条自己发的消息。`);
                setPicked(null);
              });
            }}
          >
            <Icon name="trash" size={15} /> {confirmBulkDelete ? `确认删除 ${pickedMine} 条（对方那边也会删）` : `删除${pickedMine > 0 ? `（${pickedMine}）` : ''}`}
          </button>
          <button class="btn small" onClick={() => { setPicked(null); setConfirmBulkDelete(false); }}>
            取消
          </button>
        </footer>
      ) : canSend ? (
        <footer class="composer">
          <ErrorNote text={error} />
          {replyTo ? (
            <div class="context-bar">
              <Icon name="reply" size={16} />
              <span class="context-text">回复：{replyTo.text || replyTo.media || '消息'}</span>
              <button class="icon-btn" onClick={() => setReplyTo(null)} aria-label="取消回复">
                <Icon name="close" size={16} />
              </button>
            </div>
          ) : null}
          {editing ? (
            <div class="context-bar">
              <Icon name="edit" size={16} />
              <span class="context-text">正在修改已发出的消息</span>
              <button
                class="icon-btn"
                onClick={() => {
                  setEditing(null);
                  setText('');
                }}
                aria-label="取消修改"
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          ) : null}
          <div class="quick-row">
            {props.quickReplies.map((q) => (
              <button key={q.id} class="quick" type="button" disabled={sending} onClick={() => quick(q)} title={q.text}>
                <Icon name="bolt" size={14} /> {q.title}
              </button>
            ))}
            <button class="quick ghost" type="button" onClick={props.onManageQuick}>
              <Icon name="edit" size={14} /> 管理快捷回复
            </button>
          </div>
          {emojiOpen ? (
            <div class="emoji-panel" role="group" aria-label="表情和贴纸">
              <div class="tabs panel-tabs" role="tablist">
                <button role="tab" aria-selected={panelTab === 'emoji'} class={panelTab === 'emoji' ? 'on' : ''} onClick={() => setPanelTab('emoji')}>表情</button>
                <button role="tab" aria-selected={panelTab === 'sticker'} class={panelTab === 'sticker' ? 'on' : ''} onClick={() => setPanelTab('sticker')}>贴纸</button>
              </div>
              {panelTab === 'emoji' ? (
                EMOJI_GROUPS.map((g) => (
                  <div class="emoji-group" key={g.name}>
                    <span class="emoji-group-name">{g.name}</span>
                    <div class="emoji-grid">
                      {g.items.map((em) => (
                        <button key={em} type="button" class="emoji" onClick={() => insertEmoji(em)} aria-label={`表情 ${em}`}>
                          {em}
                        </button>
                      ))}
                    </div>
                  </div>
                ))
              ) : (
                <StickerPanel
                  hub={hub}
                  accountId={dialog.accountId}
                  disabled={sending || !!editing}
                  onPick={(stickerId) => {
                    stick.current = true;
                    const reply = replyTo;
                    setReplyTo(null);
                    void run(() => hub.sendSticker(key, stickerId, { replyToId: reply?.id }));
                  }}
                />
              )}
            </div>
          ) : null}
          <div class="input-row">
            <button class="icon-btn" type="button" onClick={() => fileInput.current?.click()} aria-label="发送图片或文件" disabled={sending || !!editing}>
              <Icon name="attach" />
            </button>
            <input
              ref={fileInput}
              type="file"
              hidden
              onChange={(e) => {
                const f = e.currentTarget.files?.[0] ?? null;
                e.currentTarget.value = '';
                takeFile(f);
              }}
            />
            <button class={`icon-btn${emojiOpen ? ' on' : ''}`} type="button" onClick={() => setEmojiOpen(!emojiOpen)} aria-label="表情" aria-expanded={emojiOpen} title="表情">
              <Icon name="smile" />
            </button>
            <textarea
              ref={input}
              rows={1}
              value={text}
              placeholder={`以「${account.label}」回复 ${dialog.title}`}
              onInput={(e) => setText(e.currentTarget.value)}
              onPaste={(e) => {
                // 直接粘贴截图或复制的文件
                const f = e.clipboardData?.files[0];
                if (!f) return;
                e.preventDefault();
                takeFile(f);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isTouch()) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            <button class="send" type="button" onClick={() => void submit()} disabled={sending || !text.trim()} aria-label={editing ? '保存修改' : '发送'}>
              <Icon name={editing ? 'check' : 'send'} />
            </button>
          </div>
        </footer>
      ) : (
        <footer class="composer readonly">{account.status === 'revoked' ? '账号登录已失效，无法发送。' : '这个会话只能查看，不能发言。'}</footer>
      )}

      {forwarding ? (
        <ForwardModal
          hub={hub}
          fromKey={key}
          accountId={dialog.accountId}
          count={forwarding.length}
          onClose={() => setForwarding(null)}
          onPick={async (toKey, title) => {
            const n = await hub.forward(key, forwarding, toKey);
            setForwarding(null);
            setPicked(null);
            setNotice(`已转发 ${n} 条给「${title}」。`);
          }}
        />
      ) : null}
      {groupOpen ? <GroupModal hub={hub} chatKey={key} onClose={() => setGroupOpen(false)} /> : null}
      {pendingFile ? (
        <Modal title="发送文件" onClose={() => (sending ? undefined : setPendingFile(null))} locked={sending}>
          <p>
            把 <b>{pendingFile.name}</b>（{(pendingFile.size / 1024 / 1024).toFixed(2)} MB）发给 <b>{dialog.title}</b>？
          </p>
          <p class="hint">
            通过 <AccountChip label={account.label} color={account.color} small /> 发出{text.trim() ? `，并附上输入框里的文字作为说明。` : '。'}
          </p>
          <ErrorNote text={error} />
          <div class="row end">
            <button class="btn" onClick={() => setPendingFile(null)} disabled={sending}>
              取消
            </button>
            <button class="btn primary" onClick={() => void sendFile()} disabled={sending}>
              {sending ? '正在发送…' : '发送'}
            </button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}
