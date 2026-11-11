/**
 * 模拟连接：不联网，用于自动化测试和「演示模式」。
 * 行为尽量贴近真实连接，包括验证码、两步验证、限流、登录失效等情况。
 */
import {
  AppError,
  MAX_DOWNLOAD_BYTES,
  type AccountBackend,
  type AttachmentInfo,
  type GroupInfo,
  type LoadedFile,
  type StickerInfo,
  type StickerSetInfo,
  type BackendEvents,
  type BackendFactory,
  type ChatKind,
  type DialogInfo,
  type MessageInfo,
  type OutgoingFile,
  type QrLoginHandlers,
  type SelfInfo,
  type SendOptions,
  type SentCodeInfo,
} from './types.ts';

export const MOCK_CODE = '12345';
export const MOCK_PASSWORD = 'mima1234';

interface MockChat {
  info: DialogInfo;
  messages: MessageInfo[];
  photos: Set<number>;
  members: Set<number>;
}

interface SeedOptions {
  out?: boolean;
  ago?: number;
  sender?: string;
  photo?: boolean;
  unread?: boolean;
  /** 带一个可下载的附件 */
  file?: Partial<AttachmentInfo> & { name: string };
}

export const MOCK_STICKER_SETS: { id: string; title: string; stickers: StickerInfo[] }[] = [
  {
    id: 'biz',
    title: '生意常用',
    stickers: [
      { id: 'biz-ok', emoji: '👌', format: 'static' },
      { id: 'biz-thanks', emoji: '🙏', format: 'static' },
      { id: 'biz-deal', emoji: '🤝', format: 'static' },
    ],
  },
  {
    id: 'fun',
    title: '日常',
    stickers: [
      { id: 'fun-laugh', emoji: '😂', format: 'static' },
      { id: 'fun-anim', emoji: '🎉', format: 'animated' },
    ],
  },
];

interface MockUser {
  self: SelfInfo;
  chats: Map<number, MockChat>;
  nextId: number;
  listeners: Set<MockBackend>;
}

/** 1x1 灰色 PNG，用作模拟图片 */
const TINY_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkqK+vBwAEAgGAXRWkPgAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

export class MockNetwork {
  users = new Map<number, MockUser>();
  revoked = new Set<string>();
  /** 发送到这些会话会被限流（测试用） */
  floodChats = new Set<number>();
  /** 每次操作的模拟延迟（毫秒） */
  latency = 0;
  sent: { userId: number; chatId: number; text: string }[] = [];
  files: { userId: number; chatId: number; name: string; bytes: number; asPhoto: boolean }[] = [];
  forwards: { userId: number; from: number; to: number; ids: number[] }[] = [];
  groupLog: { userId: number; action: 'create' | 'add' | 'leave'; chatId: number; members: number[] }[] = [];
  groupCounter = 0;
  /** 这些会话禁止转发和保存（测试用） */
  protectedChats = new Set<number>();
  /** 这些人不允许被拉进群（测试用） */
  noInvite = new Set<number>();
  /** 头像被请求了多少次（测试缓存用） */
  avatarLoads = 0;
  now: () => number = () => Date.now();
  /** 正在等人扫码的登录；scanQr 会让最早的那个扫码成功 */
  qrWaiters: ((phone: string) => void)[] = [];
  /** 二维码显示出来时调用（演示模式用它来模拟「过几秒有人扫了」） */
  onQrShown: (() => void) | null = null;
  qrCounter = 0;
  /** 新用户第一次出现时调用（演示模式用它来填充示例会话） */
  onNewUser: ((userId: number) => void) | null = null;
  /** 允许用已保存的凭据恢复「这次运行里还没见过」的用户（界面测试跨刷新时用） */
  autoRestore = false;

  userIdForPhone(phone: string): number {
    const digits = phone.replace(/\D/g, '');
    return Number(digits.slice(-9)) || 1;
  }

  ensureUser(phone: string, name?: string): MockUser {
    const userId = this.userIdForPhone(phone);
    let u = this.users.get(userId);
    if (!u) {
      u = {
        self: { userId, name: name ?? `用户${String(userId).slice(-4)}`, username: null, phone },
        chats: new Map(),
        nextId: 1,
        listeners: new Set(),
      };
      this.users.set(userId, u);
      this.onNewUser?.(userId);
    }
    return u;
  }

  addChat(userId: number, chatId: number, title: string, kind: ChatKind = 'user', extra: Partial<DialogInfo> = {}): void {
    const u = this.users.get(userId);
    if (!u) throw new Error('no such mock user');
    u.chats.set(chatId, {
      info: {
        chatId,
        title,
        kind,
        unread: 0,
        muted: false,
        pinned: false,
        readOutboxMaxId: 0,
        last: null,
        canSend: kind !== 'channel',
        hasAvatar: false,
        canManage: false,
        ...extra,
      },
      messages: [],
      photos: new Set(),
      members: new Set(),
    });
  }

  /** 往会话里放一条历史消息（不触发实时事件） */
  seed(userId: number, chatId: number, text: string, opts: SeedOptions = {}): MessageInfo {
    const u = this.users.get(userId)!;
    const chat = u.chats.get(chatId)!;
    const msg: MessageInfo = {
      id: u.nextId++,
      chatId,
      date: this.now() - (opts.ago ?? 0),
      out: opts.out ?? false,
      text,
      media: opts.photo ? '[图片]' : opts.file ? (opts.file.kind === 'sticker' ? `[贴纸 ${opts.file.sticker?.emoji ?? ''}]` : `[文件] ${opts.file.name}`) : null,
      hasPhoto: opts.photo ?? false,
      attachment: opts.file
        ? { kind: 'file', mime: 'application/octet-stream', size: 1024, duration: null, sticker: null, ...opts.file }
        : null,
      sender: opts.sender ?? null,
      service: false,
      replyTo: null,
      edited: false,
    };
    if (opts.photo) chat.photos.add(msg.id);
    chat.messages.push(msg);
    chat.info.last = msg;
    if (opts.unread && !msg.out) chat.info.unread++;
    if (msg.out) chat.info.readOutboxMaxId = msg.id;
    return msg;
  }

  /** 模拟对方发来一条新消息（触发实时事件） */
  deliver(userId: number, chatId: number, text: string, sender?: string): MessageInfo {
    const u = this.users.get(userId)!;
    const chat = u.chats.get(chatId)!;
    const msg = this.seed(userId, chatId, text, { sender, unread: true });
    for (const b of u.listeners) b.emitMessage(msg, chat.info);
    return msg;
  }

  /** 模拟对方读了我方的消息 */
  peerRead(userId: number, chatId: number): void {
    const u = this.users.get(userId)!;
    const chat = u.chats.get(chatId)!;
    const maxId = chat.messages.at(-1)?.id ?? 0;
    chat.info.readOutboxMaxId = maxId;
    for (const b of u.listeners) b.emitRead(chatId, 'outbox', maxId, null);
  }

  /** 模拟用手机上的官方客户端扫了二维码（phone 是扫码的那个账号） */
  scanQr(phone: string): boolean {
    const waiter = this.qrWaiters.shift();
    if (!waiter) return false;
    waiter(phone);
    return true;
  }

  /** 模拟这份登录在别处被下线 */
  revoke(session: string): void {
    this.revoked.add(session);
    const userId = Number(session.split(':')[1]);
    for (const b of this.users.get(userId)?.listeners ?? []) b.emitStatus('revoked');
  }

  factory(): BackendFactory {
    return () => new MockBackend(this);
  }
}

export class MockBackend implements AccountBackend {
  private net: MockNetwork;
  private events: BackendEvents | null = null;
  private user: MockUser | null = null;
  private pendingPhone: string | null = null;
  private codeOk = false;
  private session: string | null = null;

  constructor(net: MockNetwork) {
    this.net = net;
  }

  setEvents(events: BackendEvents): void {
    this.events = events;
  }

  emitMessage(msg: MessageInfo, chat: DialogInfo): void {
    this.events?.onMessage({ ...msg }, { title: chat.title, kind: chat.kind, canSend: chat.canSend, hasAvatar: chat.hasAvatar, canManage: chat.canManage });
  }
  emitRead(chatId: number, kind: 'inbox' | 'outbox', maxId: number, unread: number | null): void {
    this.events?.onRead(chatId, kind, maxId, unread);
  }
  emitStatus(status: 'revoked' | 'online' | 'offline'): void {
    this.events?.onStatus(status);
  }

  private async tick(): Promise<void> {
    if (this.net.latency > 0) await new Promise((r) => setTimeout(r, this.net.latency));
  }

  private requireUser(): MockUser {
    if (!this.user) throw new AppError('invalid', '尚未登录。');
    if (this.session && this.net.revoked.has(this.session)) {
      throw new AppError('revoked', '这个账号的登录已失效（可能在别处被下线），需要重新登录。');
    }
    return this.user;
  }

  private chat(chatId: number): MockChat {
    const c = this.requireUser().chats.get(chatId);
    if (!c) throw new AppError('invalid', '找不到这个会话。');
    return c;
  }

  async sendCode(phone: string): Promise<SentCodeInfo> {
    await this.tick();
    const cleaned = phone.replace(/[^\d+]/g, '');
    if (!/^\+?\d{7,15}$/.test(cleaned)) {
      throw new AppError('bad_phone', '手机号格式不对，请带国家区号填写，例如 +8613800000000。');
    }
    if (cleaned.endsWith('000')) throw new AppError('flood', '操作太频繁，官方要求等待 5 分钟 后再试。', 300);
    this.pendingPhone = cleaned;
    this.codeOk = false;
    return { via: 'app', length: 5 };
  }

  async submitCode(code: string): Promise<'done' | 'password'> {
    await this.tick();
    if (!this.pendingPhone) throw new AppError('invalid', '请先获取验证码。');
    if (code.replace(/\D/g, '') !== MOCK_CODE) throw new AppError('bad_code', '验证码不正确，请重新输入。');
    this.codeOk = true;
    if (this.pendingPhone.endsWith('2')) return 'password';
    this.login();
    return 'done';
  }

  async passwordHint(): Promise<string | null> {
    return '演示密码';
  }

  async submitPassword(password: string): Promise<void> {
    await this.tick();
    if (!this.codeOk) throw new AppError('invalid', '请先输入验证码。');
    if (password !== MOCK_PASSWORD) throw new AppError('bad_password', '两步验证密码不正确。');
    this.login();
  }

  private login(): void {
    const u = this.net.ensureUser(this.pendingPhone!);
    this.user = u;
    this.session = `mock-session:${u.self.userId}:${Math.random().toString(36).slice(2)}`;
    u.listeners.add(this);
  }

  async qrLogin(handlers: QrLoginHandlers, signal: AbortSignal): Promise<void> {
    await this.tick();
    if (signal.aborted) throw new AppError('cancelled', '操作已取消。');
    handlers.onUrl(`tg://login?token=MOCK-${++this.net.qrCounter}-${'x'.repeat(40)}`, this.net.now() + 30_000);
    const phone = await new Promise<string>((resolve, reject) => {
      const waiter = (p: string) => resolve(p);
      this.net.qrWaiters.push(waiter);
      signal.addEventListener('abort', () => {
        this.net.qrWaiters = this.net.qrWaiters.filter((w) => w !== waiter);
        reject(new AppError('cancelled', '操作已取消。'));
      });
      this.net.onQrShown?.();
    });
    handlers.onScanned();
    await this.tick();
    this.pendingPhone = phone.replace(/[^\d+]/g, '');
    this.codeOk = true;
    if (this.pendingPhone.endsWith('2')) {
      let wrong = false;
      for (;;) {
        const pw = await handlers.askPassword('演示密码', wrong);
        if (signal.aborted) throw new AppError('cancelled', '操作已取消。');
        if (pw === MOCK_PASSWORD) break;
        wrong = true;
      }
    }
    this.login();
  }

  async exportSession(): Promise<string> {
    this.requireUser();
    return this.session!;
  }

  async resume(session: string): Promise<SelfInfo> {
    await this.tick();
    const userId = Number(session.split(':')[1]);
    let u = this.net.users.get(userId);
    if (!u && this.net.autoRestore && session.startsWith('mock-session:') && userId > 0) {
      u = this.net.ensureUser(`+${userId}`);
    }
    if (!session.startsWith('mock-session:') || !u || this.net.revoked.has(session)) {
      throw new AppError('revoked', '这个账号的登录已失效（可能在别处被下线），需要重新登录。');
    }
    this.user = u;
    this.session = session;
    u.listeners.add(this);
    this.events?.onStatus('online');
    return { ...u.self };
  }

  async whoAmI(): Promise<SelfInfo> {
    const u = this.requireUser();
    this.events?.onStatus('online');
    return { ...u.self };
  }

  async listDialogs(limit: number): Promise<DialogInfo[]> {
    await this.tick();
    return [...this.requireUser().chats.values()]
      .map((c) => ({ ...c.info, last: c.info.last ? { ...c.info.last } : null }))
      .sort((a, b) => (b.last?.date ?? 0) - (a.last?.date ?? 0))
      .slice(0, limit);
  }

  async getHistory(chatId: number, before: { id: number; date: number } | null, limit: number): Promise<MessageInfo[]> {
    await this.tick();
    const all = this.chat(chatId).messages;
    const older = before ? all.filter((m) => m.id < before.id) : all;
    return older.slice(-limit).reverse().map((m) => ({ ...m }));
  }

  async sendText(chatId: number, text: string, opts?: SendOptions): Promise<MessageInfo> {
    await this.tick();
    const u = this.requireUser();
    const chat = this.chat(chatId);
    if (!chat.info.canSend) throw new AppError('forbidden', '没有权限在这个会话里发言。');
    if (this.net.floodChats.has(chatId)) throw new AppError('flood', '操作太频繁，官方要求等待 30 秒 后再试。', 30);
    if (!text.trim()) throw new AppError('invalid', '消息内容不能为空。');
    const msg = this.net.seed(u.self.userId, chatId, text, { out: true });
    if (opts?.replyToId) msg.replyTo = { id: opts.replyToId, quote: '' };
    chat.info.readOutboxMaxId = msg.id - 1;
    this.net.sent.push({ userId: u.self.userId, chatId, text });
    return { ...msg };
  }

  async sendFile(chatId: number, file: OutgoingFile, caption: string, opts?: SendOptions): Promise<MessageInfo> {
    await this.tick();
    const u = this.requireUser();
    const chat = this.chat(chatId);
    if (!chat.info.canSend) throw new AppError('forbidden', '没有权限在这个会话里发言。');
    if (this.net.floodChats.has(chatId)) throw new AppError('flood', '操作太频繁，官方要求等待 30 秒 后再试。', 30);
    // 文件可以不带说明文字
    const msg = this.net.seed(u.self.userId, chatId, caption, { out: true, photo: file.asPhoto });
    if (!file.asPhoto) msg.media = `[文件] ${file.name}`;
    if (opts?.replyToId) msg.replyTo = { id: opts.replyToId, quote: '' };
    chat.info.readOutboxMaxId = msg.id - 1;
    this.net.sent.push({ userId: u.self.userId, chatId, text: caption });
    this.net.files.push({ userId: u.self.userId, chatId, name: file.name, bytes: file.data.byteLength, asPhoto: file.asPhoto });
    return { ...msg };
  }

  async editText(chatId: number, messageId: number, text: string): Promise<MessageInfo> {
    await this.tick();
    const msg = this.chat(chatId).messages.find((m) => m.id === messageId);
    if (!msg || !msg.out) throw new AppError('forbidden', '只能修改自己发出的消息。');
    msg.text = text;
    msg.edited = true;
    return { ...msg };
  }

  async deleteMessages(chatId: number, ids: number[]): Promise<void> {
    await this.tick();
    const chat = this.chat(chatId);
    chat.messages = chat.messages.filter((m) => !ids.includes(m.id));
    chat.info.last = chat.messages.at(-1) ?? null;
  }

  async markRead(chatId: number): Promise<void> {
    await this.tick();
    this.chat(chatId).info.unread = 0;
  }

  async loadPhoto(chatId: number, messageId: number): Promise<Uint8Array | null> {
    await this.tick();
    return this.chat(chatId).photos.has(messageId) ? TINY_PNG : null;
  }

  async loadAttachment(chatId: number, messageId: number, onProgress?: (done: number, total: number) => void): Promise<LoadedFile | null> {
    await this.tick();
    const msg = this.chat(chatId).messages.find((m) => m.id === messageId);
    const a = msg?.attachment;
    if (!a) return null;
    if ((a.size ?? 0) > MAX_DOWNLOAD_BYTES) throw new AppError('invalid', '这个文件超过 200MB，请到官方客户端下载。');
    if (this.net.protectedChats.has(chatId)) throw new AppError('forbidden', '这个会话禁止转发和保存内容。');
    const data = a.kind === 'sticker' || a.mime.startsWith('image/') ? TINY_PNG : new TextEncoder().encode(`模拟文件内容：${a.name}`);
    onProgress?.(data.byteLength / 2, data.byteLength);
    onProgress?.(data.byteLength, data.byteLength);
    return { data, mime: a.kind === 'sticker' ? 'image/png' : a.mime, name: a.name };
  }

  async loadAttachmentPreview(chatId: number, messageId: number): Promise<LoadedFile | null> {
    await this.tick();
    const a = this.chat(chatId).messages.find((m) => m.id === messageId)?.attachment;
    return a && (a.kind === 'sticker' || a.kind === 'video' || a.kind === 'gif') ? { data: TINY_PNG, mime: 'image/png', name: '预览' } : null;
  }

  async loadAvatar(chatId: number): Promise<Uint8Array | null> {
    await this.tick();
    this.net.avatarLoads++;
    return this.chat(chatId).info.hasAvatar ? TINY_PNG : null;
  }

  async forward(fromChatId: number, messageIds: number[], toChatId: number): Promise<MessageInfo[]> {
    await this.tick();
    const u = this.requireUser();
    const from = this.chat(fromChatId);
    const to = this.chat(toChatId);
    if (this.net.protectedChats.has(fromChatId)) throw new AppError('forbidden', '这个会话禁止转发和保存内容。');
    if (!to.info.canSend) throw new AppError('forbidden', '没有权限在这个会话里发言。');
    const out: MessageInfo[] = [];
    for (const id of [...messageIds].sort((a, b) => a - b)) {
      const src = from.messages.find((m) => m.id === id);
      if (!src) continue;
      const msg = this.net.seed(u.self.userId, toChatId, src.text, { out: true, photo: src.hasPhoto, file: src.attachment ?? undefined });
      if (src.hasPhoto) to.photos.add(msg.id);
      this.net.sent.push({ userId: u.self.userId, chatId: toChatId, text: src.text });
      out.push({ ...msg });
    }
    this.net.forwards.push({ userId: u.self.userId, from: fromChatId, to: toChatId, ids: [...messageIds] });
    return out;
  }

  async listStickerSets(): Promise<StickerSetInfo[]> {
    await this.tick();
    this.requireUser();
    return MOCK_STICKER_SETS.map((s) => ({ id: s.id, title: s.title, count: s.stickers.length }));
  }

  async listStickers(setId: string): Promise<StickerInfo[]> {
    await this.tick();
    const set = MOCK_STICKER_SETS.find((s) => s.id === setId);
    if (!set) throw new AppError('invalid', '这个贴纸包已经不存在了。');
    return set.stickers.map((s) => ({ ...s }));
  }

  async loadStickerImage(stickerId: string): Promise<LoadedFile | null> {
    await this.tick();
    return MOCK_STICKER_SETS.some((s) => s.stickers.some((x) => x.id === stickerId)) ? { data: TINY_PNG, mime: 'image/png', name: '贴纸' } : null;
  }

  async sendSticker(chatId: number, stickerId: string, opts?: SendOptions): Promise<MessageInfo> {
    await this.tick();
    const u = this.requireUser();
    const chat = this.chat(chatId);
    const sticker = MOCK_STICKER_SETS.flatMap((s) => s.stickers).find((x) => x.id === stickerId);
    if (!sticker) throw new AppError('invalid', '请重新打开贴纸面板后再试。');
    if (!chat.info.canSend) throw new AppError('forbidden', '没有权限在这个会话里发言。');
    const msg = this.net.seed(u.self.userId, chatId, '', {
      out: true,
      file: { kind: 'sticker', name: '贴纸', mime: 'image/webp', sticker: { emoji: sticker.emoji, format: sticker.format } },
    });
    if (opts?.replyToId) msg.replyTo = { id: opts.replyToId, quote: '' };
    this.net.sent.push({ userId: u.self.userId, chatId, text: `[贴纸:${stickerId}]` });
    return { ...msg };
  }

  /** 把「私聊会话编号」当成那个人：不允许被拉群的人会被跳过 */
  private invite(chat: MockChat, members: number[]): number {
    let notAdded = 0;
    for (const m of members) {
      if (this.net.noInvite.has(m)) notAdded++;
      else chat.members.add(m);
    }
    return notAdded;
  }

  async createGroup(title: string, members: number[]): Promise<{ dialog: DialogInfo; notAdded: number }> {
    await this.tick();
    const u = this.requireUser();
    if (!title.trim()) throw new AppError('invalid', '群名不能为空。');
    if (members.length === 0) throw new AppError('invalid', '建群至少要选一个人。');
    for (const m of members) if (this.chat(m).info.kind !== 'user') throw new AppError('invalid', '只能把联系人拉进群。');
    const chatId = -(900000 + ++this.net.groupCounter);
    this.net.addChat(u.self.userId, chatId, title.trim(), 'group', { canManage: true });
    const chat = this.chat(chatId);
    const notAdded = this.invite(chat, members);
    this.net.groupLog.push({ userId: u.self.userId, action: 'create', chatId, members: [...members] });
    return { dialog: { ...chat.info }, notAdded };
  }

  async renameGroup(chatId: number, title: string): Promise<void> {
    await this.tick();
    const chat = this.chat(chatId);
    if (!chat.info.canManage) throw new AppError('forbidden', '没有权限在这个会话里发言。');
    if (!title.trim()) throw new AppError('invalid', '群名不能为空。');
    chat.info.title = title.trim();
  }

  async addMembers(chatId: number, members: number[]): Promise<{ notAdded: number }> {
    await this.tick();
    const u = this.requireUser();
    const chat = this.chat(chatId);
    if (chat.info.kind !== 'group') throw new AppError('invalid', '这不是一个群。');
    const notAdded = this.invite(chat, members);
    this.net.groupLog.push({ userId: u.self.userId, action: 'add', chatId, members: [...members] });
    return { notAdded };
  }

  async inviteLink(chatId: number): Promise<string> {
    await this.tick();
    if (!this.chat(chatId).info.canManage) throw new AppError('forbidden', '只有群主和管理员可以查看邀请链接。');
    return `https://t.me/+mock${Math.abs(chatId)}`;
  }

  async groupInfo(chatId: number): Promise<GroupInfo> {
    await this.tick();
    return { members: this.chat(chatId).members.size + 1 };
  }

  async leaveGroup(chatId: number): Promise<void> {
    await this.tick();
    const u = this.requireUser();
    this.chat(chatId);
    u.chats.delete(chatId);
    this.net.groupLog.push({ userId: u.self.userId, action: 'leave', chatId, members: [] });
  }

  async logOut(): Promise<void> {
    if (this.session) this.net.revoked.add(this.session);
    await this.destroy();
  }

  async destroy(): Promise<void> {
    this.user?.listeners.delete(this);
    this.events = null;
  }
}
