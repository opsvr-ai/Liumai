/** Thin typed wrapper around fetch for the 六脉 backend API. */

const BASE = "/api";

function token(): string | null {
  try {
    return localStorage.getItem("liumai_token");
  } catch {
    return null;
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {};
  const tok = token();
  if (tok) headers["Authorization"] = `Bearer ${tok}`;

  let bodyStr: string | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyStr = JSON.stringify(body);
  }

  const res = await fetch(`${BASE}${path}`, { method, headers, body: bodyStr });

  // Auto-redirect to login on 401 (expired / invalid token)
  if (res.status === 401) {
    localStorage.removeItem("liumai_token");
    localStorage.removeItem("liumai_user");
    localStorage.removeItem("liumai_role");
    localStorage.removeItem("liumai_auth_type");
    // Don't redirect if already on the login page
    if (window.location.pathname !== "/login") {
      window.location.href = "/login";
    }
    throw new Error("登录已过期，请重新登录");
  }

  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(msg || `${method} ${path} → ${res.status}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/* ── RCA ─────────────────────────────────────────── */

export interface RcaSessionSummary {
  id: number;
  trigger_type: string;
  status: string;
  rule_name: string | null;
  time_window_start: string | null;
  time_window_end: string | null;
  created_at: string;
  completed_at: string | null;
  root_cause_summary: string | null;
}

export interface RcaSessionDetail extends RcaSessionSummary {
  team_id: number;
  rule_id: number | null;
  hermes_session_id: string | null;
  wecom_chat_id: string | null;
  evidence: unknown[];
  timeline: RcaTimelineEntry[];
}

export interface RcaTimelineEntry {
  timestamp: string;
  event: string;
  source: string;
  detail?: string;
}

export interface QueueStatus {
  active_count: number;
  queued_count: number;
  max_concurrency: number;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export const rca = {
  trigger(params: {
    time_window_start: string;
    time_window_end: string;
    data_sources?: string[];
    team_id?: number;
    created_by?: number | null;
  }) {
    return request<{ session_id: number; status: string; position_in_queue?: number }>(
      "POST",
      "/rca/trigger",
      params,
    );
  },
  list(page = 1, pageSize = 20) {
    return request<Paginated<RcaSessionSummary>>(
      "GET",
      `/rca/sessions?page=${page}&page_size=${pageSize}`,
    );
  },
  detail(sessionId: number) {
    return request<RcaSessionDetail>("GET", `/rca/sessions/${sessionId}`);
  },
  queue() {
    return request<QueueStatus>("GET", "/rca/queue");
  },
};

/* ── Rules ───────────────────────────────────────── */

export interface AlertRule {
  id: number;
  name: string;
  description: string | null;
  severity: string;
  source: string;
  condition_expr: string;
  team_id: number;
  created_by: number | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export const ruleApi = {
  list(page = 1, pageSize = 20, teamId?: number) {
    const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
    if (teamId) params.set("team_id", String(teamId));
    return request<Paginated<AlertRule>>("GET", `/rules?${params}`);
  },
  create(data: Partial<AlertRule>) {
    return request<AlertRule>("POST", "/rules", data);
  },
  get(ruleId: number) {
    return request<AlertRule>("GET", `/rules/${ruleId}`);
  },
  update(ruleId: number, data: Partial<AlertRule>) {
    return request<AlertRule>("PUT", `/rules/${ruleId}`, data);
  },
  delete(ruleId: number) {
    return request<void>("DELETE", `/rules/${ruleId}`);
  },
  toggle(ruleId: number) {
    return request<AlertRule>("POST", `/rules/${ruleId}/toggle`);
  },
};

/* ── History ─────────────────────────────────────── */

export const historyApi = {
  rcaList(page = 1, pageSize = 20) {
    return request<Paginated<RcaSessionSummary>>(
      "GET",
      `/history/rca?page=${page}&page_size=${pageSize}`,
    );
  },
  collaboration(rcaSessionId: number, page = 1, pageSize = 20) {
    return request<Paginated<unknown>>(
      "GET",
      `/history/collaboration/${rcaSessionId}?page=${page}&page_size=${pageSize}`,
    );
  },
};

/* ── Chat (SSE streaming) ────────────────────────── */

/** A single message in a chat conversation. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

/** A tool-call definition as streamed by Hermes. */
export interface ToolCallDelta {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
  /** Hermes-specific: emoji for the tool (e.g. 🌐 👆 📸) */
  hermes_emoji?: string;
  /** Hermes-specific: human-readable label */
  hermes_label?: string;
  /** Hermes-specific: "running" | "completed" */
  hermes_status?: string;
}

/** Parsed SSE event from the chat stream endpoint. */
export type ChatStreamEvent =
  | { type: "delta"; content: string }
  | { type: "tool_call"; tool_calls: ToolCallDelta[] }
  | { type: "done"; finish_reason: string | null; usage?: { prompt_tokens: number; completion_tokens: number } }
  | { type: "error"; error: string };

/**
 * Stream a chat completion from the Hermes agent via SSE.
 *
 * Returns an async generator that yields parsed ``ChatStreamEvent``
 * objects as they arrive from the server.
 */
export async function* chatStream(
  messages: ChatMessage[],
  opts?: {
    model?: string;
    temperature?: number;
    signal?: AbortSignal;
    mode?: string;
    timeWindowStart?: string;
    timeWindowEnd?: string;
  },
): AsyncGenerator<ChatStreamEvent> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  const tok = token();
  if (tok) headers["Authorization"] = `Bearer ${tok}`;

  const res = await fetch(`${BASE}/chat/stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      messages,
      mode: opts?.mode ?? null,
      model: opts?.model ?? "hermes-agent",
      temperature: opts?.temperature ?? 0.7,
      time_window_start: opts?.timeWindowStart ?? null,
      time_window_end: opts?.timeWindowEnd ?? null,
    }),
    signal: opts?.signal,
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(msg || `chat/stream → ${res.status}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("Response body is not readable");

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by double newlines
      const parts = buffer.split("\n\n");
      // Keep the last (potentially incomplete) part in the buffer
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        if (!part.trim()) continue;

        const dataMatch = part.match(/^data:\s*(.+)$/m);
        const dataStr = dataMatch?.[1];
        if (!dataStr) continue;

        try {
          yield JSON.parse(dataStr) as ChatStreamEvent;
        } catch {
          console.warn("[chatStream] unparseable SSE data:", dataStr.slice(0, 200));
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/* ── Auth / Setup ─────────────────────────────────── */

export interface SetupStatus {
  needs_setup: boolean;
}

export interface LdapStatus {
  enabled: boolean;
  ok: boolean;
  message: string;
}

export interface LdapConfig {
  enabled: boolean;
  server: string;
  base_dn: string;
  user_filter: string;
  bind_dn: string;
  bind_password: string;
  username_attr: string;
  auto_create_user: boolean;
}

export interface HermesConfig {
  url: string;
  api_key: string;
}

export interface LlmConfig {
  base_url: string;
  api_key: string;
  model: string;
  welcome_prompt: string;
}

export const authApi = {
  setupStatus() {
    return request<SetupStatus>("GET", "/auth/setup/status");
  },
  setup(username: string, password: string) {
    return request<{ token: string; username: string; role: string }>("POST", "/auth/setup", { username, password });
  },
  login(username: string, password: string) {
    return request<{ token: string; username: string; role: string }>("POST", "/auth/login", { username, password });
  },
  changePassword(old_password: string, new_password: string) {
    return request<void>("POST", "/auth/change-password", { old_password, new_password });
  },
  ldapStatus() {
    return request<LdapStatus>("GET", "/auth/ldap-status");
  },
  getLdapConfig() {
    return request<LdapConfig>("GET", "/auth/ldap-config");
  },
  saveLdapConfig(data: LdapConfig) {
    return request<LdapConfig>("PUT", "/auth/ldap-config", data);
  },
  getHermesConfig() {
    return request<HermesConfig>("GET", "/auth/hermes-config");
  },
  saveHermesConfig(data: HermesConfig) {
    return request<HermesConfig>("PUT", "/auth/hermes-config", data);
  },
  testHermes() {
    return request<{ ok: boolean; message: string }>("POST", "/auth/hermes-test");
  },
  getLlmConfig() {
    return request<LlmConfig>("GET", "/auth/llm-config");
  },
  saveLlmConfig(data: LlmConfig) {
    return request<LlmConfig>("PUT", "/auth/llm-config", data);
  },
  generateWelcome(username: string) {
    return request<{ text: string }>("POST", "/auth/generate-welcome", { username });
  },
  generateSetupPassword() {
    return request<{ password: string; length: number }>("GET", "/auth/setup/generate-password");
  },
  getLlmConfig() {
    return request<LlmConfig>("GET", "/auth/llm-config");
  },
};

/* ── Data Sources ──────────────────────────────────── */

export interface DataSourceOut {
  id: number;
  name: string;
  type: string;
  config: Record<string, unknown>;
  enabled: boolean;
  created_at: string | null;
  updated_at: string | null;
}

const TYPE_LABELS: Record<string, string> = {
  prometheus: "Prometheus",
  zabbix: "Zabbix",
  clickhouse: "ClickHouse",
  kafka: "Kafka",
  api: "API",
};

export const dataSourceApi = {
  list(type?: string) {
    const q = type ? `?type=${type}` : "";
    return request<DataSourceOut[]>("GET", `/datasources${q}`);
  },
  create(data: { name: string; type: string; config: Record<string, unknown> }) {
    return request<DataSourceOut>("POST", "/datasources", data);
  },
  update(id: number, data: { name?: string; config?: Record<string, unknown>; enabled?: boolean }) {
    return request<DataSourceOut>("PUT", `/datasources/${id}`, data);
  },
  delete(id: number) {
    return request<void>("DELETE", `/datasources/${id}`);
  },
  test(id: number) {
    return request<{ ok: boolean; message: string }>("POST", `/datasources/${id}/test`);
  },
  query(id: number, query: string, params?: Record<string, unknown>, parsePath?: string) {
    return request<{ rows: unknown[]; count: number; parsed?: unknown }>(
      "POST",
      `/datasources/${id}/query`,
      { query, params, parse_path: parsePath },
    );
  },
  templates(sourceType?: string) {
    const q = sourceType ? `?source_type=${sourceType}` : "";
    return request<Array<{ id: number; name: string; source_type: string; query: string; params: Array<{ name: string; label: string; default: string }>; description: string }>>("GET", `/datasources/templates${q}`);
  },
  createTemplate(data: { name: string; source_type: string; query: string }) { return request("POST", "/datasources/templates", data); },
  deleteTemplate(id: number) { return request<void>("DELETE", `/datasources/templates/${id}`); },
  healthCheckAll() {
    return request<Array<{ id: number; name: string; type: string; ok: boolean; message: string; latency_ms: number }>>("GET", "/datasources/health-check");
  },
};

/* ── Hermes skills & toolsets ─────────────────────── */

export interface HermesSkill {
  name: string;
  description: string;
  category: string | null;
}

export interface HermesToolset {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
  configured: boolean;
  tools: string[];
}

export const hermesDiscovery = {
  skills() {
    return request<HermesSkill[]>("GET", "/chat/hermes/skills");
  },
  toolsets() {
    return request<HermesToolset[]>("GET", "/chat/hermes/toolsets");
  },
  cacheStatus() {
    return request<{ age_secs: number; refresh_secs: number; stale: boolean }>(
      "GET",
      "/chat/hermes/cache-status",
    );
  },
  refresh() {
    return request<{ skills_count: number; toolsets_count: number }>(
      "POST",
      "/chat/hermes/refresh",
    );
  },
  getCacheInterval() {
    return request<{ refresh_secs: number }>("GET", "/chat/hermes/cache-interval");
  },
  setCacheInterval(refresh_secs: number) {
    return request<{ refresh_secs: number }>("PUT", "/chat/hermes/cache-interval", { refresh_secs });
  },
  health() {
    return request<{ ok: boolean; status_code: number; latency_ms: number }>("GET", "/chat/hermes-health");
  },
  listLlmModels() {
    return request<Array<{ id: string; owned_by: string }>>("GET", "/chat/llm-models");
  },
};

/* ── Knowledge Center ─────────────────────────────── */

export interface KnowledgeDoc {
  id: number;
  title: string;
  source_type: string;
  source_name: string | null;
  content: string;
  processed_content: string | null;
  status: string;
  hermes_session_id: string | null;
  knowledge_id: string | null;
  hit_count: number;
  error_message: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface KnowledgeStats {
  total_docs: number;
  stored_count: number;
  failed_count: number;
  total_hits: number;
  webhook_sources: string[];
}

export interface KnowledgeTestResult {
  hit: boolean;
  question: string;
  answer: string;
  sources: string[];
  confidence: number;
}

export const knowledgeApi = {
  list(params?: { search?: string; status?: string; source_type?: string; page?: number; page_size?: number }) {
    const qs = new URLSearchParams();
    if (params?.search) qs.set("search", params.search);
    if (params?.status) qs.set("status", params.status);
    if (params?.source_type) qs.set("source_type", params.source_type);
    if (params?.page) qs.set("page", String(params.page));
    if (params?.page_size) qs.set("page_size", String(params.page_size));
    const query = qs.toString();
    return request<KnowledgeDoc[]>("GET", `/knowledge/documents${query ? `?${query}` : ""}`);
  },
  get(id: number) {
    return request<KnowledgeDoc>("GET", `/knowledge/documents/${id}`);
  },
  uploadText(title: string, content: string) {
    return request<KnowledgeDoc>("POST", "/knowledge/documents", { title, content });
  },
  uploadFile(file: File) {
    const form = new FormData();
    form.append("file", file);
    const tok = localStorage.getItem("liumai_token");
    const headers: Record<string, string> = {};
    if (tok) headers["Authorization"] = `Bearer ${tok}`;
    return fetch("/api/knowledge/documents", { method: "POST", headers, body: form }).then((r) => {
      if (!r.ok) return r.text().then((msg) => { throw new Error(msg); });
      return r.json() as Promise<KnowledgeDoc>;
    });
  },
  delete(id: number) {
    return request<void>("DELETE", `/knowledge/documents/${id}`);
  },
  ingest(id: number) {
    return request<{ ok: boolean; status: string; hermes_session_id?: string; message: string }>("POST", `/knowledge/documents/${id}/ingest`);
  },
  test(question: string) {
    return request<KnowledgeTestResult>("POST", "/knowledge/test", { question });
  },
  feedback(question: string, hit: boolean) {
    return request<{ ok: boolean }>("POST", "/knowledge/feedback", { question, hit });
  },
  stats() {
    return request<KnowledgeStats>("GET", "/knowledge/stats");
  },
  webhooks() {
    return request<Array<{ source: string; registered: boolean; doc_count: number; total_requests: number; last_request: string | null }>>("GET", "/knowledge/webhooks");
  },
  registerWebhook(source: string) {
    return request<{ ok: boolean; source: string }>("POST", "/knowledge/webhooks/register", { source });
  },
  deleteWebhook(source: string) {
    return request<void>("DELETE", `/knowledge/webhooks/${source}`);
  },
  /* Distillation */
  triggerDistill(params?: { session_ids?: number[]; limit?: number; min_score?: number }) {
    return request<{ sessions_scanned: number; knowledge_extracted: number }>("POST", "/knowledge/distill/trigger", params || {});
  },
  listDistilled(params?: { status?: string; category?: string; min_score?: number }) {
    const qs = new URLSearchParams();
    if (params?.status) qs.set("status", params.status);
    if (params?.category) qs.set("category", params.category);
    if (params?.min_score !== undefined) qs.set("min_score", String(params.min_score));
    const query = qs.toString();
    return request<KnowledgeDoc[]>("GET", `/knowledge/distill/candidates${query ? `?${query}` : ""}`)
      .then(r => r as unknown as DistilledKnowledgeOut[]);
  },
  reviewDistilled(id: number, action: "approve" | "reject", edits?: { title?: string; content?: string; score?: number }) {
    return request<DistilledKnowledgeOut>("POST", `/knowledge/distill/${id}/review`, { action, ...edits });
  },
  distillStats() {
    return request<{ total_candidates: number; approved_count: number; rejected_count: number; avg_score: number; top_categories: Array<{ category: string; count: number }> }>("GET", "/knowledge/distill/stats");
  },
  distillConfig() {
    return request<{ auto_enabled: boolean; interval_secs: number }>("GET", "/knowledge/distill/config");
  },
  setDistillConfig(data: { auto_enabled: boolean; interval_secs: number }) {
    return request<{ auto_enabled: boolean; interval_secs: number }>("PUT", "/knowledge/distill/config", data);
  },
  distillQueue() {
    return request<{ queue_count: number; total_sessions: number; processed: number }>("GET", "/knowledge/distill/queue");
  },
};

export interface DistilledKnowledgeOut {
  id: number;
  title: string;
  content: string;
  category: string | null;
  tags: string[];
  source_type: string;
  source_ids: number[];
  score: number;
  score_details: Record<string, number>;
  status: string;
  reviewer_id: number | null;
  knowledge_id: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/* ── Users ────────────────────────────────────────── */

export interface UserOut {
  id: number;
  username: string;
  role: string;
  auth_type: string;
  team_id: number;
  last_active_at: string | null;
  created_at: string | null;
}

export const userApi = {
  list() {
    return request<UserOut[]>("GET", "/users");
  },
  create(data: { username: string; password: string; role: string; team_id?: number }) {
    return request<UserOut>("POST", "/users", data);
  },
  update(userId: number, data: { role?: string; password?: string; team_id?: number }) {
    return request<UserOut>("PUT", `/users/${userId}`, data);
  },
  delete(userId: number) {
    return request<void>("DELETE", `/users/${userId}`);
  },
};

/* ── Chat history ────────────────────────────────── */

export interface ChatSessionSummary {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface ChatSessionDetail extends ChatSessionSummary {
  messages: Array<{
    id: number;
    role: string;
    content: string;
    tool_calls?: unknown;
    created_at: string;
  }>;
}

/* ── Chat modes ──────────────────────────────────── */

export interface ChatModeOut {
  slug: string;
  name: string;
  system_prompt: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

export const chatModes = {
  list() {
    return request<ChatModeOut[]>("GET", "/chat/modes");
  },
  createUserMode(data: { name: string; system_prompt: string; icon: string; provider: string }) {
    return request<ChatModeOut>("POST", "/chat/user-modes", data);
  },
  updateUserMode(id: number, data: { name: string; system_prompt: string; icon: string; provider: string }) {
    return request<ChatModeOut>("PUT", `/chat/user-modes/${id}`, data);
  },
  deleteUserMode(id: number) {
    return request<void>("DELETE", `/chat/user-modes/${id}`);
  },
};

/* ── Chat history ────────────────────────────────── */

export const chatHistory = {
  list() {
    return request<ChatSessionSummary[]>("GET", "/chat/sessions");
  },
  create() {
    return request<ChatSessionSummary>("POST", "/chat/sessions");
  },
  get(sessionId: number) {
    return request<ChatSessionDetail>("GET", `/chat/sessions/${sessionId}`);
  },
  saveMessages(
    sessionId: number,
    messages: Array<{ role: string; content: string; tool_calls?: unknown }>,
    title?: string,
  ) {
    return request<void>("POST", `/chat/sessions/${sessionId}/messages`, {
      messages,
      title,
    });
  },
  delete(sessionId: number) {
    return request<void>("DELETE", `/chat/sessions/${sessionId}`);
  },
};

/* ── Profile ────────────────────────────────────── */

export interface ProfileData {
  id: number;
  username: string;
  role: string;
  auth_type: string;
  team_id: number;
  avatar_url: string | null;
  created_at: string | null;
}

export interface SessionItem {
  id: number;
  title: string;
  created_at: string | null;
  updated_at: string | null;
}

export interface UserStats {
  total_sessions: number;
  total_messages: number;
}

export const profileApi = {
  getMe: () => request<ProfileData>("GET", "/users/me"),
  updateMe: (data: { avatar_url?: string | null }) =>
    request<ProfileData>("PUT", "/users/me", data),
  getMySessions: (page = 1, pageSize = 20) =>
    request<{ items: SessionItem[]; total: number; page: number; page_size: number }>(
      "GET", `/users/me/sessions?page=${page}&page_size=${pageSize}`
    ),
  deleteMySession: (id: number) =>
    request<{ ok: boolean }>("DELETE", `/users/me/sessions/${id}`),
  getMyStats: () => request<UserStats>("GET", "/users/me/stats"),
};

/* ── Hermes Jobs ────────────────────────────────── */

export interface JobSchedule {
  kind: string;
  minutes?: number;
  expr?: string;
  display?: string;
}

export interface JobItem {
  id: string;
  name: string;
  prompt: string;
  schedule: JobSchedule | null;
  schedule_display: string;
  skills: string[];
  deliver: string;
  state: "scheduled" | "paused" | "running" | "completed";
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  created_at: string | null;
}

interface JobsListResponse {
  jobs: JobItem[];
}

export const jobsApi = {
  list: async (includeDisabled = false): Promise<JobItem[]> => {
    const res = await request<JobsListResponse>("GET", `/jobs?include_disabled=${includeDisabled}`);
    return res.jobs || [];
  },
  get: (id: string) => request<JobItem>("GET", `/jobs/${id}`),
  create: (data: Record<string, unknown>) => request<JobItem>("POST", "/jobs", data),
  update: (id: string, data: Record<string, unknown>) =>
    request<JobItem>("PATCH", `/jobs/${id}`, data),
  delete: (id: string) => request<void>("DELETE", `/jobs/${id}`),
  pause: (id: string) => request<JobItem>("POST", `/jobs/${id}/pause`),
  resume: (id: string) => request<JobItem>("POST", `/jobs/${id}/resume`),
  run: (id: string) => request<JobItem>("POST", `/jobs/${id}/run`),
};
