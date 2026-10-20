/** Thin typed wrapper around fetch for the 六脉 backend API. */

const BASE = "/api";

function token(): string | null {
  try {
    return localStorage.getItem("liumai_token");
  } catch {
    return null;
  }
}

/**
 * A non-2xx API response.
 *
 * ``status`` lets callers branch on the HTTP semantics (e.g. a 409 from
 * ``/runs/{id}/steer`` means the run has already finished) instead of matching
 * substrings in a human-readable message.
 */
export class ApiError extends Error {
  readonly status: number;
  /** Parsed ``detail`` of a FastAPI error envelope, when the body had one. */
  readonly detail: unknown;

  constructor(message: string, status: number, detail?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Best-effort message for an error response body.
 *
 * FastAPI returns ``{"detail": "…"}``, but platform proxies occasionally wrap
 * the upstream payload as ``{"detail": {code, message}}``.  We prefer the
 * human-readable text and fall back to the raw body so nothing is lost.
 */
function _errorBody(body: string): { message: string; detail: unknown } {
  const trimmed = body.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      const envelope = parsed as Record<string, unknown>;
      const detail = envelope.detail ?? envelope.message;
      if (typeof detail === "string" && detail) {
        return { message: detail, detail };
      }
      if (detail && typeof detail === "object") {
        const nested = detail as Record<string, unknown>;
        const text = nested.message ?? nested.code ?? nested.error;
        return {
          message: typeof text === "string" && text ? text : trimmed,
          detail,
        };
      }
    }
  } catch {
    // Not JSON (proxy error page / plain text) — use it verbatim below.
  }
  return { message: trimmed, detail: undefined };
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
    const raw = await res.text().catch(() => res.statusText);
    const { message, detail } = _errorBody(raw);
    throw new ApiError(
      message || `${method} ${path} → ${res.status}`,
      res.status,
      detail,
    );
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
  service_name?: string | null;
  alert_count?: number | null;
  trigger_reason?: string | null;
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
  id?: number;
  timestamp?: string;
  created_at?: string;
  event_type?: string;
  event?: string;
  content?: string;
  source?: string;
  detail?: string;
  metadata?: unknown;
}

export interface RcaReport {
  id: number;
  session_id: number;
  service_name: string | null;
  alert_count: number;
  category: string | null;
  root_cause: string | null;
  confidence: number | null;
  evidence: unknown[];
  impacted_services: unknown[];
  recommended_actions: unknown[];
  created_at: string;
  session_status?: string;
  trigger_reason?: string | null;
  time_window_start?: string | null;
  time_window_end?: string | null;
  alerts?: RcaReportAlert[];
  /** Top3 root causes (persisted with the session; derived when absent). */
  top3?: string[];
}

export interface RcaReportAlert {
  id: number;
  alert_uid: string | null;
  source: string | null;
  ip: string | null;
  ci_name: string | null;
  ci_application: string | null;
  content: string | null;
  severity: string | null;
  severity_level: number | null;
  alert_type: string | null;
  status: string;
  alert_time: string | null;
  raw_payload?: Record<string, unknown>;
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
  list(page = 1, pageSize = 20, status?: string) {
    const qs = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
    });
    if (status) qs.set("status", status);
    return request<Paginated<RcaSessionSummary>>(
      "GET",
      `/rca/sessions?${qs.toString()}`,
    );
  },
  detail(sessionId: number) {
    return request<RcaSessionDetail>("GET", `/rca/sessions/${sessionId}`);
  },
  queue() {
    return request<QueueStatus>("GET", "/rca/queue");
  },
  reports(params?: { page?: number; page_size?: number; search?: string; service?: string }) {
    const qs = new URLSearchParams();
    if (params?.page) qs.set("page", String(params.page));
    if (params?.page_size) qs.set("page_size", String(params.page_size));
    if (params?.search) qs.set("search", params.search);
    if (params?.service) qs.set("service", params.service);
    const q = qs.toString();
    return request<Paginated<RcaReport>>("GET", `/rca/reports${q ? `?${q}` : ""}`);
  },
  report(sessionId: number) {
    return request<RcaReport>("GET", `/rca/sessions/${sessionId}/report`);
  },
  sessionAlerts(sessionId: number) {
    return request<RcaReportAlert[]>("GET", `/rca/sessions/${sessionId}/alerts`);
  },
  rerun(sessionId: number) {
    return request<{ status: string; session_id: number }>("POST", `/rca/sessions/${sessionId}/rerun`);
  },
  /** Manually terminate a QUEUED/RUNNING session (requires `rca_terminate`). */
  cancel(sessionId: number) {
    return request<{ session_id: number; status: string; hermes_stopped: boolean }>(
      "POST",
      `/rca/sessions/${sessionId}/cancel`,
    );
  },
};

/** Backwards-compatible alias used by newer call sites. */
export const rcaApi = rca;

/* ── Report files (download) ─────────────────────── */

/** Extract the attachment filename from a Content-Disposition header. */
function _attachmentFilename(header: string | null): string | null {
  if (!header) return null;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // fall through to the ASCII filename
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim() || null;
}

export const reportApi = {
  /**
   * Download a session report as Markdown or standalone HTML.
   *
   * The endpoint requires the bearer token, so a plain `<a href>` cannot be
   * used (tokens must not leak into URLs).  Fetch as a blob, then let the
   * caller trigger a client-side save with the server-provided filename.
   */
  async download(
    sessionId: number,
    format: "md" | "html" = "md",
  ): Promise<{ blob: Blob; filename: string }> {
    const headers: Record<string, string> = {};
    const tok = token();
    if (tok) headers["Authorization"] = `Bearer ${tok}`;

    const res = await fetch(
      `${BASE}/rca/sessions/${sessionId}/report/download?format=${format}`,
      { headers },
    );

    if (res.status === 401) {
      localStorage.removeItem("liumai_token");
      localStorage.removeItem("liumai_user");
      localStorage.removeItem("liumai_role");
      localStorage.removeItem("liumai_auth_type");
      if (window.location.pathname !== "/login") window.location.href = "/login";
      throw new Error("登录已过期，请重新登录");
    }
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      throw new Error(msg || `下载报告失败（${res.status}）`);
    }

    const blob = await res.blob();
    const filename =
      _attachmentFilename(res.headers.get("content-disposition")) ||
      `liumai-rca-${sessionId}.${format}`;
    return { blob, filename };
  },

  /**
   * Bulk-export many session reports as one ZIP archive.
   *
   * Session IDs travel in the JSON body (never the query string) and the
   * bearer token stays in the Authorization header.  Resolves with the blob,
   * the server-provided attachment filename, and the number of sessions the
   * backend skipped (also listed in the archive's README.txt).
   */
  async exportZip(
    sessionIds: number[],
    format: "md" | "html" = "md",
  ): Promise<{ blob: Blob; filename: string; skipped: number }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const tok = token();
    if (tok) headers["Authorization"] = `Bearer ${tok}`;

    const res = await fetch(`${BASE}/rca/reports/export`, {
      method: "POST",
      headers,
      body: JSON.stringify({ session_ids: sessionIds, format }),
    });

    if (res.status === 401) {
      localStorage.removeItem("liumai_token");
      localStorage.removeItem("liumai_user");
      localStorage.removeItem("liumai_role");
      localStorage.removeItem("liumai_auth_type");
      if (window.location.pathname !== "/login") window.location.href = "/login";
      throw new Error("登录已过期，请重新登录");
    }
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      throw new Error(msg || `批量导出失败（${res.status}）`);
    }

    const blob = await res.blob();
    const filename =
      _attachmentFilename(res.headers.get("content-disposition")) ||
      "liumai-rca-reports.zip";
    const skipped = Number.parseInt(res.headers.get("x-skipped-count") ?? "0", 10) || 0;
    return { blob, filename, skipped };
  },
};

/* ── Rules ───────────────────────────────────────── */

/** Matching fields accepted by the backend rule engine. */
export type RuleConditionField =
  | "severity"
  | "severity_level"
  | "ci_name"
  | "ci_application"
  | "service_name"
  | "ip"
  | "source"
  | "metric"
  | "content";

/** Matching operators accepted by the backend rule engine. */
export type RuleConditionOp =
  | "eq"
  | "neq"
  | "contains"
  | "in"
  | "gte"
  | "lte"
  | "regex";

/** One condition row; multiple rows are combined with AND. */
export interface RuleCondition {
  field: RuleConditionField | string;
  op: RuleConditionOp | string;
  value: string | string[];
}

/** Minimal action descriptors (e.g. `{ coalesce_window: 900 }`). */
export type RuleAction = Record<string, unknown>;

export interface AlertRule {
  id: number;
  team_id: number;
  name: string;
  description: string | null;
  /** Structured condition rows (AND semantics). */
  conditions: RuleCondition[];
  actions: RuleAction[];
  /** Legacy free-text condition expression — read-only for display. */
  condition_expr?: string | null;
  created_by: number | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

/** Payload accepted by `POST/PUT /api/rules` (structured conditions only). */
export interface AlertRuleInput {
  name: string;
  description?: string;
  conditions: RuleCondition[];
  actions?: RuleAction[];
  enabled?: boolean;
}

export const ruleApi = {
  list(page = 1, pageSize = 20, teamId?: number) {
    const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
    if (teamId) params.set("team_id", String(teamId));
    return request<Paginated<AlertRule>>("GET", `/rules?${params}`);
  },
  create(data: AlertRuleInput) {
    return request<AlertRule>("POST", "/rules", data);
  },
  get(ruleId: number) {
    return request<AlertRule>("GET", `/rules/${ruleId}`);
  },
  update(ruleId: number, data: Partial<AlertRuleInput>) {
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

/** Inline image part accepted by Hermes' vision channel. */
export interface ChatImagePart {
  type: "image_url";
  image_url: { url: string };
}

/** Text part of a multi-part message. */
export interface ChatTextPart {
  type: "text";
  text: string;
}

/** OpenAI-compatible content parts (Hermes only accepts text + image_url). */
export type ChatContentPart = ChatTextPart | ChatImagePart;

/** A single message in a chat conversation. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[];
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
  | { type: "reasoning"; content: string }
  | { type: "session"; session_id: string }
  | { type: "tool_call"; tool_calls: ToolCallDelta[] }
  | {
      type: "done";
      finish_reason: string | null;
      usage?: { prompt_tokens: number; completion_tokens: number };
      /** Present when the turn ended abnormally (context overflow, provider error…). */
      error?: string;
      /** Raw Hermes diagnostics attached to the finish chunk. */
      hermes?: unknown;
    }
  | { type: "error"; error: string };

/* ── One-turn image staging (A3) ─────────────────── */

/** An image attached to the *current* turn only. */
export interface StagedChatImage {
  filename: string;
  /** ``data:image/<mime>;base64,...`` from ``/chat/convert-file``. */
  dataUrl: string;
}

/**
 * Module-level hand-off for inline images.
 *
 * The composer converts a picked image with ``/chat/convert-file`` and stages
 * the data URL here; the very next ``/chat/stream`` request attaches it as a
 * content part to the newest user message and clears the staging slot.  Images
 * are therefore never part of the persisted transcript or of history replays.
 */
let stagedChatImages: StagedChatImage[] = [];

export function stageChatImages(images: StagedChatImage[]): void {
  stagedChatImages = images.slice();
}

export function clearStagedChatImages(): void {
  stagedChatImages = [];
}

function consumeStagedChatImages(): StagedChatImage[] {
  const images = stagedChatImages;
  stagedChatImages = [];
  return images;
}

/** Attach staged images to the last user message as ``image_url`` parts. */
function withStagedChatImages(
  messages: ChatMessage[],
  images: StagedChatImage[],
): ChatMessage[] {
  if (images.length === 0) return messages;
  const next = messages.slice();
  for (let index = next.length - 1; index >= 0; index -= 1) {
    if (next[index].role !== "user") continue;
    const content = next[index].content;
    const text =
      typeof content === "string"
        ? content
        : content
            .filter((part): part is ChatTextPart => part.type === "text")
            .map((part) => part.text)
            .join("\n");
    next[index] = {
      ...next[index],
      content: [
        { type: "text", text },
        ...images.map<ChatImagePart>((image) => ({
          type: "image_url",
          image_url: { url: image.dataUrl },
        })),
      ],
    };
    break;
  }
  return next;
}

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
    /** Continue an existing Hermes agent session (server-side context). */
    hermesSessionId?: string | null;
    /**
     * Platform chat session id.  The backend scopes agent artifacts to
     * ``hermes-files/<chatSessionId>/`` and echoes the used token in
     * ``X-Artifact-Session-Id``.
     */
    chatSessionId?: number | null;
  },
): AsyncGenerator<ChatStreamEvent> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  const tok = token();
  if (tok) headers["Authorization"] = `Bearer ${tok}`;

  // The pending image belongs to this request only; consume it even if the
  // request fails so a retry cannot silently attach a stale image.
  const outgoingMessages = withStagedChatImages(messages, consumeStagedChatImages());

  const res = await fetch(`${BASE}/chat/stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      messages: outgoingMessages,
      mode: opts?.mode ?? null,
      model: opts?.model ?? null,
      temperature: opts?.temperature ?? 0.7,
      time_window_start: opts?.timeWindowStart ?? null,
      time_window_end: opts?.timeWindowEnd ?? null,
      hermes_session_id: opts?.hermesSessionId ?? null,
      chat_session_id: opts?.chatSessionId ?? null,
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
    // Cancel the body reader so the HTTP connection is released promptly
    // (releaseLock alone leaves the stream open).
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
    reader.releaseLock();
  }
}

/* ── Chat attachments & artifacts ────────────────── */

/** Converted text attachment returned by ``POST /api/chat/convert-file``. */
export interface ConvertedFileText {
  ok: true;
  kind: "text";
  filename: string;
  content: string;
  truncated: boolean;
  original_chars: number;
  max_chars?: number;
}

/** Inline image returned by ``POST /api/chat/convert-file`` (≤3MB). */
export interface ConvertedFileImage {
  ok: true;
  kind: "image";
  filename: string;
  mime: string;
  bytes: number;
  /** ``data:image/<mime>;base64,...`` — sent as an ``image_url`` content part. */
  data_url: string;
}

export type ConvertedFile = ConvertedFileText | ConvertedFileImage;

export const chatFiles = {
  /**
   * Convert an uploaded document to text, or inline an image as a data URL.
   *
   * @param maxChars Text char cap. Agent modes pass 60000 because Hermes
   *   silently truncates a text part above 64K characters.
   */
  async convert(file: File, maxChars?: number): Promise<ConvertedFile> {
    const headers: Record<string, string> = {};
    const tok = token();
    if (tok) headers["Authorization"] = `Bearer ${tok}`;

    const form = new FormData();
    form.append("file", file);
    const query = maxChars ? `?max_chars=${encodeURIComponent(String(maxChars))}` : "";
    const response = await fetch(`${BASE}/chat/convert-file${query}`, {
      method: "POST",
      headers,
      body: form,
    });
    if (!response.ok) {
      const payload = await response
        .json()
        .catch(() => ({ detail: `文件转换失败 (HTTP ${response.status})` }));
      throw new Error(
        typeof payload?.detail === "string" ? payload.detail : "文件转换失败",
      );
    }
    return (await response.json()) as ConvertedFile;
  },
};

export const chatArtifacts = {
  /**
   * Download a session-scoped Hermes artifact as a blob and save it
   * (Authorization header — the token is never placed in a URL).
   *
   * Artifacts live in ``hermes-files/<sessionId>/`` and the backend only serves
   * them to the session's owner, so a platform session id is required.
   */
  async download(
    sessionId: string | number | null | undefined,
    filename: string,
  ): Promise<void> {
    const sid =
      typeof sessionId === "number" ? sessionId : Number.parseInt(String(sessionId), 10);
    if (!Number.isInteger(sid) || sid <= 0) {
      throw new Error("请先保存会话后再下载产物");
    }

    const headers: Record<string, string> = {};
    const tok = token();
    if (tok) headers["Authorization"] = `Bearer ${tok}`;

    const response = await fetch(
      `${BASE}/chat/artifacts/${sid}/${encodeURIComponent(filename)}`,
      { headers },
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const detail =
        typeof payload?.detail === "string" ? payload.detail : "文件不存在或下载失败";
      throw new Error(detail);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
    } finally {
      // Give the browser a tick to start the download before revoking.
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  },
};

/* ── Chat Runs API (structured agent runs) ─────────── */

/**
 * Hermes Runs API — the agent-mode main path.
 *
 * ``POST /api/chat/runs`` returns a ``run_id`` immediately; progress arrives on
 * ``/api/chat/runs/{run_id}/events`` (SSE) and the run can be stopped, steered
 * and approved through dedicated endpoints.  Unlike ``/chat/stream`` the agent
 * keeps running server-side when the browser disconnects, so a stop actually
 * interrupts it and a refresh can reattach by ``run_id``.
 */

/** Body for ``POST /api/chat/runs``. */
export interface ChatRunCreateParams {
  input: string;
  /** Hermes session to continue (omit for a fresh one). */
  session_id?: string | null;
  /**
   * Platform chat session id — scopes agent artifacts to
   * ``hermes-files/<id>/``; the backend returns the used token as
   * ``artifact_session_id``.
   */
  chat_session_id?: number | null;
  /** Ephemeral system prompt (the backend fills it from the chat mode). */
  instructions?: string | null;
  model?: string | null;
  /**
   * Prior turns to replay when there is no Hermes session yet (e.g. after a
   * mode switch).  The newest user message travels as ``input``, not here.
   */
  conversation_history?: ChatMessage[] | null;
  /** Chat mode slug — used server-side to pick the system prompt. */
  mode?: string | null;
}

/** Response of ``POST /api/chat/runs``. */
export interface ChatRunCreateResult {
  run_id: string;
  status: string;
  /** Continuity token for the next turn (Hermes falls back to ``run_id``). */
  session_id: string;
  /** Agent artifact directory token (the platform chat session id when known). */
  artifact_session_id?: string;
  replayed?: boolean;
}

/** Token usage reported by the Runs API. */
export interface ChatRunUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
}

/** Pollable run state (``GET /api/chat/runs/{run_id}``). */
export interface ChatRunStatus {
  object?: string;
  run_id: string;
  /** queued | running | waiting_for_approval | stopping | completed | failed | cancelled | interrupted */
  status: string;
  session_id?: string;
  output?: string;
  error?: string;
  usage?: ChatRunUsage;
  pending_controls?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/** A tool-approval prompt raised by a running agent. */
export interface ChatApprovalRequest {
  /** Hermes ``request_id`` used to resolve this exact prompt ("" if absent). */
  approvalId: string;
  /** Tool the agent wants to run (``tool`` / ``tool_name`` on the wire). */
  tool?: string;
  command?: string;
  description?: string;
  /** Choices the server allows: once / session / always / deny. */
  choices: string[];
}

/** Event yielded by {@link chatRunEvents}, normalised onto the chat UI contract. */
export type ChatRunEvent = (
  | ChatStreamEvent
  | { type: "approval"; approval: ChatApprovalRequest }
) & {
  /** SSE sequence number (``id:`` line / JSON ``seq``) used to resume a stream. */
  seq?: number;
};

export const chatRuns = {
  create(params: ChatRunCreateParams) {
    return request<ChatRunCreateResult>("POST", "/chat/runs", params);
  },
  status(runId: string) {
    return request<ChatRunStatus>("GET", `/chat/runs/${encodeURIComponent(runId)}`);
  },
  stop(runId: string) {
    return request<{ run_id?: string; status?: string }>(
      "POST",
      `/chat/runs/${encodeURIComponent(runId)}/stop`,
    );
  },
  steer(runId: string, input: string) {
    return request<{ run_id?: string; accepted?: boolean; status?: string }>(
      "POST",
      `/chat/runs/${encodeURIComponent(runId)}/steer`,
      { input },
    );
  },
  approval(runId: string, approvalId: string | null | undefined, decision: string) {
    return request<{ run_id?: string; resolved?: number }>(
      "POST",
      `/chat/runs/${encodeURIComponent(runId)}/approval`,
      { approval_id: approvalId || null, decision },
    );
  },
};

/**
 * Stream a run's progress as normalised {@link ChatRunEvent}s.
 *
 * Hermes frames carry `id: <seq>` + `data: <json>` lines (the event *name* is
 * the JSON `event` field, there is no `event:` line) plus `:` keepalive
 * comments.  Comment frames are ignored, unknown event types are skipped, and
 * the connection closes when the server emits the terminal run event.
 *
 * @param runId Hermes run id returned by {@link chatRuns.create}.
 * @param opts.signal AbortSignal used by "停止" to drop the subscription.
 * @param opts.lastEventId Last sequence number seen, so Hermes replays missed
 *   frames after a reconnect (`Last-Event-ID` header).
 */
export async function* chatRunEvents(
  runId: string,
  opts?: { signal?: AbortSignal; lastEventId?: string | number | null },
): AsyncGenerator<ChatRunEvent> {
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  const tok = token();
  if (tok) headers["Authorization"] = `Bearer ${tok}`;
  if (opts?.lastEventId !== undefined && opts?.lastEventId !== null) {
    headers["Last-Event-ID"] = String(opts.lastEventId);
  }

  const res = await fetch(`${BASE}/chat/runs/${encodeURIComponent(runId)}/events`, {
    method: "GET",
    headers,
    signal: opts?.signal,
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(msg || `chat/runs/${runId}/events → ${res.status}`);
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

      // SSE frames are separated by double newlines
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const raw = _parseRunFrame(frame);
        if (!raw) continue;
        const event = _normalizeRunEvent(raw);
        if (event) {
          if (typeof raw.seq === "number") event.seq = raw.seq;
          yield event;
        }
      }
    }

    // Flush a trailing frame that arrived without its blank-line terminator.
    const tail = _parseRunFrame(buffer);
    if (tail) {
      const event = _normalizeRunEvent(tail);
      if (event) {
        if (typeof tail.seq === "number") event.seq = tail.seq;
        yield event;
      }
    }
  } finally {
    // Cancel the body reader so the HTTP connection is released promptly
    // (releaseLock alone leaves the stream open).
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
    reader.releaseLock();
  }
}

/** Decode one raw run SSE frame into its JSON payload (or ``null``). */
function _parseRunFrame(frame: string): Record<string, unknown> | null {
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue; // ': open' / ': keepalive' / ': stream closed'
    if (!line.startsWith("data:")) continue; // 'id:' (and any future 'event:') lines
    dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;

  const payload = dataLines.join("\n");
  if (payload === "[DONE]") return null;
  try {
    const parsed: unknown = JSON.parse(payload);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    console.warn("[chatRunEvents] unparseable SSE data:", payload.slice(0, 200));
    return null;
  }
}

/** Coerce an unknown JSON value to display text ("" when absent). */
function _runStr(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return String(value);
}

/** Map Hermes run usage onto the existing chat usage shape. */
function _runUsage(
  raw: unknown,
): { prompt_tokens: number; completion_tokens: number } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  const prompt = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
  const completion = Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
  return { prompt_tokens: prompt, completion_tokens: completion };
}

/**
 * Translate a raw Hermes run event into the UI's chat-event vocabulary.
 *
 * Observed Hermes 0.22.2 event types (probed against the live gateway):
 *   message.delta{delta}, message.interim{text}, reasoning.available{text},
 *   tool.started{tool,tool_call_id,preview}, tool.completed{tool,tool_call_id,
 *   preview,error,duration}, approval.request{request_id?,command,description,
 *   choices}, approval.responded, run.steered, run.queued, run.completed
 *   {output,usage,completed,partial,interrupted}, run.failed{error},
 *   run.cancelled / run.interrupted, subagent.start / subagent.complete,
 *   replay.truncated.  Unknown types are ignored (never crash the stream).
 */
function _normalizeRunEvent(raw: Record<string, unknown>): ChatRunEvent | null {
  const name = _runStr(raw.event) || _runStr(raw.type);

  switch (name) {
    case "message.delta": {
      const content = _runStr(raw.delta);
      return content ? { type: "delta", content } : null;
    }
    case "message.interim": {
      // Mid-turn commentary beside tool calls — render as normal answer text.
      const content = _runStr(raw.text);
      return content ? { type: "delta", content } : null;
    }
    case "reasoning.available": {
      const content = _runStr(raw.text);
      return content ? { type: "reasoning", content } : null;
    }
    case "tool.started":
    case "tool.completed": {
      const completed = name === "tool.completed";
      const toolName = _runStr(raw.tool) || "tool";
      const label = completed
        ? _runStr(raw.preview) || (raw.error ? "执行失败" : "已完成")
        : _runStr(raw.preview);
      return {
        type: "tool_call",
        tool_calls: [
          {
            id: _runStr(raw.tool_call_id) || toolName,
            // `arguments` is repurposed as the display label, matching the
            // hermes.tool.progress convention used by /chat/stream.
            function: { name: toolName, arguments: label },
            hermes_label: label,
            hermes_status: completed ? "completed" : "running",
          },
        ],
      };
    }
    case "approval.request": {
      const choices = (Array.isArray(raw.choices) ? raw.choices : [])
        .map((choice) => _runStr(choice))
        .filter(Boolean);
      return {
        type: "approval",
        approval: {
          approvalId:
            _runStr(raw.request_id) ||
            _runStr(raw.approval_id) ||
            _runStr(raw.id) ||
            _runStr(raw.tool_call_id),
          tool:
            _runStr(raw.tool) ||
            _runStr(raw.tool_name) ||
            _runStr(raw.name) ||
            undefined,
          command: _runStr(raw.command) || undefined,
          description: _runStr(raw.description) || undefined,
          choices: choices.length > 0 ? choices : ["once", "deny"],
        },
      };
    }
    case "run.completed":
      return { type: "done", finish_reason: "stop", usage: _runUsage(raw.usage) };
    case "run.cancelled":
    case "run.interrupted":
      return { type: "done", finish_reason: "cancelled" };
    case "run.failed":
      return { type: "error", error: _runStr(raw.error) || "运行失败" };
    case "error":
      return {
        type: "error",
        error: _runStr(raw.error) || _runStr(raw.message) || "运行事件流出错",
      };
    case "session":
    case "run.session": {
      const sessionId = _runStr(raw.session_id);
      return sessionId ? { type: "session", session_id: sessionId } : null;
    }
    case "run.queued":
    case "run.steered":
    case "run.stopping":
    case "approval.responded":
    case "subagent.start":
    case "subagent.complete":
    case "replay.truncated":
      // Lifecycle / bookkeeping only — no UI surface.
      return null;
    default:
      // Hermes may add event types at any time: ignore, never throw.
      if (name) console.debug("[chatRunEvents] ignoring event:", name);
      return null;
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
  /** Read-only: a bind password is already stored (never returned). */
  bind_password_set?: boolean;
  username_attr: string;
  /** LDAP attribute → local display_name (default: displayName, falls back to cn). */
  display_name_attr: string;
  /** LDAP attribute → local email (default: mail, falls back to userPrincipalName). */
  email_attr: string;
  /** LDAP attribute → local department (default: department, falls back to physicalDeliveryOfficeName/ou). */
  department_attr: string;
  auto_create_user: boolean;
}

/** Result of POST /auth/ldap-test-user (admin-only domain login diagnostic). */
export interface LdapTestUserResult {
  ok: boolean;
  /** service_bind | search | user_bind | auto_create */
  stage: string;
  detail: string;
}

export interface HermesConfig {
  url: string;
  api_key: string;
}

/** One URL tried by the backend's Hermes health fallback chain. */
export interface HermesProbeAttempt {
  url: string;
  status: number | null;
  error?: string | null;
  auth?: string | null;
}

/** Diagnostic metadata returned with Hermes health results. */
export interface HermesProbe {
  ok?: boolean;
  attempts: HermesProbeAttempt[];
  resolved_url?: string | null;
  hint?: string | null;
  warning?: string | null;
}

/** Result of POST /auth/hermes-test — failures are HTTP 200 by design. */
export interface HermesTestResult {
  ok: boolean;
  message: string;
  hint?: string | null;
  warning?: string | null;
  url?: string | null;
  status?: number | null;
  latency_ms?: number | null;
  attempts: HermesProbeAttempt[];
}

export interface LlmConfig {
  base_url: string;
  api_key: string;
  model: string;
  welcome_prompt: string;
}

export interface LlmModelInfo {
  id: string;
  owned_by: string;
}

/** Result of POST /auth/llm-models/probe — failures are HTTP 200 by design. */
export type LlmModelsProbeResult =
  | { ok: true; models: LlmModelInfo[]; endpoint: string }
  | { ok: false; error: string; hint?: string };

export interface PermissionCatalogItem {
  key: string;
  label: string;
  description: string;
}

export interface PermissionsResponse {
  role: string;
  permissions: string[];
  catalog: PermissionCatalogItem[];
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
  /** Effective permission bits for the current user (derived from their role). */
  permissions() {
    return request<PermissionsResponse>("GET", "/auth/permissions");
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
  /** Admin-only: test an actual domain-user login through the full LDAP chain. */
  ldapTestUser(data: { username: string; password: string }) {
    return request<LdapTestUserResult>("POST", "/auth/ldap-test-user", data);
  },
  getHermesConfig() {
    return request<HermesConfig>("GET", "/auth/hermes-config");
  },
  saveHermesConfig(data: HermesConfig) {
    return request<HermesConfig>("PUT", "/auth/hermes-config", data);
  },
  testHermes() {
    return request<HermesTestResult>("POST", "/auth/hermes-test");
  },
  getLlmConfig() {
    return request<LlmConfig>("GET", "/auth/llm-config");
  },
  saveLlmConfig(data: LlmConfig) {
    return request<LlmConfig>("PUT", "/auth/llm-config", data);
  },
  /**
   * Discover the models an OpenAI-compatible endpoint exposes.
   *
   * Omitting `api_key` (or passing the masked value shown in the form) makes
   * the backend reuse the stored key.  Failures resolve with `ok: false`
   * instead of throwing, so callers can show an inline hint.
   */
  probeLlmModels(base_url: string, api_key?: string) {
    return request<LlmModelsProbeResult>("POST", "/auth/llm-models/probe", {
      base_url,
      api_key: api_key?.trim() ? api_key.trim() : null,
    });
  },
  generateWelcome(username: string) {
    return request<{ text: string }>("POST", "/auth/generate-welcome", { username });
  },
  generateSetupPassword() {
    return request<{ password: string; length: number }>("GET", "/auth/setup/generate-password");
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

/* ── Application Systems ──────────────────────────── */

export interface AppSystemResource {
  id: number;
  resource_type: string;
  resource_id: number;
}

export interface AppSystem {
  id: number;
  name: string;
  tier: "L0" | "L1" | "L2";
  status: "active" | "inactive" | "archived";
  description?: string | null;
  resources: AppSystemResource[];
  created_at?: string | null;
  updated_at?: string | null;
}

export const systemApi = {
  list(params?: { search?: string; tier?: string }) {
    const qs = new URLSearchParams();
    if (params?.search) qs.set("search", params.search);
    if (params?.tier) qs.set("tier", params.tier);
    const q = qs.toString();
    return request<AppSystem[]>("GET", `/systems${q ? `?${q}` : ""}`);
  },

  get(id: number) {
    return request<AppSystem>("GET", `/systems/${id}`);
  },

  create(data: { name: string; tier?: string; description?: string }) {
    return request<AppSystem>("POST", "/systems", data);
  },

  update(id: number, data: { name?: string; tier?: string; status?: string; description?: string }) {
    return request<AppSystem>("PUT", `/systems/${id}`, data);
  },

  delete(id: number) {
    return request<void>("DELETE", `/systems/${id}`);
  },

  resources: {
    list(systemId: number) {
      return request<AppSystemResource[]>("GET", `/systems/${systemId}/resources`);
    },

    attach(systemId: number, resourceType: string, resourceId: number) {
      return request<AppSystemResource>("POST", `/systems/${systemId}/resources`, {
        resource_type: resourceType,
        resource_id: resourceId,
      });
    },

    detach(systemId: number, resourceId: number) {
      return request<void>("DELETE", `/systems/${systemId}/resources/${resourceId}`);
    },
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

/** In-process ingestion heartbeat from GET /knowledge/documents/{id}/status. */
export interface KnowledgeDocStatus {
  status: string;
  progress: {
    stage: string;
    step: number;
    total: number;
    message: string;
  };
  error: string | null;
  updated_at: string | null;
}

/** One explainable-search source; doc_id is filled by title matching (not vectors). */
export interface KnowledgeExplainSource {
  title: string;
  doc_id: number | null;
  score: number | null;
}

export interface KnowledgeSearchExplainResult {
  hit: boolean;
  answer: string;
  sources: KnowledgeExplainSource[];
  confidence: number;
  latency_ms: number;
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
  batchDelete(ids: number[]) {
    return request<{ deleted: number; requested: number; missing: number[] }>(
      "POST",
      "/knowledge/documents/batch-delete",
      { ids },
    );
  },
  status(id: number) {
    return request<KnowledgeDocStatus>("GET", `/knowledge/documents/${id}/status`);
  },
  ingest(id: number) {
    return request<{ ok: boolean; status: string; hermes_session_id?: string; message: string }>("POST", `/knowledge/documents/${id}/ingest`);
  },
  test(question: string) {
    return request<KnowledgeTestResult>("POST", "/knowledge/test", { question });
  },
  searchExplain(question: string) {
    const qs = new URLSearchParams({ question });
    return request<KnowledgeSearchExplainResult>("GET", `/knowledge/search-explain?${qs.toString()}`);
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
  display_name?: string | null;
  email?: string | null;
  department?: string | null;
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
  /**
   * Hermes agent session bound to this chat (continuity token).  When present
   * the next turn continues the same agent context instead of replaying the
   * whole transcript.
   */
  hermes_session_id?: string | null;
  /** Hermes run still executing for this chat (reattach after a reload). */
  active_run_id?: string | null;
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
  /** Update a system chat mode (currently: its system prompt). */
  update(slug: string, data: { system_prompt?: string; enabled?: boolean }) {
    return request<ChatModeOut>("PUT", `/chat/modes/${slug}`, data);
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
  /** Rich Hermes self-report (version / runtime / features / health). */
  hermesInfo() {
    return request<HermesInfo>("GET", "/chat/hermes-info");
  },
  /** Capability bits only — readable by every signed-in user (no admin needed). */
  hermesCapabilities() {
    return request<{
      run_submission?: boolean;
      run_stop?: boolean;
      run_steer?: boolean;
      run_approval_response?: boolean;
      tool_progress_events?: boolean;
      chat_completions_streaming?: boolean;
      session_continuity_header?: string | null;
    }>("GET", "/chat/hermes-capabilities");
  },
};

/** Capability self-report surfaced by ``GET /api/chat/hermes-info``. */
export interface HermesInfo {
  url: string;
  ok: boolean;
  latency_ms?: number;
  error?: string;
  warning?: string;
  probe?: HermesProbe;
  version?: string;
  platform?: string;
  gateway_state?: string;
  runtime?: {
    mode?: string;
    tool_execution?: string;
    split_runtime?: boolean;
    description?: string;
  };
  features?: Record<string, boolean | string | Record<string, unknown> | undefined>;
  session_continuity_header?: string | null;
  checks?: Record<string, string>;
  platforms?: Record<string, string>;
  current_model?: { provider: string; models: string[] } | null;
  disk_used_percent?: number | null;
}

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
    /**
     * Hermes linkage persisted in the same write.  Omit a key to leave the
     * stored value untouched; send ``null`` to clear it.
     */
    links?: {
      hermes_session_id?: string | null;
      active_run_id?: string | null;
    },
  ) {
    return request<void>("POST", `/chat/sessions/${sessionId}/messages`, {
      messages,
      title,
      ...(links ?? {}),
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
  display_name?: string | null;
  email?: string | null;
  department?: string | null;
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
  /** Error message from the most recent execution, when Hermes reports one. */
  last_error?: string | null;
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

/* ── Alert center (webhook → RCA pipeline) ─────────── */

export interface AlertOut {
  id: number;
  alert_uid: string | null;
  source: string | null;
  ip: string | null;
  ci_name: string | null;
  ci_application: string | null;
  ci_id: string | null;
  content: string | null;
  severity: string | null;
  severity_level: number | null;
  severity_label: string;
  alert_type: string | null;
  metric: string | null;
  alert_time: string | null;
  status: string;
  trigger_reason: string | null;
  rca_session_id: number | null;
  raw_payload: Record<string, unknown>;
  created_at: string;
}

export interface AlertStats {
  days: number;
  total: number;
  pending: number;
  triggered: number;
  coalesced: number;
  filtered: number;
  dismissed: number;
  by_status: Record<string, number>;
  by_severity: Record<string, number>;
  top_services: Array<{ name: string; count: number }>;
  by_type: Array<{ name: string; count: number }>;
  rca: {
    by_status: Record<string, number>;
    completed: number;
    failed: number;
    running: number;
    queued: number;
    avg_seconds: number | null;
  };
}

export interface AlertRetention {
  /** 收件箱保留天数；0 = 不自动清理 */
  inbox_days: number;
  /** 垃圾箱保留天数；0 = 不自动清理 */
  trash_days: number;
  auto_clear_enabled: boolean;
}

export interface AlertPolicy {
  mode: "auto" | "manual";
  trigger: {
    severity_max: number;
    severity_trigger: boolean;
    unrecognized_severity: string;
    analysis_start_offset_minutes: number;
    app_coalesce_window: number;
    critical_components: string[];
    high_risk_keywords: string[];
  };
  dedup: { window_seconds: number };
  multi: { trigger_paths: { A: boolean; B: boolean; C: boolean } };
  rca: { run_timeout_seconds: number; concurrency: number };
  notify: { enabled: boolean; wecom_chat_id: string };
  retention: AlertRetention;
  webhook_token: string;
}

export interface WebhookInfo {
  url: string;
  token: string;
  token_configured: boolean;
  token_mode?: "multi" | "legacy" | "open";
  team_token_count?: number;
  sample_payload: Record<string, unknown>;
  curl: string;
  formats: string[];
}

/* Webhook token → team bindings (multi-team ingestion) */
export interface WebhookTokenItem {
  id: string;
  name: string;
  team_id: number;
  team_name: string | null;
  enabled: boolean;
  created_at: string;
  token_prefix: string;
  masked: string;
}

export interface WebhookTokenList {
  configured: boolean;
  mode: "single" | "multi";
  items: WebhookTokenItem[];
  teams: Array<{ id: number; name: string }>;
  legacy_token_configured: boolean;
  max_tokens: number;
}

export interface WebhookTokenCreated {
  token: string;
  item: WebhookTokenItem;
  message: string;
}

export interface AlertPurgeResult {
  team_id: number | null;
  inbox_days: number;
  trash_days: number;
  deleted_inbox: number;
  deleted_trash: number;
  deleted_total: number;
  executed_at?: string;
  message?: string;
}

export const alertsApi = {
  webhookInfo() {
    return request<WebhookInfo>("GET", "/alerts/webhook-info");
  },
  rotateToken() {
    return request<{ token: string; configured: boolean }>("POST", "/alerts/webhook/rotate-token");
  },
  inbox(params?: { page?: number; page_size?: number; status?: string; search?: string }) {
    const qs = new URLSearchParams();
    if (params?.page) qs.set("page", String(params.page));
    if (params?.page_size) qs.set("page_size", String(params.page_size));
    if (params?.status) qs.set("status", params.status);
    if (params?.search) qs.set("search", params.search);
    const q = qs.toString();
    return request<Paginated<AlertOut>>("GET", `/alerts/inbox${q ? `?${q}` : ""}`);
  },
  trash(params?: { page?: number; page_size?: number; search?: string }) {
    const qs = new URLSearchParams();
    if (params?.page) qs.set("page", String(params.page));
    if (params?.page_size) qs.set("page_size", String(params.page_size));
    if (params?.search) qs.set("search", params.search);
    const q = qs.toString();
    return request<Paginated<AlertOut>>("GET", `/alerts/trash${q ? `?${q}` : ""}`);
  },
  clearTrash() {
    return request<{ deleted: number }>("POST", "/alerts/trash/clear");
  },
  stats(days = 7) {
    return request<AlertStats>("GET", `/alerts/stats?days=${days}`);
  },
  policy() {
    return request<AlertPolicy>("GET", "/alerts/policy");
  },
  savePolicy(policy: AlertPolicy) {
    return request<AlertPolicy>("PUT", "/alerts/policy", policy);
  },
  webhookTokens() {
    return request<WebhookTokenList>("GET", "/alerts/webhook-tokens");
  },
  createWebhookToken(data: { name?: string; team_id: number; enabled?: boolean }) {
    return request<WebhookTokenCreated>("POST", "/alerts/webhook-tokens", data);
  },
  deleteWebhookToken(params: { id?: string; prefix?: string; token?: string }) {
    const qs = new URLSearchParams();
    if (params.id) qs.set("id", params.id);
    if (params.prefix) qs.set("prefix", params.prefix);
    if (params.token) qs.set("token", params.token);
    const q = qs.toString();
    return request<{
      deleted: number;
      id: string;
      name: string;
      team_id: number;
      remaining: number;
      message: string;
    }>("DELETE", `/alerts/webhook-tokens${q ? `?${q}` : ""}`);
  },
  purgeAlerts(allTeams = false) {
    return request<AlertPurgeResult>(
      "POST",
      `/alerts/purge${allTeams ? "?all_teams=true" : ""}`,
    );
  },
  trigger(id: number) {
    return request<{ status: string; rca_session_id: number }>("POST", `/alerts/${id}/trigger`);
  },
  dismiss(id: number) {
    return request<{ status: string; id: number }>("POST", `/alerts/${id}/dismiss`);
  },
};

/* ── Root-cause knowledge base ─────────────────────── */

export interface RootCauseItem {
  id: number;
  session_id: number | null;
  service_name: string | null;
  alert_type: string | null;
  title: string | null;
  root_cause: string | null;
  digest: string | null;
  evidence: unknown[];
  label: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  similarity?: number;
}

export const rootCauseApi = {
  list(params?: { page?: number; page_size?: number; label?: string; service?: string; search?: string }) {
    const qs = new URLSearchParams();
    if (params?.page) qs.set("page", String(params.page));
    if (params?.page_size) qs.set("page_size", String(params.page_size));
    if (params?.label) qs.set("label", params.label);
    if (params?.service) qs.set("service", params.service);
    if (params?.search) qs.set("search", params.search);
    const q = qs.toString();
    return request<Paginated<RootCauseItem>>("GET", `/knowledge/root-causes${q ? `?${q}` : ""}`);
  },
  similar(query: string, service?: string) {
    const qs = new URLSearchParams({ query });
    if (service) qs.set("service", service);
    return request<{ query: string; items: RootCauseItem[] }>("GET", `/knowledge/root-causes/similar?${qs}`);
  },
  label(id: number, label: "confirmed" | "false_positive" | "pending") {
    return request<RootCauseItem>("PUT", `/knowledge/root-causes/${id}/label`, { label });
  },
  create(data: { root_cause: string; service_name?: string; alert_type?: string; title?: string; label?: string }) {
    return request<RootCauseItem>("POST", "/knowledge/root-causes", data);
  },
  remove(id: number) {
    return request<{ deleted: number }>("DELETE", `/knowledge/root-causes/${id}`);
  },
};

/* ── Audit trail ───────────────────────────────────── */

export interface AuditEntry {
  id: number;
  username: string | null;
  action: string;
  detail: string | null;
  ip: string | null;
  extra: Record<string, unknown> | null;
  created_at: string;
}

export const auditApi = {
  list(params?: { page?: number; page_size?: number; action?: string; username?: string }) {
    const qs = new URLSearchParams();
    if (params?.page) qs.set("page", String(params.page));
    if (params?.page_size) qs.set("page_size", String(params.page_size));
    if (params?.action) qs.set("action", params.action);
    if (params?.username) qs.set("username", params.username);
    const q = qs.toString();
    return request<{ items: AuditEntry[]; total: number; page: number; page_size: number; actions: string[] }>(
      "GET", `/audit${q ? `?${q}` : ""}`,
    );
  },
};
