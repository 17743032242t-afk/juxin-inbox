/** 建群、群管理（改名、加人、邀请链接、退群） */
import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { AccountView, Hub } from '../core/hub.ts';
import { MAX_GROUP_ADD, errorText } from '../core/types.ts';
import { ChatAvatar } from './media.tsx';
import { AccountChip, ErrorNote, Icon, Modal, useHub } from './util.tsx';

/** 从某个账号已有的私聊里选人 */
function MemberPicker(props: { hub: Hub; accountId: string; picked: Set<string>; onChange: (next: Set<string>) => void }): JSX.Element {
  const [search, setSearch] = useState('');
  const needle = search.trim().toLowerCase();
  const people = props.hub
    .dialogs()
    .filter((d) => d.accountId === props.accountId && d.kind === 'user' && (!needle || d.title.toLowerCase().includes(needle)))
    .slice(0, 200);
  const toggle = (key: string) => {
    const next = new Set(props.picked);
    if (next.has(key)) next.delete(key);
    else if (next.size < MAX_GROUP_ADD) next.add(key);
    props.onChange(next);
  };
  return (
    <div>
      <div class="row between">
        <span class="field-label">
          选择成员（已选 {props.picked.size} / 最多 {MAX_GROUP_ADD}）
        </span>
      </div>
      <div class="search">
        <Icon name="search" size={18} />
        <input type="search" value={search} onInput={(e) => setSearch(e.currentTarget.value)} placeholder="搜索联系人" aria-label="搜索联系人" />
      </div>
      <ul class="pick-list">
        {people.map((d) => (
          <li key={d.key}>
            <label class="check pick-row">
              <input type="checkbox" checked={props.picked.has(d.key)} disabled={!props.picked.has(d.key) && props.picked.size >= MAX_GROUP_ADD} onChange={() => toggle(d.key)} />
              <ChatAvatar hub={props.hub} chatKey={d.key} title={d.title} hasAvatar={d.hasAvatar} size={32} />
              <b>{d.title}</b>
            </label>
          </li>
        ))}
        {people.length === 0 ? <li class="hint">这个账号里没有可以选的联系人。只能选已经有过私聊的人。</li> : null}
      </ul>
    </div>
  );
}

const RISK_NOTE = '建群和拉人是官方重点防范的行为。请只拉认识你、愿意进群的人；一次最多 10 个，不要短时间内反复建群或拉人。';

export function NewGroupModal(props: { hub: Hub; accounts: AccountView[]; defaultAccountId: string | null; onClose: () => void; onCreated: (key: string, notAdded: number) => void }): JSX.Element {
  useHub(props.hub);
  const usable = props.accounts.filter((a) => a.status === 'online');
  const [accountId, setAccountId] = useState(props.defaultAccountId ?? usable[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const account = props.accounts.find((a) => a.id === accountId);

  const create = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { key, notAdded } = await props.hub.createGroup(accountId, title, [...picked]);
      props.onCreated(key, notAdded);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="新建群" onClose={props.onClose} wide locked={busy}>
      <form onSubmit={create}>
        {usable.length === 0 ? <p class="hint">没有在线的账号。</p> : null}
        <label>
          用哪个账号建群
          <select
            value={accountId}
            onChange={(e) => {
              setAccountId(e.currentTarget.value);
              setPicked(new Set());
            }}
          >
            {usable.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}（{a.name}）
              </option>
            ))}
          </select>
        </label>
        {account ? (
          <p class="hint">
            群主将是 <AccountChip label={account.label} color={account.color} small />，只能拉这个账号的联系人。
          </p>
        ) : null}
        <label>
          群名
          <input value={title} onInput={(e) => setTitle(e.currentTarget.value)} maxLength={64} placeholder="例如：华东客户群" autofocus />
        </label>
        {accountId ? <MemberPicker hub={props.hub} accountId={accountId} picked={picked} onChange={setPicked} /> : null}
        <p class="hint warn">{RISK_NOTE}</p>
        <ErrorNote text={error} />
        <div class="row end">
          <button class="btn" type="button" onClick={props.onClose} disabled={busy}>
            取消
          </button>
          <button class="btn primary" type="submit" disabled={busy || !title.trim() || picked.size === 0}>
            {busy ? '正在建群…' : `建群（${picked.size} 人）`}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function GroupModal(props: { hub: Hub; chatKey: string; onClose: () => void }): JSX.Element | null {
  const { hub, chatKey } = props;
  useHub(hub);
  const dialog = hub.dialog(chatKey);
  const account = dialog ? hub.account(dialog.accountId) : null;
  const [section, setSection] = useState<'main' | 'add' | 'leave'>('main');
  const [members, setMembers] = useState<number | null>(null);
  const [title, setTitle] = useState(dialog?.title ?? '');
  const [link, setLink] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    hub
      .groupInfo(chatKey)
      .then((info) => alive && setMembers(info.members))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [hub, chatKey]);

  // 退群后这个会话就不存在了
  useEffect(() => {
    if (!dialog) props.onClose();
  }, [!dialog]);
  if (!dialog || !account) return null;

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="群管理" onClose={props.onClose} wide locked={busy}>
      <p>
        <b>{dialog.title}</b>
        {members !== null ? ` · ${members} 人` : ''} · 通过 <AccountChip label={account.label} color={account.color} small /> {dialog.canManage ? '管理' : '参与'}
      </p>
      {note ? <p class="banner">{note}</p> : null}
      <ErrorNote text={error} />

      {section === 'main' ? (
        <div class="settings">
          {dialog.canManage ? (
            <form
              class="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await hub.renameGroup(chatKey, title);
                  setNote('群名已修改。');
                });
              }}
            >
              <input value={title} onInput={(e) => setTitle(e.currentTarget.value)} maxLength={64} aria-label="群名" />
              <button class="btn small primary" type="submit" disabled={busy || !title.trim() || title.trim() === dialog.title}>
                改群名
              </button>
            </form>
          ) : null}
          <button class="setting as-button" onClick={() => { setSection('add'); setError(null); setNote(null); }}>
            <span>
              <b>加人进群</b>
              <small>从这个账号的联系人里选，一次最多 {MAX_GROUP_ADD} 个。</small>
            </span>
            <Icon name="group-add" />
          </button>
          {dialog.canManage ? (
            <div class="setting">
              <span>
                <b>邀请链接</b>
                <small>{link ? <code class="link-text">{link}</code> : '把链接发给对方，对方点开即可进群。'}</small>
              </span>
              {link ? (
                <button
                  class="btn small"
                  onClick={() =>
                    void navigator.clipboard
                      ?.writeText(link)
                      .then(() => setNote('邀请链接已复制。'))
                      .catch(() => setNote('没能自动复制，请手动选中链接复制。'))
                  }
                >
                  <Icon name="copy" size={15} /> 复制
                </button>
              ) : (
                <button class="btn small" disabled={busy} onClick={() => void run(async () => setLink(await hub.inviteLink(chatKey)))}>
                  查看
                </button>
              )}
            </div>
          ) : null}
          <button class="setting as-button danger-text" onClick={() => { setSection('leave'); setError(null); }}>
            <span>
              <b>退出这个群</b>
              <small>退出后这个群会从列表里消失。</small>
            </span>
            <Icon name="trash" />
          </button>
        </div>
      ) : null}

      {section === 'add' ? (
        <div>
          <MemberPicker hub={hub} accountId={dialog.accountId} picked={picked} onChange={setPicked} />
          <p class="hint warn">{RISK_NOTE}</p>
          <div class="row end">
            <button class="btn" onClick={() => setSection('main')} disabled={busy}>
              返回
            </button>
            <button
              class="btn primary"
              disabled={busy || picked.size === 0}
              onClick={() =>
                void run(async () => {
                  const n = picked.size;
                  const { notAdded } = await hub.addMembers(chatKey, [...picked]);
                  setPicked(new Set());
                  setSection('main');
                  setMembers((m) => (m === null ? m : m + n - notAdded));
                  setNote(notAdded > 0 ? `已拉 ${n - notAdded} 人进群；有 ${notAdded} 人因为对方的隐私设置没能拉进来。` : `已拉 ${n} 人进群。`);
                })
              }
            >
              {busy ? '正在加人…' : `加入 ${picked.size} 人`}
            </button>
          </div>
        </div>
      ) : null}

      {section === 'leave' ? (
        <div class="danger-box">
          <p>确定退出「{dialog.title}」吗？{dialog.canManage ? '你是这个群的管理者，退出后可能无法再回来管理。' : ''}</p>
          <div class="row end">
            <button class="btn" onClick={() => setSection('main')} disabled={busy}>
              取消
            </button>
            <button class="btn danger" disabled={busy} onClick={() => void run(() => hub.leaveGroup(chatKey))}>
              {busy ? '正在退出…' : '确认退出'}
            </button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
