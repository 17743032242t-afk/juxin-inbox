/** 头像、附件（文件 / 语音 / 视频 / 贴纸）和贴纸面板的显示。 */
import type { JSX, RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Hub } from '../core/hub.ts';
import { errorText, type AttachmentInfo, type LoadedFile, type StickerInfo, type StickerSetInfo } from '../core/types.ts';
import { Icon, avatarColor, initial, withPhotoSlot } from './util.tsx';

// —— 小工具 ——

/** 只允许当作图片 / 音频 / 视频来显示的类型；其余一律按「二进制文件」处理，绝不在页面里打开 */
function safeMediaType(mime: string, family: 'image' | 'audio' | 'video'): string {
  const m = mime.toLowerCase();
  const ok = family === 'image' ? /^image\/(png|jpeg|webp|gif)$/ : family === 'audio' ? /^audio\/[a-z0-9.+-]+$/ : /^video\/[a-z0-9.+-]+$/;
  return ok.test(m) ? m : family === 'image' ? 'image/webp' : family === 'audio' ? 'audio/ogg' : 'video/mp4';
}

function blobUrl(file: LoadedFile, type: string): string {
  return URL.createObjectURL(new Blob([file.data as Uint8Array<ArrayBuffer>], { type }));
}

export function formatSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '';
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * 把文件保存到用户的电脑或手机上。
 * 一律当作「二进制下载」交给浏览器保存，不在软件里打开——
 * 这样即使对方发来的是一个网页或脚本文件，也不会在本软件的环境里运行。
 */
function saveToDisk(anchor: HTMLElement, file: LoadedFile): void {
  const doc = anchor.ownerDocument;
  const url = URL.createObjectURL(new Blob([file.data as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }));
  const a = doc.createElement('a');
  a.href = url;
  a.download = file.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || '文件';
  a.rel = 'noopener';
  doc.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** 元素滚到看得见的地方才算「需要」：列表很长时，只为看得见的那几行去取头像和贴纸图 */
function useSeen<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const view = el.ownerDocument.defaultView;
    if (!view || !('IntersectionObserver' in view)) return setSeen(true);
    const io = new view.IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

// —— 头像 ——

const avatarUrls = new Map<string, string>();

/** 上锁时调用：释放所有已经加载的头像图片 */
export function releaseAvatars(): void {
  for (const url of avatarUrls.values()) URL.revokeObjectURL(url);
  avatarUrls.clear();
}

export function ChatAvatar(props: { hub: Hub; chatKey: string; title: string; hasAvatar: boolean; size?: number; badgeColor?: string }): JSX.Element {
  const size = props.size ?? 46;
  const [ref, seen] = useSeen<HTMLSpanElement>();
  const [url, setUrl] = useState<string | null>(() => avatarUrls.get(props.chatKey) ?? null);

  useEffect(() => {
    if (!props.hasAvatar) return setUrl(null);
    const cached = avatarUrls.get(props.chatKey);
    if (cached) return setUrl(cached);
    if (!seen) return;
    let alive = true;
    withPhotoSlot(() => props.hub.loadAvatar(props.chatKey))
      .then((bytes) => {
        if (!bytes) return;
        let made = avatarUrls.get(props.chatKey);
        if (!made) {
          made = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }));
          avatarUrls.set(props.chatKey, made);
        }
        if (alive) setUrl(made);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [props.hub, props.chatKey, props.hasAvatar, seen]);

  return (
    <span ref={ref} class="avatar" style={{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.42)}px`, background: avatarColor(props.title) }}>
      {url ? <img class="avatar-img" src={url} alt="" /> : initial(props.title)}
      {props.badgeColor ? <span class="avatar-dot" style={{ background: props.badgeColor }} /> : null}
    </span>
  );
}

// —— 附件 ——

interface AttachmentProps {
  hub: Hub;
  chatKey: string;
  messageId: number;
  info: AttachmentInfo;
}

function useLoader(props: AttachmentProps): { file: LoadedFile | null; busy: boolean; percent: number | null; error: string | null; load: () => Promise<LoadedFile | null> } {
  const [file, setFile] = useState<LoadedFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async (): Promise<LoadedFile | null> => {
    if (file) return file;
    if (busy) return null;
    setBusy(true);
    setError(null);
    setPercent(0);
    try {
      const got = await props.hub.loadAttachment(props.chatKey, props.messageId, (done, total) => setPercent(total > 0 ? Math.round((done / total) * 100) : null));
      if (!got) throw new Error('这个文件已经取不到了，请重新打开这个会话后再试。');
      setFile(got);
      return got;
    } catch (e) {
      setError(errorText(e));
      return null;
    } finally {
      setBusy(false);
      setPercent(null);
    }
  };
  return { file, busy, percent, error, load };
}

function FileCard(props: AttachmentProps): JSX.Element {
  const { busy, percent, error, load } = useLoader(props);
  const [saved, setSaved] = useState(false);
  const save = async (e: MouseEvent) => {
    e.stopPropagation();
    const anchor = e.currentTarget as HTMLElement;
    const got = await load();
    if (!got) return;
    saveToDisk(anchor, got);
    setSaved(true);
  };
  return (
    <div class="file-card">
      <span class="file-icon">
        <Icon name="file" size={22} />
      </span>
      <span class="file-meta">
        <b>{props.info.name}</b>
        <small>{error ?? (busy ? `正在下载…${percent !== null ? ` ${percent}%` : ''}` : saved ? '已保存到「下载」文件夹' : formatSize(props.info.size))}</small>
      </span>
      <button type="button" class="btn small" onClick={save} disabled={busy} aria-label={`下载 ${props.info.name}`}>
        <Icon name="download" size={15} /> {saved ? '再存一次' : '下载'}
      </button>
    </div>
  );
}

function Playable(props: AttachmentProps): JSX.Element {
  const { info } = props;
  const { file, busy, percent, error, load } = useLoader(props);
  const [url, setUrl] = useState<string | null>(null);
  const isVideo = info.kind === 'video' || info.kind === 'gif';

  useEffect(() => {
    if (!file) return;
    const made = blobUrl(file, safeMediaType(file.mime, isVideo ? 'video' : 'audio'));
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [file]);

  if (url) {
    return isVideo ? (
      <video class="video" src={url} controls autoplay loop={info.kind === 'gif'} muted={info.kind === 'gif'} playsInline onClick={(e) => e.stopPropagation()} />
    ) : (
      <audio class="audio" src={url} controls autoplay onClick={(e) => e.stopPropagation()} />
    );
  }
  const label = info.kind === 'voice' ? '语音' : info.kind === 'audio' ? info.name : info.kind === 'gif' ? '动图' : '视频';
  return (
    <div class="playable">
      <button
        type="button"
        class="play-btn"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          void load();
        }}
        aria-label={`播放${label}`}
      >
        <Icon name="play" size={18} />
      </button>
      <span class="file-meta">
        <b>{label}</b>
        <small>{error ?? (busy ? `正在加载…${percent !== null ? ` ${percent}%` : ''}` : [formatDuration(info.duration), formatSize(info.size)].filter(Boolean).join(' · '))}</small>
      </span>
    </div>
  );
}

function StickerView(props: AttachmentProps): JSX.Element {
  const format = props.info.sticker?.format ?? 'static';
  const [src, setSrc] = useState<{ url: string; video: boolean } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    // 静态贴纸和视频贴纸用本体；动画贴纸（矢量动画）用它的静态预览图
    const job = format === 'animated' ? props.hub.loadAttachmentPreview(props.chatKey, props.messageId) : props.hub.loadAttachment(props.chatKey, props.messageId);
    withPhotoSlot(() => job)
      .then((file) => {
        if (!alive) return;
        if (!file) return setFailed(true);
        const video = format === 'video';
        made = blobUrl(file, safeMediaType(file.mime, video ? 'video' : 'image'));
        setSrc({ url: made, video });
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [props.chatKey, props.messageId]);

  if (failed) return <span class="sticker-fallback">{props.info.sticker?.emoji || '贴纸'}</span>;
  if (!src) return <span class="sticker sticker-loading" />;
  return src.video ? (
    <video class="sticker" src={src.url} autoplay loop muted playsInline />
  ) : (
    <img class="sticker" src={src.url} alt={`贴纸 ${props.info.sticker?.emoji ?? ''}`} />
  );
}

export function AttachmentView(props: AttachmentProps): JSX.Element {
  switch (props.info.kind) {
    case 'sticker':
      return <StickerView {...props} />;
    case 'file':
      return <FileCard {...props} />;
    default:
      return <Playable {...props} />;
  }
}

// —— 贴纸面板 ——

function StickerThumb(props: { hub: Hub; accountId: string; sticker: StickerInfo; disabled: boolean; onPick: (id: string) => void }): JSX.Element {
  const [ref, seen] = useSeen<HTMLButtonElement>();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!seen) return;
    let alive = true;
    let made: string | null = null;
    withPhotoSlot(() => props.hub.loadStickerImage(props.accountId, props.sticker.id))
      .then((file) => {
        if (!alive || !file) return;
        made = blobUrl(file, safeMediaType(file.mime, 'image'));
        setUrl(made);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [seen, props.sticker.id]);
  return (
    <button ref={ref} type="button" class="sticker-thumb" disabled={props.disabled} onClick={() => props.onPick(props.sticker.id)} aria-label={`发送贴纸 ${props.sticker.emoji}`} title="点一下直接发送">
      {url ? <img src={url} alt="" /> : <span>{props.sticker.emoji}</span>}
    </button>
  );
}

export function StickerPanel(props: { hub: Hub; accountId: string; disabled: boolean; onPick: (id: string) => void }): JSX.Element {
  const [sets, setSets] = useState<StickerSetInfo[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [stickers, setStickers] = useState<StickerInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setSets(null);
    setError(null);
    props.hub
      .listStickerSets(props.accountId)
      .then((list) => {
        if (!alive) return;
        setSets(list);
        setCurrent(list[0]?.id ?? null);
      })
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [props.hub, props.accountId]);

  useEffect(() => {
    if (!current) return setStickers(null);
    let alive = true;
    setStickers(null);
    props.hub
      .listStickers(props.accountId, current)
      .then((list) => alive && setStickers(list))
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [current]);

  if (error) return <p class="error">{error}</p>;
  if (!sets) return <p class="hint">正在读取这个账号的贴纸包…</p>;
  if (sets.length === 0) return <p class="hint">这个账号还没有添加贴纸包。请先在官方客户端里添加，这里就能用了。</p>;
  return (
    <div class="sticker-panel">
      <div class="quick-row">
        {sets.map((s) => (
          <button key={s.id} type="button" class={`quick${s.id === current ? '' : ' ghost'}`} onClick={() => setCurrent(s.id)}>
            {s.title}
          </button>
        ))}
      </div>
      <div class="sticker-grid">
        {stickers === null ? <p class="hint">正在加载…</p> : stickers.map((s) => <StickerThumb key={s.id} hub={props.hub} accountId={props.accountId} sticker={s} disabled={props.disabled} onPick={props.onPick} />)}
      </div>
    </div>
  );
}
