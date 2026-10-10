/**
 * ui/features/Login.jsx —— 登录页（需求 2：登录即本机账号登录）。
 *
 * 只做一件事：展示本机账号（只读）+ 密码框，POST /api/auth；
 * 成功后令牌由 state/session.js 存进 localStorage，全部请求自动带上。
 * authDisabled（QIMING_AUTH=off）时 boot() 根本不会走到这里。
 */
import { useState } from 'react';
import { useApp } from '../state/store.js';
import { login } from '../state/session.js';
import { Btn, Icon, Input, Spinner } from './ui.jsx';

export default function Login() {
  const st = useApp();
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const user = st.auth?.user ?? '';
  const disabled = Boolean(st.auth?.authDisabled);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      await login(pw);
    } catch (e2) {
      setErr(e2?.message ?? String(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg p-4 text-fg">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-line bg-card p-6 shadow-2xl">
        <div className="mb-1 flex items-center gap-2">
          <span className="grid size-8 place-items-center rounded-lg bg-accent/15 text-accent">
            <Icon name="brain" className="size-5" />
          </span>
          <h1 className="text-lg font-semibold tracking-wide">启明</h1>
        </div>
        <p className="mb-5 text-xs leading-relaxed text-subtle">本机智能体 · 登录后命令以你的本机账号执行</p>

        <div className="mb-3 flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2">
          <Icon name="user" className="size-4 shrink-0 text-muted" />
          <span className="min-w-0 flex-1 truncate text-sm">{user || '（读不到本机账号）'}</span>
          <span className="shrink-0 text-[11px] text-subtle">只读</span>
        </div>

        {disabled ? (
          <p className="text-xs text-warn">登录已关闭（QIMING_AUTH=off），正在直接进入…</p>
        ) : (
          <>
            <Input
              type="password"
              autoFocus
              autoComplete="current-password"
              placeholder="本机账号密码（用 sudo 校验）"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
            />
            <p className="mt-1.5 text-[11px] leading-relaxed text-subtle">密码只送到服务进程内存里（执行 sudo 用），不落盘；服务重启后需重新登录。</p>
            {err || st.bootError ? (
              <p className="mt-3 whitespace-pre-wrap rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs leading-relaxed text-danger">{err || st.bootError}</p>
            ) : null}
            <Btn variant="primary" className="mt-4 w-full justify-center" disabled={busy || !pw} type="submit">
              {busy ? <Spinner className="size-4" /> : <Icon name="logout" className="size-4" />}
              登录
            </Btn>
          </>
        )}
      </form>
    </div>
  );
}
