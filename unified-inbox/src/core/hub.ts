/**
 * 汇总中心：同时管理所有账号的连接，把各账号的会话和消息汇成一个收件箱。
 *
 * 每条会话都带着「来自哪个账号」，回复时一定从收到消息的那个账号发出，
 * 不会串号。消息内容只放在内存里，不写入磁盘。
 */
import {
  AppError,
  MAX_FORWARD,
  MAX_GROUP_ADD,
  errorText,
  type ChatBrief,
  type GroupInfo,
  type LoadedFile,
  type StickerInfo,
  type StickerSetInfo,
  type AccountBackend,
  type AccountStatus,
  type BackendFactory,
  type DialogInfo,
  type MessageInfo,
  type OutgoingFile,
  type QrLoginHandlers,
  type SendOptions,
  type SentCodeInfo,
} from './types.ts';
import type { StoredAccount, Vault } from './vault.ts';

export const ACCOUNT_COLORS = ['#2f7de1', '#e0683a', '#2aa876', '#b455c9', '#d9a514', '#d94a6a', '#1aa3b8', '#7a6ee6'];
/** 新登录保护期：刚登录的账号这段时间内不参与批量回复 */
export const NEW_LOGIN_PROTECT_MS = 24 * 60 * 60 * 1000;
/** 两次登录账号之间建议的最短间隔 */
export const LOGIN_SPACING_MS = 10 * 60 * 1000;
/** 一天之内建议最多新登录几个账号 */
export const LOGINS_PER_DAY_ADVICE = 3;
/** 单个账号每分钟最多发几条（普通 / 重要账号） */
export const SEND_LIMIT_PER_MINUTE = 20;
export const SEND_LIMIT_PER_MINUTE_IMPORTANT = 10;
const SEND_WINDOW_MS = 60_000;
const DIALOG_LIMIT = 150;
const HISTORY_PAGE = 40;
const MESSAGE_CAP = 600;
/** 「超级群/频道」的会话编号都小于这个数 */
const CHANNEL_ID_BASE = -1_000_000_000_000;

export interface AccountView {
  id: string;
  label: string;
  color: string;
  phone: string;
  name: string;
  username: string | null;
  status: AccountStatus;
  statusDetail: string | null;
  unread: number;
  unreadChats: number;
  /** 重要账号（开启额外保护） */
  important: boolean;
  /** 新登录保护期到什么时候结束；不在保护期为 null */
  protectedUntil: number | null;
}

export interface LoginPacing {
  /** 最近 24 小时已经新登录了几个账号 */
  last24h: number;
  /** 距离建议的间隔还差几分钟；0 表示可以登录 */
  waitMinutes: number;
}

export interface InboxDialog extends DialogInfo {
  /** 全局唯一：账号编号 + 会话编号 */
  key: string;
  accountId: string;
}

export interface HistoryState {
  loaded: boolean;
  loading: boolean;
  hasMore: boolean;
  error: string | null;
}

interface AccountRuntime {
  stored: StoredAccount;
  backend: AccountBackend | null;
  status: AccountStatus;
  statusDetail: string | null;
}

export type IncomingListener = (account: AccountView, dialog: InboxDialog, msg: MessageInfo) => void;

export function dialogKey(accountId: string, chatId: number): string {
  return `${accountId}:${chatId}`;
}

function newId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class Hub {
  private vault: Vault;
  private factory: BackendFactory;
  private runtimes = new Map<string, AccountRuntime>();
  private dialogMap = new Map<string, InboxDialog>();
  private messageMap = new Map<string, MessageInfo[]>();
  private historyMap = new Map<string, HistoryState>();
  private listeners = new Set<() => void>();
  private keyListeners = new Map<string, Set<() => void>>();
  private pendingKeys = new Set<string>();
  private pendingAllKeys = false;
  private notifyQueued = false;
  private destroyed = false;
  private sortedCache: InboxDialog[] | null = null;

  /** 当前打开的会话 */
  activeKey: string | null = null;
  /** 页面是否在前台（由界面层告知），不在前台时不自动标已读 */
  isVisible: () => boolean = () => true;
  onIncoming: IncomingListener | null = null;
  version = 0;
  /** 当前时间（测试时可以替换） */
  now: () => number = () => Date.now();
  private sendLog = new Map<string, number[]>();
  private avatarCache = new Map<string, Promise<Uint8Array | null>>();
  /** 独立窗口里正在显示的会话：窗口编号 → 会话和「这个窗口现在是否正被人看着」 */
  private viewers = new Map<string, { key: string; watching: () => boolean }>();

  constructor(vault: Vault, factory: BackendFactory) {
    this.vault = vault;
    this.factory = factory;
    for (const stored of vault.data.accounts) {
      this.runtimes.set(stored.id, { stored, backend: null, status: 'connecting', statusDetail: null });
    }
  }

  // —— 订阅 ——

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 只关心某一个会话的订阅（独立窗口用）：别的会话来消息时不会被打扰 */
  subscribeKey(key: string, fn: () => void): () => void {
    let set = this.keyListeners.get(key);
    if (!set) {
      set = new Set();
      this.keyListeners.set(key, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0 && this.keyListeners.get(key) === set) this.keyListeners.delete(key);
    };
  }

  /**
   * 通知界面刷新。传了 key 表示「只有这一个会话变了」，
   * 这样开着很多独立窗口时，只有相关的那个窗口需要重画，其余窗口不动。
   * 不传 key 表示账号级或全局的变化，所有窗口都刷新。
   */
  private changed(key?: string): void {
    this.sortedCache = null;
    this.version++;
    if (key === undefined) this.pendingAllKeys = true;
    else this.pendingKeys.add(key);
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      const all = this.pendingAllKeys;
      const keys = this.pendingKeys;
      this.pendingAllKeys = false;
      this.pendingKeys = new Set();
      for (const fn of [...this.listeners]) fn();
      if (all) {
        for (const set of [...this.keyListeners.values()]) for (const fn of [...set]) fn();
      } else {
        for (const k of keys) for (const fn of [...(this.keyListeners.get(k) ?? [])]) fn();
      }
    });
  }

  // —— 读取 ——

  accounts(): AccountView[] {
    const unread = new Map<string, { n: number; chats: number }>();
    for (const d of this.dialogMap.values()) {
      if (d.unread <= 0 || d.muted) continue;
      const u = unread.get(d.accountId) ?? { n: 0, chats: 0 };
      u.n += d.unread;
      u.chats += 1;
      unread.set(d.accountId, u);
    }
    return [...this.runtimes.values()].map((rt) => this.view(rt, unread.get(rt.stored.id)));
  }

  account(id: string): AccountView | null {
    const rt = this.runtimes.get(id);
    return rt ? this.view(rt) : null;
  }

  private view(rt: AccountRuntime, unread?: { n: number; chats: number }): AccountView {
    const s = rt.stored;
    const until = (s.loginAt ?? 0) + NEW_LOGIN_PROTECT_MS;
    return {
      id: s.id,
      label: s.label,
      color: s.color,
      phone: s.phone,
      name: s.name,
      username: s.username,
      status: rt.status,
      statusDetail: rt.statusDetail,
      unread: unread?.n ?? 0,
      unreadChats: unread?.chats ?? 0,
      important: s.important === true,
      protectedUntil: until > this.now() ? until : null,
    };
  }

  /** 这个账号现在能不能参与批量回复；不能时返回原因 */
  batchBlock(accountId: string): string | null {
    const rt = this.runtimes.get(accountId);
    if (!rt) return '账号不存在。';
    if (rt.stored.important) return '重要账号已开启保护，不参与批量回复。';
    const until = (rt.stored.loginAt ?? 0) + NEW_LOGIN_PROTECT_MS;
    if (until > this.now()) {
      const hours = Math.ceil((until - this.now()) / 3_600_000);
      return `刚登录的账号 24 小时内不参与批量回复（还剩约 ${hours} 小时）。`;
    }
    return null;
  }

  /** 添加账号前的节奏提醒：短时间内连续登录很多账号容易被官方判为异常 */
  loginPacing(): LoginPacing {
    const now = this.now();
    const times = this.vault.data.accounts.map((a) => a.loginAt ?? 0).filter((t) => t > now - NEW_LOGIN_PROTECT_MS);
    const last = Math.max(0, ...times);
    const wait = last + LOGIN_SPACING_MS - now;
    return { last24h: times.length, waitMinutes: wait > 0 ? Math.ceil(wait / 60_000) : 0 };
  }

  /** 发送限速：同一个账号一分钟内发太多条会被拦下，避免被官方当成机器刷屏 */
  private checkSendRate(accountId: string): void {
    const rt = this.runtimes.get(accountId);
    const limit = rt?.stored.important ? SEND_LIMIT_PER_MINUTE_IMPORTANT : SEND_LIMIT_PER_MINUTE;
    const now = this.now();
    const recent = (this.sendLog.get(accountId) ?? []).filter((t) => t > now - SEND_WINDOW_MS);
    if (recent.length >= limit) {
      const seconds = Math.max(1, Math.ceil((recent[0]! + SEND_WINDOW_MS - now) / 1000));
      throw new AppError(
        'flood',
        `账号「${rt?.stored.label ?? '?'}」1 分钟内已发出 ${recent.length} 条。为避免被官方判定为异常，请 ${seconds} 秒后再发。`,
        seconds,
      );
    }
    recent.push(now);
    this.sendLog.set(accountId, recent);
  }

  /** 所有账号的会话合在一起，最新的排最前 */
  dialogs(): InboxDialog[] {
    if (!this.sortedCache) {
      this.sortedCache = [...this.dialogMap.values()].sort((a, b) => (b.last?.date ?? 0) - (a.last?.date ?? 0));
    }
    return this.sortedCache;
  }

  dialog(key: string): InboxDialog | null {
    return this.dialogMap.get(key) ?? null;
  }

  messages(key: string): MessageInfo[] {
    return this.messageMap.get(key) ?? [];
  }

  history(key: string): HistoryState {
    return this.historyMap.get(key) ?? { loaded: false, loading: false, hasMore: true, error: null };
  }

  totalUnread(): number {
    let n = 0;
    for (const d of this.dialogMap.values()) if (!d.muted) n += d.unread;
    return n;
  }

  // —— 连接 ——

  /** 解锁后调用：所有账号同时上线 */
  async startAll(): Promise<void> {
    await Promise.all([...this.runtimes.keys()].map((id) => this.connect(id)));
  }

  async connect(accountId: string): Promise<void> {
    const rt = this.runtimes.get(accountId);
    const api = this.vault.data.api;
    if (!rt || !api || this.destroyed) return;
    if (rt.backend) {
      await rt.backend.destroy();
      rt.backend = null;
    }
    rt.status = 'connecting';
    rt.statusDetail = null;
    this.changed();
    const backend = this.factory(api);
    rt.backend = backend;
    this.attach(rt, backend);
    try {
      const me = await backend.resume(rt.stored.session);
      if (this.destroyed || rt.backend !== backend) return;
      if (me.name !== rt.stored.name || me.username !== rt.stored.username) {
        rt.stored.name = me.name;
        rt.stored.username = me.username;
        void this.vault.save();
      }
      rt.status = 'online';
      this.changed();
      await this.refreshDialogs(accountId);
    } catch (e) {
      if (this.destroyed || rt.backend !== backend) return;
      const revoked = e instanceof AppError && e.code === 'revoked';
      rt.status = revoked ? 'revoked' : 'error';
      rt.statusDetail = errorText(e);
      this.changed();
    }
  }

  async refreshDialogs(accountId: string): Promise<void> {
    const rt = this.runtimes.get(accountId);
    if (!rt?.backend) return;
    const backend = rt.backend;
    const list = await backend.listDialogs(DIALOG_LIMIT);
    if (this.destroyed || rt.backend !== backend) return;
    for (const d of list) {
      const key = dialogKey(accountId, d.chatId);
      this.dialogMap.set(key, { ...d, key, accountId });
    }
    this.changed();
  }

  private attach(rt: AccountRuntime, backend: AccountBackend): void {
    const accountId = rt.stored.id;
    const live = () => !this.destroyed && rt.backend === backend;
    backend.setEvents({
      onMessage: (msg, chat) => {
        if (live()) this.handleMessage(accountId, msg, chat);
      },
      onEdit: (msg) => {
        if (!live()) return;
        const key = dialogKey(accountId, msg.chatId);
        const list = this.messageMap.get(key);
        const i = list?.findIndex((m) => m.id === msg.id) ?? -1;
        if (list && i >= 0) list[i] = msg;
        const d = this.dialogMap.get(key);
        if (d?.last?.id === msg.id) this.dialogMap.set(key, { ...d, last: msg });
        this.changed(key);
      },
      onDelete: (chatId, ids) => {
        if (live()) this.handleDelete(accountId, chatId, ids);
      },
      onRead: (chatId, kind, maxId, unread) => {
        if (!live()) return;
        const key = dialogKey(accountId, chatId);
        const d = this.dialogMap.get(key);
        if (!d) return;
        if (kind === 'outbox') {
          this.dialogMap.set(key, { ...d, readOutboxMaxId: Math.max(d.readOutboxMaxId, maxId) });
        } else {
          this.dialogMap.set(key, { ...d, unread: unread ?? 0 });
        }
        this.changed(key);
      },
      onStatus: (status, detail) => {
        if (!live()) return;
        // 已判定失效的登录不会因为重连而「复活」
        if (rt.status === 'revoked' && status !== 'revoked') return;
        if (rt.status === status) return;
        rt.status = status;
        rt.statusDetail = detail ?? null;
        this.changed();
      },
    });
  }

  private handleMessage(accountId: string, msg: MessageInfo, chat: ChatBrief): void {
    const key = dialogKey(accountId, msg.chatId);
    const existing = this.dialogMap.get(key);
    const reading = this.isBeingRead(key);
    const countsAsUnread = !msg.out && chat.kind !== 'self' && !reading;
    const base: InboxDialog = existing ?? {
      key,
      accountId,
      chatId: msg.chatId,
      title: chat.title,
      kind: chat.kind,
      unread: 0,
      muted: false,
      pinned: false,
      readOutboxMaxId: 0,
      last: null,
      canSend: chat.canSend,
      hasAvatar: chat.hasAvatar,
      canManage: chat.canManage,
    };
    const isNewer = !base.last || msg.date >= base.last.date;
    const dialog: InboxDialog = {
      ...base,
      title: chat.title || base.title,
      last: isNewer ? msg : base.last,
      unread: msg.out ? 0 : base.unread + (countsAsUnread ? 1 : 0),
    };
    this.dialogMap.set(key, dialog);
    this.insertMessages(key, [msg]);
    this.changed(key);
    // 正在看的会话来了新消息：本地不计未读，但仍要告诉服务器「已读」，否则下次打开又变回未读
    if (!msg.out && reading) void this.markRead(key, true);
    if (countsAsUnread && !dialog.muted) {
      const account = this.account(accountId);
      if (account) this.onIncoming?.(account, dialog, msg);
    }
  }

  private handleDelete(accountId: string, channelId: number | null, ids: number[]): void {
    const idSet = new Set(ids);
    const prefix = `${accountId}:`;
    for (const [key, list] of this.messageMap) {
      if (!key.startsWith(prefix)) continue;
      const chatId = Number(key.slice(prefix.length));
      const isChannel = chatId <= CHANNEL_ID_BASE;
      if (channelId === null ? isChannel : chatId !== channelId && chatId !== CHANNEL_ID_BASE - channelId) continue;
      const kept = list.filter((m) => !idSet.has(m.id));
      if (kept.length === list.length) continue;
      this.messageMap.set(key, kept);
      const d = this.dialogMap.get(key);
      if (d?.last && idSet.has(d.last.id)) this.dialogMap.set(key, { ...d, last: kept.at(-1) ?? null });
    }
    this.changed();
  }

  private insertMessages(key: string, incoming: MessageInfo[]): void {
    const byId = new Map<number, MessageInfo>();
    for (const m of this.messageMap.get(key) ?? []) byId.set(m.id, m);
    for (const m of incoming) byId.set(m.id, m);
    let list = [...byId.values()].sort((a, b) => a.id - b.id);
    // 只在「正在看最新消息」时才裁掉太旧的，避免翻历史时被截断
    if (list.length > MESSAGE_CAP && !this.isOpen(key)) list = list.slice(-MESSAGE_CAP);
    this.messageMap.set(key, list);
  }

  // —— 会话操作 ——

  private backendFor(key: string): { backend: AccountBackend; dialog: InboxDialog } {
    const dialog = this.dialogMap.get(key);
    if (!dialog) throw new AppError('invalid', '找不到这个会话。');
    const rt = this.runtimes.get(dialog.accountId);
    if (!rt?.backend || rt.status === 'revoked') {
      throw new AppError('revoked', `账号「${rt?.stored.label ?? '?'}」的登录已失效，请重新登录后再试。`);
    }
    return { backend: rt.backend, dialog };
  }

  /** 这个会话是否在主窗口或任何独立窗口里开着 */
  isOpen(key: string): boolean {
    if (this.activeKey === key) return true;
    for (const v of this.viewers.values()) if (v.key === key) return true;
    return false;
  }

  /** 这个会话现在是否真的有人在看（开着，而且那个窗口在前台） */
  isBeingRead(key: string): boolean {
    if (this.activeKey === key && this.isVisible()) return true;
    for (const v of this.viewers.values()) if (v.key === key && v.watching()) return true;
    return false;
  }

  /** 哪些会话开在独立窗口里（主窗口用来标记） */
  poppedOutKeys(): Set<string> {
    return new Set([...this.viewers.values()].map((v) => v.key));
  }

  /**
   * 独立窗口开始显示一个会话。同一个窗口再次调用就是换了会话。
   * watching 返回 true 时，来的新消息才算「已读」。
   */
  async attachViewer(viewerId: string, key: string, watching: () => boolean): Promise<void> {
    this.viewers.set(viewerId, { key, watching });
    this.changed(key);
    const state = this.history(key);
    if (!state.loaded && !state.loading) await this.loadHistory(key, false);
    if (this.viewers.get(viewerId)?.key === key && watching()) await this.markRead(key);
  }

  detachViewer(viewerId: string): void {
    if (this.viewers.delete(viewerId)) this.changed();
  }

  async openChat(key: string | null): Promise<void> {
    this.activeKey = key;
    this.changed();
    if (!key) return;
    const state = this.history(key);
    if (!state.loaded && !state.loading) await this.loadHistory(key, false);
    await this.markRead(key);
  }

  async loadOlder(key: string): Promise<void> {
    const state = this.history(key);
    if (state.loading || !state.hasMore) return;
    await this.loadHistory(key, true);
  }

  private async loadHistory(key: string, older: boolean): Promise<void> {
    const prev = this.history(key);
    this.historyMap.set(key, { ...prev, loading: true, error: null });
    this.changed(key);
    try {
      const { backend, dialog } = this.backendFor(key);
      const oldest = older ? this.messages(key)[0] : undefined;
      const page = await backend.getHistory(dialog.chatId, oldest ? { id: oldest.id, date: oldest.date } : null, HISTORY_PAGE);
      if (this.destroyed) return;
      this.insertMessages(key, page);
      this.historyMap.set(key, { loaded: true, loading: false, hasMore: page.length >= HISTORY_PAGE, error: null });
    } catch (e) {
      this.historyMap.set(key, { ...prev, loading: false, error: errorText(e) });
    }
    this.changed(key);
  }

  async markRead(key: string, force = false): Promise<void> {
    const d = this.dialogMap.get(key);
    if (!d || (d.unread === 0 && !force)) return;
    if (d.unread !== 0) {
      this.dialogMap.set(key, { ...d, unread: 0 });
      this.changed(key);
    }
    try {
      await this.backendFor(key).backend.markRead(d.chatId);
    } catch {
      /* 标已读失败不打扰用户，下次打开会再试 */
    }
  }

  private afterSend(key: string, msg: MessageInfo): void {
    const d = this.dialogMap.get(key);
    if (d) this.dialogMap.set(key, { ...d, last: msg, unread: 0 });
    this.insertMessages(key, [msg]);
    this.changed(key);
  }

  /** 从「收到消息的那个账号」发出回复 */
  async send(key: string, text: string, opts?: SendOptions): Promise<MessageInfo> {
    const trimmed = text.trim();
    if (!trimmed) throw new AppError('invalid', '消息内容不能为空。');
    const { backend, dialog } = this.backendFor(key);
    if (!dialog.canSend) throw new AppError('forbidden', '没有权限在这个会话里发言。');
    this.checkSendRate(dialog.accountId);
    const msg = await backend.sendText(dialog.chatId, trimmed, opts);
    this.afterSend(key, msg);
    return msg;
  }

  async sendFile(key: string, file: OutgoingFile, caption: string, opts?: SendOptions): Promise<MessageInfo> {
    const { backend, dialog } = this.backendFor(key);
    if (!dialog.canSend) throw new AppError('forbidden', '没有权限在这个会话里发言。');
    this.checkSendRate(dialog.accountId);
    const msg = await backend.sendFile(dialog.chatId, file, caption.trim(), opts);
    this.afterSend(key, msg);
    return msg;
  }

  async edit(key: string, messageId: number, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) throw new AppError('invalid', '消息内容不能为空。');
    const { backend, dialog } = this.backendFor(key);
    const msg = await backend.editText(dialog.chatId, messageId, trimmed);
    const list = this.messageMap.get(key);
    const i = list?.findIndex((m) => m.id === messageId) ?? -1;
    if (list && i >= 0) list[i] = msg;
    const d = this.dialogMap.get(key);
    if (d?.last?.id === messageId) this.dialogMap.set(key, { ...d, last: msg });
    this.changed(key);
  }

  async remove(key: string, messageId: number): Promise<void> {
    await this.removeMany(key, [messageId]);
  }

  /** 删除多条（只会删自己发出的；别人发的会被跳过） */
  async removeMany(key: string, messageIds: number[]): Promise<number> {
    const { backend, dialog } = this.backendFor(key);
    const mine = new Set(this.messages(key).filter((m) => m.out && messageIds.includes(m.id)).map((m) => m.id));
    if (mine.size === 0) return 0;
    await backend.deleteMessages(dialog.chatId, [...mine]);
    const kept = this.messages(key).filter((m) => !mine.has(m.id));
    this.messageMap.set(key, kept);
    const d = this.dialogMap.get(key);
    if (d?.last && mine.has(d.last.id)) this.dialogMap.set(key, { ...d, last: kept.at(-1) ?? null });
    this.changed(key);
    return mine.size;
  }

  /**
   * 转发：只能在同一个账号内转发（消息是「这个账号」看到的，别的账号没有权限读它）。
   * 一次最多 MAX_FORWARD 条，计入发送限速。
   */
  async forward(fromKey: string, messageIds: number[], toKey: string): Promise<number> {
    const ids = [...new Set(messageIds)];
    if (ids.length === 0) throw new AppError('invalid', '请先选择要转发的消息。');
    if (ids.length > MAX_FORWARD) throw new AppError('invalid', `一次最多转发 ${MAX_FORWARD} 条。`);
    const { backend, dialog: from } = this.backendFor(fromKey);
    const { dialog: to } = this.backendFor(toKey);
    if (from.accountId !== to.accountId) {
      throw new AppError('invalid', '只能转发到同一个账号的会话里。要发给别的账号的联系人，请复制内容或重新发送文件。');
    }
    if (!to.canSend) throw new AppError('forbidden', '没有权限在这个会话里发言。');
    this.checkSendRate(to.accountId);
    const sent = await backend.forward(from.chatId, ids, to.chatId);
    const last = sent.at(-1);
    if (last) {
      const d = this.dialogMap.get(toKey);
      if (d) this.dialogMap.set(toKey, { ...d, last, unread: 0 });
      this.insertMessages(toKey, sent);
    }
    this.changed(toKey);
    return sent.length;
  }

  loadAttachment(key: string, messageId: number, onProgress?: (done: number, total: number) => void): Promise<LoadedFile | null> {
    const { backend, dialog } = this.backendFor(key);
    return backend.loadAttachment(dialog.chatId, messageId, onProgress);
  }

  loadAttachmentPreview(key: string, messageId: number): Promise<LoadedFile | null> {
    const { backend, dialog } = this.backendFor(key);
    return backend.loadAttachmentPreview(dialog.chatId, messageId);
  }

  /** 头像。同一个会话只向服务器要一次，之后用缓存；没有头像或取不到时返回 null。 */
  loadAvatar(key: string): Promise<Uint8Array | null> {
    let p = this.avatarCache.get(key);
    if (!p) {
      const d = this.dialogMap.get(key);
      if (!d?.hasAvatar) return Promise.resolve(null);
      p = Promise.resolve()
        .then(() => this.backendFor(key).backend.loadAvatar(d.chatId))
        .catch(() => {
          // 失败不缓存，下次还可以再试
          this.avatarCache.delete(key);
          return null;
        });
      this.avatarCache.set(key, p);
    }
    return p;
  }

  // —— 贴纸 ——

  private backendOf(accountId: string): AccountBackend {
    const rt = this.runtimes.get(accountId);
    if (!rt?.backend || rt.status === 'revoked') {
      throw new AppError('revoked', `账号「${rt?.stored.label ?? '?'}」的登录已失效，请重新登录后再试。`);
    }
    return rt.backend;
  }

  /** 这个账号已添加的贴纸包（每个账号的贴纸包各不相同） */
  listStickerSets(accountId: string): Promise<StickerSetInfo[]> {
    return this.backendOf(accountId).listStickerSets();
  }

  listStickers(accountId: string, setId: string): Promise<StickerInfo[]> {
    return this.backendOf(accountId).listStickers(setId);
  }

  loadStickerImage(accountId: string, stickerId: string): Promise<LoadedFile | null> {
    return this.backendOf(accountId).loadStickerImage(stickerId);
  }

  async sendSticker(key: string, stickerId: string, opts?: SendOptions): Promise<MessageInfo> {
    const { backend, dialog } = this.backendFor(key);
    if (!dialog.canSend) throw new AppError('forbidden', '没有权限在这个会话里发言。');
    this.checkSendRate(dialog.accountId);
    const msg = await backend.sendSticker(dialog.chatId, stickerId, opts);
    this.afterSend(key, msg);
    return msg;
  }

  // —— 群 ——

  /**
   * 建群、拉人是官方重点盯的行为（最像拉人广告），所以比发消息管得更严：
   * 刚登录不满 24 小时的账号不能做；一次最多选 MAX_GROUP_ADD 个人；只能拉自己已有私聊的联系人。
   */
  private groupGuard(accountId: string, memberKeys: string[]): number[] {
    const rt = this.runtimes.get(accountId);
    const until = (rt?.stored.loginAt ?? 0) + NEW_LOGIN_PROTECT_MS;
    if (until > this.now()) {
      const hours = Math.ceil((until - this.now()) / 3_600_000);
      throw new AppError('forbidden', `刚登录的账号 24 小时内不能建群和拉人（还剩约 ${hours} 小时）。这是为了避免账号被官方当成拉人广告而限制。`);
    }
    const keys = [...new Set(memberKeys)];
    if (keys.length > MAX_GROUP_ADD) throw new AppError('invalid', `一次最多选 ${MAX_GROUP_ADD} 个人。`);
    return keys.map((k) => {
      const d = this.dialogMap.get(k);
      if (!d || d.accountId !== accountId || d.kind !== 'user') throw new AppError('invalid', '只能选这个账号里已有私聊的联系人。');
      return d.chatId;
    });
  }

  /** 建群，返回新群的会话 key 和没能拉进来的人数 */
  async createGroup(accountId: string, title: string, memberKeys: string[]): Promise<{ key: string; notAdded: number }> {
    const name = title.trim();
    if (!name) throw new AppError('invalid', '请填写群名。');
    const members = this.groupGuard(accountId, memberKeys);
    if (members.length === 0) throw new AppError('invalid', '建群至少要选一个人。');
    const { dialog, notAdded } = await this.backendOf(accountId).createGroup(name, members);
    const key = dialogKey(accountId, dialog.chatId);
    this.dialogMap.set(key, { ...dialog, key, accountId, last: dialog.last ?? { ...this.placeholderMessage(dialog.chatId, '群已创建') } });
    this.changed();
    return { key, notAdded };
  }

  /** 让新群在列表里有时间可排（服务器的「创建了群」消息随后会覆盖它） */
  private placeholderMessage(chatId: number, text: string): MessageInfo {
    return { id: 0, chatId, date: this.now(), out: true, text: '', media: text, hasPhoto: false, attachment: null, sender: null, service: true, replyTo: null, edited: false };
  }

  async addMembers(key: string, memberKeys: string[]): Promise<{ notAdded: number }> {
    const { backend, dialog } = this.backendFor(key);
    if (dialog.kind !== 'group') throw new AppError('invalid', '只有群才能加人。');
    const members = this.groupGuard(dialog.accountId, memberKeys);
    if (members.length === 0) throw new AppError('invalid', '请至少选一个人。');
    return backend.addMembers(dialog.chatId, members);
  }

  async renameGroup(key: string, title: string): Promise<void> {
    const name = title.trim();
    if (!name) throw new AppError('invalid', '请填写群名。');
    const { backend, dialog } = this.backendFor(key);
    await backend.renameGroup(dialog.chatId, name);
    const d = this.dialogMap.get(key);
    if (d) this.dialogMap.set(key, { ...d, title: name });
    this.changed(key);
  }

  inviteLink(key: string): Promise<string> {
    const { backend, dialog } = this.backendFor(key);
    return backend.inviteLink(dialog.chatId);
  }

  groupInfo(key: string): Promise<GroupInfo> {
    const { backend, dialog } = this.backendFor(key);
    return backend.groupInfo(dialog.chatId);
  }

  /** 退群：退出后这个群从列表里消失 */
  async leaveGroup(key: string): Promise<void> {
    const { backend, dialog } = this.backendFor(key);
    if (dialog.kind !== 'group') throw new AppError('invalid', '只有群才能退出。');
    await backend.leaveGroup(dialog.chatId);
    this.dialogMap.delete(key);
    this.messageMap.delete(key);
    this.historyMap.delete(key);
    this.avatarCache.delete(key);
    if (this.activeKey === key) this.activeKey = null;
    for (const [viewerId, v] of [...this.viewers]) if (v.key === key) this.viewers.delete(viewerId);
    this.changed();
  }

  async loadPhoto(key: string, messageId: number, size: 'thumb' | 'full'): Promise<Uint8Array | null> {
    const { backend, dialog } = this.backendFor(key);
    return backend.loadPhoto(dialog.chatId, messageId, size);
  }

  // —— 账号管理 ——

  /** 开始添加一个新账号（或给失效的账号重新登录） */
  beginLogin(): LoginFlow {
    const api = this.vault.data.api;
    if (!api) throw new AppError('bad_api', '请先填写接口参数。');
    return new LoginFlow(this, this.factory(api));
  }

  /** 由 LoginFlow 在登录成功后调用 */
  async adopt(backend: AccountBackend, phone: string, label: string, color: string | null, important = false): Promise<string> {
    const me = await backend.whoAmI();
    const session = await backend.exportSession();
    const existing = this.vault.data.accounts.find((a) => a.userId === me.userId);
    let stored: StoredAccount;
    if (existing) {
      // 同一个账号重新登录：替换凭据，不重复添加
      const old = this.runtimes.get(existing.id);
      if (old?.backend) await old.backend.destroy();
      existing.session = session;
      existing.name = me.name;
      existing.username = me.username;
      existing.phone = me.phone ?? phone;
      if (label.trim()) existing.label = label.trim();
      if (color) existing.color = color;
      // 重新登录等于一份全新的登录，保护期重新计算；「重要」标记只会加不会被悄悄去掉
      existing.loginAt = this.now();
      if (important) existing.important = true;
      stored = existing;
    } else {
      stored = {
        id: newId(),
        label: label.trim() || me.name || phone,
        color: color ?? ACCOUNT_COLORS[this.vault.data.accounts.length % ACCOUNT_COLORS.length]!,
        phone: me.phone ?? phone,
        userId: me.userId,
        name: me.name,
        username: me.username,
        session,
        loginAt: this.now(),
        important,
      };
      this.vault.data.accounts.push(stored);
    }
    await this.vault.save();
    const rt: AccountRuntime = { stored, backend, status: 'online', statusDetail: null };
    this.runtimes.set(stored.id, rt);
    this.attach(rt, backend);
    this.changed();
    try {
      await this.refreshDialogs(stored.id);
    } catch (e) {
      rt.statusDetail = errorText(e);
      this.changed();
    }
    return stored.id;
  }

  async updateAccount(id: string, patch: { label?: string; color?: string; important?: boolean }): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    if (patch.label !== undefined && patch.label.trim()) rt.stored.label = patch.label.trim();
    if (patch.color !== undefined) rt.stored.color = patch.color;
    if (patch.important !== undefined) rt.stored.important = patch.important;
    await this.vault.save();
    this.changed();
  }

  /**
   * 移除账号。会先在服务器上退出登录，让这份凭据彻底作废，
   * 再从保险库删除；即使退出登录失败（比如断网），本机的凭据也一定删除。
   */
  async removeAccount(id: string): Promise<{ loggedOut: boolean }> {
    const rt = this.runtimes.get(id);
    if (!rt) return { loggedOut: false };
    let loggedOut = false;
    if (rt.backend) {
      try {
        if (rt.status !== 'revoked') {
          await rt.backend.logOut();
          loggedOut = true;
        }
      } catch {
        loggedOut = false;
      }
      await rt.backend.destroy();
      rt.backend = null;
    }
    this.runtimes.delete(id);
    this.sendLog.delete(id);
    this.vault.data.accounts = this.vault.data.accounts.filter((a) => a.id !== id);
    await this.vault.save();
    const prefix = `${id}:`;
    for (const key of [...this.dialogMap.keys()]) {
      if (!key.startsWith(prefix)) continue;
      this.dialogMap.delete(key);
      this.messageMap.delete(key);
      this.historyMap.delete(key);
      this.avatarCache.delete(key);
    }
    if (this.activeKey?.startsWith(prefix)) this.activeKey = null;
    for (const [viewerId, v] of [...this.viewers]) if (v.key.startsWith(prefix)) this.viewers.delete(viewerId);
    this.changed();
    return { loggedOut };
  }

  /** 全部账号退出登录（用于「清空本机数据」之前） */
  async logOutAll(): Promise<void> {
    for (const id of [...this.runtimes.keys()]) await this.removeAccount(id);
  }

  /** 上锁或关闭时调用：断开所有连接，清掉内存里的消息 */
  async destroy(): Promise<void> {
    this.destroyed = true;
    this.listeners.clear();
    this.keyListeners.clear();
    this.onIncoming = null;
    const backends = [...this.runtimes.values()].map((rt) => rt.backend);
    this.runtimes.clear();
    this.dialogMap.clear();
    this.messageMap.clear();
    this.historyMap.clear();
    this.sortedCache = null;
    this.activeKey = null;
    this.viewers.clear();
    this.avatarCache.clear();
    await Promise.all(backends.map((b) => b?.destroy()));
  }
}

/** 添加账号的分步流程：手机号 → 验证码 →（两步验证密码）→ 完成 */
export class LoginFlow {
  private hub: Hub;
  private backend: AccountBackend;
  private phone = '';
  private finished = false;
  private authed = false;
  private qrAbort: AbortController | null = null;

  constructor(hub: Hub, backend: AccountBackend) {
    this.hub = hub;
    this.backend = backend;
    backend.setEvents({ onMessage() {}, onEdit() {}, onDelete() {}, onRead() {}, onStatus() {} });
  }

  /**
   * 扫码登录：二维码内容通过 handlers.onUrl 交给界面显示，
   * 用户用手机上已登录这个账号的官方客户端扫描并确认后，这个调用才返回。
   */
  async startQr(handlers: QrLoginHandlers): Promise<void> {
    this.qrAbort = new AbortController();
    await this.backend.qrLogin(handlers, this.qrAbort.signal);
    this.authed = true;
  }

  async sendCode(phone: string): Promise<SentCodeInfo> {
    this.phone = phone.replace(/[^\d+]/g, '');
    return this.backend.sendCode(phone);
  }

  async submitCode(code: string): Promise<'done' | 'password'> {
    const result = await this.backend.submitCode(code);
    if (result === 'done') this.authed = true;
    return result;
  }

  passwordHint(): Promise<string | null> {
    return this.backend.passwordHint().catch(() => null);
  }

  async submitPassword(password: string): Promise<void> {
    await this.backend.submitPassword(password);
    this.authed = true;
  }

  /** 登录成功后保存到保险库并开始收消息；返回账号编号 */
  async finish(label: string, color: string | null, important = false): Promise<string> {
    const id = await this.hub.adopt(this.backend, this.phone, label, color, important);
    this.finished = true;
    return id;
  }

  /**
   * 中途放弃：断开这次临时连接。
   * 如果已经登录成功但还没保存，就顺手退出登录，不在服务器上留下没人管的登录。
   */
  async cancel(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.qrAbort?.abort();
    if (this.authed) {
      try {
        await this.backend.logOut();
      } catch {
        /* 退出失败也继续断开 */
      }
    }
    await this.backend.destroy();
  }
}
