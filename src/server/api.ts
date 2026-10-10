/**
 * src/server/api.ts —— 全部 API 端点（唯一路由表）。
 *
 * 约定：
 *  · 一切以 /api/ 开头；除 /api/auth 外都要登录令牌（需求 2 的"登录即本机账号登录"）；
 *  · 读端点都是 GET 返回 JSON；写端点 POST 收 JSON；
 *  · 出错统一 `{ error: "人话" }` + 合适的状态码，界面直接显示这句话。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, readJson, sseStart, text, serveFile, notFound } from './http.ts';
import type { AppCtx } from './app.ts';
import { writeTodo, readTodo } from '../modules/plugins/builtin/misc.ts';
import { readCallDetail, readThinking } from './journal.ts';
import * as memory from '../modules/memory/index.ts';
import * as skills from '../modules/skills/index.ts';
import { publicSettings, readSettings, patchSettings, mergeProviders, providerOf } from '../store/settings.ts';
import {
  addProject,
  archiveProject,
  findProject,
  insideWorkspace,
  listProjects,
  pinProject,
  purgeProjectData,
  readProjects,
  removeProject,
  setCurrentProject,
  updateProject,
} from '../store/projects.ts';
import {
  archiveSession,
  deleteSession,
  getSession,
  newSession,
  pinSession,
  putSession,
  sessionSummaries,
} from '../store/sessions.ts';
import type { Session } from '../store/sessions.ts';
import { usageOf } from '../agent/context.ts';
import { toRequestMessages } from './runner.ts';
import { DOWNLOADS_DIR, osHome, osUser } from '../util/paths.ts';

export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, ctx: AppCtx): Promise<boolean> {
  const p = url.pathname;
  if (!p.startsWith('/api/')) return false;
  const method = req.method ?? 'GET';

  try {
    /* ───────── 登录（唯一免鉴权端点） ───────── */
    if (p === '/api/auth') {
      if (method === 'GET') return json(res, 200, ctx.auth.state()), true;
      if (method === 'POST') {
        const body = await readJson<{ password?: string; logout?: boolean }>(req);
        if (body.logout) {
          ctx.auth.logout();
          return json(res, 200, { ok: true, ...ctx.auth.state() }), true;
        }
        const r = await ctx.auth.login(String(body.password ?? ''));
        if (!r.ok) return json(res, 401, { error: r.detail }), true;
        return json(res, 200, { ok: true, token: r.token, ...ctx.auth.state() }), true;
      }
    }

    // 令牌两条通道：请求头（普通 fetch）与 query（EventSource 不能带自定义头）
    const token = String(req.headers['x-qiming-token'] ?? url.searchParams.get('token') ?? '');
    if (!ctx.auth.check(token)) {
      return json(res, 401, { error: '未登录：请先用本机账号登录。' }), true;
    }

    /* ───────── 启动快照 ───────── */
    if (p === '/api/bootstrap' && method === 'GET') {
      const settings = readSettings();
      return json(res, 200, {
        auth: ctx.auth.state(),
        settings: publicSettings(settings),
        // 待下载目录：界面用它过滤"哪些文件真的能下载"（历史记录里混进来的普通路径会被滤掉）
        downloadsDir: DOWNLOADS_DIR,
        projects: listProjects(),
        sessions: sessionSummaries(),
        running: ctx.runs.summaries(),
        plugins: ctx.plugins.views(),
        prompts: ctx.prompts.list(),
        skills: skills.list(),
        resources: ctx.resources.views(),
      }), true;
    }

    /* ───────── 会话 ───────── */
    if (p === '/api/sessions' && method === 'GET') {
      const archived = url.searchParams.get('archived') === '1';
      return json(res, 200, { sessions: sessionSummaries({ archived }) }), true;
    }
    // 建一条**空会话**（侧栏「+」选完项目后立刻建出来，这样它当场就出现在该项目分组下）
    if (p === '/api/sessions' && method === 'POST') {
      const body = await readJson<{ projectId?: string | null; providerId?: string | null }>(req);
      const session = putSession(newSession({ projectId: body.projectId ?? null, providerId: body.providerId ?? null }));
      return json(res, 200, { ok: true, session }), true;
    }
    if (p.startsWith('/api/session/')) {
      const rest = p.slice('/api/session/'.length);
      const [id, ...tailParts] = rest.split('/');
      const tail = tailParts.join('/');
      if (!id) return json(res, 400, { error: '缺少会话 id' }), true;
      if (!tail && method === 'GET') {
        const session = getSession(id);
        if (!session) return json(res, 404, { error: '会话不存在' }), true;
        return json(res, 200, {
          session,
          run: ctx.runs.ofSession(id)
            ? { id: ctx.runs.ofSession(id)!.id, status: ctx.runs.ofSession(id)!.status, startedAt: ctx.runs.ofSession(id)!.startedAt }
            : null,
          // 排队中的消息：刷新后输入框上方那条"排队 N 条"要能恢复
          queue: ctx.runs.queueOf(id),
          // 上下文占用：不跑的时候也要显示（否则顶栏的环只在那一段运行时才有数）
          usage: sessionUsage(session),
        }), true;
      }
      if (tail === 'archive' && method === 'POST') {
        const body = await readJson<{ archived?: boolean }>(req);
        const session = archiveSession(id, body.archived !== false);
        return json(res, session ? 200 : 404, session ? { ok: true, session } : { error: '会话不存在' }), true;
      }
      if (tail === 'pin' && method === 'POST') {
        const body = await readJson<{ pinned?: boolean }>(req);
        const session = pinSession(id, body.pinned !== false);
        return json(res, session ? 200 : 404, session ? { ok: true, session } : { error: '会话不存在' }), true;
      }
      if (!tail && method === 'POST') {
        const session = getSession(id);
        if (!session) return json(res, 404, { error: '会话不存在' }), true;
        const patch = await readJson<Record<string, unknown>>(req);
        if (typeof patch.title === 'string') session.title = patch.title.slice(0, 120);
        if ('projectId' in patch) session.projectId = patch.projectId ? String(patch.projectId) : null;
        if (typeof patch.providerId === 'string') session.providerId = patch.providerId;
        putSession(session);
        return json(res, 200, { ok: true, session }), true;
      }
      if (!tail && method === 'DELETE') {
        // 彻底删除只在归档页可用：先归档再删，避免手滑把活会话删掉
        const session = getSession(id);
        if (!session) return json(res, 404, { error: '会话不存在' }), true;
        if (!session.archivedAt) return json(res, 409, { error: '先归档，再在「设置 → 归档」里彻底删除。' }), true;
        if (ctx.runs.ofSession(id)?.status === 'running') return json(res, 409, { error: '会话正在运行，先停止再删。' }), true;
        return json(res, 200, { ok: deleteSession(id) }), true;
      }
    }

    /* ───────── 发消息 / 停止 ───────── */
    if (p === '/api/chat' && method === 'POST') {
      const body = await readJson<{ sessionId?: string; projectId?: string | null; text?: string; providerId?: string | null; mode?: string }>(req);
      const r = ctx.runs.start({
        sessionId: body.sessionId,
        projectId: body.projectId ?? null,
        text: String(body.text ?? ''),
        providerId: body.providerId ?? null,
        mode: body.mode === 'urgent' ? 'urgent' : 'steer',
      });
      return json(res, r.ok ? 200 : 409, r), true;
    }
    /* 排队队列：读 / 删 / 立即执行（消息先排队，用户再决定何时执行 —— 标准做法） */
    if (p === '/api/run/queue' && method === 'GET') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      return json(res, 200, { items: ctx.runs.queueOf(sessionId) }), true;
    }
    if (p === '/api/run/queue' && method === 'POST') {
      const body = await readJson<{ sessionId?: string; id?: string; action?: string }>(req);
      const sessionId = String(body.sessionId ?? '');
      const id = String(body.id ?? '');
      if (!sessionId || !id) return json(res, 400, { error: 'sessionId 与 id 必填' }), true;
      const ok =
        body.action === 'remove'
          ? ctx.runs.removeQueued(sessionId, id)
          : ctx.runs.executeQueued(sessionId, id);
      return json(res, ok ? 200 : 404, { ok, items: ctx.runs.queueOf(sessionId) }), true;
    }
    if (p === '/api/run/stop' && method === 'POST') {
      const body = await readJson<{ runId?: string; sessionId?: string }>(req);
      return json(res, 200, { ok: ctx.runs.stop(body.runId, body.sessionId) }), true;
    }

    /* ───────── SSE 事件流 ───────── */
    if (p === '/api/events' && method === 'GET') {
      const sse = sseStart(req, res);
      const sessionId = url.searchParams.get('sessionId') ?? undefined;
      for (const ev of ctx.runs.replayFor(sessionId)) sse.send({ ...ev, replay: true });
      const off = ctx.runs.subscribe((ev) => {
        if (sessionId && ev.sessionId !== sessionId) return;
        sse.send(ev);
      });
      req.on('close', off);
      return true;
    }

    /* ───────── 运行明细（按需取全文：思考、工具参数与结果） ───────── */
    const runDetail = /^\/api\/run\/([\w]+)\/(call|thinking)\/([\w.-]+)$/.exec(p);
    if (runDetail && method === 'GET') {
      const [, runId, kind, key] = runDetail;
      if (kind === 'call') {
        const detail = readCallDetail(runId!, Number(key));
        if (!detail) return json(res, 404, { error: '这条调用没有记录（可能已被清理）' }), true;
        return json(res, 200, detail), true;
      }
      return json(res, 200, { text: readThinking(runId!, key!) }), true;
    }

    /* ───────── 项目 ───────── */
    if (p === '/api/projects' && method === 'GET') {
      const store = readProjects();
      const settings = readSettings();
      const archived = url.searchParams.get('archived') === '1';
      const all = url.searchParams.get('all') === '1';
      return json(res, 200, {
        projects: listProjects({ archived, all }),
        current: store.current,
        workspace: settings.workspace,
        home: osHome(),
      }), true;
    }
    // 归档页：一次性拿归档的会话与项目
    if (p === '/api/archive' && method === 'GET') {
      return json(res, 200, {
        sessions: sessionSummaries({ archived: true }),
        projects: listProjects({ archived: true }),
      }), true;
    }
    if (p === '/api/projects' && method === 'POST') {
      const body = await readJson<{ root?: string; name?: string; current?: string | null }>(req);
      if ('current' in body) {
        setCurrentProject(body.current ?? null);
        return json(res, 200, { ok: true, projects: listProjects() }), true;
      }
      const raw = String(body.root ?? '').trim();
      if (!raw) return json(res, 400, { error: '路径必填' }), true;
      const abs = path.resolve(raw.startsWith('~') ? path.join(osHome(), raw.slice(1)) : raw);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
        return json(res, 400, { error: `目录不存在：${abs}` }), true;
      }
      const workspace = readSettings().workspace;
      if (!insideWorkspace(abs, workspace)) {
        return json(res, 400, { error: `项目必须放在工作区之内：${workspace}（当前填的是 ${abs}）。要换地方就先改工作区。` }), true;
      }
      const all = listProjects();
      if (all.length >= 200) return json(res, 400, { error: '项目太多了（200 上限），先删一些。' }), true;
      return json(res, 200, { ok: true, project: addProject(abs, body.name) }), true;
    }
    if (p.startsWith('/api/projects/') && method === 'POST') {
      const rest = p.slice('/api/projects/'.length);
      const action = rest.endsWith('/archive') ? 'archive' : rest.endsWith('/pin') ? 'pin' : '';
      const id = action ? rest.slice(0, -(action.length + 1)) : rest;
      if (action === 'archive') {
        const body = await readJson<{ archived?: boolean }>(req);
        const archived = body.archived !== false;
        const project = archiveProject(id, archived);
        if (!project) return json(res, 404, { error: '项目不存在' }), true;
        // 项目归档 → 它的会话一起归档；恢复同理（会话不会孤零零留在侧栏）
        for (const sm of sessionSummaries({ archived: !archived })) {
          if (sm.projectId === id) archiveSession(sm.id, archived);
        }
        /* 返回的是**活跃**会话列表 —— 界面拿它直接当侧栏数据用。
           早先这里回的是"归档列表"（按 archived 取），于是归档一个项目后侧栏变成显示已归档的会话、
           刷新（重新 bootstrap）才恢复正常 —— 就是用户报的那个 bug。归档的条数另给，供提示用。 */
        return json(res, 200, {
          ok: true,
          project,
          sessions: sessionSummaries(),
          archivedCount: sessionSummaries({ archived: true }).length,
        }), true;
      }
      if (action === 'pin') {
        const body = await readJson<{ pinned?: boolean }>(req);
        const project = pinProject(id, body.pinned !== false);
        return json(res, project ? 200 : 404, project ? { ok: true, project } : { error: '项目不存在' }), true;
      }
      const body = await readJson<{ name?: string; root?: string }>(req);
      const patch: { name?: string; root?: string } = {};
      if (body.name !== undefined) patch.name = String(body.name).trim().slice(0, 80) || undefined;
      if (body.root !== undefined) {
        const raw = String(body.root).trim();
        const abs = path.resolve(raw.startsWith('~') ? path.join(osHome(), raw.slice(1)) : raw);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
          return json(res, 400, { error: `目录不存在：${abs}` }), true;
        }
        if (!insideWorkspace(abs, readSettings().workspace)) {
          return json(res, 400, { error: `项目必须放在工作区之内：${readSettings().workspace}` }), true;
        }
        patch.root = abs;
      }
      const updated = updateProject(id, patch);
      return json(res, updated ? 200 : 404, updated ? { ok: true, project: updated } : { error: '项目不存在' }), true;
    }
    if (p.startsWith('/api/projects/') && method === 'DELETE') {
      const id = p.slice('/api/projects/'.length);
      const project = findProject(id);
      if (!project) return json(res, 404, { error: '项目不存在' }), true;
      if (!project.archivedAt) return json(res, 409, { error: '先归档，再在「设置 → 归档」里彻底删除。' }), true;
      // 彻底删除：项目记录 + 项目记忆目录 + 它的会话记录（磁盘上的项目文件一个字不动）
      const removedSessions = sessionSummaries({ archived: true }).filter((sm) => sm.projectId === id);
      for (const sm of removedSessions) deleteSession(sm.id);
      removeProject(id);
      purgeProjectData(id);
      return json(res, 200, { ok: true, removedSessions: removedSessions.length }), true;
    }
    if (p === '/api/browse' && method === 'GET') {
      // 目录选择器收在工作区内：默认从工作区开始，越界的请求一律拒（需求 3）
      const workspace = readSettings().workspace;
      const raw = url.searchParams.get('path') ?? workspace;
      const dir = path.resolve(raw.startsWith('~') ? path.join(osHome(), raw.slice(1)) : raw);
      const clamped = insideWorkspace(dir, workspace);
      if (!clamped) {
        return json(res, 400, { error: `只能在工作区之内选目录：${workspace}` }), true;
      }
      try {
        const items = fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((it) => !it.name.startsWith('.'))
          .map((it) => ({ name: it.name, dir: it.isDirectory() || isDirLink(path.join(dir, it.name)) }))
          .filter((it) => it.dir)
          .sort((a, b) => a.name.localeCompare(b.name));
        const parent = path.dirname(dir);
        return json(res, 200, {
          path: dir,
          workspace,
          parent: insideWorkspace(parent, workspace) ? parent : null, // 到工作区根就没了
          items,
        }), true;
      } catch (err) {
        return json(res, 400, { error: `读不了 ${dir}：${err instanceof Error ? err.message : String(err)}` }), true;
      }
    }

    /* ───────── 设置 ───────── */
    if (p === '/api/settings' && method === 'GET') return json(res, 200, publicSettings(readSettings())), true;
    if (p === '/api/settings' && method === 'POST') {
      const body = await readJson<Record<string, unknown>>(req);
      const cur = readSettings();
      const next: Parameters<typeof patchSettings>[0] = {};
      if (Array.isArray(body.providers)) {
        next.providers = mergeProviders(cur.providers, body.providers as Array<{ id: string }>);
      }
      if ('activeId' in body) next.activeId = body.activeId as string | null;
      if (body.params && typeof body.params === 'object') next.params = body.params as Record<string, never>;
      if (typeof body.workspace === 'string') next.workspace = body.workspace;
      if (body.ui && typeof body.ui === 'object') next.ui = body.ui as Record<string, never>;
      return json(res, 200, publicSettings(patchSettings(next))), true;
    }

    /* ───────── 插件 ───────── */
    if (p === '/api/plugins' && method === 'GET') return json(res, 200, { plugins: ctx.plugins.views() }), true;
    if (p === '/api/plugins' && method === 'POST') {
      const body = await readJson<{ id?: string; name?: string; desc?: string; prompt?: string; enabled?: boolean; params?: Array<unknown>; tools?: Array<unknown> }>(req);
      if (!body.id || !body.name) return json(res, 400, { error: 'id 与 name 必填' }), true;
      ctx.plugins.upsertCustom({
        id: String(body.id).replace(/[^\w-]/g, '-'),
        name: body.name,
        desc: body.desc ?? '',
        prompt: body.prompt ?? '',
        enabled: body.enabled !== false,
        params: (body.params ?? []) as never,
        tools: (body.tools ?? []) as never,
      });
      return json(res, 200, { ok: true, plugins: ctx.plugins.views() }), true;
    }
    if (p.startsWith('/api/plugins/')) {
      const id = p.slice('/api/plugins/'.length);
      if (method === 'POST') {
        const body = await readJson<{ enabled?: boolean; prompt?: string; params?: Record<string, unknown> }>(req);
        ctx.plugins.setOverride(id, body);
        return json(res, 200, { ok: true, plugins: ctx.plugins.views() }), true;
      }
      if (method === 'DELETE') {
        ctx.plugins.removeCustom(id);
        return json(res, 200, { ok: true, plugins: ctx.plugins.views() }), true;
      }
    }

    /* ───────── 提示词 ───────── */
    if (p === '/api/prompts' && method === 'GET') return json(res, 200, { prompts: ctx.prompts.list() }), true;
    if (p.startsWith('/api/prompts/')) {
      const rest = p.slice('/api/prompts/'.length);
      const reset = rest.endsWith('/reset');
      const id = reset ? rest.slice(0, -'/reset'.length) : rest;
      if (method === 'POST') {
        const entry = reset ? ctx.prompts.reset(id) : ctx.prompts.set(id, await readJson<{ text?: string; enabled?: boolean }>(req));
        if (!entry) return json(res, 404, { error: '没有这条提示词' }), true;
        ctx.syncResources();
        return json(res, 200, { ok: true, entry }), true;
      }
    }

    /* ───────── 记忆 ───────── */
    if (p === '/api/memory' && method === 'GET') {
      // scope=all：一次给全部作用域的**计数**（汇总页的折叠标题要显示"全局 3 条 / 项目A 5 条"，
      // 正文仍按需拉 —— 与会话列表同一套"列表轻、详情按需"的纪律）
      if (url.searchParams.get('scope') === 'all') {
        const scopes: Array<{ kind: 'global' | 'project'; projectId?: string; label: string; count: number }> = [
          { kind: 'global', label: '全局记忆', count: memory.listEntries({ kind: 'global' }).length },
        ];
        for (const proj of listProjects({ all: true })) {
          scopes.push({
            kind: 'project',
            projectId: proj.id,
            label: proj.name,
            count: memory.listEntries({ kind: 'project', id: proj.id, name: proj.name }).length,
          });
        }
        return json(res, 200, { scopes }), true;
      }
      const scope = scopeFrom(url.searchParams, ctx);
      if (!scope) return json(res, 400, { error: '项目记忆需要一个项目' }), true;
      return json(res, 200, { scope, entries: memory.listEntries(scope).map((e) => ({ ...e, body: undefined })) }), true;
    }
    if (p === '/api/memory' && method === 'POST') {
      const body = await readJson<{ scope?: string; projectId?: string; slug?: string; title?: string; description?: string; body?: string; tags?: string[] }>(req);
      const scope = scopeFrom(new URLSearchParams(body as Record<string, string>), ctx);
      if (!scope) return json(res, 400, { error: '项目记忆需要一个项目' }), true;
      if (!body.title || !body.body) return json(res, 400, { error: 'title 与 body 必填' }), true;
      const entry = memory.writeEntry(scope, { slug: body.slug, title: body.title, description: body.description, body: body.body, tags: body.tags ?? [] });
      return json(res, 200, { ok: true, entry }), true;
    }
    if (p === '/api/memory/entry' && method === 'GET') {
      const scope = scopeFrom(url.searchParams, ctx);
      if (!scope) return json(res, 400, { error: '项目记忆需要一个项目' }), true;
      const entry = memory.readEntry(scope, url.searchParams.get('slug') ?? '');
      return json(res, entry ? 200 : 404, entry ?? { error: '没有这条记忆' }), true;
    }
    if (p === '/api/memory' && method === 'DELETE') {
      const scope = scopeFrom(url.searchParams, ctx);
      if (!scope) return json(res, 400, { error: '项目记忆需要一个项目' }), true;
      return json(res, 200, { ok: memory.removeEntry(scope, url.searchParams.get('slug') ?? '') }), true;
    }

    /* ───────── 技能 ───────── */
    if (p === '/api/skills' && method === 'GET') return json(res, 200, { skills: skills.list() }), true;
    if (p === '/api/skills' && method === 'POST') {
      const body = await readJson<{ name?: string; description?: string; body?: string }>(req);
      if (!body.name || !body.body) return json(res, 400, { error: 'name 与 body 必填' }), true;
      const meta = skills.write({ name: body.name, description: body.description ?? '', body: body.body });
      return json(res, 200, { ok: true, skill: meta }), true;
    }
    if (p === '/api/skills/import' && method === 'POST') {
      const body = await readJson<{ path?: string }>(req);
      const target = String(body.path ?? '').trim();
      if (!target) return json(res, 400, { error: 'path 必填' }), true;
      const abs = path.resolve(target.startsWith('~') ? path.join(osHome(), target.slice(1)) : target);
      try {
        const stat = fs.statSync(abs);
        const imported = stat.isDirectory() ? skills.importDir(abs) : [skills.importMarkdown(fs.readFileSync(abs, 'utf8'))];
        return json(res, 200, { ok: true, imported }), true;
      } catch (err) {
        return json(res, 400, { error: `导入失败：${err instanceof Error ? err.message : String(err)}` }), true;
      }
    }
    if (p.startsWith('/api/skills/')) {
      const name = decodeURIComponent(p.slice('/api/skills/'.length));
      if (method === 'GET') {
        const found = skills.read(name);
        return json(res, found ? 200 : 404, found ?? { error: '没有这个技能' }), true;
      }
      if (method === 'DELETE') return json(res, 200, { ok: skills.remove(name) }), true;
      if (method === 'POST') {
        const body = await readJson<{ enabled?: boolean }>(req);
        if (typeof body.enabled === 'boolean') skills.setEnabled(name, body.enabled);
        return json(res, 200, { ok: true, skills: skills.list() }), true;
      }
    }

    /* ───────── 外部资源 ───────── */
    if (p === '/api/resources' && method === 'GET') return json(res, 200, { resources: ctx.resources.views(), user: osUser() }), true;
    if (p === '/api/resources' && method === 'POST') {
      const body = await readJson<Record<string, unknown>>(req);
      if (!body.id || !body.name || !body.kind) return json(res, 400, { error: 'id / name / kind 必填' }), true;
      const saved = ctx.resources.upsert(body as never);
      ctx.syncResources();
      return json(res, 200, { ok: true, resource: saved }), true;
    }
    if (p.startsWith('/api/resources/')) {
      const rest = p.slice('/api/resources/'.length);
      const test = rest.endsWith('/test');
      const id = test ? rest.slice(0, -'/test'.length) : rest;
      if (method === 'POST' && test) {
        const st = await ctx.resources.connect(id);
        ctx.syncResources();
        return json(res, 200, { ok: st.state === 'ready', status: st }), true;
      }
      if (method === 'POST') {
        const body = await readJson<{ enabled?: boolean; params?: Record<string, unknown>; prompt?: string }>(req);
        if (typeof body.enabled === 'boolean') {
          ctx.resources.setEnabled(id, body.enabled);
          ctx.syncResources();
        }
        if (body.params && typeof body.params === 'object') ctx.resources.setParams(id, body.params);
        // 资源说明改的是提示词中心里的同一条（res.<id>.usage），与提示词页完全等价
        if (typeof body.prompt === 'string') ctx.prompts.set(`res.${id}.usage`, { text: body.prompt });
        return json(res, 200, { ok: true, resources: ctx.resources.views() }), true;
      }
      if (method === 'DELETE') {
        const ok = ctx.resources.remove(id);
        ctx.syncResources();
        return json(res, 200, { ok }), true;
      }
    }

    /* ───────── 待办 / 待下载 ───────── */
    if (p === '/api/todo' && method === 'GET') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      return json(res, 200, { todo: sessionId ? readTodo(sessionId) : null }), true;
    }
    if (p === '/api/todo' && method === 'POST') {
      const body = await readJson<{ sessionId?: string; items?: unknown[] }>(req);
      if (!body.sessionId) return json(res, 400, { error: 'sessionId 必填' }), true;
      writeTodo({ sessionId: body.sessionId, items: (body.items ?? []) as never, updated: Date.now() });
      return json(res, 200, { ok: true }), true;
    }
    if (p === '/api/downloads' && method === 'GET') {
      let files: Array<{ name: string; size: number; mtime: number }> = [];
      try {
        files = fs
          .readdirSync(DOWNLOADS_DIR, { withFileTypes: true })
          .filter((it) => it.isFile())
          .map((it) => {
            const st = fs.statSync(path.join(DOWNLOADS_DIR, it.name));
            return { name: it.name, size: st.size, mtime: st.mtimeMs };
          })
          .sort((a, b) => b.mtime - a.mtime);
      } catch {
        files = [];
      }
      return json(res, 200, { files }), true;
    }
    if (p === '/api/downloads/file' && method === 'GET') {
      const name = path.basename(url.searchParams.get('name') ?? '');
      if (!name) return json(res, 400, { error: 'name 必填' }), true;
      return serveFile(req, res, path.join(DOWNLOADS_DIR, name), { inline: url.searchParams.get('inline') === '1' }), true;
    }

    return json(res, 404, {
      error: `没有这个接口：${method} ${p}。若界面上是新加的功能，多半是**服务端还是旧进程**（改了后端没重启）：跑一次 bash down.sh && bash up.sh。`,
    }), true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json(res, 500, { error: message }), true;
  }
}

/**
 * 会话的上下文占用（给界面顶栏的上下文环用）。
 *
 * 口径与 runner 里的压缩判定**完全一致**（同一个 usageOf）—— 否则会出现
 * "环上写着 82% 但没压缩"或"环是绿的其实已经该压了"这种自相矛盾。
 * 工具表拿不到（要由运行宿主注入），所以这里只算"历史 + 系统提示词"，
 * 相当于**下界**：真实占用只会比它高（每轮还会加上工具表与预留输出）。
 * 运行中的那段由 usage 事件给出精确值，会覆盖这里的结果。
 */
function sessionUsage(session: Session) {
  try {
    const settings = readSettings();
    const provider = providerOf(settings, session.providerId);
    const messages = toRequestMessages(session.msgs);
    const compact = session.compact ?? null;
    const view = compact && compact.upTo > 0 ? messages.slice(Math.min(compact.upTo, messages.length)) : messages;
    return usageOf({
      messages: view,
      system: '',
      tools: [],
      ctxLimit: settings.params.ctxLimit ?? 0,
      reserve: Math.max(0, Math.trunc(Number(settings.params.maxTokens ?? 8192) || 8192)),
      model: provider?.model ?? session.model ?? '',
    });
  } catch {
    return null;
  }
}

function scopeFrom(params: URLSearchParams, ctx: AppCtx): memory.Scope | null {
  const raw = params.get('scope') ?? 'global';
  if (raw === 'global') return { kind: 'global' };
  const id = params.get('projectId') ?? '';
  const project = findProject(id);
  if (!project) return null;
  return { kind: 'project', id: project.id, name: project.name };
}

function isDirLink(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export { notFound, text };
