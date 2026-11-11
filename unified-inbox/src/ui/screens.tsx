import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { errorText, type ApiCredentials } from '../core/types.ts';
import { MIN_PASSWORD_LENGTH, Vault, checkPasswordStrength, type KeyValueStore } from '../core/vault.ts';
import { ErrorNote, Icon } from './util.tsx';

export const APP_NAME = '聚信';
export const APP_TAGLINE = '多账号聚合收件箱';

function Brand(): JSX.Element {
  return (
    <div class="brand">
      <img src="./icon.svg" alt="" width="56" height="56" />
      <h1>{APP_NAME}</h1>
      <p>{APP_TAGLINE}</p>
    </div>
  );
}

/** 首次使用：设置主密码 */
export function SetupScreen(props: { store: KeyValueStore; iter: number; onReady: (vault: Vault) => void }): JSX.Element {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [understood, setUnderstood] = useState(false);
  const weak = pw ? checkPasswordStrength(pw) : null;

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    const problem = checkPasswordStrength(pw);
    if (problem) return setError(problem);
    if (pw !== pw2) return setError('两次输入的主密码不一样。');
    if (!understood) return setError('请先确认你已了解：主密码忘了无法找回。');
    setBusy(true);
    setError(null);
    try {
      props.onReady(await Vault.create(props.store, pw, props.iter));
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <main class="gate">
      <form class="gate-card" onSubmit={submit}>
        <Brand />
        <h2>先设置一个主密码</h2>
        <p class="hint">
          所有账号的登录凭据都会用这个主密码加密后，只保存在这台设备上。每次打开软件都要输入它。
        </p>
        <label>
          主密码（至少 {MIN_PASSWORD_LENGTH} 位，建议字母加数字）
          <input type="password" value={pw} onInput={(e) => setPw(e.currentTarget.value)} autocomplete="new-password" autofocus />
        </label>
        {weak ? <p class="hint warn">{weak}</p> : null}
        <label>
          再输入一次
          <input type="password" value={pw2} onInput={(e) => setPw2(e.currentTarget.value)} autocomplete="new-password" />
        </label>
        <label class="check">
          <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.currentTarget.checked)} />
          <span>我知道主密码不会上传到任何地方，<b>忘记了无法找回</b>，只能清空后重新登录各个账号。</span>
        </label>
        <ErrorNote text={error} />
        <button class="btn primary" type="submit" disabled={busy}>
          {busy ? '正在创建加密保险库…' : '创建并进入'}
        </button>
      </form>
    </main>
  );
}

/** 解锁 */
export function UnlockScreen(props: { store: KeyValueStore; hint?: string; onReady: (vault: Vault) => void; onWipe: () => void }): JSX.Element {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(() => Vault.lockedForSeconds(props.store));
  const [confirmWipe, setConfirmWipe] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setInterval(() => setWait(Vault.lockedForSeconds(props.store)), 500);
    return () => clearInterval(t);
  }, [wait > 0]);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy || wait > 0 || !pw) return;
    setBusy(true);
    setError(null);
    try {
      props.onReady(await Vault.unlock(props.store, pw));
    } catch (err) {
      setError(errorText(err));
      setPw('');
      setWait(Vault.lockedForSeconds(props.store));
      setBusy(false);
      input.current?.focus();
    }
  };

  return (
    <main class="gate">
      <form class="gate-card" onSubmit={submit}>
        <Brand />
        <h2>
          <Icon name="lock" size={18} /> 已上锁
        </h2>
        <label>
          输入主密码解锁
          <input ref={input} type="password" value={pw} onInput={(e) => setPw(e.currentTarget.value)} autocomplete="current-password" autofocus disabled={wait > 0} />
        </label>
        {props.hint ? <p class="hint">{props.hint}</p> : null}
        <ErrorNote text={wait > 0 ? `输错次数过多，请 ${wait} 秒后再试。` : error} />
        <button class="btn primary" type="submit" disabled={busy || wait > 0 || !pw}>
          {busy ? '正在解锁…' : '解锁'}
        </button>
        {confirmWipe ? (
          <div class="danger-box">
            <p>
              清空后，这台设备上保存的所有账号登录都会删除，需要重新逐个登录。各账号本身和聊天记录不受影响。
              由于现在处于上锁状态，无法通知官方服务器作废这些登录；清空后请到官方客户端的「设置 → 设备」里，把这台设备上的登录（应用名是你申请接口参数时填的名字）下线。
            </p>
            <div class="row">
              <button class="btn" type="button" onClick={() => setConfirmWipe(false)}>
                取消
              </button>
              <button class="btn danger" type="button" onClick={props.onWipe}>
                确认清空
              </button>
            </div>
          </div>
        ) : (
          <button class="link" type="button" onClick={() => setConfirmWipe(true)}>
            忘记主密码？清空本机数据
          </button>
        )}
      </form>
    </main>
  );
}

/** 填写接口参数（每个使用者只需做一次） */
export function ApiSetup(props: { initial: ApiCredentials | null; onSave: (api: ApiCredentials) => Promise<void>; onCancel?: () => void }): JSX.Element {
  const [id, setId] = useState(props.initial ? String(props.initial.id) : '');
  const [hash, setHash] = useState(props.initial?.hash ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    const n = Number(id.trim());
    const h = hash.trim().toLowerCase();
    if (!Number.isInteger(n) || n <= 0) return setError('api_id 应该是一串数字。');
    if (!/^[0-9a-f]{32}$/.test(h)) return setError('api_hash 应该是 32 位的字母数字（0-9、a-f）。');
    setBusy(true);
    try {
      await props.onSave({ id: n, hash: h });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <form class="api-setup" onSubmit={submit}>
      <h2>填写接口参数</h2>
      <p class="hint">
        这是官方发给每位开发者的一对编号，用来让第三方软件合规地连接官方服务器。只需填一次，所有账号共用，填好后同样加密保存在本机。
      </p>
      <ol class="steps">
        <li>
          用浏览器打开官方网站 <code>my.telegram.org</code>，用你任意一个账号的手机号登录（验证码会发到那个账号的官方客户端里）。
        </li>
        <li>
          点 <b>API development tools</b>，随便填一个应用名称（例如 MyInbox），平台选 Desktop，提交。
        </li>
        <li>
          页面上会显示 <b>App api_id</b> 和 <b>App api_hash</b>，把它们抄到下面。
        </li>
      </ol>
      <label>
        api_id
        <input inputMode="numeric" value={id} onInput={(e) => setId(e.currentTarget.value)} placeholder="例如 1234567" autofocus />
      </label>
      <label>
        api_hash
        <input value={hash} onInput={(e) => setHash(e.currentTarget.value)} placeholder="32 位字母数字" autocomplete="off" spellcheck={false} />
      </label>
      <p class="hint warn">不要把 api_hash 告诉别人，也不要使用别人给你的——它等同于你这个应用的身份。</p>
      <ErrorNote text={error} />
      <div class="row end">
        {props.onCancel ? (
          <button class="btn" type="button" onClick={props.onCancel}>
            取消
          </button>
        ) : null}
        <button class="btn primary" type="submit" disabled={busy}>
          保存
        </button>
      </div>
    </form>
  );
}
