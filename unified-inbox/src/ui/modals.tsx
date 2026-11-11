import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { BATCH_DELAY_MAX_MS, MAX_BATCH, batchCandidates, batchExclusions, runBatch, type BatchItem } from '../core/batch.ts';
import { ACCOUNT_COLORS, LOGINS_PER_DAY_ADVICE, type AccountView, type Hub, type LoginFlow } from '../core/hub.ts';
import { qrMatrix, qrPath } from '../core/qr.ts';
import { AppError, errorText, type SentCodeInfo } from '../core/types.ts';
import type { QuickReply, Vault } from '../core/vault.ts';
import { ApiSetup } from './screens.tsx';
import { AccountChip, ErrorNote, Icon, Modal } from './util.tsx';

function ColorPicker(props: { value: string; onChange: (c: string) => void }): JSX.Element {
  return (
    <div class="colors" role="radiogroup" aria-label="标签颜色">
      {ACCOUNT_COLORS.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={c === props.value} class={`color${c === props.value ? ' on' : ''}`} style={{ background: c }} onClick={() => props.onChange(c)} aria-label={`颜色 ${c}`} />
      ))}
    </div>
  );
}

const STATUS_TEXT: Record<AccountView['status'], string> = {
  online: '在线',
  connecting: '连接中…',
  offline: '离线，等待重连',
  revoked: '登录已失效',
  error: '连接出错',
};

/** 二维码：固定白底黑码，深色模式下也一样，保证手机能扫出来 */
function QrCode(props: { text: string }): JSX.Element {
  const matrix = useMemo(() => qrMatrix(props.text), [props.text]);
  const size = matrix.length;
  return (
    <svg class="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="登录二维码" shape-rendering="crispEdges">
      <rect width={size} height={size} fill="#ffffff" />
      <path d={qrPath(matrix)} fill="#000000" />
    </svg>
  );
}

type AddStep = 'method' | 'qr' | 'phone' | 'code' | 'password' | 'label';

/** 添加账号：扫码（推荐）或 手机号 + 验证码 →（两步验证密码）→ 起备注名 */
export function AddAccountModal(props: { hub: Hub; usedColors: string[]; relogin?: AccountView; onClose: () => void }): JSX.Element {
  const flow = useRef<LoginFlow | null>(null);
  const [step, setStep] = useState<AddStep>('method');
  const [phone, setPhone] = useState(props.relogin?.phone ?? '+86');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const [sent, setSent] = useState<SentCodeInfo | null>(null);
  const [label, setLabel] = useState(props.relogin?.label ?? '');
  const [color, setColor] = useState(props.relogin?.color ?? ACCOUNT_COLORS.find((c) => !props.usedColors.includes(c)) ?? ACCOUNT_COLORS[0]!);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [important, setImportant] = useState(props.relogin?.important ?? false);
  const [acceptRisk, setAcceptRisk] = useState(false);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [scanned, setScanned] = useState(false);
  /** 扫码登录遇到两步验证时，等界面把密码交回去 */
  const answerPassword = useRef<((pw: string) => void) | null>(null);
  // 打开弹窗时算一次，避免输入过程中提示跳来跳去
  const pacing = useMemo(() => props.hub.loginPacing(), []);
  const tooFast = !props.relogin && (pacing.waitMinutes > 0 || pacing.last24h >= LOGINS_PER_DAY_ADVICE);
  const blocked = tooFast && !acceptRisk;

  useEffect(
    () => () => {
      void flow.current?.cancel();
    },
    [],
  );

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const startQr = async () => {
    await flow.current?.cancel();
    const f = props.hub.beginLogin();
    flow.current = f;
    answerPassword.current = null;
    setStep('qr');
    setQrUrl(null);
    setScanned(false);
    setError(null);
    setBusy(false);
    const mine = () => flow.current === f;
    try {
      await f.startQr({
        onUrl: (url) => {
          if (!mine()) return;
          setQrUrl(url);
          setScanned(false);
        },
        onScanned: () => {
          if (mine()) setScanned(true);
        },
        askPassword: (pwHint, wrong) =>
          new Promise<string>((resolve) => {
            if (!mine()) return;
            answerPassword.current = resolve;
            setHint(pwHint);
            setPassword('');
            setError(wrong ? '两步验证密码不正确，请重新输入。' : null);
            setBusy(false);
            setStep('password');
          }),
      });
      if (!mine()) return;
      setBusy(false);
      setError(null);
      setStep('label');
    } catch (e) {
      if (!mine() || (e instanceof AppError && e.code === 'cancelled')) return;
      setBusy(false);
      setQrUrl(null);
      setError(errorText(e));
      setStep('qr');
    }
  };

  const usePhone = async () => {
    const old = flow.current;
    flow.current = null;
    answerPassword.current = null;
    setError(null);
    setBusy(false);
    setStep('phone');
    await old?.cancel();
  };

  const sendCode = () =>
    run(async () => {
      await flow.current?.cancel();
      flow.current = props.hub.beginLogin();
      setSent(await flow.current.sendCode(phone));
      setCode('');
      setStep('code');
    });

  const submitCode = () =>
    run(async () => {
      const r = await flow.current!.submitCode(code);
      if (r === 'password') {
        setHint(await flow.current!.passwordHint());
        setStep('password');
      } else {
        setStep('label');
      }
    });

  const submitPassword = () => {
    const answer = answerPassword.current;
    if (answer) {
      // 扫码登录：把密码交回给等待中的登录流程，结果由 startQr 里处理
      answerPassword.current = null;
      setBusy(true);
      setError(null);
      answer(password);
      return;
    }
    void run(async () => {
      await flow.current!.submitPassword(password);
      setPassword('');
      setStep('label');
    });
  };

  const finish = () =>
    run(async () => {
      await flow.current!.finish(label, color, important);
      props.onClose();
    });

  const title = props.relogin ? `重新登录「${props.relogin.label}」` : '添加账号';
  const verifying = step === 'qr' || step === 'phone' || step === 'code' || step === 'password';
  return (
    <Modal title={title} onClose={props.onClose} locked={busy}>
      <ol class="progress">
        <li class={step === 'method' ? 'on' : 'done'}>登录方式</li>
        <li class={verifying ? 'on' : step === 'label' ? 'done' : ''}>验证</li>
        <li class={step === 'label' ? 'on' : ''}>备注名</li>
      </ol>

      {step === 'method' ? (
        <div>
          <details class="tips" open={!props.relogin}>
            <summary>登录前请确认（关系到账号会不会被官方判为「环境异常」）</summary>
            <ul>
              <li>用这个账号<b>平时常用的网络</b>登录；不要用和平时不同国家的线路，登录过程中不要切换线路。</li>
              <li>这个账号在手机官方客户端上<b>保持登录</b>，不要因为这里登上了就把那边退掉。</li>
              <li>账号要<b>隔开登录</b>：两个之间至少隔 10 分钟，一天最多 {LOGINS_PER_DAY_ADVICE} 个。</li>
              <li>登录后 24 小时内像平常一样用就行，不要改资料、不要大量加人或群发。</li>
            </ul>
          </details>
          {tooFast ? (
            <div class="danger-box">
              <p>
                {pacing.waitMinutes > 0
                  ? `上一个账号刚登录不久，建议再等 ${pacing.waitMinutes} 分钟。`
                  : `最近 24 小时已经登录了 ${pacing.last24h} 个账号，建议明天再加。`}
                短时间内连续登录多个账号，是被官方判定「登录环境异常」最常见的原因。
              </p>
              <label class="check">
                <input type="checkbox" checked={acceptRisk} onChange={(e) => setAcceptRisk(e.currentTarget.checked)} />
                <span>我了解风险，这个账号不重要，仍然现在登录。</span>
              </label>
            </div>
          ) : null}
          <div class="methods">
            <button class="method primary" type="button" disabled={blocked} onClick={() => void startQr()}>
              <b>扫码登录（推荐）</b>
              <small>用手机上已登录这个账号的官方客户端扫一下，不用输手机号和验证码。</small>
            </button>
            <button class="method" type="button" disabled={blocked} onClick={() => void usePhone()}>
              <b>用手机号和验证码登录</b>
              <small>身边没有第二台设备可以扫码时用这个（比如正在手机上用本软件）。</small>
            </button>
          </div>
          <div class="row end">
            <button class="btn" type="button" onClick={props.onClose}>取消</button>
          </div>
        </div>
      ) : null}

      {step === 'qr' ? (
        <div class="qr-step">
          <div class="qr-box">
            {qrUrl ? <QrCode text={qrUrl} /> : <div class="qr-wait">{error ? '二维码没有生成' : '正在生成二维码…'}</div>}
            {scanned ? <div class="qr-scanned" role="status">已扫码，正在确认…</div> : null}
          </div>
          <ol class="steps">
            <li>打开手机上<b>已登录这个账号</b>的官方客户端。</li>
            <li>进入 <b>设置 → 设备 → 关联桌面设备</b>。</li>
            <li>扫描上面的二维码，并在手机上确认。</li>
          </ol>
          <p class="hint">二维码大约每 30 秒会自动换一张，这是官方的安全规定，直接扫当前显示的即可。</p>
          <ErrorNote text={error} />
          <div class="row end">
            <button class="btn" type="button" onClick={() => void usePhone()}>改用手机号登录</button>
            {error ? (
              <button class="btn primary" type="button" onClick={() => void startQr()}>重新生成二维码</button>
            ) : null}
          </div>
        </div>
      ) : null}

      {step === 'phone' ? (
        <form onSubmit={(e) => { e.preventDefault(); void sendCode(); }}>
          <label>
            这个账号的手机号（带国家区号）
            <input type="tel" value={phone} onInput={(e) => setPhone(e.currentTarget.value)} placeholder="+8613800000000" autofocus autocomplete="off" />
          </label>
          <p class="hint">官方会把验证码发到这个账号已登录的官方客户端里（或短信）。验证码只在这里输入，不要告诉任何人。</p>
          <ErrorNote text={error} />
          <div class="row end">
            <button class="btn" type="button" onClick={() => void startQr()} disabled={busy}>改用扫码登录</button>
            <button class="btn primary" type="submit" disabled={busy}>{busy ? '正在请求…' : '获取验证码'}</button>
          </div>
        </form>
      ) : null}

      {step === 'code' ? (
        <form onSubmit={(e) => { e.preventDefault(); void submitCode(); }}>
          <p>
            验证码已发到 <b>{phone}</b>
            {sent?.via === 'app' ? ' 的官方客户端里（在「服务通知」那个会话）。' : sent?.via === 'sms' ? ' 的手机短信。' : '。'}
          </p>
          <label>
            验证码
            <input inputMode="numeric" value={code} onInput={(e) => setCode(e.currentTarget.value)} maxLength={8} autofocus autocomplete="one-time-code" />
          </label>
          <ErrorNote text={error} />
          <div class="row end">
            <button class="btn" type="button" onClick={() => setStep('phone')} disabled={busy}>换手机号</button>
            <button class="btn primary" type="submit" disabled={busy || code.trim().length < 4}>{busy ? '正在验证…' : '下一步'}</button>
          </div>
        </form>
      ) : null}

      {step === 'password' ? (
        <form onSubmit={(e) => { e.preventDefault(); submitPassword(); }}>
          <p>这个账号开启了两步验证，还需要输入你为它设置的密码。</p>
          <label>
            两步验证密码{hint ? `（提示：${hint}）` : ''}
            <input type="password" value={password} onInput={(e) => setPassword(e.currentTarget.value)} autofocus autocomplete="off" />
          </label>
          <p class="hint">密码只用于这一次登录，不会保存。</p>
          <ErrorNote text={error} />
          <div class="row end">
            <button class="btn primary" type="submit" disabled={busy || !password}>{busy ? '正在验证…' : '下一步'}</button>
          </div>
        </form>
      ) : null}

      {step === 'label' ? (
        <form onSubmit={(e) => { e.preventDefault(); void finish(); }}>
          <p>登录成功。给这个账号起个一眼能认出的备注名，所有来自它的消息都会带上这个标签。</p>
          <label>
            备注名
            <input value={label} onInput={(e) => setLabel(e.currentTarget.value)} placeholder="例如：客户号、供应商号、售后号" maxLength={12} autofocus />
          </label>
          <span class="field-label">标签颜色</span>
          <ColorPicker value={color} onChange={setColor} />
          <p>
            效果预览：<AccountChip label={label.trim() || '备注名'} color={color} />
          </p>
          <label class="check">
            <input type="checkbox" checked={important} onChange={(e) => setImportant(e.currentTarget.checked)} />
            <span>
              <b>这是重要账号</b>，开启保护：不参与批量回复，每分钟最多发 10 条。
            </span>
          </label>
          <p class="hint">所有新登录的账号在头 24 小时内都不参与批量回复，逐条回复不受影响。</p>
          <ErrorNote text={error} />
          <div class="row end">
            <button class="btn primary" type="submit" disabled={busy}>{busy ? '正在保存…' : '完成'}</button>
          </div>
        </form>
      ) : null}
    </Modal>
  );
}

/** 账号管理：改备注、重连、重新登录、移除 */
export function AccountsModal(props: { hub: Hub; onClose: () => void; onAdd: () => void; onRelogin: (a: AccountView) => void }): JSX.Element {
  const accounts = props.hub.accounts();
  const [editing, setEditing] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [color, setColor] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const remove = async (a: AccountView) => {
    setBusy(true);
    const r = await props.hub.removeAccount(a.id);
    setBusy(false);
    setRemoving(null);
    setNote(
      r.loggedOut
        ? `已移除「${a.label}」，并已在官方服务器上退出登录。`
        : `已从本机移除「${a.label}」。未能通知官方服务器退出登录，请到官方客户端的「设置 → 设备」里确认这台设备已下线。`,
    );
  };

  return (
    <Modal title="账号管理" onClose={props.onClose} wide locked={busy}>
      {note ? <p class="banner">{note}</p> : null}
      {accounts.length === 0 ? <p class="hint">还没有添加账号。</p> : null}
      <ul class="account-list">
        {accounts.map((a) => (
          <li key={a.id}>
            <div class="account-row">
              <AccountChip label={a.label} color={a.color} />
              <div class="account-info">
                <strong>{a.name}</strong>
                <span>
                  {a.phone}
                  {a.username ? ` · @${a.username}` : ''}
                </span>
                <span class={`status status-${a.status}`}>
                  {STATUS_TEXT[a.status]}
                  {a.statusDetail && a.status !== 'online' ? ` — ${a.statusDetail}` : ''}
                </span>
                {a.important || a.protectedUntil ? (
                  <span class="guards">
                    {a.important ? <span class="guard-tag"><Icon name="shield" size={13} /> 重要账号保护中</span> : null}
                    {a.protectedUntil ? <span class="guard-tag">新登录保护期，还剩约 {Math.ceil((a.protectedUntil - Date.now()) / 3_600_000)} 小时</span> : null}
                  </span>
                ) : null}
              </div>
              <div class="account-actions">
                {a.status === 'revoked' ? (
                  <button class="btn small primary" onClick={() => props.onRelogin(a)}>重新登录</button>
                ) : a.status !== 'online' ? (
                  <button class="btn small" onClick={() => void props.hub.connect(a.id)}>重连</button>
                ) : null}
                <button class="btn small" onClick={() => void props.hub.updateAccount(a.id, { important: !a.important })}>{a.important ? '取消重要' : '设为重要'}</button>
                <button class="btn small" onClick={() => { setEditing(editing === a.id ? null : a.id); setLabel(a.label); setColor(a.color); }}>改备注</button>
                <button class="btn small danger-outline" onClick={() => setRemoving(a.id)}>移除</button>
              </div>
            </div>
            {editing === a.id ? (
              <form class="inline-form" onSubmit={(e) => { e.preventDefault(); void props.hub.updateAccount(a.id, { label, color }).then(() => setEditing(null)); }}>
                <input value={label} onInput={(e) => setLabel(e.currentTarget.value)} maxLength={12} aria-label="备注名" />
                <ColorPicker value={color} onChange={setColor} />
                <button class="btn small primary" type="submit" disabled={!label.trim()}>保存</button>
              </form>
            ) : null}
            {removing === a.id ? (
              <div class="danger-box">
                <p>
                  移除「{a.label}」？软件会在官方服务器上退出这个账号在本软件里的登录，并删除本机保存的凭据。账号本身、聊天记录和你在其他设备上的登录都不受影响。
                </p>
                <div class="row end">
                  <button class="btn" onClick={() => setRemoving(null)} disabled={busy}>取消</button>
                  <button class="btn danger" onClick={() => void remove(a)} disabled={busy}>{busy ? '正在移除…' : '确认移除'}</button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <div class="row end">
        <button class="btn primary" onClick={props.onAdd}>
          <Icon name="plus" size={16} /> 添加账号
        </button>
      </div>
    </Modal>
  );
}

/** 快捷回复管理 */
export function QuickRepliesModal(props: { vault: Vault; onChanged: () => void; onClose: () => void }): JSX.Element {
  const [items, setItems] = useState<QuickReply[]>(() => props.vault.data.quickReplies.map((q) => ({ ...q })));
  const [error, setError] = useState<string | null>(null);

  const update = (id: string, patch: Partial<QuickReply>) => setItems((list) => list.map((q) => (q.id === id ? { ...q, ...patch } : q)));

  const save = async () => {
    const cleaned = items.map((q) => ({ ...q, title: q.title.trim(), text: q.text.trim() })).filter((q) => q.text);
    for (const q of cleaned) if (!q.title) q.title = q.text.slice(0, 6);
    props.vault.data.quickReplies = cleaned;
    try {
      await props.vault.save();
      props.onChanged();
      props.onClose();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <Modal title="快捷回复" onClose={props.onClose} wide>
      <p class="hint">把常用的话存在这里，聊天时点一下就能发出去。批量回复时也可以直接选用。</p>
      <ul class="quick-edit">
        {items.map((q) => (
          <li key={q.id}>
            <input value={q.title} onInput={(e) => update(q.id, { title: e.currentTarget.value })} placeholder="按钮名称" maxLength={8} aria-label="按钮名称" />
            <textarea value={q.text} onInput={(e) => update(q.id, { text: e.currentTarget.value })} placeholder="要发送的内容" rows={2} aria-label="要发送的内容" />
            <button class="icon-btn" onClick={() => setItems((list) => list.filter((x) => x.id !== q.id))} aria-label="删除这条快捷回复">
              <Icon name="trash" size={18} />
            </button>
          </li>
        ))}
      </ul>
      <button class="btn" onClick={() => setItems((list) => [...list, { id: `qr-${Date.now()}-${list.length}`, title: '', text: '' }])}>
        <Icon name="plus" size={16} /> 新增一条
      </button>
      <ErrorNote text={error} />
      <div class="row end">
        <button class="btn" onClick={props.onClose}>取消</button>
        <button class="btn primary" onClick={() => void save()}>保存</button>
      </div>
    </Modal>
  );
}

const BATCH_STATE_TEXT: Record<BatchItem['state'], string> = {
  pending: '等待中',
  sending: '发送中…',
  sent: '已发送',
  failed: '失败',
  skipped: '已跳过',
};

/** 批量回复未读会话 */
export function BatchModal(props: { hub: Hub; accountId: string | null; quickReplies: QuickReply[]; onClose: () => void }): JSX.Element {
  const { hub } = props;
  // 打开时就把名单定下来，发送过程中新来的消息不会悄悄加进名单
  const candidates = useMemo(() => batchCandidates(hub, props.accountId), []);
  const excluded = useMemo(() => batchExclusions(hub, props.accountId), []);
  const accounts = useMemo(() => new Map(hub.accounts().map((a) => [a.id, a])), []);
  // 默认只勾私聊；群聊列在名单里但要自己勾，避免不小心往群里发
  const [picked, setPicked] = useState<Set<string>>(() => new Set(candidates.filter((d) => d.kind === 'user').slice(0, MAX_BATCH).map((d) => d.key)));
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<'edit' | 'confirm' | 'running' | 'done'>('edit');
  const [items, setItems] = useState<BatchItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const toggle = (key: string) =>
    setPicked((old) => {
      const next = new Set(old);
      if (next.has(key)) next.delete(key);
      else if (next.size < MAX_BATCH) next.add(key);
      return next;
    });

  const start = async () => {
    setPhase('running');
    setError(null);
    abort.current = new AbortController();
    try {
      const result = await runBatch(hub, [...picked], text, { signal: abort.current.signal, onProgress: setItems });
      setItems(result);
    } catch (e) {
      setError(errorText(e));
    }
    setPhase('done');
  };

  const sentCount = items.filter((i) => i.state === 'sent').length;
  const failCount = items.filter((i) => i.state === 'failed' || i.state === 'skipped').length;
  const estimate = Math.ceil(((picked.size - 1) * BATCH_DELAY_MAX_MS) / 1000);

  return (
    <Modal title="批量回复未读" onClose={props.onClose} wide locked={phase === 'running'}>
      {phase === 'edit' ? (
        <>
          {excluded.length > 0 ? (
            <p class="banner">
              以下账号处于保护中，它们的未读会话没有列入，请逐条回复：
              {excluded.map((x) => `「${x.label}」${x.reason}`).join(' ')}
            </p>
          ) : null}
          {candidates.length === 0 ? (
            <p class="empty">现在没有可以批量回复的未读会话。</p>
          ) : (
            <>
              <p class="hint">
                下面是所有有未读消息的会话。勾选要回复的，写好内容，每个会话会从<b>收到消息的那个账号</b>各发一条。为保护账号不被官方限制，一次最多 {MAX_BATCH} 个，并且会一条一条间隔着发。
              </p>
              <div class="row between">
                <span>已选 {picked.size} / {candidates.length}</span>
                <span class="row">
                  <button class="link" onClick={() => setPicked(new Set(candidates.slice(0, MAX_BATCH).map((d) => d.key)))}>全选</button>
                  <button class="link" onClick={() => setPicked(new Set())}>全不选</button>
                </span>
              </div>
              <ul class="batch-list">
                {candidates.map((d) => {
                  const a = accounts.get(d.accountId);
                  return (
                    <li key={d.key}>
                      <label class="check">
                        <input type="checkbox" checked={picked.has(d.key)} onChange={() => toggle(d.key)} />
                        <span class="batch-item">
                          <span class="batch-title">
                            {a ? <AccountChip label={a.label} color={a.color} small /> : null}
                            <b>{d.title}</b>
                            {d.kind === 'group' ? <span class="kind-tag">群聊</span> : null}
                            <span class="badge">{d.unread}</span>
                          </span>
                          <span class="batch-preview">{d.last?.text || d.last?.media || ''}</span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              <label>
                回复内容
                <textarea value={text} onInput={(e) => setText(e.currentTarget.value)} rows={3} placeholder="例如：您好，消息已收到，稍后给您详细回复。" />
              </label>
              <div class="quick-row">
                {props.quickReplies.map((q) => (
                  <button key={q.id} class="quick" type="button" onClick={() => setText(q.text)} title={q.text}>
                    <Icon name="bolt" size={14} /> {q.title}
                  </button>
                ))}
              </div>
            </>
          )}
          <ErrorNote text={error} />
          <div class="row end">
            <button class="btn" onClick={props.onClose}>取消</button>
            <button class="btn primary" disabled={picked.size === 0 || !text.trim()} onClick={() => setPhase('confirm')}>下一步</button>
          </div>
        </>
      ) : null}

      {phase === 'confirm' ? (
        <>
          <p>
            即将向 <b>{picked.size}</b> 个会话各发送一条：
          </p>
          <blockquote class="preview">{text.trim()}</blockquote>
          <p class="hint">发出后无法一键撤回。预计需要约 {estimate} 秒，期间可以随时停止。</p>
          <div class="row end">
            <button class="btn" onClick={() => setPhase('edit')}>返回修改</button>
            <button class="btn primary" onClick={() => void start()}>确认发送</button>
          </div>
        </>
      ) : null}

      {phase === 'running' || phase === 'done' ? (
        <>
          <p role="status">
            {phase === 'running' ? `正在发送… 已完成 ${sentCount} / ${items.length}` : `发送结束：成功 ${sentCount} 个${failCount ? `，未发出 ${failCount} 个` : ''}。`}
          </p>
          <ErrorNote text={error} />
          <ul class="batch-list">
            {items.map((i) => {
              const a = accounts.get(i.accountId);
              return (
                <li key={i.key} class={`batch-result state-${i.state}`}>
                  <span class="batch-title">
                    {a ? <AccountChip label={a.label} color={a.color} small /> : null}
                    <b>{i.title}</b>
                  </span>
                  <span class="batch-state">
                    {BATCH_STATE_TEXT[i.state]}
                    {i.error ? ` — ${i.error}` : ''}
                  </span>
                </li>
              );
            })}
          </ul>
          <div class="row end">
            {phase === 'running' ? (
              <button class="btn danger" onClick={() => abort.current?.abort()}>停止发送</button>
            ) : (
              <button class="btn primary" onClick={props.onClose}>完成</button>
            )}
          </div>
        </>
      ) : null}
    </Modal>
  );
}

/** 设置与安全 */
export function SettingsModal(props: { vault: Vault; hub: Hub; onChanged: () => void; onClose: () => void; onWipe: () => Promise<void> }): JSX.Element {
  const { vault } = props;
  const s = vault.data.settings;
  const [, bump] = useState(0);
  const [section, setSection] = useState<'main' | 'password' | 'api' | 'wipe'>('main');
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');
  const [wipeText, setWipeText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const set = async (patch: Partial<typeof s>) => {
    Object.assign(s, patch);
    bump((n) => n + 1);
    await vault.save();
    props.onChanged();
  };

  const toggleNotify = async (on: boolean) => {
    setError(null);
    if (on) {
      if (!('Notification' in window)) return setError('这个浏览器不支持桌面通知。');
      const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      if (p !== 'granted') return setError('浏览器没有允许通知。请在浏览器的网站设置里允许本页面发送通知后再打开。');
    }
    await set({ notify: on });
  };

  const changePassword = async (e: Event) => {
    e.preventDefault();
    if (newPw !== newPw2) return setError('两次输入的新密码不一样。');
    setBusy(true);
    setError(null);
    try {
      await vault.changePassword(oldPw, newPw);
      setOldPw('');
      setNewPw('');
      setNewPw2('');
      setSection('main');
      setNote('主密码已修改。');
    } catch (err) {
      setError(errorText(err));
    }
    setBusy(false);
  };

  if (section === 'api') {
    return (
      <Modal title="接口参数" onClose={() => setSection('main')}>
        <ApiSetup
          initial={vault.data.api}
          onCancel={() => setSection('main')}
          onSave={async (api) => {
            vault.data.api = api;
            await vault.save();
            setSection('main');
            setNote('接口参数已保存，正在重新连接各账号。');
            for (const a of props.hub.accounts()) void props.hub.connect(a.id);
          }}
        />
      </Modal>
    );
  }

  return (
    <Modal title="设置与安全" onClose={props.onClose} wide locked={busy}>
      {note ? <p class="banner">{note}</p> : null}
      {section === 'main' ? (
        <div class="settings">
          <h3>安全</h3>
          <label class="setting">
            <span>
              <b>自动上锁</b>
              <small>一段时间没有操作就自动上锁并断开所有账号，需要重新输入主密码。</small>
            </span>
            <select value={String(s.autoLockMinutes)} onChange={(e) => void set({ autoLockMinutes: Number(e.currentTarget.value) })}>
              <option value="1">1 分钟</option>
              <option value="5">5 分钟</option>
              <option value="10">10 分钟</option>
              <option value="30">30 分钟</option>
              <option value="120">2 小时</option>
              <option value="0">不自动上锁</option>
            </select>
          </label>
          <button class="setting as-button" onClick={() => { setSection('password'); setError(null); }}>
            <span>
              <b>修改主密码</b>
              <small>需要先输入现在的主密码。</small>
            </span>
            <Icon name="lock" />
          </button>
          <button class="setting as-button" onClick={() => setSection('api')}>
            <span>
              <b>接口参数</b>
              <small>api_id：{vault.data.api ? vault.data.api.id : '未填写'}</small>
            </span>
            <Icon name="edit" />
          </button>

          <h3>消息</h3>
          <label class="setting">
            <span>
              <b>新消息通知</b>
              <small>软件不在前台时，来新消息弹出系统通知。</small>
            </span>
            <input type="checkbox" checked={s.notify} onChange={(e) => void toggleNotify(e.currentTarget.checked)} />
          </label>
          <label class="setting">
            <span>
              <b>通知里显示消息内容</b>
              <small>关闭后通知只显示「哪个账号、谁发来消息」，旁人看不到内容。</small>
            </span>
            <input type="checkbox" checked={s.notifyPreview} onChange={(e) => void set({ notifyPreview: e.currentTarget.checked })} />
          </label>
          <label class="setting">
            <span>
              <b>点快捷回复直接发送</b>
              <small>关闭后，点快捷回复只把内容填进输入框，由你确认后再发。</small>
            </span>
            <input type="checkbox" checked={s.quickSendDirect} onChange={(e) => void set({ quickSendDirect: e.currentTarget.checked })} />
          </label>
          <ErrorNote text={error} />

          <h3>这个软件怎样保护你的账号</h3>
          <ul class="facts">
            <li>各账号的登录凭据用主密码加密（AES-256）后只存在这台设备上，不上传到任何服务器。</li>
            <li>软件只连接官方服务器，没有任何第三方中转、统计或广告。</li>
            <li>聊天内容只在内存里，上锁或关闭后即清除，不写入磁盘。</li>
            <li>每台设备需要各自登录一次账号；同一份登录不会被复制到别处。</li>
          </ul>

          <h3>危险操作</h3>
          <button class="setting as-button danger-text" onClick={() => { setSection('wipe'); setError(null); }}>
            <span>
              <b>退出所有账号并清空本机数据</b>
              <small>换设备、设备要送修或转手之前使用。</small>
            </span>
            <Icon name="trash" />
          </button>
        </div>
      ) : null}

      {section === 'password' ? (
        <form onSubmit={changePassword}>
          <label>
            现在的主密码
            <input type="password" value={oldPw} onInput={(e) => setOldPw(e.currentTarget.value)} autocomplete="current-password" autofocus />
          </label>
          <label>
            新的主密码
            <input type="password" value={newPw} onInput={(e) => setNewPw(e.currentTarget.value)} autocomplete="new-password" />
          </label>
          <label>
            再输入一次新密码
            <input type="password" value={newPw2} onInput={(e) => setNewPw2(e.currentTarget.value)} autocomplete="new-password" />
          </label>
          <ErrorNote text={error} />
          <div class="row end">
            <button class="btn" type="button" onClick={() => setSection('main')} disabled={busy}>返回</button>
            <button class="btn primary" type="submit" disabled={busy || !oldPw || !newPw}>{busy ? '正在修改…' : '修改主密码'}</button>
          </div>
        </form>
      ) : null}

      {section === 'wipe' ? (
        <div>
          <p>
            这会让所有账号在本软件里的登录在官方服务器上作废，并删除这台设备上的全部数据（包括主密码、快捷回复和设置）。账号本身、聊天记录、其他设备上的登录不受影响。
          </p>
          <label>
            请输入「清空」两个字确认
            <input value={wipeText} onInput={(e) => setWipeText(e.currentTarget.value)} autofocus />
          </label>
          <ErrorNote text={error} />
          <div class="row end">
            <button class="btn" onClick={() => setSection('main')} disabled={busy}>返回</button>
            <button
              class="btn danger"
              disabled={busy || wipeText.trim() !== '清空'}
              onClick={() => {
                setBusy(true);
                void props.onWipe().catch((e) => {
                  setError(errorText(e));
                  setBusy(false);
                });
              }}
            >
              {busy ? '正在退出并清空…' : '退出所有账号并清空'}
            </button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
