import type { JSX } from 'preact';
import { memo } from 'preact/compat';
import type { InboxDialog } from '../core/hub.ts';
import { AccountChip, Avatar, Icon, listTime } from './util.tsx';

function preview(d: InboxDialog): string {
  const m = d.last;
  if (!m) return '';
  const body = m.text || m.media || '';
  if (m.out) return `我：${body}`;
  if (m.sender) return `${m.sender}：${body}`;
  return body;
}

export interface DialogRowProps {
  d: InboxDialog;
  accountLabel: string | null;
  accountColor: string | null;
  active: boolean;
  /** 这个会话正开在独立窗口里 */
  popped: boolean;
  onOpen: (key: string) => void;
  /** 双击：在独立窗口打开 */
  onPopout?: (key: string) => void;
}

/**
 * 会话列表里的一行。内容没变就不重画：
 * 几十个账号、上千个会话时，来一条消息只重画变了的那一行。
 */
export const DialogRow = memo(function DialogRow(props: DialogRowProps): JSX.Element {
  const { d } = props;
  return (
    <li>
      <button
        class={`dialog${props.active ? ' active' : ''}${d.unread > 0 ? ' unread' : ''}`}
        onClick={() => props.onOpen(d.key)}
        onDblClick={() => props.onPopout?.(d.key)}
        title={props.onPopout ? '单击打开，双击在独立窗口打开' : undefined}
        style={{ '--acct': props.accountColor ?? 'transparent' }}
      >
        <Avatar title={d.title} badgeColor={props.accountColor ?? undefined} />
        <span class="dialog-main">
          <span class="dialog-top">
            <span class="dialog-title">{d.title}</span>
            {props.popped ? <span class="muted-mark" title="已在独立窗口打开"><Icon name="popout" size={14} /></span> : null}
            {d.muted ? <span class="muted-mark"><Icon name="mute" size={14} /></span> : null}
            <time>{d.last ? listTime(d.last.date) : ''}</time>
          </span>
          <span class="dialog-bottom">
            {props.accountLabel && props.accountColor ? <AccountChip label={props.accountLabel} color={props.accountColor} small /> : null}
            <span class="dialog-preview">{preview(d)}</span>
            {d.unread > 0 ? <span class={`badge${d.muted ? ' quiet' : ''}`}>{d.unread > 99 ? '99+' : d.unread}</span> : null}
          </span>
        </span>
      </button>
    </li>
  );
});
