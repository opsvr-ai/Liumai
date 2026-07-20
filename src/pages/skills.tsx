/** Hermes Skills & Toolsets center — discover the agent's capabilities. */

import { useCallback, useEffect, useState } from "react";
import {
  Wrench,
  Puzzle,
  Search,
  RefreshCw,
  Check,
  X,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  hermesDiscovery,
  type HermesSkill,
  type HermesToolset,
} from "@/lib/api";
import { toast } from "sonner";

export default function SkillsPage() {
  const [skills, setSkills] = useState<HermesSkill[]>([]);
  const [toolsets, setToolsets] = useState<HermesToolset[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"toolsets" | "skills">("toolsets");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [t, s] = await Promise.all([
        hermesDiscovery.toolsets(),
        hermesDiscovery.skills(),
      ]);
      setToolsets(t);
      setSkills(s);
    } catch {
      toast.error("加载技能数据失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filteredToolsets = toolsets.filter(
    (t) =>
      !search ||
      t.label.toLowerCase().includes(search.toLowerCase()) ||
      t.description.toLowerCase().includes(search.toLowerCase()) ||
      t.tools.some((tool) => tool.toLowerCase().includes(search.toLowerCase())),
  );

  const filteredSkills = skills.filter(
    (s) =>
      !search ||
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.description.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-6xl mx-auto h-full flex flex-col">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h2 className="text-lg font-semibold">技能中心</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Hermes Agent 能力清单 · {toolsets.length} 工具集 · {skills.length} 技能
          </p>
        </div>
        <Button variant="ghostMuted" size="icon-sm" onClick={load}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {/* Search + tabs */}
      <div className="flex items-center gap-3 shrink-0">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索技能或工具..."
            className="pl-9"
          />
        </div>
        <div className="flex rounded-lg border border-border p-0.5">
          {(["toolsets", "skills"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-3 py-1 rounded-md text-[13px] font-medium transition-colors ${
                tab === t
                  ? "bg-interactive-primary text-white"
                  : "text-muted-foreground hover:text-text-secondary"
              }`}
            >
              {t === "toolsets" ? "工具集" : "技能"}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          {loading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <Card key={i}>
                  <CardContent className="py-4">
                    <Skeleton className="h-5 w-32 mb-2" />
                    <Skeleton className="h-4 w-48 mb-2" />
                    <Skeleton className="h-3 w-24" />
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : tab === "toolsets" ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {filteredToolsets.map((t) => (
                <ToolsetCard key={t.name} toolset={t} />
              ))}
              {filteredToolsets.length === 0 && (
                <p className="text-sm text-muted-foreground col-span-full text-center py-8">
                  没有匹配的工具集
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {filteredSkills.map((s) => (
                <SkillRow key={s.name} skill={s} />
              ))}
              {filteredSkills.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-8">
                  没有匹配的技能
                </p>
              )}
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}

/* ── Toolset card ──────────────────────────────────────── */

function ToolsetCard({ toolset: t }: { toolset: HermesToolset }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card className="hover:shadow-sm transition-shadow">
      <CardContent className="py-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t.label}</p>
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
              {t.description}
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {t.enabled ? (
              <Check className="h-3.5 w-3.5 text-status-success" />
            ) : (
              <X className="h-3.5 w-3.5 text-muted-foreground/40" />
            )}
            <Badge
              variant={t.configured ? "default" : "secondary"}
              className="text-[10px] px-1.5"
            >
              {t.configured ? "已配置" : "未配置"}
            </Badge>
          </div>
        </div>

        {/* Tool list */}
        {t.tools.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-text-secondary mb-1"
            >
              {expanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              {t.tools.length} 个工具
            </button>
            {expanded && (
              <div className="flex flex-wrap gap-1">
                {t.tools.map((tool) => (
                  <code
                    key={tool}
                    className="text-[11px] bg-surface-secondary rounded px-1.5 py-0.5 font-mono text-text-secondary"
                  >
                    {tool}
                  </code>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ── Skill row ─────────────────────────────────────────── */

function SkillRow({ skill: s }: { skill: HermesSkill }) {
  return (
    <div className="flex items-start gap-3 px-3 py-2.5 rounded-lg hover:bg-surface-secondary/50 transition-colors">
      <div className="h-7 w-7 rounded-lg bg-interactive-primary/10 flex items-center justify-center shrink-0 mt-0.5">
        <Puzzle className="h-3.5 w-3.5 text-interactive-primary" />
      </div>
      <div className="min-w-0">
        <p className="text-[13px] font-medium">{s.name}</p>
        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
          {s.description}
        </p>
        {s.category && (
          <Badge variant="secondary" className="text-[10px] mt-1">
            {s.category}
          </Badge>
        )}
      </div>
    </div>
  );
}
