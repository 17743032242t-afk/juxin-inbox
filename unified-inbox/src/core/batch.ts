/**
 * 批量回复：把同一段话依次回给多个「有未读消息」的会话。
 *
 * 为了账号安全，故意做了这些限制：
 * - 只能回复给对方先发来消息、且还没读的会话，不能用来群发拉人；
 * - 静音的会话、频道、机器人不在名单里；群聊在名单里但默认不勾选；
 * - 重要账号、刚登录不满 24 小时的账号不参与；
 * - 一条一条发，每条之间随机停顿，避免触发官方的防骚扰限制；
 * - 一旦某个账号被官方限流，立刻停止这个账号后面的发送；
 * - 单次有数量上限。
 */
import { AppError, errorText } from './types.ts';
import type { Hub, InboxDialog } from './hub.ts';

export const MAX_BATCH = 30;
export const BATCH_DELAY_MIN_MS = 3000;
export const BATCH_DELAY_MAX_MS = 5500;

export type BatchItemState = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';

export interface BatchItem {
  key: string;
  title: string;
  accountId: string;
  state: BatchItemState;
  error: string | null;
}

export interface BatchOptions {
  signal?: AbortSignal;
  onProgress?: (items: BatchItem[]) => void;
  /** 两条之间等待多久（毫秒）；测试时可以传 0 */
  delay?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** 可以批量回复的会话：有未读、能发言、没被静音、不是频道/机器人/自己，且所属账号没有处于保护中 */
export function batchCandidates(hub: Hub, accountId: string | null = null): InboxDialog[] {
  const blocked = new Map<string, boolean>();
  const isBlocked = (id: string): boolean => {
    let b = blocked.get(id);
    if (b === undefined) {
      b = hub.batchBlock(id) !== null;
      blocked.set(id, b);
    }
    return b;
  };
  return hub.dialogs().filter(
    (d) =>
      d.unread > 0 &&
      d.canSend &&
      !d.muted &&
      (d.kind === 'user' || d.kind === 'group') &&
      (accountId === null || d.accountId === accountId) &&
      !isBlocked(d.accountId),
  );
}

/** 因为保护而没有列入批量回复名单的账号及原因（给界面显示用） */
export function batchExclusions(hub: Hub, accountId: string | null = null): { label: string; reason: string }[] {
  const out: { label: string; reason: string }[] = [];
  for (const a of hub.accounts()) {
    if (accountId !== null && a.id !== accountId) continue;
    const reason = hub.batchBlock(a.id);
    if (reason && a.unreadChats > 0) out.push({ label: a.label, reason });
  }
  return out;
}

function defaultDelay(): number {
  return BATCH_DELAY_MIN_MS + Math.random() * (BATCH_DELAY_MAX_MS - BATCH_DELAY_MIN_MS);
}

export async function runBatch(hub: Hub, keys: string[], text: string, opts: BatchOptions = {}): Promise<BatchItem[]> {
  const trimmed = text.trim();
  if (!trimmed) throw new AppError('invalid', '请先填写要回复的内容。');
  const unique = [...new Set(keys)];
  if (unique.length === 0) throw new AppError('invalid', '请至少选择一个会话。');
  if (unique.length > MAX_BATCH) {
    throw new AppError('invalid', `一次最多批量回复 ${MAX_BATCH} 个会话，请分批处理。`);
  }
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delay = opts.delay ?? defaultDelay;

  const allowed = new Set(batchCandidates(hub).map((d) => d.key));
  const items: BatchItem[] = unique.map((key) => {
    const d = hub.dialog(key);
    const ok = allowed.has(key);
    return {
      key,
      title: d?.title ?? '（会话已不存在）',
      accountId: d?.accountId ?? '',
      state: ok ? 'pending' : 'skipped',
      error: ok ? null : (d && hub.batchBlock(d.accountId)) ?? '这个会话没有未读消息或不能发言，已跳过。',
    };
  });
  const report = () => opts.onProgress?.(items.map((i) => ({ ...i })));
  report();

  /** 被限流的账号：后面的都不再发 */
  const blocked = new Map<string, string>();
  let sentAny = false;
  for (const item of items) {
    if (item.state !== 'pending') continue;
    if (opts.signal?.aborted) {
      item.state = 'skipped';
      item.error = '已手动停止。';
      continue;
    }
    const blockReason = blocked.get(item.accountId);
    if (blockReason) {
      item.state = 'skipped';
      item.error = blockReason;
      continue;
    }
    if (sentAny) await sleep(delay());
    if (opts.signal?.aborted) {
      item.state = 'skipped';
      item.error = '已手动停止。';
      continue;
    }
    item.state = 'sending';
    report();
    try {
      await hub.send(item.key, trimmed);
      item.state = 'sent';
      sentAny = true;
    } catch (e) {
      item.state = 'failed';
      item.error = errorText(e);
      if (e instanceof AppError && (e.code === 'flood' || e.code === 'revoked')) {
        blocked.set(item.accountId, e.code === 'flood' ? '这个账号已被官方限流，为保护账号已停止后续发送。' : '这个账号的登录已失效，已停止后续发送。');
      }
    }
    report();
  }
  report();
  return items;
}
