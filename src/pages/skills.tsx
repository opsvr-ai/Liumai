/** Hermes Skills & Toolsets center — discover the agent's capabilities. */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Wrench,
  Puzzle,
  Search,
  RefreshCw,
  Check,
  X,
  ChevronDown,
  ChevronRight,
  Package,
  Zap,
  Clock,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { hermesDiscovery, type HermesSkill, type HermesToolset } from "@/lib/api";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

function formatAge(secs: number): string {
  if (secs < 60) return `${Math.round(secs)}秒前`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}分钟前`;
  return `${Math.round(mins / 60)}小时前`;
}

/** Matches one leading pictographic emoji (variation selector / ZWJ sequence /
 *  skin-tone modifier included), plus regional-indicator flag pairs.
 *
 *  Deliberately not ``\p{Emoji}``: ASCII digits (0-9) and other plain ASCII
 *  characters carry the Unicode Emoji property, which used to make labels such
 *  as "10 tools" render a bogus icon and lose their leading characters. */
const EMOJI_ICON_RE =
  /^(?:\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?\p{Emoji_Modifier}?)*|[\u{1F1E6}-\u{1F1FF}]{2})/u;

function extractIcon(label: string): string {
  const emoji = label.match(EMOJI_ICON_RE);
  return emoji ? emoji[0] : "";
}

export default function SkillsPage() {
  const [skills, setSkills] = useState<HermesSkill[]>([]);
  const [toolsets, setToolsets] = useState<HermesToolset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"toolsets" | "skills">("toolsets");
  const [filter, setFilter] = useState("all"); // all | enabled | configured
  const [cacheAge, setCacheAge] = useState<string>("");
  const [nextRefresh, setNextRefresh] = useState(300);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [t, s, status] = await Promise.all([
        hermesDiscovery.toolsets(), hermesDiscovery.skills(), hermesDiscovery.cacheStatus(),
      ]);
      setToolsets(t); setSkills(s);
      setCacheAge(formatAge(status.age_secs));
      setNextRefresh(status.refresh_secs);
      setError(null);
    } catch (e) {
      // Only surface a full error state for foreground loads; a failed silent
      // refresh keeps the last good data on screen instead of blanking it.
      if (!silent) {
        setError(e instanceof Error ? e.message : "未知错误");
        toast.error("加载失败");
      }
    } finally { if (!silent) setLoading(false); }
  }, []);

  // 60s auto-refresh, paused while the tab is hidden.
  useEffect(() => {
    load();
    let timer: number | null = null;
    const stop = () => {
      if (timer !== null) { window.clearInterval(timer); timer = null; }
    };
    const start = () => {
      stop();
      timer = window.setInterval(() => load(true), 60000);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") { load(true); start(); }
      else stop();
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [load]);

  const filteredToolsets = useMemo(() => {
    let list = toolsets;
    if (search) list = list.filter((t) => t.label.toLowerCase().includes(search.toLowerCase()) || t.description.toLowerCase().includes(search.toLowerCase()) || t.tools.some((tool) => tool.toLowerCase().includes(search.toLowerCase())));
    if (filter === "enabled") list = list.filter((t) => t.enabled);
    if (filter === "configured") list = list.filter((t) => t.configured);
    return list;
  }, [toolsets, search, filter]);

  const filteredSkills = useMemo(() => {
    if (!search) return skills;
    return skills.filter((s) => s.name.toLowerCase().includes(search.toLowerCase()) || s.description.toLowerCase().includes(search.toLowerCase()));
  }, [skills, search]);

  const groupedSkills = useMemo(() => {
    const groups: Record<string, HermesSkill[]> = {};
    for (const s of filteredSkills) {
      const cat = s.category || "未分类";
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(s);
    }
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  }, [filteredSkills]);

  const stats = useMemo(() => ({
    toolsets: toolsets.length,
    enabled: toolsets.filter((t) => t.enabled).length,
    skills: skills.length,
    next: `${Math.round(nextRefresh / 60)}分钟`,
  }), [toolsets, skills, nextRefresh]);

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">技能中心</h2>
          <p className="text-sm text-muted-foreground mt-0.5">Hermes Agent 能力清单 · 更新于 {cacheAge}</p>
        </div>
        <Button variant="ghostMuted" size="icon-sm" onClick={() => load(false)}><RefreshCw className="h-4 w-4" /></Button>
      </div>

      {/* Stats bar */}
      {!loading && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: "工具集", value: stats.toolsets, icon: Package, color: "text-interactive-primary", bg: "bg-interactive-primary/10" },
            { label: "已启用", value: stats.enabled, icon: Zap, color: "text-status-resolved", bg: "bg-status-resolved/10" },
            { label: "技能", value: stats.skills, icon: Puzzle, color: "text-amber-600", bg: "bg-amber-50" },
            { label: "自动刷新", value: stats.next, icon: Clock, color: "text-indigo-600", bg: "bg-indigo-50" },
          ].map((s) => (
            <Card key={s.label}>
              <CardContent className="p-3 flex items-center gap-3">
                <div className={cn("shrink-0 h-9 w-9 rounded-lg flex items-center justify-center", s.bg)}><s.icon className={cn("h-4 w-4", s.color)} /></div>
                <div><p className="text-lg font-bold text-text-primary">{s.value}</p><p className="text-[11px] text-muted-foreground">{s.label}</p></div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Search + tabs + filter */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索技能或工具..." className="pl-9" />
        </div>
        <div className="flex rounded-lg border border-border p-0.5">
          {(["toolsets", "skills"] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)} className={cn("px-3 py-1 rounded-md text-[13px] font-medium transition-colors", tab === t ? "bg-interactive-primary text-white" : "text-muted-foreground hover:text-text-secondary")}>
              {t === "toolsets" ? `工具集 (${toolsets.length})` : `技能 (${skills.length})`}
            </button>
          ))}
        </div>
        {tab === "toolsets" && (
          <Select value={filter} onValueChange={(value) => setFilter(value ?? "all")}>
            <SelectTrigger className="w-24 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              <SelectItem value="enabled">已启用</SelectItem>
              <SelectItem value="configured">已配置</SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Content */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {Array.from({ length: 8 }).map((_, i) => <Card key={i}><CardContent className="py-4"><Skeleton className="h-5 w-32 mb-2" /><Skeleton className="h-4 w-48 mb-2" /><Skeleton className="h-3 w-24" /></CardContent></Card>)}
        </div>
      ) : error ? (
        <Card>
          <CardContent className="py-12 flex flex-col items-center gap-2 text-center">
            <p className="text-sm font-medium text-status-active">加载技能与工具集失败</p>
            <p className="text-xs text-muted-foreground max-w-md break-words">{error}</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => load(false)}>
              <RefreshCw className="h-3.5 w-3.5 mr-1" />重试
            </Button>
          </CardContent>
        </Card>
      ) : tab === "toolsets" ? (
        <>
          {filteredToolsets.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-12">
              {toolsets.length === 0 ? "暂无工具集数据" : "没有匹配的工具集"}
            </p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {filteredToolsets.map((t) => <ToolsetCard key={t.name} toolset={t} />)}
            </div>
          )}
        </>
      ) : (
        <div className="space-y-4">
          {groupedSkills.map(([category, items]) => <SkillGroup key={category} category={category} skills={items} />)}
          {groupedSkills.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-12">
              {skills.length === 0 ? "暂无技能数据" : "没有匹配的技能"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Toolset card ──────────────────────────────────────── */

function ToolsetCard({ toolset: t }: { toolset: HermesToolset }) {
  const [expanded, setExpanded] = useState(false);
  const icon = extractIcon(t.label);
  const displayLabel = icon ? t.label.slice(icon.length).replace(/^\s+/, "") : t.label;

  return (
    <Card className={cn("hover:shadow-md transition-all duration-200 hover:-translate-y-0.5", !t.enabled && "opacity-60")}>
      <CardContent className="py-4 space-y-3">
        <div className="flex items-start gap-3">
          <div className="shrink-0 h-10 w-10 rounded-xl bg-interactive-primary/8 flex items-center justify-center text-lg">
            {icon || <Wrench className="h-5 w-5 text-interactive-primary/40" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-semibold">{displayLabel}</p>
              {t.enabled ? <Badge variant="default" className="text-[10px] px-1.5 gap-0.5"><Check className="h-2.5 w-2.5" />启用</Badge> : <Badge variant="secondary" className="text-[10px] px-1.5"><X className="h-2.5 w-2.5" />禁用</Badge>}
              {t.configured && <Badge variant="outline" className="text-[10px] px-1.5">已配置</Badge>}
            </div>
            <p className="text-xs text-muted-foreground mt-1.5 line-clamp-2">{t.description}</p>
          </div>
        </div>

        {t.tools.length > 0 && (
          <div>
            <button type="button" onClick={() => setExpanded(!expanded)} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-text-secondary mb-1.5">
              {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              <Badge variant="secondary" className="text-[10px] px-1.5">{t.tools.length}</Badge> 个工具
            </button>
            {expanded && (
              <div className="flex flex-wrap gap-1">
                {t.tools.map((tool) => <code key={tool} className="text-[11px] bg-surface-secondary rounded px-1.5 py-0.5 font-mono text-text-secondary">{tool}</code>)}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ── Skill group ───────────────────────────────────────── */

function SkillGroup({ category, skills }: { category: string; skills: HermesSkill[] }) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-2 w-full text-left py-1.5 px-1 hover:bg-surface-secondary/30 rounded-lg transition-colors">
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        <span className="text-sm font-semibold text-text-primary">{category}</span>
        <Badge variant="secondary" className="text-[10px]">{skills.length}</Badge>
      </button>
      {open && (
        <div className="space-y-0.5 ml-2 mt-1">
          {skills.map((s) => (
            <div key={s.name} className="flex items-start gap-3 px-3 py-2 rounded-lg hover:bg-surface-secondary/50 transition-colors">
              <div className="h-7 w-7 rounded-lg bg-interactive-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                <Puzzle className="h-3.5 w-3.5 text-interactive-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-[13px] font-medium">{s.name}</p>
                <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{s.description}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
