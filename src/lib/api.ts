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
};

/* ── Users ────────────────────────────────────────── */

export interface UserOut {
  id: number;
  username: string;
  role: string;
  auth_type: string;
  team_id: number;
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
  update(slug: string, data: { system_prompt?: string; enabled?: boolean }) {
    return request<ChatModeOut>("PUT", `/chat/modes/${slug}`, data);
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
