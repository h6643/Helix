"use client";

import {
  X,
  Search,
  Trash2,
  Puzzle,
  Zap,
  FileText,
  Download,
  Loader2,
  Check,
} from "lucide-react";
import React, {
  useState,
  useMemo,
  useEffect,
  useCallback,
  useRef,
} from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { helixApi } from "@/lib/electron-bridge";
import { useHelixStore } from "@/stores/helix-store";

interface SkillPanelProps {}

interface InstalledItem {
  name: string;
  type: "extension" | "skill" | "prompt" | "package";
  source: "pi" | "pi-rpc" | "pi-package" | "pi-npm" | "helix";
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
  /** Where pi loads the skill from: "pi" (user root), "memory"
   * (pi-hermes-memory extension managed), or the bundling npm package name. */
  source?: string;
  path: string;
  callCount: number;
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
}

type TabKey = "plugins" | "skills";

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
  package: {
    label: "包",
    color: "bg-blue-500/10 text-blue-500",
    icon: <Puzzle className="size-3" />,
  },
};

export function SkillPanel({}: SkillPanelProps) {
  const [activeTab, setActiveTab] = useState<TabKey>("plugins");
  const [searchQuery, setSearchQuery] = useState("");
  const [showBrowse, setShowBrowse] = useState(false);
  const [sortBy, setSortBy] = useState<"downloads" | "date">("downloads");
  const [filterType, setFilterType] = useState<string>("all");

  // Plugins state
  const [items, setItems] = useState<InstalledItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Browse state
  const [browseQuery, setBrowseQuery] = useState("");
  const [searchResults, setSearchResults] = useState<PackageResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(null);

  // Skills state
  const [skills, setSkills] = useState<HelixSkill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);

  // ── Plugins ──
  // 插件更新检查：piCheckUpdates 一次拿回全部 npm 插件的最新版本，
  // 有更新的卡片在开关右侧显示「更新」按钮。
  const [latestMap, setLatestMap] = useState<Record<string, string>>({});
  // 点击「更新」按钮后弹确认框：name → {installed, latest}
  const [updateFound, setUpdateFound] = useState<{
    name: string;
    installed: string;
    latest: string;
  } | null>(null);

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
      // 插件更新检查已禁用
      setLatestMap({});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const doSearch = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }
    setSearchLoading(true);
    try {
      const api = helixApi();
      if (!api?.piSearchPackages) return;
      // npm 搜索 API 将 "-" 视为分隔符，所以搜索 "lens" 不会匹配到 "pi-lens"。
      // 为了提高搜索结果的准确性，我们同时搜索原始查询和替换 "-" 为空格后的查询，
      // 然后合并结果并去重。
      const normalizedQuery = query.replace(/-/g, " ");
      const [res1, res2] = await Promise.all([
        api.piSearchPackages(query),
        normalizedQuery !== query
          ? api.piSearchPackages(normalizedQuery)
          : null,
      ]);
      const packages1 = Array.isArray(res1?.packages) ? res1.packages : [];
      const packages2 = Array.isArray(res2?.packages) ? res2.packages : [];
      const seen = new Set<string>();
      const merged: PackageResult[] = [];
      for (const pkg of [...packages1, ...packages2]) {
        if (!seen.has(pkg.name)) {
          seen.add(pkg.name);
          merged.push(pkg);
        }
      }
      setSearchResults(merged);
    } catch {
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }, []);

  const handleBrowseSearchChange = useCallback(
    (value: string) => {
      setBrowseQuery(value);
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      searchTimerRef.current = setTimeout(() => void doSearch(value), 400);
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
        useHelixStore.getState().showToast({
          type: "success",
          title: next ? "插件已启用" : "插件已禁用",
          description: `${item.name} — 网关正在重启使配置生效`,
        });
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
    } else {
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
      // Only show extensions, hide skills and prompts
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

  // ── Browse: filtered + sorted results ──
  const filteredResults = useMemo(() => {
    let list = [...searchResults];
    if (filterType !== "all") {
      list = list.filter((pkg) => pkg.type === filterType);
    }
    list.sort((a, b) => {
      if (sortBy === "downloads")
        return (b.downloads || 0) - (a.downloads || 0);
      if (sortBy === "date") return (b.date || "").localeCompare(a.date || "");
      return 0;
    });
    return list;
  }, [searchResults, filterType, sortBy]);

  // ── Render helpers ──
  const renderItem = (item: InstalledItem, idx: number) => {
    const meta = typeLabels[item.type] ?? typeLabels.extension;
    // 有可用更新的 npm 插件：在开关右侧显示「更新」按钮（打开确认弹窗）。
    const updateName = item.packageName ?? item.name;
    const latest = latestMap[updateName];
    const hasUpdate =
      item.source === "pi-npm" &&
      !!item.version &&
      !!latest &&
      latest !== item.version;
    // 启停开关：npm 包（pi-npm）与本地扩展（pi/pi-package）支持；
    // pi-rpc（提示模板）与 helix 源不支持。
    const canToggle =
      item.type === "extension" &&
      (item.source === "pi-npm" ||
        item.source === "pi-package" ||
        (item.source === "pi" && !!item.path));
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
              title={`更新至 v${latest}`}
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
              title={isEnabled ? "点击禁用插件" : "点击启用插件"}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform duration-200 ${
                  isEnabled ? "translate-x-4" : ""
                }`}
              />
            </button>
          )}
          {item.source !== "helix" &&
            item.type !== "skill" &&
            item.type !== "prompt" && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void handleUninstall(item);
                }}
                disabled={installing === item.name}
                className="shrink-0 p-1.5 rounded text-muted-foreground/40 hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                title="卸载"
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
    <div className="h-full w-full flex flex-col bg-background">
      {/* Header — big title + action, search below (same layout as the
          scheduled tasks panel). 40px top padding clears the window controls. */}
      <div className="px-6 pt-10 pb-4 shrink-0 border-b border-border/40">
        <div className="flex items-center justify-between">
          <h1 className="ui-title font-semibold text-foreground tracking-tight">
            插件中心
          </h1>
          <div className="flex items-center gap-1">
            {activeTab === "plugins" && (
              <button
                onClick={() => setShowBrowse(!showBrowse)}
                className={`p-1.5 rounded hover:bg-accent/60 transition-colors ${
                  showBrowse
                    ? "text-primary bg-primary/10"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                data-tip="浏览安装"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M5 12h14" />
                  <path d="M12 5v14" />
                </svg>
              </button>
            )}
            {activeTab === "skills" && (
              <button
                onClick={async () => {
                  if (window.electron?.helixSkills) {
                    const dir = await window.electron.helixSkills.getDir();
                    if (dir) {
                      window.electron.shell.showItemInFolder(dir);
                    }
                  }
                }}
                className="p-1.5 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors"
                data-tip="打开技能目录"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M5 12h14" />
                  <path d="M12 5v14" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {!showBrowse && (
          <div className="relative mt-3">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索插件..."
              className="w-full h-10 pl-10 pr-4 rounded-full border border-border/60 bg-background text-[length:var(--helix-transcript-size)] focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 transition-all"
            />
          </div>
        )}
      </div>

      <ScrollArea className="flex-1">
        <div className="max-w-3xl mx-auto px-6 pt-2 pb-8">
          {activeTab === "plugins" ? (
            showBrowse ? (
              <>
                {/* Browse view */}
                <div className="flex items-center gap-2 mb-4">
                  <div className="relative flex-1">
                    <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                    <input
                      type="text"
                      value={browseQuery}
                      onChange={(e) => handleBrowseSearchChange(e.target.value)}
                      placeholder="搜索 npm 上的 Pi 插件..."
                      className="w-full h-10 pl-10 pr-4 rounded border border-border/60 bg-background text-[length:var(--helix-transcript-size)] focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 transition-all"
                    />
                    {searchLoading && (
                      <Loader2 className="absolute right-3.5 top-1/2 -translate-y-1/2 size-4 animate-spin text-muted-foreground" />
                    )}
                  </div>
                  <select
                    value={filterType}
                    onChange={(e) => setFilterType(e.target.value)}
                    className="h-10 px-3 rounded border border-border/60 bg-background text-[length:var(--helix-transcript-size)] text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 transition-all min-w-[110px]"
                  >
                    <option value="all">全部类型</option>
                    <option value="extension">扩展</option>
                    <option value="skill">技能</option>
                    <option value="theme">主题</option>
                    <option value="prompt">提示模板</option>
                  </select>
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                    className="h-10 px-3 rounded border border-border/60 bg-background text-[length:var(--helix-transcript-size)] text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 transition-all min-w-[130px]"
                  >
                    <option value="downloads">最多下载</option>
                    <option value="date">最近更新</option>
                  </select>
                </div>

                {searchResults.length > 0 ? (
                  <div className="space-y-1.5">
                    <p className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/50 px-1">
                      找到 {filteredResults.length} 个包
                    </p>
                    {filteredResults.map((pkg) => renderPackageResult(pkg))}
                  </div>
                ) : browseQuery && !searchLoading ? (
                  <div className="text-center py-12 text-[length:var(--helix-transcript-size)] text-muted-foreground/60">
                    未找到相关插件
                  </div>
                ) : !browseQuery ? (
                  <div className="text-center py-12 text-[length:var(--helix-transcript-size)] text-muted-foreground/60">
                    输入关键词搜索 Pi 插件
                    <p className="mt-2 text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/40">
                      例如: memory, web, subagent, plan
                    </p>
                  </div>
                ) : null}
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
          ) : (
            <>
              {/* Skills tab */}
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-[length:var(--helix-transcript-size)] font-semibold text-foreground">
                  已安装 ({filteredSkills.length})
                </h2>
              </div>

              {skillsLoading && skills.length === 0 ? (
                <p className="text-[length:var(--helix-transcript-size)] text-muted-foreground/60 text-center py-8">
                  加载中...
                </p>
              ) : filteredSkills.length === 0 ? (
                <p className="text-[length:var(--helix-transcript-size)] text-muted-foreground/60 text-center py-8">
                  暂无技能
                </p>
              ) : (
                <div className="space-y-2">
                  {filteredSkills.map((skill) => (
                    <div
                      key={skill.id}
                      className="flex items-center gap-3 p-3 rounded-xl border border-border/50 bg-card/50 hover:bg-accent/30 hover:border-border transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-[length:var(--helix-transcript-size)] font-medium text-foreground truncate">
                            {skill.name}
                          </p>
                          {skill.source && (
                            <span
                              className="text-[calc(var(--helix-transcript-size)*0.7143)] px-1.5 py-0.5 rounded bg-primary/10 text-primary/80 font-mono"
                              title={`来源: ${skill.source}`}
                            >
                              {skill.source}
                            </span>
                          )}
                          {skill.callCount > 0 && (
                            <span className="text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground/40 font-mono">
                              {skill.callCount}次
                            </span>
                          )}
                        </div>
                        {skill.description && (
                          <p className="text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/70 truncate mt-0.5">
                            {skill.description}
                          </p>
                        )}
                      </div>
                      {!skill.isBuiltin && (
                        <button
                          onClick={() => void onDeleteSkill(skill)}
                          className="shrink-0 p-1.5 rounded text-muted-foreground/40 hover:text-red-500 hover:bg-red-500/10 transition-colors"
                          title="删除"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </ScrollArea>

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
                <p className="text-[length:var(--helix-transcript-size)] text-muted-foreground mt-1">
                  {updateFound.name} 可从 v{updateFound.installed} 更新到 v
                  {updateFound.latest}。更新后 pi 将重新加载插件。
                </p>
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
