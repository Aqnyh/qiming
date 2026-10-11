/**
 * src/server/app.ts —— 应用装配（唯一的依赖接线处）。
 *
 * 为什么单独一份：模块之间只认类型不认全局单例，装配顺序在别处会散成"谁先被 import 谁赢"。
 * 这里显式按顺序建：提示词中心 → 插件登记表 → 外部资源 → 运行注册表，并把资源工具挂回插件表。
 */
import { ensureDirs, PLUGINS_FILE, RESOURCES_FILE, PROMPTS_FILE } from '../util/paths.ts';
import { watchFiles } from '../store/watch.ts';
import { logger } from '../util/log.ts';
import { prompts, corePromptDefs } from '../modules/prompts/registry.ts';
import { createPluginRegistry } from '../modules/plugins/registry.ts';
import { createResourceRegistry } from '../modules/resources/index.ts';
import { createRunRegistry } from './runs.ts';
import { seedBuiltin as seedSkills } from '../modules/skills/index.ts';
import { createAuth } from './auth.ts';
import { migrateLegacySubagentRounds, readSettings, saveSettings } from '../store/settings.ts';

const log = logger('app');

export type AppCtx = {
  auth: ReturnType<typeof createAuth>;
  prompts: typeof prompts;
  plugins: ReturnType<typeof createPluginRegistry>;
  resources: ReturnType<typeof createResourceRegistry>;
  runs: ReturnType<typeof createRunRegistry>;
  syncResources: () => void;
  stopWatch: () => void;
};

export function createApp(): AppCtx {
  ensureDirs();

  prompts.register(corePromptDefs());
  seedSkills();

  /* 一次性迁移：旧存档 settings.params.subagentMaxRounds → 子智能体插件参数 max_rounds。
     必须在建插件登记表**之前**做（否则读到的还是迁移前的 plugins.json）。 */
  const migratedSubRounds = migrateLegacySubagentRounds();
  if (migratedSubRounds) {
    // 让 settings 归一（旧字段消失）；插件登记表随后读到迁移后的值
    saveSettings(readSettings());
    log.info('已迁移旧的「子智能体轮次上限」到子智能体插件参数', { max_rounds: migratedSubRounds });
  }

  const plugins = createPluginRegistry();
  const resources = createResourceRegistry();

  /**
   * 外部资源的工具以"插件"形态进插件表（启用/参数/提示词统一管）。
   * 顺序有讲究：先让插件表注册自己的默认提示词，再让资源表覆盖同 id 的条目
   * （两个模块都会注册 `plugin.<id>.usage`，最后一次注册决定它在界面上归哪一组）。
   */
  const syncResources = (): void => {
    plugins.clearExternal();
    for (const def of resources.pluginDefs()) plugins.registerExternal(def);
    plugins.syncPromptDefs();
    resources.refresh();
  };
  plugins.syncPromptDefs();
  resources.refresh();
  syncResources();
  resources.setToolsChangedHook(() => syncResources());

  const auth = createAuth();
  const runs = createRunRegistry({
    plugins,
    prompts,
    resources,
    sudoPassword: () => auth.sudoPassword(),
  });

  void resources.startEnabled().catch((err) => log.warn('外部资源启动失败', { err: String(err) }));

  /**
   * 配置文件热加载（需求 3）：agent 用文件工具直接改 plugins/resources/prompts.json 就能
   * 新增或修改插件、外部资源、提示词，**不用重启**。解析失败时各 reload() 返回 false，
   * 内存里的旧状态保持不变（半截写入不会把配置清空）。
   */
  const watcher = watchFiles([PLUGINS_FILE, RESOURCES_FILE, PROMPTS_FILE], (file) => {
    try {
      if (file === PLUGINS_FILE) plugins.reload();
      else if (file === RESOURCES_FILE) resources.reload();
      else if (file === PROMPTS_FILE) prompts.reload();
      syncResources();
      log.info('检测到配置被外部改动，已热重载', { file });
    } catch (err) {
      log.warn('热重载失败（保留内存里的旧配置）', { file, err: String(err) });
    }
  });

  return { auth, prompts, plugins, resources, runs, syncResources, stopWatch: () => watcher.stop() };
}
