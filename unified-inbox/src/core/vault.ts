/**
 * 加密保险库。
 *
 * 所有账号的登录凭据、接口参数、快捷回复和设置都放在这里，
 * 用主密码派生出的密钥整体加密后才写入本机存储。
 *
 * - 密钥派生：PBKDF2-HMAC-SHA256，60 万次迭代，每个保险库独立的随机盐。
 * - 加密：AES-256-GCM，每次保存都换新的随机 IV，文件头作为附加认证数据。
 * - 密钥对象不可导出：即使页面里的脚本拿到密钥对象，也读不出密钥本身。
 * - 主密码本身从不保存；忘记主密码就无法恢复，只能清空后重新登录各账号。
 */
import { AppError, type ApiCredentials } from './types.ts';

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface StoredAccount {
  /** 本软件内部编号 */
  id: string;
  /** 用户起的备注名，例如「客户号」「供应商号」 */
  label: string;
  /** 标签颜色 */
  color: string;
  phone: string;
  userId: number;
  name: string;
  username: string | null;
  /** 登录凭据 */
  session: string;
  /** 这份登录是什么时候建立的（毫秒时间戳）；用于「新登录保护期」 */
  loginAt?: number;
  /** 重要账号：开启额外保护（不参与批量回复、发送限速更严） */
  important?: boolean;
}

export interface QuickReply {
  id: string;
  title: string;
  text: string;
}

export interface Settings {
  /** 无操作多少分钟后自动上锁；0 表示不自动上锁 */
  autoLockMinutes: number;
  /** 新消息桌面通知 */
  notify: boolean;
  /** 通知里是否显示消息内容（关掉更隐私） */
  notifyPreview: boolean;
  /** 点一下快捷回复就直接发出（关掉则只填进输入框） */
  quickSendDirect: boolean;
}

export interface VaultData {
  api: ApiCredentials | null;
  accounts: StoredAccount[];
  quickReplies: QuickReply[];
  settings: Settings;
}

export const DEFAULT_SETTINGS: Settings = {
  autoLockMinutes: 10,
  // 默认关：打开时才向浏览器申请通知权限
  notify: false,
  notifyPreview: false,
  quickSendDirect: true,
};

export function emptyVaultData(): VaultData {
  return {
    api: null,
    accounts: [],
    quickReplies: [
      { id: 'qr-1', title: '收到', text: '收到，马上处理。' },
      { id: 'qr-2', title: '稍等', text: '您好，请稍等，我确认一下马上回复您。' },
    ],
    settings: { ...DEFAULT_SETTINGS },
  };
}

const VAULT_KEY = 'vault';
const THROTTLE_KEY = 'unlock-throttle';
const FORMAT_VERSION = 1;
const AAD_PREFIX = 'unified-inbox-vault';
export const KDF_ITERATIONS = 600_000;
export const MIN_PASSWORD_LENGTH = 8;

interface VaultFile {
  v: number;
  kdf: 'PBKDF2-SHA256';
  iter: number;
  salt: string;
  iv: string;
  ct: string;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

function aad(iter: number): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${AAD_PREFIX}|v${FORMAT_VERSION}|PBKDF2-SHA256|${iter}`);
}

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, iter: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password.normalize('NFKC')),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter },
    material,
    { name: 'AES-GCM', length: 256 },
    false, // 不可导出
    ['encrypt', 'decrypt'],
  );
}

/** 主密码强度检查；返回 null 表示可以用，否则返回原因 */
export function checkPasswordStrength(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `主密码至少 ${MIN_PASSWORD_LENGTH} 位。`;
  if (/^(.)\1+$/.test(password)) return '主密码不能是同一个字符重复。';
  if (/^\d+$/.test(password) && password.length < 12) return '纯数字密码太容易被猜到，请加入字母，或至少 12 位。';
  const weak = ['12345678', '123456789', 'password', 'qwertyui', '11111111', '88888888', 'abcd1234', 'a1234567'];
  if (weak.includes(password.toLowerCase())) return '这个密码太常见，请换一个。';
  return null;
}

function validateData(raw: unknown): VaultData {
  if (!raw || typeof raw !== 'object') throw new AppError('invalid', '保险库内容格式不对。');
  const d = raw as Partial<VaultData>;
  const base = emptyVaultData();
  return {
    api: d.api && typeof d.api.id === 'number' && typeof d.api.hash === 'string' ? d.api : null,
    accounts: Array.isArray(d.accounts) ? d.accounts : [],
    quickReplies: Array.isArray(d.quickReplies) ? d.quickReplies : base.quickReplies,
    settings: { ...base.settings, ...(d.settings ?? {}) },
  };
}

/** 连续输错主密码后的等待时间（秒） */
export function throttleDelaySeconds(failures: number): number {
  if (failures < 3) return 0;
  return Math.min(300, 5 * 2 ** (failures - 3));
}

interface ThrottleState {
  failures: number;
  until: number;
}

export class Vault {
  private key: CryptoKey;
  private salt: Uint8Array<ArrayBuffer>;
  private iter: number;
  private store: KeyValueStore;
  private saving: Promise<void> = Promise.resolve();
  data: VaultData;

  private constructor(store: KeyValueStore, key: CryptoKey, salt: Uint8Array<ArrayBuffer>, iter: number, data: VaultData) {
    this.store = store;
    this.key = key;
    this.salt = salt;
    this.iter = iter;
    this.data = data;
  }

  static exists(store: KeyValueStore): boolean {
    return store.get(VAULT_KEY) !== null;
  }

  /** 首次使用：用主密码新建保险库 */
  static async create(store: KeyValueStore, password: string, iter = KDF_ITERATIONS): Promise<Vault> {
    const problem = checkPasswordStrength(password);
    if (problem) throw new AppError('invalid', problem);
    if (Vault.exists(store)) throw new AppError('invalid', '这台设备上已经有保险库了。');
    const salt = randomBytes(16);
    const key = await deriveKey(password, salt, iter);
    const vault = new Vault(store, key, salt, iter, emptyVaultData());
    await vault.save();
    return vault;
  }

  /** 距离可以再次尝试解锁还要等多少秒 */
  static lockedForSeconds(store: KeyValueStore, now = Date.now()): number {
    const t = Vault.readThrottle(store);
    return t.until > now ? Math.ceil((t.until - now) / 1000) : 0;
  }

  private static readThrottle(store: KeyValueStore): ThrottleState {
    try {
      const raw = store.get(THROTTLE_KEY);
      if (raw) {
        const t = JSON.parse(raw) as ThrottleState;
        if (typeof t.failures === 'number' && typeof t.until === 'number') return t;
      }
    } catch {
      /* 损坏就当没有 */
    }
    return { failures: 0, until: 0 };
  }

  static async unlock(store: KeyValueStore, password: string, now = Date.now()): Promise<Vault> {
    const wait = Vault.lockedForSeconds(store, now);
    if (wait > 0) throw new AppError('flood', `输错次数过多，请 ${wait} 秒后再试。`, wait);
    const raw = store.get(VAULT_KEY);
    if (raw === null) throw new AppError('invalid', '这台设备上还没有保险库。');
    let file: VaultFile;
    try {
      file = JSON.parse(raw) as VaultFile;
    } catch {
      throw new AppError('invalid', '保险库文件已损坏。');
    }
    if (file.v !== FORMAT_VERSION || file.kdf !== 'PBKDF2-SHA256' || typeof file.iter !== 'number') {
      throw new AppError('invalid', '保险库版本不受支持。');
    }
    const salt = fromBase64(file.salt);
    const key = await deriveKey(password, salt, file.iter);
    let plain: ArrayBuffer;
    try {
      plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(file.iv), additionalData: aad(file.iter) },
        key,
        fromBase64(file.ct),
      );
    } catch {
      const t = Vault.readThrottle(store);
      const failures = t.failures + 1;
      const delay = throttleDelaySeconds(failures);
      store.set(THROTTLE_KEY, JSON.stringify({ failures, until: now + delay * 1000 }));
      throw new AppError(
        'bad_password',
        delay > 0 ? `主密码不正确。请 ${delay} 秒后再试。` : '主密码不正确。',
        delay || null,
      );
    }
    store.remove(THROTTLE_KEY);
    const data = validateData(JSON.parse(new TextDecoder().decode(plain)));
    return new Vault(store, key, salt, file.iter, data);
  }

  /** 加密并写入本机存储。多次调用按顺序执行，不会互相覆盖。 */
  save(): Promise<void> {
    const run = async () => {
      const iv = randomBytes(12);
      const plain = new TextEncoder().encode(JSON.stringify(this.data));
      const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: aad(this.iter) },
        this.key,
        plain,
      );
      const file: VaultFile = {
        v: FORMAT_VERSION,
        kdf: 'PBKDF2-SHA256',
        iter: this.iter,
        salt: toBase64(this.salt),
        iv: toBase64(iv),
        ct: toBase64(new Uint8Array(ct)),
      };
      this.store.set(VAULT_KEY, JSON.stringify(file));
    };
    this.saving = this.saving.then(run, run);
    return this.saving;
  }

  /** 修改主密码：必须先验证旧密码 */
  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    const problem = checkPasswordStrength(newPassword);
    if (problem) throw new AppError('invalid', problem);
    await this.saving;
    // 用旧密码真正解一次密，确认操作的人知道旧密码
    await Vault.unlock(this.store, oldPassword);
    const salt = randomBytes(16);
    this.key = await deriveKey(newPassword, salt, KDF_ITERATIONS);
    this.salt = salt;
    this.iter = KDF_ITERATIONS;
    await this.save();
  }

  /** 彻底删除本机保险库（不可恢复） */
  static wipe(store: KeyValueStore): void {
    store.remove(VAULT_KEY);
    store.remove(THROTTLE_KEY);
  }
}

/** 内存存储：测试和演示用，关掉页面就没了 */
export class MemoryStore implements KeyValueStore {
  private map = new Map<string, string>();
  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.map.set(key, value);
  }
  remove(key: string): void {
    this.map.delete(key);
  }
}

/** 浏览器本机存储，带前缀隔离 */
export class LocalStore implements KeyValueStore {
  private prefix: string;
  constructor(prefix: string) {
    this.prefix = prefix;
  }
  get(key: string): string | null {
    return localStorage.getItem(this.prefix + key);
  }
  set(key: string, value: string): void {
    localStorage.setItem(this.prefix + key, value);
  }
  remove(key: string): void {
    localStorage.removeItem(this.prefix + key);
  }
}
