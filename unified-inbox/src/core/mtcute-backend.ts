/**
 * 真实连接：通过官方公开的客户端接口（MTProto）直连官方服务器。
 *
 * 安全要点：
 * - 登录凭据只存在内存里（MemoryStorage），不写入浏览器的任何明文存储；
 *   需要长期保存时由上层导出后放进加密保险库。
 * - 只连接官方服务器，不经过任何中转。
 */
import {
  InputMedia,
  MemoryStorage,
  TelegramClient,
  Thumbnail,
  tl,
  type Dialog,
  type Message,
  type Peer,
  type Photo,
} from '@mtcute/web';
import { describeClient } from './env.ts';
import {
  AppError,
  type AccountBackend,
  type ApiCredentials,
  type BackendEvents,
  type ChatKind,
  type DialogInfo,
  type MessageInfo,
  type OutgoingFile,
  type QrLoginHandlers,
  type SelfInfo,
  type SendOptions,
  type SentCodeInfo,
} from './types.ts';

const MEDIA_LABELS: Record<string, string> = {
  photo: '[图片]',
  video: '[视频]',
  voice: '[语音]',
  audio: '[音频]',
  sticker: '[贴纸]',
  document: '[文件]',
  location: '[位置]',
  live_location: '[实时位置]',
  venue: '[地点]',
  contact: '[名片]',
  poll: '[投票]',
  dice: '[骰子]',
  game: '[游戏]',
  invoice: '[账单]',
  story: '[动态]',
  paid: '[付费内容]',
  todo: '[清单]',
};

const PHOTO_CACHE_LIMIT = 400;
const REQUEST_TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 10 * 60_000;

/** 把服务器返回的各种错误翻译成可以直接给人看的说明 */
export function translateError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (tl.RpcError.is(e)) {
    const text = e.text;
    const flood = /^(?:FLOOD_WAIT|FLOOD_PREMIUM_WAIT|SLOWMODE_WAIT)_(\d+)$/.exec(text);
    if (flood) {
      const seconds = Number(flood[1]);
      return new AppError('flood', `操作太频繁，官方要求等待 ${formatWait(seconds)} 后再试。`, seconds);
    }
    switch (text) {
      case 'PHONE_NUMBER_INVALID':
        return new AppError('bad_phone', '手机号格式不对，请带国家区号填写，例如 +8613800000000。');
      case 'PHONE_NUMBER_BANNED':
        return new AppError('bad_phone', '这个手机号已被官方封禁，无法登录。');
      case 'PHONE_NUMBER_UNOCCUPIED':
        return new AppError('bad_phone', '这个手机号还没有注册账号，请先用官方客户端注册。');
      case 'PHONE_CODE_INVALID':
      case 'PHONE_CODE_EMPTY':
        return new AppError('bad_code', '验证码不正确，请重新输入。');
      case 'PHONE_CODE_EXPIRED':
        return new AppError('code_expired', '验证码已过期，请重新获取。');
      case 'PASSWORD_HASH_INVALID':
        return new AppError('bad_password', '两步验证密码不正确。');
      case 'API_ID_INVALID':
      case 'API_ID_PUBLISHED_FLOOD':
        return new AppError('bad_api', '接口参数（api_id / api_hash）不正确，请到设置里重新填写。');
      case 'AUTH_KEY_UNREGISTERED':
      case 'AUTH_KEY_INVALID':
      case 'SESSION_REVOKED':
      case 'SESSION_EXPIRED':
      case 'USER_DEACTIVATED':
      case 'USER_DEACTIVATED_BAN':
        return new AppError('revoked', '这个账号的登录已失效（可能在别处被下线），需要重新登录。');
      case 'AUTH_KEY_DUPLICATED':
        return new AppError('revoked', '同一份登录凭据在两个地方同时使用，官方已将其作废，需要重新登录。');
      case 'CHAT_WRITE_FORBIDDEN':
      case 'CHAT_SEND_PLAIN_FORBIDDEN':
      case 'CHAT_ADMIN_REQUIRED':
      case 'USER_BANNED_IN_CHANNEL':
      case 'CHAT_RESTRICTED':
        return new AppError('forbidden', '没有权限在这个会话里发言。');
      case 'USER_IS_BLOCKED':
      case 'YOU_BLOCKED_USER':
        return new AppError('forbidden', '对方已将你拉黑，或你已拉黑对方，无法发送。');
      case 'PEER_FLOOD':
        return new AppError('flood', '官方暂时限制了这个账号主动发消息，请过一段时间再试。');
      case 'MESSAGE_EMPTY':
        return new AppError('invalid', '消息内容不能为空。');
      case 'MESSAGE_TOO_LONG':
        return new AppError('invalid', '消息太长了，请分成几条发送。');
      case 'MESSAGE_EDIT_TIME_EXPIRED':
        return new AppError('forbidden', '这条消息发出太久，已经不能修改了。');
      case 'MESSAGE_NOT_MODIFIED':
        return new AppError('invalid', '内容没有变化。');
      case 'MESSAGE_DELETE_FORBIDDEN':
        return new AppError('forbidden', '没有权限删除这条消息。');
      default:
        return new AppError('unknown', `官方服务器拒绝了这次操作（${text}）。`);
    }
  }
  if (e instanceof Error) {
    if (e.name === 'AbortError') return new AppError('cancelled', '操作已取消。');
    if (/timeout|network|socket|connect/i.test(e.message)) {
      return new AppError('network', '连接不上官方服务器，请检查网络或代理。');
    }
    return new AppError('unknown', `操作没有完成：${e.message}`);
  }
  return new AppError('unknown', '操作没有完成，请稍后再试。');
}

function formatWait(seconds: number): string {
  if (seconds < 90) return `${seconds} 秒`;
  if (seconds < 5400) return `${Math.ceil(seconds / 60)} 分钟`;
  return `${Math.ceil(seconds / 3600)} 小时`;
}

function peerKind(peer: Peer): ChatKind {
  if (peer.type === 'user') {
    if (peer.isSelf) return 'self';
    return peer.isBot ? 'bot' : 'user';
  }
  return peer.chatType === 'channel' ? 'channel' : 'group';
}

function peerTitle(peer: Peer): string {
  if (peer.type === 'user' && peer.isSelf) return '收藏夹（发给自己）';
  return peer.displayName || '（无名称）';
}

function peerCanSend(peer: Peer): boolean {
  if (peer.type === 'user') return true;
  if (peer.chatType === 'channel') return peer.isCreator || peer.isAdmin;
  return !peer.isBanned;
}

export class MtcuteBackend implements AccountBackend {
  private tg: TelegramClient;
  private events: BackendEvents | null = null;
  private peers = new Map<number, tl.TypeInputPeer>();
  private photos = new Map<string, Photo>();
  private pendingPhone: string | null = null;
  private pendingCodeHash: string | null = null;
  private destroyed = false;

  constructor(api: ApiCredentials) {
    this.tg = new TelegramClient({
      apiId: api.id,
      apiHash: api.hash,
      storage: new MemoryStorage(),
      // 只输出警告和错误，避免把会话内容打到控制台
      logLevel: 1,
      // 如实、稳定地上报这台设备的真实环境（见 env.ts）
      initConnectionOptions: describeClient(navigator.userAgent, navigator.language),
    });

    this.tg.onNewMessage.add((msg) => {
      this.remember(msg);
      this.events?.onMessage(this.toMessage(msg), {
        title: peerTitle(msg.chat),
        kind: peerKind(msg.chat),
        canSend: peerCanSend(msg.chat),
      });
    });
    this.tg.onEditMessage.add((msg) => {
      this.remember(msg);
      this.events?.onEdit(this.toMessage(msg));
    });
    this.tg.onDeleteMessage.add((upd) => {
      this.events?.onDelete(upd.channelId, upd.messageIds);
    });
    this.tg.onHistoryRead.add((upd) => {
      if (upd.isDiscussion || upd.isMonoForum) return;
      this.events?.onRead(upd.chatId, upd.isOutbox ? 'outbox' : 'inbox', upd.maxReadId, upd.isOutbox ? null : upd.unreadCount);
    });
    this.tg.onConnectionState.add((state) => {
      if (this.destroyed) return;
      this.events?.onStatus(state === 'connected' || state === 'updating' ? 'online' : state === 'offline' ? 'offline' : 'connecting');
    });
    this.tg.onError.add((err) => {
      if (this.destroyed) return;
      const translated = translateError(err);
      if (translated.code === 'revoked') this.events?.onStatus('revoked', translated.message);
    });
  }

  setEvents(events: BackendEvents): void {
    this.events = events;
  }

  private remember(msg: Message): void {
    this.peers.set(msg.chat.id, msg.chat.inputPeer);
    const media = msg.media;
    if (media?.type === 'photo') {
      const key = `${msg.chat.id}:${msg.id}`;
      this.photos.delete(key);
      this.photos.set(key, media);
      if (this.photos.size > PHOTO_CACHE_LIMIT) {
        const oldest = this.photos.keys().next().value;
        if (oldest !== undefined) this.photos.delete(oldest);
      }
    }
  }

  private peer(chatId: number): tl.TypeInputPeer | number {
    return this.peers.get(chatId) ?? chatId;
  }

  private toMessage(msg: Message): MessageInfo {
    const media = msg.media;
    let label: string | null = null;
    if (media && media.type !== 'webpage') {
      label = MEDIA_LABELS[media.type] ?? '[暂不支持显示的内容]';
      if (media.type === 'document' && media.fileName) label = `[文件] ${media.fileName}`;
      if (media.type === 'sticker' && media.emoji) label = `[贴纸 ${media.emoji}]`;
    }
    const isGroup = msg.chat.type === 'chat' && msg.chat.chatType !== 'channel';
    const reply = msg.replyToMessage;
    return {
      id: msg.id,
      chatId: msg.chat.id,
      date: msg.date.getTime(),
      out: msg.isOutgoing,
      text: msg.isService ? '' : msg.text,
      media: msg.isService ? '[系统消息]' : label,
      hasPhoto: media?.type === 'photo',
      sender: isGroup && !msg.isOutgoing ? msg.sender.displayName || null : null,
      service: msg.isService,
      replyTo: reply && reply.id !== null && !reply.isForumTopic ? { id: reply.id, quote: reply.quoteText } : null,
      edited: msg.editDate !== null && !msg.hideEditMark,
    };
  }

  private toDialog(d: Dialog): DialogInfo {
    const peer = d.peer;
    this.peers.set(peer.id, peer.inputPeer);
    const last = d.lastMessage;
    if (last) this.remember(last);
    return {
      chatId: peer.id,
      title: peerTitle(peer),
      kind: peerKind(peer),
      unread: d.unreadCount || (d.isManuallyUnread ? 1 : 0),
      muted: d.isMuted === true,
      pinned: d.isPinned,
      readOutboxMaxId: d.lastReadOutgoing,
      last: last ? this.toMessage(last) : null,
      canSend: peerCanSend(peer),
    };
  }

  /**
   * 统一包装每一次请求：
   * - 超时就取消（取消后这次请求不会在网络恢复时又被悄悄补发，避免重复发消息）；
   * - 把各种错误翻译成能直接给人看的说明；
   * - 发现登录失效时通知上层。
   * timeoutMs 传 0 表示一直等（用于启动时的自动重连）。
   */
  private async wrap<T>(
    fn: (tg: TelegramClient, signal: AbortSignal) => Promise<T>,
    timeoutMs = REQUEST_TIMEOUT_MS,
    external?: AbortSignal,
  ): Promise<T> {
    const ctl = new AbortController();
    const onExternal = () => ctl.abort();
    if (external?.aborted) ctl.abort();
    external?.addEventListener('abort', onExternal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          ctl.abort();
          reject(new AppError('network', '连接官方服务器超时，请检查网络或代理后再试。'));
        }, timeoutMs);
      }
    });
    try {
      return await Promise.race([fn(this.tg.withParams({ abortSignal: ctl.signal }), ctl.signal), timeout]);
    } catch (e) {
      const err = external?.aborted
        ? new AppError('cancelled', '操作已取消。')
        : ctl.signal.aborted
          ? new AppError('network', '连接官方服务器超时，请检查网络或代理后再试。')
          : translateError(e);
      if (err.code === 'revoked') this.events?.onStatus('revoked', err.message);
      throw err;
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternal);
    }
  }

  // —— 登录 ——

  sendCode(phone: string): Promise<SentCodeInfo> {
    return this.wrap(async (tg) => {
      const cleaned = phone.replace(/[^\d+]/g, '');
      if (!/^\+?\d{7,15}$/.test(cleaned)) {
        throw new AppError('bad_phone', '手机号格式不对，请带国家区号填写，例如 +8613800000000。');
      }
      const res = await tg.sendCode({ phone: cleaned });
      if (!('phoneCodeHash' in res)) {
        // 服务器直接认可了登录（极少见）
        this.pendingPhone = null;
        this.pendingCodeHash = null;
        return { via: 'other', length: null };
      }
      this.pendingPhone = cleaned;
      this.pendingCodeHash = res.phoneCodeHash;
      const via = res.type === 'app' ? 'app' : res.type === 'sms' || res.type === 'sms_word' || res.type === 'sms_phrase' ? 'sms' : 'other';
      return { via, length: res.length > 0 ? res.length : null };
    });
  }

  submitCode(code: string): Promise<'done' | 'password'> {
    return this.wrap(async (tg) => {
      if (!this.pendingPhone || !this.pendingCodeHash) {
        throw new AppError('invalid', '请先获取验证码。');
      }
      try {
        await tg.signIn({
          phone: this.pendingPhone,
          phoneCodeHash: this.pendingCodeHash,
          phoneCode: code.replace(/\D/g, ''),
        });
        return 'done';
      } catch (e) {
        if (tl.RpcError.is(e, 'SESSION_PASSWORD_NEEDED')) return 'password';
        throw e;
      }
    });
  }

  passwordHint(): Promise<string | null> {
    return this.wrap((tg) => tg.getPasswordHint());
  }

  submitPassword(password: string): Promise<void> {
    return this.wrap(async (tg) => {
      await tg.checkPassword(password);
    });
  }

  async qrLogin(handlers: QrLoginHandlers, signal: AbortSignal): Promise<void> {
    // 二维码要一直挂着等人扫，所以整体不设超时；
    // 但如果迟迟连第一张二维码都拿不到，说明连不上服务器，就不要让人干等。
    const inner = new AbortController();
    const forward = () => inner.abort();
    signal.addEventListener('abort', forward);
    let gotUrl = false;
    let timedOut = false;
    const firstUrlTimer = setTimeout(() => {
      if (gotUrl) return;
      timedOut = true;
      inner.abort();
    }, REQUEST_TIMEOUT_MS);
    let wrong = false;
    try {
      await this.wrap(
        async (tg, abortSignal) => {
          await tg.signInQr({
            onUrlUpdated: (url, expires) => {
              gotUrl = true;
              handlers.onUrl(url, expires.getTime());
            },
            onQrScanned: () => handlers.onScanned(),
            password: async () => {
              const hint = await tg.getPasswordHint().catch(() => null);
              return handlers.askPassword(hint, wrong);
            },
            invalidPasswordCallback: () => {
              wrong = true;
            },
            abortSignal,
          });
        },
        0,
        inner.signal,
      );
    } catch (e) {
      if (timedOut && !signal.aborted) {
        throw new AppError('network', '连接官方服务器超时，请检查网络或代理后再试。');
      }
      throw e;
    } finally {
      clearTimeout(firstUrlTimer);
      signal.removeEventListener('abort', forward);
    }
  }

  exportSession(): Promise<string> {
    return this.wrap((tg) => tg.exportSession());
  }

  // —— 日常 ——

  resume(session: string): Promise<SelfInfo> {
    return this.wrap(async (tg) => {
      await tg.importSession(session, true);
      return this.identify(tg);
    }, 0);
  }

  whoAmI(): Promise<SelfInfo> {
    return this.wrap((tg) => this.identify(tg));
  }

  private async identify(tg: TelegramClient): Promise<SelfInfo> {
    const me = await tg.getMe();
    // 通知底层「已登录」，它会自己开始接收实时消息（重复通知无害）
    await tg.notifyLoggedIn(me.raw);
    return {
      userId: me.id,
      name: me.displayName,
      username: me.username,
      phone: me.phoneNumber ? `+${me.phoneNumber}` : null,
    };
  }

  listDialogs(limit: number): Promise<DialogInfo[]> {
    return this.wrap(async (tg) => {
      const out: DialogInfo[] = [];
      for await (const d of tg.iterDialogs({ limit, archived: 'exclude' })) {
        out.push(this.toDialog(d));
      }
      return out;
    });
  }

  getHistory(chatId: number, before: { id: number; date: number } | null, limit: number): Promise<MessageInfo[]> {
    return this.wrap(async (tg) => {
      const list = await tg.getHistory(this.peer(chatId), {
        limit,
        offset: before ? { id: before.id, date: Math.floor(before.date / 1000) } : undefined,
      });
      for (const m of list) this.remember(m);
      return list.map((m) => this.toMessage(m));
    });
  }

  sendText(chatId: number, text: string, opts?: SendOptions): Promise<MessageInfo> {
    return this.wrap(async (tg) => {
      const msg = await tg.sendText(this.peer(chatId), text, { replyTo: opts?.replyToId });
      this.remember(msg);
      return this.toMessage(msg);
    });
  }

  sendFile(chatId: number, file: OutgoingFile, caption: string, opts?: SendOptions): Promise<MessageInfo> {
    return this.wrap(async (tg) => {
      const media = file.asPhoto
        ? InputMedia.photo(file.data, { caption, fileName: file.name, fileMime: file.type || undefined })
        : InputMedia.document(file.data, { caption, fileName: file.name, fileMime: file.type || undefined });
      const msg = await tg.sendMedia(this.peer(chatId), media, { replyTo: opts?.replyToId });
      this.remember(msg);
      return this.toMessage(msg);
    }, TRANSFER_TIMEOUT_MS);
  }

  editText(chatId: number, messageId: number, text: string): Promise<MessageInfo> {
    return this.wrap(async (tg) => {
      const msg = await tg.editMessage({ chatId: this.peer(chatId), message: messageId, text });
      this.remember(msg);
      return this.toMessage(msg);
    });
  }

  deleteMessages(chatId: number, ids: number[]): Promise<void> {
    return this.wrap((tg) => tg.deleteMessagesById(this.peer(chatId), ids, { revoke: true }));
  }

  markRead(chatId: number): Promise<void> {
    return this.wrap(async (tg) => {
      await tg.readHistory(this.peer(chatId), { clearMentions: true });
    });
  }

  loadPhoto(chatId: number, messageId: number, size: 'thumb' | 'full'): Promise<Uint8Array | null> {
    return this.wrap(async (tg) => {
      const photo = this.photos.get(`${chatId}:${messageId}`);
      if (!photo) return null;
      if (size === 'thumb') {
        const thumb = photo.getThumbnail(Thumbnail.THUMB_320x320_BOX) ?? photo.getThumbnail(Thumbnail.THUMB_800x800_BOX);
        if (thumb) return tg.downloadAsBuffer(thumb);
      }
      return tg.downloadAsBuffer(photo);
    }, TRANSFER_TIMEOUT_MS);
  }

  logOut(): Promise<void> {
    return this.wrap(async (tg) => {
      await tg.logOut();
    });
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.events = null;
    this.peers.clear();
    this.photos.clear();
    try {
      await this.tg.destroy();
    } catch {
      /* 已经断开就不用管了 */
    }
  }
}
