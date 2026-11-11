/** 会话类型 */
export type ChatKind = 'user' | 'bot' | 'group' | 'channel' | 'self';

/** 账号在线状态 */
export type AccountStatus =
  | 'connecting'
  | 'online'
  | 'offline'
  /** 登录已失效（在别处被踢下线或被收回），需要重新登录 */
  | 'revoked'
  | 'error';

export interface SelfInfo {
  userId: number;
  name: string;
  username: string | null;
  phone: string | null;
}

export interface MessageInfo {
  id: number;
  chatId: number;
  /** 毫秒时间戳 */
  date: number;
  /** 是否是我方发出的 */
  out: boolean;
  text: string;
  /** 非文字内容的说明，例如「[图片]」 */
  media: string | null;
  /** 是否有可以显示的图片 */
  hasPhoto: boolean;
  /** 群里的发言人名字（私聊为空） */
  sender: string | null;
  /** 系统消息（入群、置顶等） */
  service: boolean;
  /** 引用的那条消息；quote 是对方只引用了其中一段时的那段文字 */
  replyTo: { id: number; quote: string } | null;
  edited: boolean;
}

export interface DialogInfo {
  chatId: number;
  title: string;
  kind: ChatKind;
  unread: number;
  muted: boolean;
  pinned: boolean;
  /** 对方已读到我方哪一条 */
  readOutboxMaxId: number;
  last: MessageInfo | null;
  /** 我方是否可以在此发言（频道通常不行） */
  canSend: boolean;
}

export interface SentCodeInfo {
  /** 验证码发送方式：app = 发到已登录的官方客户端；sms = 短信；other = 其他 */
  via: 'app' | 'sms' | 'other';
  length: number | null;
}

export interface BackendEvents {
  onMessage(msg: MessageInfo, chat: { title: string; kind: ChatKind; canSend: boolean }): void;
  onEdit(msg: MessageInfo): void;
  onDelete(chatId: number | null, ids: number[]): void;
  /** inbox：我方在别的设备上读了消息；outbox：对方读了我方消息 */
  onRead(chatId: number, kind: 'inbox' | 'outbox', maxId: number, unread: number | null): void;
  onStatus(status: AccountStatus, detail?: string): void;
}

/** 扫码登录过程中，连接层回调给界面的事件 */
export interface QrLoginHandlers {
  /** 有新的二维码内容要显示（官方规定大约每 30 秒换一次） */
  onUrl(url: string, expiresAt: number): void;
  /** 手机那边已经扫了，正在确认 */
  onScanned(): void;
  /** 这个账号开了两步验证，需要密码；wrong 表示上一次输错了 */
  askPassword(hint: string | null, wrong: boolean): Promise<string>;
}

export interface SendOptions {
  replyToId?: number;
}

export interface OutgoingFile {
  name: string;
  type: string;
  data: Uint8Array;
  /** 作为图片发送（否则作为文件） */
  asPhoto: boolean;
}

/**
 * 单个账号的连接。真实实现连官方服务器，测试和演示用模拟实现。
 * 所有抛出的错误都应是 AppError，带可直接展示的中文说明。
 */
export interface AccountBackend {
  setEvents(events: BackendEvents): void;

  // —— 登录流程 ——
  sendCode(phone: string): Promise<SentCodeInfo>;
  /** 返回 'password' 表示这个账号开了两步验证，还要输入密码 */
  submitCode(code: string): Promise<'done' | 'password'>;
  passwordHint(): Promise<string | null>;
  submitPassword(password: string): Promise<void>;
  /**
   * 扫码登录：显示二维码，等用户用手机上已登录的官方客户端扫描确认。
   * 成功后返回；signal 被取消时抛出 cancelled。
   */
  qrLogin(handlers: QrLoginHandlers, signal: AbortSignal): Promise<void>;
  /** 导出登录凭据（极敏感，只能放进加密保险库） */
  exportSession(): Promise<string>;

  // —— 日常使用 ——
  /** 用保存的凭据恢复登录并开始接收消息 */
  resume(session: string): Promise<SelfInfo>;
  /** 新登录完成后调用，开始接收消息 */
  whoAmI(): Promise<SelfInfo>;
  listDialogs(limit: number): Promise<DialogInfo[]>;
  getHistory(chatId: number, before: { id: number; date: number } | null, limit: number): Promise<MessageInfo[]>;
  sendText(chatId: number, text: string, opts?: SendOptions): Promise<MessageInfo>;
  sendFile(chatId: number, file: OutgoingFile, caption: string, opts?: SendOptions): Promise<MessageInfo>;
  editText(chatId: number, messageId: number, text: string): Promise<MessageInfo>;
  deleteMessages(chatId: number, ids: number[]): Promise<void>;
  markRead(chatId: number): Promise<void>;
  /** 取图片内容；没有图片返回 null */
  loadPhoto(chatId: number, messageId: number, size: 'thumb' | 'full'): Promise<Uint8Array | null>;

  /** 退出登录：让这份凭据在服务器上作废 */
  logOut(): Promise<void>;
  /** 断开连接并释放资源（凭据仍然有效） */
  destroy(): Promise<void>;
}

export interface ApiCredentials {
  id: number;
  hash: string;
}

export type BackendFactory = (api: ApiCredentials) => AccountBackend;

export type ErrorCode =
  | 'flood'
  | 'bad_phone'
  | 'bad_code'
  | 'code_expired'
  | 'bad_password'
  | 'revoked'
  | 'network'
  | 'forbidden'
  | 'bad_api'
  | 'cancelled'
  | 'invalid'
  | 'unknown';

export class AppError extends Error {
  readonly code: ErrorCode;
  /** flood 限流时，需要等待的秒数 */
  readonly seconds: number | null;
  constructor(code: ErrorCode, message: string, seconds: number | null = null) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.seconds = seconds;
  }
}

export function errorText(e: unknown): string {
  if (e instanceof AppError) return e.message;
  if (e instanceof Error) return `操作没有完成：${e.message}`;
  return '操作没有完成，请稍后再试。';
}
