/**
 * src/server/auth.ts —— 本机账号登录（需求 2）。
 *
 * 没有账号表、没有角色、没有权限级别：**登录就是本机账号的登录**。
 * 校验方式用 `sudo -S -k -v`：能通过说明两件事同时成立 ——
 *   1) 这是这台机器上该账号的真实密码；
 *   2) 该账号有 sudo 权限（需求 2 的"权限最大化"）。
 * 登录后密码只留在**服务进程内存**里，供 SUDO_ASKPASS 使用（不落盘），
 * 服务重启需要重新登录 —— 这是刻意的：磁盘上没有密码，也没有会话表。
 *
 * `QIMING_AUTH=off` 可以整体关掉登录（自动化测试/完全信任的场景）。
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { osUser } from '../util/paths.ts';
import { logger } from '../util/log.ts';

const log = logger('auth');

export type AuthState = {
  authenticated: boolean;
  user: string;
  authDisabled: boolean;
  since?: number;
};

export function createAuth() {
  const disabled = String(process.env.QIMING_AUTH ?? '').toLowerCase() === 'off';
  let password = '';
  let token = '';
  let since = 0;

  function verifyWithSudo(pw: string): Promise<{ ok: boolean; detail: string }> {
    return new Promise((resolve) => {
      const child = spawn('sudo', ['-S', '-k', '-p', '', '-v'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let err = '';
      child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
      child.on('close', (code) => {
        if (code === 0) resolve({ ok: true, detail: 'ok' });
        else resolve({ ok: false, detail: err.trim().slice(0, 300) || `sudo 校验失败（退出码 ${code}）` });
      });
      child.on('error', (e) => resolve({ ok: false, detail: `无法执行 sudo：${e.message}` }));
      child.stdin.end(`${pw}\n`);
    });
  }

  async function login(pw: string): Promise<{ ok: boolean; token?: string; detail: string }> {
    if (disabled) {
      token = token || randomBytes(16).toString('hex');
      password = '';
      since = Date.now();
      return { ok: true, token, detail: '登录已关闭（QIMING_AUTH=off）' };
    }
    const res = await verifyWithSudo(pw);
    if (!res.ok) {
      log.warn('登录失败', { detail: res.detail });
      return { ok: false, detail: `${res.detail}\n（提示：用本机账号 ${osUser()} 的密码；服务进程必须跑在该账号下）` };
    }
    password = pw;
    token = randomBytes(16).toString('hex');
    since = Date.now();
    log.info('本机账号登录成功', { user: osUser() });
    return { ok: true, token, detail: 'ok' };
  }

  function logout(): void {
    password = '';
    token = '';
    since = 0;
  }

  function check(header?: string): boolean {
    if (disabled) return true;
    return Boolean(token) && header === token;
  }

  function state(): AuthState {
    return {
      authenticated: disabled || Boolean(token),
      user: osUser(),
      authDisabled: disabled,
      since: since || undefined,
    };
  }

  return {
    login,
    logout,
    check,
    state,
    /** 执行 sudo 用的密码（内存里；没登录就是空串） */
    sudoPassword: () => password,
    hasSudo: () => Boolean(password) || disabled,
  };
}

export type Auth = ReturnType<typeof createAuth>;
