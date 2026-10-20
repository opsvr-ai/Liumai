import { useCallback, useEffect, useRef, useState } from "react";
import {
  RefreshCw,
  Server,
  Shield,
  Key,
  Wifi,
  WifiOff,
  Save,
  FlaskConical,
  Zap,
  MessageSquare,
  Clock,
  Settings,
  Brain,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { authApi, chatModes, hermesDiscovery, type ChatModeOut, type HermesConfig, type HermesInfo, type HermesProbeAttempt, type HermesTestResult, type LdapConfig, type LdapStatus, type LlmConfig, type LlmModelInfo } from "@/lib/api";
import { useAuth } from "@/components/auth/auth-context";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/* ── Category definitions ────────────────────────────────── */
interface SettingsCategory {
  key: string;
  label: string;
  icon: typeof Zap;
}

const CATEGORIES: SettingsCategory[] = [
  { key: "ai", label: "智能引擎", icon: Zap },
  { key: "auth", label: "认证安全", icon: Shield },
  { key: "general", label: "通用", icon: Settings },
];

/** Human labels for the Hermes capability flags shown in the settings panel. */
const FEATURE_LABELS: Record<string, string> = {
  chat_completions_streaming: "对话流式",
  responses_api: "Responses",
  run_submission: "Runs 任务",
  run_stop: "可停止",
  run_steer: "可干预",
  run_approval_response: "工具审批",
  tool_progress_events: "工具进度",
  reasoning_streaming: "推理流",
  session_chat_streaming: "会话流式",
  session_fork: "会话分叉",
  skills_api: "技能接口",
  jobs_admin: "定时任务",
  memory_write_api: "记忆写入",
};

/**
 * Compact list of URLs the backend tried while probing Hermes health.
 * Diagnostics only — never dump the full response body into the UI.
 */
function ProbeAttemptList({ attempts }: { attempts?: HermesProbeAttempt[] | null }) {
  if (!attempts?.length) return null;
  return (
    <div className="rounded-md border border-border/60 bg-surface-secondary/40 px-2.5 py-2">
      <div className="mb-1 text-[10px] text-muted-foreground">探测明细（{attempts.length} 次）</div>
      <ul className="space-y-1">
        {attempts.map((attempt, index) => {
          const reachable = attempt.status != null && attempt.status >= 200 && attempt.status < 400;
          return (
            <li key={`${attempt.url}-${index}`} className="text-[10px] leading-snug">
              <div className="flex items-start gap-1.5">
                <span
                  className={cn(
                    "shrink-0 rounded px-1 py-px font-mono",
                    reachable ? "bg-status-resolved/10 text-status-resolved" : "bg-status-active/10 text-status-active",
                  )}
                >
                  {attempt.status != null ? `HTTP ${attempt.status}` : "ERR"}
                </span>
                <span className="min-w-0 break-all font-mono text-text-secondary">{attempt.url}</span>
                {attempt.auth === "none" && <span className="shrink-0 text-muted-foreground">无 Auth</span>}
              </div>
              {attempt.error && (
                <div className="mt-0.5 break-all text-muted-foreground" title={attempt.error}>
                  {attempt.error.length > 180 ? `${attempt.error.slice(0, 180)}…` : attempt.error}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function SettingsPage() {
  const { username, role } = useAuth();
  const [activeCat, setActiveCat] = useState("ai");

  /* ── LDAP status ───────────────────────────────────────── */
  const [ldapStatus, setLdapStatus] = useState<LdapStatus | null>(null);
  const [ldapLoading, setLdapLoading] = useState(true);

  /* ── LDAP config form ──────────────────────────────────── */
  const [ldapConfig, setLdapConfig] = useState<LdapConfig | null>(null);
  const [cfgLoading, setCfgLoading] = useState(true);
  const [cfgSaving, setCfgSaving] = useState(false);
  const [cfgExpanded, setCfgExpanded] = useState(false);

  /* ── Hermes config form ────────────────────────────────── */
  const [hermesConfig, setHermesConfig] = useState<HermesConfig | null>(null);
  const [hermesLoading, setHermesLoading] = useState(true);
  const [hermesSaving, setHermesSaving] = useState(false);
  const [hermesExpanded, setHermesExpanded] = useState(true);
  const [hermesTesting, setHermesTesting] = useState(false);
  /** Last POST /auth/hermes-test result — drives the inline diagnostics panel. */
  const [hermesTest, setHermesTest] = useState<HermesTestResult | null>(null);
  /** Rich capability report from GET /chat/hermes-info. */
  const [hermesInfo, setHermesInfo] = useState<HermesInfo | null>(null);

  /* ── Mode prompt editing ───────────────────────────────── */
  const [modes, setModes] = useState<ChatModeOut[]>([]);
  const [modeEditor, setModeEditor] = useState<ChatModeOut | null>(null);
  const [modePrompt, setModePrompt] = useState("");
  const [modeSaving, setModeSaving] = useState(false);

  /* ── LLM model config ─────────────────────────────────── */
  const [llmConfig, setLlmConfig] = useState<LlmConfig>({ base_url: "", api_key: "", model: "", welcome_prompt: "" });
  const [llmLoading, setLlmLoading] = useState(true);
  const [llmSaving, setLlmSaving] = useState(false);
  /** Models discovered from the configured endpoint (may be empty). */
  const [llmModels, setLlmModels] = useState<LlmModelInfo[]>([]);
  const [llmProbing, setLlmProbing] = useState(false);
  const [llmProbeError, setLlmProbeError] = useState<string | null>(null);
  /** Auto-probe runs at most once per page visit. */
  const llmProbedRef = useRef(false);

  const loadLlmConfig = useCallback(() => {
    setLlmLoading(true);
    authApi.getLlmConfig().then(setLlmConfig).catch(() => {}).finally(() => setLlmLoading(false));
  }, []);

  const probeLlmModels = useCallback(async (
    baseUrl: string,
    apiKey?: string,
    opts?: { silent?: boolean },
  ) => {
    const base = baseUrl.trim();
    if (!base) {
      if (!opts?.silent) setLlmProbeError("请先填写 Base URL");
      return;
    }
    setLlmProbing(true);
    if (!opts?.silent) setLlmProbeError(null);
    try {
      const result = await authApi.probeLlmModels(base, apiKey);
      if (result.ok) {
        setLlmModels(result.models ?? []);
        setLlmProbeError(null);
        if ((result.models?.length ?? 0) === 0 && !opts?.silent) {
          setLlmProbeError("未发现可用模型");
        }
      } else {
        setLlmModels([]);
        // Auto-probe failures stay silent — the manual fallback still works.
        if (!opts?.silent) setLlmProbeError(result.error || "未知错误");
      }
    } catch (e: any) {
      setLlmModels([]);
      if (!opts?.silent) setLlmProbeError(e?.message || "请求失败");
    } finally {
      setLlmProbing(false);
    }
  }, []);

  // First visit with a saved Base URL: probe once, silently.
  useEffect(() => {
    if (llmLoading || llmProbedRef.current) return;
    llmProbedRef.current = true;
    if (llmConfig.base_url.trim()) {
      void probeLlmModels(llmConfig.base_url, undefined, { silent: true });
    }
  }, [llmLoading, llmConfig.base_url, probeLlmModels]);

  async function handleSaveLlm() {
    setLlmSaving(true);
    try {
      const saved = await authApi.saveLlmConfig(llmConfig);
      setLlmConfig(saved);
      toast.success("LLM 配置已保存");
    } catch (e: any) { toast.error(`保存失败: ${e.message}`); }
    finally { setLlmSaving(false); }
  }

  function handleProbeModels() {
    void probeLlmModels(llmConfig.base_url, llmConfig.api_key);
  }

  /* ── Skills cache interval ──────────────────────────── */
  const [cacheInterval, setCacheInterval] = useState(300);
  const [cacheSaving, setCacheSaving] = useState(false);

  /* ── Change password ────────────────────────────────────── */
  const [pwOpen, setPwOpen] = useState(false);
  const [pw, setPw] = useState({ old: "", new: "", confirm: "" });
  const [pwSaving, setPwSaving] = useState(false);

  /* ── Load ──────────────────────────────────────────────── */
  const loadLdapStatus = useCallback(() => {
    setLdapLoading(true);
    authApi.ldapStatus().then(setLdapStatus).catch(() => setLdapStatus(null)).finally(() => setLdapLoading(false));
  }, []);

  const loadLdapConfig = useCallback(() => {
    setCfgLoading(true);
    authApi.getLdapConfig().then((cfg) => {
      setLdapConfig(cfg);
      if (cfg.enabled) setCfgExpanded(true);
    }).catch(() => toast.error("加载 LDAP 配置失败")).finally(() => setCfgLoading(false));
  }, []);

  const loadHermesConfig = useCallback(() => {
    setHermesLoading(true);
    authApi.getHermesConfig().then(setHermesConfig).catch(() => toast.error("加载 Hermes 配置失败")).finally(() => setHermesLoading(false));
  }, []);

  useEffect(() => { loadLdapStatus(); loadLdapConfig(); loadHermesConfig(); loadLlmConfig(); }, [loadLdapStatus, loadLdapConfig, loadHermesConfig, loadLlmConfig]);

  // Capability self-report is optional — never block the settings page on it.
  useEffect(() => { chatModes.hermesInfo().then(setHermesInfo).catch(() => {}); }, []);

  useEffect(() => {
    hermesDiscovery.getCacheInterval().then((r) => setCacheInterval(r.refresh_secs)).catch(() => {});
    chatModes.list().then(setModes).catch(() => {});
  }, []);

  /* ── Handlers ──────────────────────────────────────────── */
  function openModeEditor(m: ChatModeOut) { setModeEditor(m); setModePrompt(m.system_prompt); }

  async function handleSaveMode() {
    if (!modeEditor) return;
    setModeSaving(true);
    try {
      const updated = await chatModes.update(modeEditor.slug, { system_prompt: modePrompt });
      setModes((prev) => prev.map((m) => (m.slug === updated.slug ? updated : m)));
      toast.success(`模式 "${updated.name}" 已更新`);
      setModeEditor(null);
    } catch (e: any) { toast.error(`保存失败: ${e.message}`); }
    finally { setModeSaving(false); }
  }

  async function handleSaveHermes() {
    if (!hermesConfig) return;
    setHermesSaving(true);
    try {
      const saved = await authApi.saveHermesConfig(hermesConfig);
      setHermesConfig(saved);
      toast.success("Hermes 配置已保存");
    } catch (e: any) { toast.error(`保存失败: ${e.message}`); }
    finally { setHermesSaving(false); }
  }

  async function handleTestHermes() {
    setHermesTesting(true);
    setHermesTest(null);
    try {
      const result = await authApi.testHermes();
      setHermesTest(result);
      if (result.ok) {
        if (result.warning) {
          toast.warning(result.warning);
        } else {
          toast.success(`Hermes 运行正常${result.status ? ` (HTTP ${result.status})` : ""} · ${result.latency_ms ?? "?"}ms`);
        }
        // Refresh the rich capability report only when the probe succeeded.
        chatModes.hermesInfo().then(setHermesInfo).catch(() => {});
      } else {
        setHermesInfo(null);
        toast.error(result.message);
      }
    } catch (e: any) { toast.error(`测试失败: ${e.message}`); }
    finally { setHermesTesting(false); }
  }

  async function handleSaveLdap() {
    if (!ldapConfig) return;
    setCfgSaving(true);
    try { await authApi.saveLdapConfig(ldapConfig); toast.success("LDAP 配置已保存"); loadLdapStatus(); }
    catch (e: any) { toast.error(`保存失败: ${e.message}`); }
    finally { setCfgSaving(false); }
  }

  async function handleSaveCache() {
    setCacheSaving(true);
    try {
      const r = await hermesDiscovery.setCacheInterval(cacheInterval);
      setCacheInterval(r.refresh_secs);
      toast.success(`缓存刷新周期已设为 ${Math.round(r.refresh_secs / 60)} 分钟`);
    } catch (e: any) { toast.error(`保存失败: ${e.message}`); }
    finally { setCacheSaving(false); }
  }

  async function handleChangePw() {
    if (!pw.old || !pw.new) { toast.error("请填写原密码和新密码"); return; }
    if (pw.new.length < 6) { toast.error("新密码至少 6 位"); return; }
    if (pw.new !== pw.confirm) { toast.error("两次输入的新密码不一致"); return; }
    setPwSaving(true);
    try {
      await authApi.changePassword(pw.old, pw.new);
      toast.success("密码已修改，下次登录时生效");
      setPwOpen(false); setPw({ old: "", new: "", confirm: "" });
    } catch (e: any) { toast.error(`修改失败: ${e.message}`); }
    finally { setPwSaving(false); }
  }

  function updateCfg<K extends keyof LdapConfig>(key: K, value: LdapConfig[K]) {
    setLdapConfig((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  const selectedLlmModel = llmModels.find((m) => m.id === llmConfig.model);

  /* ═══════════════════════════════════════════════════════ */
  return (
    <div className="flex flex-col md:flex-row h-full">
      {/* ── Left nav ────────────────────────────────────── */}
      <nav className="shrink-0 md:w-44 border-b md:border-b-0 md:border-r border-border bg-surface-secondary/50">
        <div className="p-3 md:p-4">
          <h2 className="text-sm font-semibold text-text-primary mb-3 md:block hidden">系统设置</h2>
          <div className="flex md:flex-col gap-0.5 overflow-x-auto pb-1 md:pb-0">
            {CATEGORIES.map((cat) => {
              const Icon = cat.icon;
              return (
                <button
                  key={cat.key}
                  type="button"
                  onClick={() => setActiveCat(cat.key)}
                  className={cn(
                    "flex items-center gap-2 px-3 py-2 rounded-lg text-sm whitespace-nowrap transition-colors",
                    activeCat === cat.key
                      ? "bg-interactive-primary/10 text-interactive-primary font-medium"
                      : "text-text-secondary hover:bg-surface-primary/60 hover:text-text-primary",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  <span className="md:inline hidden">{cat.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </nav>

      {/* ── Right content ───────────────────────────────── */}
      <div className="flex-1 min-w-0 overflow-y-auto p-4 md:p-6 space-y-6 max-w-3xl">
        {/* ── AI Engine ──────────────────────────────────── */}
        {activeCat === "ai" && (
          <>
            <div className="mb-2">
              <h2 className="text-lg font-semibold text-text-primary">智能引擎</h2>
              <p className="text-sm text-muted-foreground mt-0.5">配置 AI 服务和对话模式</p>
            </div>

            {/* Hermes config */}
            <Card>
              <CardHeader className="pb-3 cursor-pointer select-none" onClick={() => setHermesExpanded(!hermesExpanded)}>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-medium flex items-center gap-2"><Zap className="h-4 w-4" />Hermes 智能引擎</CardTitle>
                  <Badge variant="secondary" className="text-[10px]">核心</Badge>
                </div>
              </CardHeader>
              {hermesExpanded && (
                <CardContent className="space-y-4">
                  {hermesLoading ? (<div className="space-y-3"><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-full" /></div>) : hermesConfig ? (<>
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">API 地址</label>
                      <Input value={hermesConfig.url} onChange={(e) => setHermesConfig((prev) => prev ? { ...prev, url: e.target.value } : prev)} placeholder="http://host.docker.internal:8642/v1" />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">API Key（可选）</label>
                      <Input type="password" value={hermesConfig.api_key} onChange={(e) => setHermesConfig((prev) => prev ? { ...prev, api_key: e.target.value } : prev)} placeholder="（留空则不使用认证）" />
                    </div>
                    <div className="flex items-center gap-2 pt-2 border-t border-border/50">
                      <Button size="sm" onClick={handleSaveHermes} disabled={hermesSaving}><Save className="h-3.5 w-3.5 mr-1" />{hermesSaving ? "保存中…" : "保存"}</Button>
                      <Button variant="ghostMuted" size="sm" onClick={handleTestHermes} disabled={hermesTesting}><FlaskConical className="h-3.5 w-3.5 mr-1" />{hermesTesting ? "测试中…" : "测试连接"}</Button>
                    </div>
                    {hermesTest && (!hermesTest.ok || hermesTest.warning) && (
                      <div
                        className={cn(
                          "rounded-lg border px-3 py-2 space-y-1.5",
                          hermesTest.ok
                            ? "border-amber-500/30 bg-amber-500/10"
                            : "border-status-active/30 bg-status-active/5",
                        )}
                      >
                        <p className={cn("text-xs font-medium", hermesTest.ok ? "text-amber-700 dark:text-amber-400" : "text-status-active")}>
                          {hermesTest.message}
                        </p>
                        {!hermesTest.ok && hermesTest.hint && (
                          <p className="text-xs text-text-secondary"><span className="text-muted-foreground">建议：</span>{hermesTest.hint}</p>
                        )}
                        {!hermesTest.ok && <ProbeAttemptList attempts={hermesTest.attempts} />}
                      </div>
                    )}
                  </>) : (<p className="text-sm text-muted-foreground">加载失败</p>)}
                </CardContent>
              )}
            </Card>

            {/* Hermes capability / health report */}
            {hermesInfo && (
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      <Wifi className={cn("h-4 w-4", hermesInfo.ok ? "text-status-resolved" : "text-status-active")} />
                      连接与能力
                    </CardTitle>
                    <div className="flex items-center gap-2">
                      <Badge variant={hermesInfo.ok ? "secondary" : "destructive"} className="text-[10px]">
                        {hermesInfo.ok ? "正常" : "异常"}
                      </Badge>
                      <Button variant="ghostMuted" size="icon-sm" onClick={handleTestHermes} disabled={hermesTesting} aria-label="刷新状态">
                        <RefreshCw className={cn("h-3.5 w-3.5", hermesTesting && "animate-spin")} />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {hermesInfo.warning && (
                    <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                      {hermesInfo.warning}
                    </p>
                  )}
                  {hermesInfo.error ? (
                    <div className="space-y-2">
                      <p className="text-xs text-status-active">{hermesInfo.error}</p>
                      {hermesInfo.probe?.hint && (
                        <p className="text-xs text-text-secondary"><span className="text-muted-foreground">建议：</span>{hermesInfo.probe.hint}</p>
                      )}
                      <ProbeAttemptList attempts={hermesInfo.probe?.attempts} />
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                        {([
                          ["版本", hermesInfo.version ?? "—"],
                          ["延迟", hermesInfo.latency_ms != null ? `${hermesInfo.latency_ms}ms` : "—"],
                          ["网关", hermesInfo.gateway_state ?? "—"],
                          ["运行时", hermesInfo.runtime?.mode ?? "—"],
                        ] as const).map(([k, v]) => (
                          <div key={k} className="rounded-lg border border-border/60 px-2.5 py-1.5">
                            <div className="text-[10px] text-muted-foreground">{k}</div>
                            <div className="font-medium text-text-primary truncate" title={String(v)}>{v}</div>
                          </div>
                        ))}
                      </div>

                      {hermesInfo.current_model?.provider && (
                        <div className="flex items-center gap-1.5 text-xs">
                          <span className="text-muted-foreground">当前模型</span>
                          <Badge variant="secondary" className="text-[10px]">{hermesInfo.current_model.provider}</Badge>
                          {hermesInfo.current_model.models.slice(0, 3).map((m) => (
                            <span key={m} className="rounded bg-surface-secondary px-1.5 py-0.5 text-[10px] text-text-secondary">{m}</span>
                          ))}
                        </div>
                      )}

                      {hermesInfo.features && Object.keys(hermesInfo.features).length > 0 && (
                        <div className="space-y-1.5">
                          <div className="text-[10px] text-muted-foreground">能力</div>
                          <div className="flex flex-wrap gap-1.5">
                            {Object.entries(hermesInfo.features).map(([key, value]) => {
                              const on = Boolean(value);
                              return (
                                <span
                                  key={key}
                                  className={cn(
                                    "rounded-md border px-1.5 py-0.5 text-[10px]",
                                    on
                                      ? "border-status-resolved/30 bg-status-resolved/10 text-status-resolved"
                                      : "border-border text-muted-foreground/60 line-through",
                                  )}
                                  title={on ? "已启用" : "未启用"}
                                >
                                  {FEATURE_LABELS[key] ?? key}
                                </span>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {hermesInfo.checks && Object.keys(hermesInfo.checks).length > 0 && (
                        <div className="space-y-1.5">
                          <div className="text-[10px] text-muted-foreground">就绪检查</div>
                          <div className="flex flex-wrap gap-1.5">
                            {Object.entries(hermesInfo.checks).map(([key, status]) => (
                              <span
                                key={key}
                                className={cn(
                                  "rounded-md border px-1.5 py-0.5 text-[10px]",
                                  status === "ok"
                                    ? "border-border bg-surface-secondary text-text-secondary"
                                    : "border-status-active/30 bg-status-active/10 text-status-active",
                                )}
                              >
                                {key} · {status}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {hermesInfo.platforms && Object.keys(hermesInfo.platforms).length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                          平台连接：
                          {Object.entries(hermesInfo.platforms).map(([name, state]) => (
                            <span key={name} className={state === "connected" ? "text-status-resolved" : ""}>
                              {name}({state})
                            </span>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>
            )}

            {/* LLM model config */}
            <Card>
              <CardHeader className="pb-3"><CardTitle className="text-sm font-medium flex items-center gap-2"><Brain className="h-4 w-4" />通用模型</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {llmLoading ? (<div className="space-y-3"><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-full" /></div>) : (<>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Base URL</label>
                    <Input
                      value={llmConfig.base_url}
                      onChange={(e) => {
                        const base_url = e.target.value;
                        setLlmConfig((p) => ({ ...p, base_url }));
                        // The old list belongs to the old endpoint — keep only a manual model value.
                        setLlmModels([]);
                        setLlmProbeError(null);
                      }}
                      placeholder="https://api.openai.com/v1"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">API Key</label>
                    <Input
                      type="password"
                      value={llmConfig.api_key}
                      onChange={(e) => {
                        const api_key = e.target.value;
                        setLlmConfig((p) => ({ ...p, api_key }));
                        setLlmProbeError(null);
                      }}
                      placeholder="sk-..."
                    />
                  </div>

                  {/* Model discovery — optional; manual entry below always works. */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghostMuted"
                        size="sm"
                        onClick={handleProbeModels}
                        disabled={llmProbing || !llmConfig.base_url.trim()}
                      >
                        <RefreshCw className={cn("h-3.5 w-3.5 mr-1", llmProbing && "animate-spin")} />
                        {llmProbing ? "获取中…" : "获取模型列表"}
                      </Button>
                      {!llmProbing && llmModels.length > 0 && (
                        <span className="text-[11px] text-muted-foreground">共 {llmModels.length} 个可用模型</span>
                      )}
                    </div>
                    {llmProbeError && (
                      <p className="text-xs text-status-active">自动获取失败：{llmProbeError}，可手动填写模型名</p>
                    )}
                    {llmModels.length > 0 && (
                      <div>
                        <select
                          value={llmConfig.model}
                          onChange={(e) => setLlmConfig((p) => ({ ...p, model: e.target.value }))}
                          className="h-9 w-full rounded-lg border border-border bg-surface-secondary px-3 text-sm text-text-primary"
                          aria-label="可用模型列表"
                        >
                          <option value="">选择模型（可选）</option>
                          {llmConfig.model && !llmModels.some((m) => m.id === llmConfig.model) && (
                            <option value={llmConfig.model}>{llmConfig.model}（当前配置，不在列表中）</option>
                          )}
                          {llmModels.map((m) => (
                            <option key={m.id} value={m.id}>{m.id}</option>
                          ))}
                        </select>
                        {selectedLlmModel?.owned_by && (
                          <p className="text-[11px] text-muted-foreground/70 mt-1">owned_by: {selectedLlmModel.owned_by}</p>
                        )}
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">模型名</label>
                    <Input value={llmConfig.model} onChange={(e) => setLlmConfig((p) => ({ ...p, model: e.target.value }))} placeholder="gpt-4o-mini" />
                    <p className="text-[11px] text-muted-foreground mt-0.5">可从上方列表选择，或手动输入</p>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">欢迎语生成提示词</label>
                    <textarea
                      value={llmConfig.welcome_prompt}
                      onChange={(e) => setLlmConfig((p) => ({ ...p, welcome_prompt: e.target.value }))}
                      className="w-full h-20 rounded-lg border border-border bg-surface-secondary px-3 py-2 text-xs font-mono resize-none focus:outline-none focus:ring-2 focus:ring-interactive-primary/25"
                      placeholder="你是一个运维平台的智能助手。请为用户 {username} 生成一句简短的欢迎语..."
                    />
                    <p className="text-[11px] text-muted-foreground mt-0.5">使用 {"{username}"} 作为用户名占位符</p>
                  </div>
                  <div className="flex items-center gap-2 pt-2 border-t border-border/50">
                    <Button size="sm" onClick={handleSaveLlm} disabled={llmSaving}><Save className="h-3.5 w-3.5 mr-1" />{llmSaving ? "保存中…" : "保存"}</Button>
                  </div>
                </>)}
              </CardContent>
            </Card>

            {/* Chat modes */}
            <Card>
              <CardHeader className="pb-3"><CardTitle className="text-sm font-medium flex items-center gap-2"><MessageSquare className="h-4 w-4" />对话模式</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {modes.length === 0 ? (<p className="text-sm text-muted-foreground">加载中…</p>) : modes.map((m) => (
                  <div key={m.slug} className="flex items-center justify-between gap-3 py-2 border-b border-border/50 last:border-0">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{m.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{m.system_prompt ? m.system_prompt.slice(0, 60) + "…" : "（无提示词）"}</p>
                    </div>
                    <Button variant="ghostMuted" size="sm" onClick={() => openModeEditor(m)}>编辑</Button>
                  </div>
                ))}
              </CardContent>
            </Card>

            {/* Skills cache */}
            <Card>
              <CardHeader className="pb-3"><CardTitle className="text-sm font-medium flex items-center gap-2"><Clock className="h-4 w-4" />技能中心缓存</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground">Hermes 技能列表自动刷新周期</p>
                <div className="flex items-center gap-2">
                  <select value={cacheInterval} onChange={(e) => setCacheInterval(Number(e.target.value))} className="h-9 rounded-lg border border-border bg-surface-secondary px-3 text-sm text-text-primary">
                    {[60, 120, 300, 600, 1800, 3600].map((s) => (<option key={s} value={s}>{s < 60 ? `${s} 秒` : s < 3600 ? `${Math.round(s / 60)} 分钟` : `${Math.round(s / 3600)} 小时`}</option>))}
                  </select>
                  <Button size="sm" onClick={handleSaveCache} disabled={cacheSaving}>{cacheSaving ? "保存中…" : "保存"}</Button>
                </div>
              </CardContent>
            </Card>
          </>
        )}

        {/* ── Auth & Security ────────────────────────────── */}
        {activeCat === "auth" && (
          <>
            <div className="mb-2">
              <h2 className="text-lg font-semibold text-text-primary">认证安全</h2>
              <p className="text-sm text-muted-foreground mt-0.5">管理 LDAP 集成和账号安全</p>
            </div>

            {/* LDAP */}
            <Card>
              <CardHeader className="pb-3 cursor-pointer select-none" onClick={() => setCfgExpanded(!cfgExpanded)}>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-medium flex items-center gap-2"><Server className="h-4 w-4" />LDAP / Active Directory</CardTitle>
                  <div className="flex items-center gap-2">
                    {!cfgLoading && ldapStatus && (ldapStatus.enabled ? (<Badge variant="default" className="gap-1 text-[10px]">{ldapStatus.ok ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}{ldapStatus.ok ? "已连接" : "未连接"}</Badge>) : (<Badge variant="secondary" className="text-[10px]">未启用</Badge>))}
                  </div>
                </div>
              </CardHeader>
              {cfgExpanded && (
                <CardContent className="space-y-4">
                  {cfgLoading ? (<div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}</div>) : ldapConfig ? (<>
                    <label className="flex items-center gap-3 cursor-pointer"><input type="checkbox" checked={ldapConfig.enabled} onChange={(e) => updateCfg("enabled", e.target.checked)} className="h-4 w-4 rounded border-border/60 accent-interactive-primary" /><span className="text-sm">启用 LDAP 认证</span></label>
                    <div><label className="text-xs text-muted-foreground mb-1 block">服务器地址</label><Input value={ldapConfig.server} onChange={(e) => updateCfg("server", e.target.value)} placeholder="ldap://ldap.example.com:389" /></div>
                    <div><label className="text-xs text-muted-foreground mb-1 block">Base DN</label><Input value={ldapConfig.base_dn} onChange={(e) => updateCfg("base_dn", e.target.value)} placeholder="dc=example,dc=com" /></div>
                    <div><label className="text-xs text-muted-foreground mb-1 block">用户过滤模板</label><Input value={ldapConfig.user_filter} onChange={(e) => updateCfg("user_filter", e.target.value)} placeholder="(uid={username})" /><p className="text-[11px] text-muted-foreground/60 mt-0.5">{"{username}"} 会被替换为登录用户名</p></div>
                    <div><label className="text-xs text-muted-foreground mb-1 block">Bind DN（可选）</label><Input value={ldapConfig.bind_dn} onChange={(e) => updateCfg("bind_dn", e.target.value)} placeholder="cn=admin,dc=example,dc=com" /></div>
                    <div><label className="text-xs text-muted-foreground mb-1 block">Bind Password</label><Input type="password" value={ldapConfig.bind_password} onChange={(e) => updateCfg("bind_password", e.target.value)} placeholder="(留空则不修改)" /></div>
                    <div><label className="text-xs text-muted-foreground mb-1 block">用户名属性</label><Input value={ldapConfig.username_attr} onChange={(e) => updateCfg("username_attr", e.target.value)} placeholder="uid" /></div>
                    <label className="flex items-center gap-3 cursor-pointer"><input type="checkbox" checked={ldapConfig.auto_create_user} onChange={(e) => updateCfg("auto_create_user", e.target.checked)} className="h-4 w-4 rounded border-border/60 accent-interactive-primary" /><span className="text-sm">LDAP 用户首次登录时自动创建本地账号</span></label>
                    <div className="flex items-center gap-2 pt-2 border-t border-border/50">
                      <Button size="sm" onClick={handleSaveLdap} disabled={cfgSaving}><Save className="h-3.5 w-3.5 mr-1" />{cfgSaving ? "保存中…" : "保存"}</Button>
                      <Button variant="ghostMuted" size="sm" onClick={loadLdapStatus} disabled={ldapLoading}><FlaskConical className="h-3.5 w-3.5 mr-1" />测试连接</Button>
                    </div>
                    {!ldapLoading && ldapStatus && <p className={`text-xs ${ldapStatus.ok ? "text-status-resolved" : "text-status-active"}`}>{ldapStatus.message}</p>}
                  </>) : (<p className="text-sm text-muted-foreground">加载失败</p>)}
                </CardContent>
              )}
            </Card>

            {/* Account */}
            <Card>
              <CardHeader className="pb-3"><CardTitle className="text-sm font-medium flex items-center gap-2"><Shield className="h-4 w-4" />账号安全</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between">
                  <div><p className="text-sm font-medium">{username ?? "—"}</p><p className="text-xs text-muted-foreground">角色: {role ?? "—"}</p></div>
                  <Button variant="outline" size="sm" onClick={() => setPwOpen(!pwOpen)}><Key className="h-3.5 w-3.5 mr-1" />修改密码</Button>
                </div>
                {pwOpen && (
                  <div className="space-y-3 pt-2 border-t border-border/50">
                    <Input type="password" placeholder="原密码" value={pw.old} onChange={(e) => setPw({ ...pw, old: e.target.value })} />
                    <Input type="password" placeholder="新密码 (至少 6 位)" value={pw.new} onChange={(e) => setPw({ ...pw, new: e.target.value })} />
                    <Input type="password" placeholder="确认新密码" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={handleChangePw} disabled={pwSaving}>{pwSaving ? "保存中…" : "确认修改"}</Button>
                      <Button variant="ghostMuted" size="sm" onClick={() => { setPwOpen(false); setPw({ old: "", new: "", confirm: "" }); }}>取消</Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}

        {/* ── General ──────────────────────────────────────── */}
        {activeCat === "general" && (
          <>
            <div className="mb-2">
              <h2 className="text-lg font-semibold text-text-primary">通用</h2>
              <p className="text-sm text-muted-foreground mt-0.5">通知、集成等扩展设置</p>
            </div>
            <Card>
              <CardContent className="py-12 text-center">
                <Settings className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">更多通用设置将在后续版本中提供</p>
                <p className="text-xs text-muted-foreground/60 mt-1">如 Webhook 通知、系统集成等</p>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* ── Mode editor dialog ───────────────────────────── */}
      {modeEditor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-surface-primary rounded-xl shadow-xl w-full max-w-lg mx-4 p-6 space-y-4">
            <h3 className="text-sm font-semibold">编辑模式: {modeEditor.name}</h3>
            <textarea value={modePrompt} onChange={(e) => setModePrompt(e.target.value)} className="w-full h-40 rounded-lg border border-border bg-surface-secondary px-3 py-2 text-sm text-text-primary resize-none focus:outline-none focus:ring-2 focus:ring-interactive-primary/25" placeholder="输入系统提示词…" />
            <p className="text-[11px] text-muted-foreground">系统提示词会在选择此模式时自动注入到对话开头</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghostMuted" size="sm" onClick={() => setModeEditor(null)}>取消</Button>
              <Button size="sm" onClick={handleSaveMode} disabled={modeSaving}>{modeSaving ? "保存中…" : "保存"}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
