"use client";

import {
  Search,
  Trash2,
  Puzzle,
  Zap,
  FileText,
  Download,
  Loader2,
  Check,
  Wrench,
  ChevronDown,
} from "lucide-react";
import React, {
  useState,
  useMemo,
  useEffect,
  useCallback,
  useRef,
} from "react";
import { AgentsSettings } from "./agents-settings";
import { McpPanel } from "./mcp-panel";
import { PopupSelect } from "./settings-ui";
import { Button } from "@/components/ui/button";
import { helixApi } from "@/lib/electron-bridge";
import { useHelixStore } from "@/stores/helix-store";

interface InstalledItem {
  name: string;
  type: "extension" | "skill" | "prompt" | "tool" | "package";
  source: "pi" | "pi-rpc" | "pi-package" | "pi-npm" | "pi-tool" | "helix";
  description?: string;
  version?: string;
  path?: string;
  location?: string;
  /** npm: package id ("npm:<name>") for toggling via settings.json. */
  packageId?: string;
  /** Actual npm backend when a `-lite` wrapper is folded into its card. */
  packageName?: string;
  packagePath?: string;
  /** Whether the plugin's resources are currently loaded. */
  enabled?: boolean;
}

interface HelixSkill {
  id: string;
  name: string;
  description: string;
  isBuiltin: boolean;
  /** Where pi loads the skill from: "pi" (user root ~/.pi/agent/skills)
   * or the bundling npm package name. */
  source?: string;
  path: string;
  /** 技能是否启用。false = SKILL.md 已改名 SKILL.md.disabled，pi 不加载。 */
  isActive?: boolean;
  /** 面板能否给此技能开关启用/禁用（内置点目录为 false）。 */
  disableable?: boolean;
}

interface PackageResult {
  name: string;
  description: string;
  version: string;
  type: "extension" | "skill" | "theme" | "prompt" | "package";
  author: string;
  npmUrl: string;
  installCmd: string;
  downloads: number;
  date: string;
  /** pi.dev 上的详情页（后端会带，缺省不影响渲染） */
  piUrl?: string;
}

type TabKey = "plugins" | "skills" | "mcp" | "agents";

const typeLabels: Record<
  string,
  { label: string; color: string; icon: React.ReactNode }
> = {
  extension: {
    label: "扩展",
    color: "bg-violet-500/10 text-violet-500",
    icon: <Puzzle className="size-3" />,
  },
  skill: {
    label: "技能",
    color: "bg-emerald-500/10 text-emerald-500",
    icon: <Zap className="size-3" />,
  },
  prompt: {
    label: "提示模板",
    color: "bg-amber-500/10 text-amber-500",
    icon: <FileText className="size-3" />,
  },
  tool: {
    label: "工具",
    color: "bg-sky-500/10 text-sky-500",
    icon: <Wrench className="size-3" />,
  },
  package: {
    label: "包",
    color: "bg-blue-500/10 text-blue-500",
    icon: <Puzzle className="size-3" />,
  },
};

export function SkillPanel() {
  const [activeTab, setActiveTab] = useState<TabKey>("plugins");
  const [searchQuery, setSearchQuery] = useState("");
  const [showBrowse, setShowBrowse] = useState(false);
  const [sortBy, setSortBy] = useState<"downloads" | "date">("downloads");
  const [filterType, setFilterType] = useState<string>("all");

  // 页签计数与「添加」分发：连接器 / 智能体数量由子面板上报，
  // 添加动作通过递增序号传给子面板（0 = 从未触发）。
  const [mcpCount, setMcpCount] = useState(0);
  const [agentCount, setAgentCount] = useState(0);
  const [mcpAddRequest, setMcpAddRequest] = useState(0);
  const [agentAddRequest, setAgentAddRequest] = useState(0);
  const handleMcpCount = useCallback((n: number) => setMcpCount(n), []);
  const handleAgentCount = useCallback((n: number) => setAgentCount(n), []);
  const handleAddClick = useCallback(() => {
    if (activeTab === "plugins") setShowBrowse(true);
    else if (activeTab === "skills") {
      void (async () => {
        if (window.electron?.helixSkills) {
          const dir = await window.electron.helixSkills.getDir();
          if (dir) {
            window.electron.shell.showItemInFolder(dir);
          }
        }
      })();
    } else if (activeTab === "mcp") setMcpAddRequest((n) => n + 1);
    else if (activeTab === "agents") setAgentAddRequest((n) => n + 1);
  }, [activeTab]);

  // Plugins state
  const [items, setItems] = useState<InstalledItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Browse state
  const [browseQuery, setBrowseQuery] = useState("");
  const [searchResults, setSearchResults] = useState<PackageResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  /** 目录筛选后的总命中数（服务端算好；null = 还没拿到/没筛选） */
  const [total, setTotal] = useState<number | null>(null);
  /** 当前已加载到第几页（1 起） */
  const [page, setPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(null);

  // Skills state
  const [skills, setSkills] = useState<HelixSkill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);

  // ── Plugins ──
  // 插件更新检查：piCheckUpdates 一次拿回全部 npm 插件的最新版本，
  // 有更新的卡片在开关右侧显示「更新」按钮。列表首次加载后自动查一次
  // （后台跑，不阻塞列表渲染）；点头部按钮 = 手动复查，反馈更完整。
  const [latestMap, setLatestMap] = useState<Record<string, string>>({});
  const [, setCheckingUpdates] = useState(false);
  // 点击「更新」按钮后弹确认框：name → {installed, latest}
  const [updateFound, setUpdateFound] = useState<{
    name: string;
    installed: string;
    latest: string;
  } | null>(null);

  const checkUpdates = useCallback(async (manual: boolean) => {
    const api = helixApi();
    if (!api?.piCheckUpdates) {
      // 静默返回会让按钮「点了没反应」——必须给出可诊断的反馈。
      if (manual) {
        useHelixStore.getState().showToast({
          type: "error",
          title: "检查更新失败",
          description: "当前后端不支持 piCheckUpdates",
        });
      }
      return;
    }
    setCheckingUpdates(true);
    try {
      const res = await api.piCheckUpdates();
      const packages: {
        name: string;
        installed: string;
        latest: string | null;
        hasUpdate?: boolean;
      }[] = (Array.isArray(res?.packages) ? res.packages : []).filter(
        (p) => p.name !== "@zhushanwen/pi-permission",
      );
      const map: Record<string, string> = {};
      const outdated: string[] = [];
      let failed = 0;
      for (const p of packages) {
        if (p.latest) map[p.name] = p.latest;
        else failed++;
        if (p.hasUpdate)
          outdated.push(`${p.name} v${p.installed} → v${p.latest}`);
      }
      setLatestMap(map);
      const showToast = useHelixStore.getState().showToast;
      // 自动检查（后台填充「更新」按钮数据）一律不弹 toast；
      // 结果类/失败类反馈只在手动检查时给。
      if (manual && outdated.length > 0) {
        showToast({
          type: "info",
          title: `${outdated.length} 个插件可更新`,
          description:
            outdated.slice(0, 3).join("\n") +
            (outdated.length > 3 ? `\n…等 ${outdated.length} 个` : ""),
          duration: 10000,
        });
      } else if (manual) {
        if (failed > 0) {
          showToast({
            type: "error",
            title: "部分插件查询失败",
            description: `${failed}/${packages.length} 个包没能从 npm 拿到最新版本（网络问题），稍后再试`,
          });
        } else if (packages.length > 0) {
          showToast({
            type: "success",
            title: "插件已是最新",
            description: `已检查 ${packages.length} 个 npm 插件`,
          });
        } else {
          showToast({
            type: "info",
            title: "没有可检查的插件",
            description: "仅本地扩展不走 npm，无法检查更新",
          });
        }
      }
    } catch (e) {
      if (manual) {
        useHelixStore.getState().showToast({
          type: "error",
          title: "检查更新失败",
          description: e instanceof Error ? e.message : String(e),
        });
      }
    } finally {
      setCheckingUpdates(false);
    }
  }, []);

  const loadItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const api = helixApi();
      if (!api?.piListInstalled) throw new Error("Pi 网关不可用");
      const res = await api.piListInstalled();
      const list: InstalledItem[] = Array.isArray(res?.items) ? res.items : [];
      const seen = new Set<string>();
      setItems(
        list.filter((item) => {
          const key = `${item.type}:${item.name}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }),
      );
      // 版本比对结果跟随列表：清掉旧的，再后台自动查一轮（有更新的卡片
      // 会亮出「更新」按钮；全军覆没时 checkUpdates 会弹错误提示）。
      setLatestMap({});
      void checkUpdates(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [checkUpdates]);

  // 拉 pi.dev 官方目录。
  //
  // 与旧实现的差别（都值得记住）：
  // 1. **不再需要「`-` 换空格再搜一遍」的 hack** —— 那是 npm 搜索分词器的怪癖
  //    （搜 `lens` 匹配不到 `pi-lens`）；pi.dev 的 `name` 是子串匹配，天然没这问题。
  // 2. **类型筛选 / 排序 / 分页下推服务端**。以前在前端对 20 条结果做过滤和排序，
  //    过滤完常常只剩 0-2 条，且顺序不是全局序。现在交给服务端，翻页才能真的看到全量。
  // 3. **空 query 返回最热门**（旧实现直接清空，等于白屏）。浏览页默认就有内容。
  const doSearch = useCallback(
    async (opts?: { append?: boolean }) => {
      const append = !!opts?.append;
      if (!append) {
        setPage(1);
        setTotal(null);
      }
      const targetPage = append ? page + 1 : 1;
      if (!append) setSearchLoading(true);
      else setLoadingMore(true);
      try {
        const api = helixApi();
        if (!api?.piSearchPackages) return;
        const res = await api.piSearchPackages(
          browseQuery.trim(),
          filterType === "all" ? "" : filterType,
          sortBy === "date" ? "recent" : sortBy,
          targetPage,
        );
        const list: PackageResult[] = Array.isArray(res?.packages)
          ? res.packages
          : [];
        setTotal(typeof res?.total === "number" ? res.total : null);
        setPage(targetPage);
        setSearchResults((prev) => {
          if (!append) return list;
          // 翻页去重：目录内容可能在两次请求之间变动
          const seen = new Set(prev.map((p) => p.name));
          return [...prev, ...list.filter((p) => !seen.has(p.name))];
        });
      } catch {
        if (!append) {
          setSearchResults([]);
          setTotal(null);
        }
      } finally {
        setSearchLoading(false);
        setLoadingMore(false);
      }
    },
    [browseQuery, filterType, sortBy, page],
  );

  // 打开浏览页时若还没拉过内容，先取一次最热门（空 query）。
  useEffect(() => {
    if (!showBrowse) return;
    if (searchResults.length > 0 || searchLoading) return;
    void doSearch();
    // 只在「从无到有」这一刻触发一次；后续翻页/改筛选由各自 handler 驱动。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showBrowse]);

  const handleBrowseSearchChange = useCallback(
    (value: string) => {
      setBrowseQuery(value);
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      searchTimerRef.current = setTimeout(() => void doSearch(), 400);
    },
    [doSearch],
  );

  // 改类型 / 排序都直接重新查询（服务端筛选排序，前端不再做二次过滤）
  const handleFilterTypeChange = useCallback(
    (value: string) => {
      setFilterType(value);
      setTimeout(() => void doSearch(), 0);
    },
    [doSearch],
  );
  const handleSortChange = useCallback(
    (value: string) => {
      setSortBy(value as typeof sortBy);
      setTimeout(() => void doSearch(), 0);
    },
    [doSearch],
  );

  const handleInstall = useCallback(
    async (pkgName: string) => {
      setInstalling(pkgName);
      try {
        const api = helixApi();
        if (!api?.piInstallPackage) return;
        await api.piInstallPackage(pkgName);
        await loadItems();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setInstalling(null);
      }
    },
    [loadItems],
  );

  const handleUninstall = useCallback(
    async (item: InstalledItem) => {
      const pkgName = item.packageName ?? item.name;
      setInstalling(item.name);
      try {
        const api = helixApi();
        if (!api?.piUninstallPackage) return;
        await api.piUninstallPackage(pkgName);
        await loadItems();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setInstalling(null);
      }
    },
    [loadItems],
  );

  // 「更新」按钮确认后的实际更新：`pi install npm:<pkg>` 对已安装包就是升级
  // 到最新，复用 piInstallPackage。更新后 pi 会重新加载插件。
  const handleUpdatePlugin = useCallback(
    async (pkgName: string) => {
      setUpdateFound(null);
      setInstalling(pkgName);
      try {
        const api = helixApi();
        if (!api?.piInstallPackage) return;
        await api.piInstallPackage(pkgName);
        await loadItems();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setInstalling(null);
      }
    },
    [loadItems],
  );

  const isInstalled = useCallback(
    (pkgName: string) =>
      items.some((i) => i.name === pkgName || i.packageName === pkgName),
    [items],
  );

  // ── 启用/禁用插件 ──
  // 点击开关后写入 ~/.pi/agent/settings.json（后端负责重启网关生效）。
  // 支持两类插件：
  // - pi-npm：传 packageId（"npm:<name>"），由后端改 packages 列表；
  // - pi / pi-package（本地扩展）：传相对 agent 目录的路径 pattern
  //   （如 "extensions/foo.ts"），后端用 +/- 覆盖模式写 extensions 数组。
  const [togglingName, setTogglingName] = useState<string | null>(null);
  const toggleEnabled = useCallback(
    async (item: InstalledItem, next: boolean) => {
      // 计算传给后端的标识：优先 packageId，其次本地扩展的相对路径
      let identifier = item.packageId;
      if (!identifier) {
        if (item.source === "pi-npm") {
          identifier = `npm:${item.name}`;
        } else if (
          (item.source === "pi" || item.source === "pi-package") &&
          item.path
        ) {
          // 本地扩展 / 本地扩展包：转为 ~/.pi/agent 相对路径（posix 风格）。
          // 这些是自动发现的顶级资源，由 settings.json 的 extensions 数组
          // （+/- 覆盖模式）控制，而非 packages 列表。
          const marker = ".pi/agent/";
          const posix = item.path.replace(/\\/g, "/");
          const idx = posix.lastIndexOf(marker);
          if (idx !== -1) {
            identifier = posix.slice(idx + marker.length);
          }
        }
      }
      if (!identifier) return;

      setTogglingName(item.name);
      try {
        const api = helixApi();
        if (!api?.piSetPackageEnabled) {
          throw new Error("当前后端不支持插件启停");
        }
        // 乐观更新：先切状态，失败再回滚
        setItems((prev) =>
          prev.map((i) =>
            i.name === item.name && i.type === item.type
              ? { ...i, enabled: next }
              : i,
          ),
        );
        await api.piSetPackageEnabled(identifier, next);
        await loadItems();
      } catch (e) {
        // 回滚
        setItems((prev) =>
          prev.map((i) =>
            i.name === item.name && i.type === item.type
              ? { ...i, enabled: !next }
              : i,
          ),
        );
        const msg = e instanceof Error ? e.message : String(e);
        useHelixStore.getState().showToast({
          type: "error",
          title: next ? "启用失败" : "禁用失败",
          description: msg,
        });
      } finally {
        setTogglingName(null);
      }
    },
    [loadItems],
  );

  // ── Skills ──
  const loadSkills = async () => {
    setSkillsLoading(true);
    try {
      const list = await window.electron?.helixSkills.listSkills();
      if (Array.isArray(list)) setSkills(list);
    } catch (e) {
      console.error("loadSkills error:", e);
    }
    setSkillsLoading(false);
  };

  useEffect(() => {
    if (activeTab === "plugins") {
      void loadItems();
    } else if (activeTab === "skills") {
      void loadSkills();
    }
  }, [activeTab, loadItems]);

  useEffect(() => {
    const handleFocus = () => {
      if (activeTab === "skills") void loadSkills();
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [activeTab]);

  // 开关技能「启用 / 禁用」：把正文文件在 SKILL.md ↔ SKILL.md.disabled 之间
  // 改名。禁用后 pi 根本不加载这个技能（不进 prompt、也不能 /skill:name 触发），
  // 随时可开回来，正文一字未动。
  // 改名后后端触发网关 respawn，当前会话也会重新加载技能；有对话在跑时重启
  // 会被延后到对话结算完，不打断在飞的 run。
  const [togglingSkillId, setTogglingSkillId] = useState<string | null>(null);
  const onToggleSkillEnabled = async (skill: HelixSkill) => {
    const next = !(skill.isActive !== false);
    setTogglingSkillId(skill.id);
    // 乐观更新：先切 UI，失败再回滚
    setSkills((prev) =>
      prev.map((s) => (s.id === skill.id ? { ...s, isActive: next } : s)),
    );
    try {
      const r = await window.electron?.helixSkills?.setSkillEnabled(
        skill.path,
        next,
      );
      if (!r) {
        useHelixStore.getState().showToast({
          type: "error",
          title: "当前环境不支持",
          description: "本地后端未提供技能启停命令",
        });
        setSkills((prev) =>
          prev.map((s) =>
            s.id === skill.id ? { ...s, isActive: !next } : s,
          ),
        );
        return;
      }
      setSkills((prev) =>
        prev.map((s) =>
          s.id === skill.id ? { ...s, isActive: r.enabled } : s,
        ),
      );
      useHelixStore.getState().showToast({
        type: "success",
        title: r.enabled ? "已启用技能" : "已禁用技能",
        description: r.deferred
          ? "有对话正在运行，等它结束后自动重启生效"
          : "正在重启网关生效",
      });
    } catch (e) {
      setSkills((prev) =>
        prev.map((s) => (s.id === skill.id ? { ...s, isActive: !next } : s)),
      );
      console.error("toggleSkillEnabled error:", e);
      useHelixStore.getState().showToast({
        type: "error",
        title: "修改失败",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTogglingSkillId(null);
    }
  };

  const onDeleteSkill = async (skill: HelixSkill) => {
    if (skill.isBuiltin) return;
    setSkillsLoading(true);
    try {
      await window.electron?.helixSkills.deleteDir(skill.path);
      await loadSkills();
    } catch (e) {
      console.error("deleteSkill error:", e);
    }
    setSkillsLoading(false);
  };

  // ── Filtered data ──
  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return items.filter((item) => {
      // Only extensions are listed here; skills, prompts and registerTool tools are hidden.
      if (item.type !== "extension") return false;
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        (item.description || "").toLowerCase().includes(q)
      );
    });
  }, [items, searchQuery]);

  const filteredSkills = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return skills.filter((s) => {
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        (s.description || "").toLowerCase().includes(q)
      );
    });
  }, [skills, searchQuery]);

  const extensions = filteredItems.filter((i) => i.type === "extension");

  // ── Browse 结果 ──
  // 类型筛选与排序都已下推给 pi.dev（见 doSearch 注释），这里**不再**做前端
  // 二次过滤/排序 —— 那会把「服务端全局序」打乱成「本页内序」，翻页时顺序跳变。
  const hasMore = total != null && searchResults.length < total;

  // ── Render helpers ──
  const renderItem = (item: InstalledItem, idx: number) => {
    // 有可用更新的 npm 插件：在开关右侧显示「更新」按钮（打开确认弹窗）。
    const updateName = item.packageName ?? item.name;
    const latest = latestMap[updateName] ?? latestMap[item.name];
    const hasUpdate =
      item.source === "pi-npm" &&
      updateName !== "@zhushanwen/pi-permission" &&
      !!item.version &&
      !!latest &&
      latest !== item.version;
    // 启停开关：npm 包（pi-npm）与本地扩展（pi/pi-package）支持；
    // pi-rpc（提示模板）、helix 源与 tool（registerTool 静态声明）不支持——
    // 工具的开关等同于关闭宿主扩展本身。
    const canToggle =
      item.type === "extension" &&
      (item.source === "pi-npm" ||
        item.source === "pi-package" ||
        (item.source === "pi" && !!item.path));
    const isTool = item.type === "tool";
    const isEnabled = item.enabled !== false;
    const isToggling = togglingName === item.name;
    return (
      <div
        key={`${item.type}:${item.name}:${idx}`}
        className={`flex items-start gap-3 p-3 rounded-xl border border-border/50 bg-card/50 hover:bg-accent/30 transition-colors ${!isEnabled ? "opacity-50" : ""}`}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[length:var(--helix-transcript-size)] font-medium text-foreground">
              {item.name}
            </span>
            {!isEnabled && (
              <span className="text-[calc(var(--helix-transcript-size)*0.7143)] px-1.5 py-0.5 rounded bg-muted/60 text-muted-foreground/70">
                已禁用
              </span>
            )}
          </div>
          {item.description && (
            <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70 mt-0.5">
              {item.description}
            </p>
          )}
        </div>
        <div className="shrink-0 flex items-center gap-2">
          {hasUpdate && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setUpdateFound({
                  name: updateName,
                  installed: item.version ?? "",
                  latest: latest!,
                });
              }}
              className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg text-[calc(var(--helix-transcript-size)*0.7143)] text-primary bg-primary/10 hover:bg-primary/20 transition-colors"
              data-tip={`更新至 v${latest}`}
            >
              <Download className="size-3.5" />
              更新
            </button>
          )}
          {canToggle && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (!isToggling) void toggleEnabled(item, !isEnabled);
              }}
              disabled={isToggling}
              className={`relative w-10 h-6 rounded-full transition-colors duration-200 ${
                isEnabled ? "bg-primary" : "bg-muted-foreground/20"
              } disabled:opacity-50`}
              data-tip={isEnabled ? "点击禁用插件" : "点击启用插件"}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform duration-200 ${
                  isEnabled ? "translate-x-4" : ""
                }`}
              />
            </button>
          )}
          {item.source !== "helix" &&
            !isTool &&
            item.type !== "skill" &&
            item.type !== "prompt" && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void handleUninstall(item);
                }}
                disabled={installing === item.name}
                className="shrink-0 p-1.5 rounded text-muted-foreground/40 hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                data-tip="卸载"
              >
                {installing === item.name ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Trash2 className="size-3.5" />
                )}
              </button>
            )}
        </div>
      </div>
    );
  };

  const renderSection = (
    title: string,
    sectionItems: InstalledItem[],
    icon: React.ReactNode,
  ) => {
    if (sectionItems.length === 0) return null;
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 px-1 pb-1">
          {icon}
          <h3 className="text-[calc(var(--helix-transcript-size)*0.8571)] font-medium text-muted-foreground/70">
            {title}
          </h3>
          <span className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/40 font-mono">
            {sectionItems.length}
          </span>
        </div>
        {sectionItems.map((item, i) => renderItem(item, i))}
      </div>
    );
  };

  const renderPackageResult = (pkg: PackageResult) => {
    const installed = isInstalled(pkg.name);
    const pkgType = pkg.type || "package";
    const meta = typeLabels[pkgType] ?? typeLabels.extension;
    const formatDownloads = (n: number) => {
      if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
      if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
      return String(n);
    };
    const formatDate = (d: string) => {
      if (!d) return "";
      const date = new Date(d);
      const now = new Date();
      const diff = now.getTime() - date.getTime();
      const days = Math.floor(diff / (1000 * 60 * 60 * 24));
      if (days === 0) return "今天";
      if (days === 1) return "昨天";
      if (days < 7) return `${days}天前`;
      if (days < 30) return `${Math.floor(days / 7)}周前`;
      if (days < 365) return `${Math.floor(days / 30)}月前`;
      return `${Math.floor(days / 365)}年前`;
    };
    return (
      <div
        key={pkg.name}
        className="flex items-start gap-3 p-3 rounded-xl border border-border/50 bg-card/50 hover:bg-accent/30 transition-colors"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[length:var(--helix-transcript-size)] font-medium text-foreground">
              {pkg.name}
            </span>
            <span
              className={`text-[calc(var(--helix-transcript-size)*0.7143)] px-1.5 py-0.5 rounded ${meta.color}`}
            >
              {meta.label}
            </span>
            {pkg.version && (
              <span className="text-[calc(var(--helix-transcript-size)*0.7143)] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono">
                v{pkg.version}
              </span>
            )}
            {pkg.author && (
              <span className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/50">
                by {pkg.author}
              </span>
            )}
          </div>
          {pkg.description && (
            <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70 mt-0.5">
              {pkg.description}
            </p>
          )}
          <div className="flex items-center gap-3 mt-1">
            {pkg.downloads > 0 && (
              <span className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/40">
                {formatDownloads(pkg.downloads)} 周下载
              </span>
            )}
            {pkg.date && (
              <span className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/40">
                {formatDate(pkg.date)}
              </span>
            )}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-1.5">
          {installed ? (
            <span className="flex items-center gap-1 text-[calc(var(--helix-transcript-size)*0.7143)] px-2 py-1 rounded bg-emerald-500/10 text-emerald-500">
              <Check className="size-3" />
              已安装
            </span>
          ) : (
            <button
              onClick={() => handleInstall(pkg.name)}
              disabled={installing === pkg.name}
              className="flex items-center gap-1 text-[calc(var(--helix-transcript-size)*0.7143)] px-2 py-1 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-50"
            >
              {installing === pkg.name ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Download className="size-3" />
              )}
              安装
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="w-full">
      <div className="pb-5 border-b border-border/40">
        <h1 className="ui-title font-semibold text-foreground tracking-tight">
          扩展管理
        </h1>
        <p className="ui-text text-muted-foreground/60 mt-1">
          管理本机已安装的插件、技能、连接器和智能体。
        </p>

        {!showBrowse ? (
          <div className="flex items-center justify-between gap-3 mt-5">
            {/* Tab pills — 插件 / 技能 / 连接器 / 智能体，带已安装计数 */}
            <div className="inline-flex items-center rounded-xl bg-muted/60 p-1">
              {(
                [
                  { key: "plugins", label: "插件", count: extensions.length },
                  { key: "skills", label: "技能", count: skills.length },
                  { key: "mcp", label: "MCP", count: mcpCount },
                  { key: "agents", label: "子智能体", count: agentCount },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`flex items-center gap-2 px-3.5 h-8 rounded-lg text-[length:var(--helix-transcript-size)] transition-all ${
                    activeTab === tab.key
                      ? "bg-background shadow-sm border border-border/60 text-foreground font-medium"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  data-tip={
                    tab.key === "mcp"
                      ? "管理 MCP 连接器"
                      : tab.key === "agents"
                        ? "管理子智能体"
                        : undefined
                  }
                >
                  {tab.label}
                  <span className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/60">
                    {tab.count}
                  </span>
                </button>
              ))}
            </div>

            {/* Search + add — 添加按页签分发（插件=浏览市场 / 技能=打开目录 /
                连接器=打开添加表单 / 智能体=新增子智能体草稿） */}
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="搜索已安装项"
                  className="w-64 h-10 pl-9 pr-3 rounded-xl border border-border/60 bg-background text-[length:var(--helix-transcript-size)] transition-all"
                />
              </div>
              <Button
                variant="outline"
                onClick={handleAddClick}
                className="h-10 rounded-xl"
              >
                添加
              </Button>
            </div>
          </div>
        ) : (
          /* Browse 中头部右侧给出返回入口（市场按钮顶部已无） */
          <div className="flex justify-end mt-5">
            <Button
              variant="outline"
              onClick={() => setShowBrowse(false)}
              className="h-10 rounded-xl"
            >
              返回
            </Button>
          </div>
        )}
      </div>

      <div className="pt-2 pb-8">
        {activeTab === "mcp" ? (
          <McpPanel
            onCount={handleMcpCount}
            addRequest={mcpAddRequest}
            searchQuery={searchQuery}
          />
        ) : activeTab === "plugins" ? (
            showBrowse ? (
              <>
                {/* Browse view */}
                <div className="flex items-center gap-2 mb-4">
                  <div className="relative flex-1 flex justify-center">
                    <Search className="absolute left-[calc(2.5%+12px)] top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
                    <input
                      type="text"
                      value={browseQuery}
                      onChange={(e) => handleBrowseSearchChange(e.target.value)}
                      placeholder="搜索 pi.dev 上的 Pi 插件..."
                      className="w-[95%] h-10 pl-10 pr-4 rounded border border-border/60 bg-card/40 text-[length:var(--helix-transcript-size)] transition-all"
                    />
                    {searchLoading && (
                      <Loader2 className="absolute right-3.5 top-1/2 -translate-y-1/2 size-4 animate-spin text-muted-foreground" />
                    )}
                  </div>
                  <PopupSelect
                    value={filterType}
                    onChange={handleFilterTypeChange}
                    className="h-10 min-w-[110px] rounded border border-border/60 bg-background text-[length:var(--helix-transcript-size)] text-muted-foreground transition-all"
                    options={[
                      { label: "全部类型", value: "all" },
                      { label: "扩展", value: "extension" },
                      { label: "技能", value: "skill" },
                      { label: "主题", value: "theme" },
                      { label: "提示模板", value: "prompt" },
                    ]}
                  />
                  <PopupSelect
                    value={sortBy}
                    onChange={handleSortChange}
                    className="h-10 min-w-[130px] rounded border border-border/60 bg-background text-[length:var(--helix-transcript-size)] text-muted-foreground transition-all"
                    options={[
                      { label: "最多下载", value: "downloads" },
                      { label: "最近更新", value: "date" },
                    ]}
                  />
                </div>

                {searchResults.length > 0 ? (
                  <div className="space-y-1.5">
                    <p className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/50 px-1">
                      {total != null ? `共 ${total} 个包` : "结果"}
                      {searchResults.length < (total ?? 0) &&
                        `（已显示 ${searchResults.length}）`}
                      <span className="text-muted-foreground/30 ml-1.5">
                        来源 pi.dev
                      </span>
                    </p>
                    {searchResults.map((pkg) => renderPackageResult(pkg))}
                    {hasMore && (
                      <div className="flex justify-center pt-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1.5"
                          disabled={loadingMore}
                          onClick={() => void doSearch({ append: true })}
                        >
                          {loadingMore ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <ChevronDown className="size-3" />
                          )}
                          {loadingMore ? "加载中" : "加载更多"}
                        </Button>
                      </div>
                    )}
                  </div>
                ) : searchLoading ? null : (
                  <div className="text-center py-12 text-[length:var(--helix-transcript-size)] text-muted-foreground/60">
                    未找到相关插件
                  </div>
                )}
              </>
            ) : (
              <>
                {/* Installed view */}
                {loading && items.length === 0 ? (
                  <div className="text-center py-12 text-[length:var(--helix-transcript-size)] text-muted-foreground/60 flex items-center justify-center gap-2">
                    <Loader2 className="size-4 animate-spin" /> 加载中...
                  </div>
                ) : error ? (
                  <div className="text-center py-12 text-[length:var(--helix-transcript-size)] text-red-500/80">
                    <p>{error}</p>
                    <button
                      onClick={() => void loadItems()}
                      className="mt-3 px-3 py-1.5 rounded-lg bg-primary/10 text-primary text-[calc(var(--helix-transcript-size)*0.8571)] font-medium hover:bg-primary/20 transition-colors"
                    >
                      重试
                    </button>
                  </div>
                ) : filteredItems.length === 0 ? (
                  <div className="text-center py-12 text-[length:var(--helix-transcript-size)] text-muted-foreground/60">
                    暂无插件，点击右上角 + 浏览安装
                  </div>
                ) : (
                  <div className="space-y-5">
                    {renderSection("扩展", extensions, null)}
                  </div>
                )}
              </>
            )
          ) : activeTab === "agents" ? (
            <AgentsSettings onCount={handleAgentCount} addRequest={agentAddRequest} />
          ) : (
            <>
              {/* Skills tab */}
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-[length:var(--helix-transcript-size)] font-semibold text-foreground">
                  已安装 ({filteredSkills.length})
                </h2>
              </div>

              {(
                <div className="space-y-2">
                  {filteredSkills.map((skill) => {
                    const isActive = skill.isActive !== false;
                    const isSkillToggling = togglingSkillId === skill.id;
                    return (
                    <div
                      key={skill.id}
                      className={`flex items-center gap-3 p-3 rounded-xl border border-border/50 bg-card/50 hover:bg-accent/30 hover:border-border transition-colors ${!isActive ? "opacity-50" : ""}`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-[length:var(--helix-transcript-size)] font-medium text-foreground truncate">
                            {skill.name}
                          </p>
                          {!isActive && (
                            <span className="text-[calc(var(--helix-transcript-size)*0.7143)] px-1.5 py-0.5 rounded bg-muted/60 text-muted-foreground/70">
                              已禁用
                            </span>
                          )}
                          {skill.source && (
                            <span
                              className="text-[calc(var(--helix-transcript-size)*0.7143)] px-1.5 py-0.5 rounded bg-primary/10 text-primary/80 font-mono"
                              data-tip={`来源: ${skill.source}`}
                            >
                              {skill.source}
                            </span>
                          )}
                        </div>
                        {skill.description && (
                          <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70 truncate mt-0.5">
                            {skill.description}
                          </p>
                        )}
                      </div>
                      {skill.disableable !== false && (
                        <button
                          onClick={() => void onToggleSkillEnabled(skill)}
                          disabled={isSkillToggling}
                          className={`shrink-0 relative w-10 h-6 rounded-full transition-colors duration-200 disabled:opacity-50 ${
                            isActive ? "bg-primary" : "bg-muted-foreground/20"
                          }`}
                        >
                          <span
                            className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform duration-200 ${
                              isActive ? "translate-x-4" : ""
                            }`}
                          />
                        </button>
                      )}
                      {!skill.isBuiltin && (
                        <button
                          onClick={() => void onDeleteSkill(skill)}
                          className="shrink-0 p-1.5 rounded text-muted-foreground/40 hover:text-red-500 hover:bg-red-500/10 transition-colors"
                          data-tip="删除"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      )}
                    </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
      </div>

      {/* Plugin update confirmation dialog */}
      {updateFound && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center animate-fade-in">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setUpdateFound(null)}
          />
          <div className="relative bg-popover border border-border/40 rounded-2xl shadow-2xl w-96 mx-4 p-6 space-y-4 animate-scale-in">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                <Download className="size-5 text-primary" />
              </div>
              <div>
                <h3 className="text-[length:var(--helix-transcript-size)] font-semibold text-foreground">
                  插件有新版本
                </h3>
              </div>
            </div>
            <div className="flex justify-between gap-2">
              <button
                onClick={() => void handleUpdatePlugin(updateFound.name)}
                disabled={installing === updateFound.name}
                className="px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.9286)] text-primary-foreground bg-primary hover:bg-primary/90 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5"
              >
                {installing === updateFound.name && (
                  <Loader2 className="size-3.5 animate-spin" />
                )}
                更新
              </button>
              <button
                onClick={() => setUpdateFound(null)}
                className="px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.9286)] text-foreground/70 hover:text-foreground hover:bg-accent rounded-lg transition-colors"
              >
                稍后再说
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
