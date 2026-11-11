import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Hub } from '../core/hub.ts';

/** 订阅汇总中心：数据一变就重新渲染 */
export function useHub(hub: Hub): number {
  const [version, setVersion] = useState(hub.version);
  useEffect(() => {
    const off = hub.subscribe(() => setVersion(hub.version));
    // 从第一次渲染到订阅成功之间可能已经有变化（账号连得很快时），这里补一次，避免界面停在旧状态
    setVersion(hub.version);
    return off;
  }, [hub]);
  return version;
}

/**
 * 只订阅一个会话：这个会话（或账号级的东西）变了才重新渲染。
 * 开着几十个独立窗口时，每个窗口只为自己的会话干活，互不拖累。
 */
export function useChat(hub: Hub, key: string): void {
  const [, setTick] = useState(0);
  // 用同步的副作用订阅，避免「渲染完到订阅上」之间漏掉变化
  useLayoutEffect(() => {
    const off = hub.subscribeKey(key, () => setTick((n) => n + 1));
    setTick((n) => n + 1);
    return off;
  }, [hub, key]);
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function dayStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function clockTime(t: number): string {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 会话列表里的时间：今天显示几点，昨天、本周、更早依次变粗略 */
export function listTime(t: number, now = Date.now()): string {
  const days = Math.round((dayStart(now) - dayStart(t)) / 86_400_000);
  if (days <= 0) return clockTime(t);
  if (days === 1) return '昨天';
  if (days < 7) return WEEKDAYS[new Date(t).getDay()]!;
  const d = new Date(t);
  if (d.getFullYear() === new Date(now).getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 聊天窗口里的日期分隔 */
export function dayLabel(t: number, now = Date.now()): string {
  const days = Math.round((dayStart(now) - dayStart(t)) / 86_400_000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  const d = new Date(t);
  const base = `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`;
  return d.getFullYear() === new Date(now).getFullYear() ? base : `${d.getFullYear()}年${base}`;
}

export function sameDay(a: number, b: number): boolean {
  return dayStart(a) === dayStart(b);
}

const AVATAR_COLORS = ['#e17076', '#eda86c', '#a695e7', '#7bc862', '#6ec9cb', '#65aadd', '#ee7aae'];

export function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]!;
}

export function initial(title: string): string {
  const ch = [...title.trim()][0];
  return ch ? ch.toUpperCase() : '?';
}

export function Avatar(props: { title: string; size?: number; badgeColor?: string }): JSX.Element {
  const size = props.size ?? 46;
  return (
    <span class="avatar" style={{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.42)}px`, background: avatarColor(props.title) }}>
      {initial(props.title)}
      {props.badgeColor ? <span class="avatar-dot" style={{ background: props.badgeColor }} /> : null}
    </span>
  );
}

/** 账号标签：整个软件里「这是哪个账号」都用它来标 */
export function AccountChip(props: { label: string; color: string; small?: boolean }): JSX.Element {
  return (
    <span class={`chip${props.small ? ' chip-small' : ''}`} style={{ background: props.color }}>
      {props.label}
    </span>
  );
}

type IconName =
  | 'lock'
  | 'plus'
  | 'settings'
  | 'send'
  | 'attach'
  | 'back'
  | 'search'
  | 'bolt'
  | 'inbox'
  | 'close'
  | 'reply'
  | 'edit'
  | 'trash'
  | 'copy'
  | 'refresh'
  | 'check'
  | 'checks'
  | 'batch'
  | 'shield'
  | 'users'
  | 'mute'
  | 'popout'
  | 'smile';

const PATHS: Record<IconName, string> = {
  lock: 'M7 10V7a5 5 0 0 1 10 0v3M6 10h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z',
  plus: 'M12 5v14M5 12h14',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.4-2.3 1a7.6 7.6 0 0 0-2.6-1.5L14 2.5h-4l-.5 2.6a7.6 7.6 0 0 0-2.6 1.5l-2.3-1-2 3.4 2 1.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.4 2.3-1a7.6 7.6 0 0 0 2.6 1.5l.5 2.6h4l.5-2.6a7.6 7.6 0 0 0 2.6-1.5l2.3 1 2-3.4z',
  send: 'M4 12l16-8-6 16-2.5-6.5z M11.5 13.5L20 4',
  attach: 'M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.8 17a1.7 1.7 0 0 1-2.4-2.4L15 7',
  back: 'M15 5l-7 7 7 7',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6z',
  inbox: 'M4 13l2.5-8h11L20 13M4 13v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5M4 13h5a3 3 0 0 0 6 0h5',
  close: 'M6 6l12 12M18 6L6 18',
  reply: 'M10 8L5 12l5 4M5 12h9a5 5 0 0 1 5 5v1',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  refresh: 'M20 11a8 8 0 1 0-2.3 6.3M20 5v6h-6',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  checks: 'M2 12.5l4.5 4.5L15 8M10 15l2 2 9.5-9.5',
  batch: 'M4 6h16M4 12h10M4 18h7M17 14l3 3-3 3M14 17h6',
  shield: 'M12 3l7 3v6c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6zM9 12l2 2 4-4',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.2a3.5 3.5 0 0 1 0 6.6M18 14.5a6.5 6.5 0 0 1 3.5 5.5',
  mute: 'M4 9v6h4l5 4V5L8 9zM17 9l4 6M21 9l-4 6',
  popout: 'M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  smile: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.5 14a4.5 4.5 0 0 0 7 0M9 9.5v1M15 9.5v1',
};

export function Icon(props: { name: IconName; size?: number }): JSX.Element {
  const size = props.size ?? 20;
  return (
    <svg class="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={PATHS[props.name]} />
    </svg>
  );
}

export function Modal(props: { title: string; onClose: () => void; children: ComponentChildren; wide?: boolean; locked?: boolean }): JSX.Element {
  const overlay = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // 弹窗可能显示在独立窗口里，所以要监听它所在的那个窗口，而不是固定监听主窗口
    const doc = overlay.current?.ownerDocument ?? document;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !props.locked) props.onClose();
    };
    doc.addEventListener('keydown', onKey);
    return () => doc.removeEventListener('keydown', onKey);
  }, [props.onClose, props.locked]);
  return (
    <div class="overlay" ref={overlay} onMouseDown={(e) => { if (e.target === e.currentTarget && !props.locked) props.onClose(); }}>
      <div class={`modal${props.wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={props.title}>
        <header class="modal-head">
          <h2>{props.title}</h2>
          {props.locked ? null : (
            <button class="icon-btn" onClick={props.onClose} aria-label="关闭">
              <Icon name="close" />
            </button>
          )}
        </header>
        <div class="modal-body">{props.children}</div>
      </div>
    </div>
  );
}

export function ErrorNote(props: { text: string | null }): JSX.Element | null {
  return props.text ? <p class="error" role="alert">{props.text}</p> : null;
}

/** 同时最多几张图片在下载，避免一下子发太多请求 */
let photoSlots = 3;
const photoWaiters: (() => void)[] = [];
export async function withPhotoSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (photoSlots <= 0) await new Promise<void>((r) => photoWaiters.push(r));
  else photoSlots--;
  try {
    return await fn();
  } finally {
    const next = photoWaiters.shift();
    if (next) next();
    else photoSlots++;
  }
}
