/* ==========================================================================
 *  Markdown renderer for assistant answers
 *
 *  - GFM tables / task lists / strikethrough (remark-gfm)
 *  - Raw HTML allowed through rehype-raw, then sanitised
 *  - Fenced code → <CodeBlock> (language label + copy + horizontal scroll)
 *  - External links open in a new tab and carry an external-link glyph
 *  - Images are responsive and open in a dependency-free lightbox
 *
 *  The visual rhythm (headings, lists, quotes, tables, inline code) lives in
 *  the appended ``.chat-prose`` block in globals.css so the component stays
 *  focused on structure.
 * ========================================================================== */

import {
  memo,
  useCallback,
  useEffect,
  useState,
  type FC,
} from "react";
import { createPortal } from "react-dom";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { Download, ExternalLink, Loader2, Lock, X } from "lucide-react";
import { toast } from "sonner";
import { chatArtifacts } from "@/lib/api";
import { CodeBlock } from "./code-block";
import { nodeToText } from "./chat-utils";

/* ==========================================================================
 *  Agent artifacts (B1) — [[artifact: name]] / MEDIA:<path> download chips
 *
 *  The backend only serves basenames matching [A-Za-z0-9._-]+ from the shared
 *  hermes-files directory, so anything else stays as plain text.
 * ========================================================================== */

const ARTIFACT_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;

function safeArtifactName(name: string): boolean {
  return ARTIFACT_NAME_RE.test(name) && name !== "." && name !== "..";
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

/** Fenced-code opener at the start of a line (``` or ~~~, 3+ chars). */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

/** A plain-text or protected (code / URL) run of a line. */
interface InlineSegment {
  text: string;
  protected: boolean;
}

/** Rewrite artifact / MEDIA markers inside one plain-text run. */
function replaceMarkers(text: string): string {
  const withArtifacts = text.replace(
    /\[\[artifact:\s*([^\]\s]+)\s*\]\]/g,
    (match, rawName: string) =>
      safeArtifactName(rawName)
        ? `[下载 ${rawName}](#liumai-artifact:${encodeURIComponent(rawName)})`
        : match,
  );
  /* MEDIA:<绝对路径> is Hermes' native delivery marker. Only its basename is
     trusted — never turn an arbitrary absolute path into a link. */
  return withArtifacts.replace(/MEDIA:([^\s)\]}>]+)/g, (match, rawPath: string) => {
    const name = basename(rawPath);
    return safeArtifactName(name)
      ? `[文件：${name}](#liumai-media:${encodeURIComponent(name)})`
      : match;
  });
}

/**
 * Split one line into inline-code spans and plain text.
 *
 * CommonMark code spans are delimited by runs of the same number of backticks
 * and never cross a newline; markers inside them must stay verbatim.
 */
function splitInlineCode(line: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let buffer = "";
  let index = 0;
  const flush = () => {
    if (buffer) {
      segments.push({ text: buffer, protected: false });
      buffer = "";
    }
  };

  while (index < line.length) {
    if (line[index] !== "`") {
      buffer += line[index];
      index += 1;
      continue;
    }

    let run = 1;
    while (line[index + run] === "`") run += 1;

    let cursor = index + run;
    let close = -1;
    while (cursor < line.length && line[cursor] !== "\n") {
      if (line[cursor] === "`") {
        let closeRun = 1;
        while (line[cursor + closeRun] === "`") closeRun += 1;
        if (closeRun === run) {
          close = cursor;
          break;
        }
        cursor += closeRun;
        continue;
      }
      cursor += 1;
    }

    if (close === -1) {
      // Unmatched backticks are literal text, not a code span.
      buffer += line.slice(index, index + run);
      index += run;
      continue;
    }

    flush();
    segments.push({ text: line.slice(index, close + run), protected: true });
    index = close + run;
  }

  flush();
  return segments;
}

/**
 * Split plain text so markdown link destinations, autolinks and bare URLs are
 * never rewritten.  A marker inside a URL must not become a download chip.
 */
function splitLinkTargets(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let buffer = "";
  let index = 0;
  const flush = () => {
    if (buffer) {
      segments.push({ text: buffer, protected: false });
      buffer = "";
    }
  };

  while (index < text.length) {
    // Markdown link destination: "](" … ")" (balanced parentheses).
    if (text[index] === "]" && text[index + 1] === "(") {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < text.length && depth > 0) {
        if (text[cursor] === "(") depth += 1;
        else if (text[cursor] === ")") depth -= 1;
        cursor += 1;
      }
      flush();
      segments.push({ text: text.slice(index, cursor), protected: true });
      index = cursor;
      continue;
    }

    // Autolink / HTML tag: <scheme:…>
    if (text[index] === "<") {
      const close = text.indexOf(">", index + 1);
      if (close !== -1) {
        const inside = text.slice(index + 1, close);
        if (/^[a-z][a-z0-9+.-]*:/i.test(inside)) {
          flush();
          segments.push({ text: text.slice(index, close + 1), protected: true });
          index = close + 1;
          continue;
        }
      }
    }

    // Bare http(s) URL (square brackets may legally appear in a URL path).
    const url = /^https?:\/\/[^\s<>()]+/.exec(text.slice(index));
    if (url) {
      flush();
      segments.push({ text: url[0], protected: true });
      index += url[0].length;
      continue;
    }

    buffer += text[index];
    index += 1;
  }

  flush();
  return segments;
}

/** Rewrite markers in plain text only (code spans / URLs already protected). */
function rewritePlainText(text: string): string {
  return splitLinkTargets(text)
    .map((segment) => (segment.protected ? segment.text : replaceMarkers(segment.text)))
    .join("");
}

/**
 * Rewrite both artifact conventions into internal fragment links, skipping
 * fenced code blocks (``` / ~~~), inline code and link targets.  The custom
 * ``a`` renderer below turns the generated links into download chips;
 * rehype-sanitize keeps fragment URLs intact.
 */
function withArtifactLinks(content: string): string {
  const lines = content.split("\n");
  const output: string[] = [];
  let fence: { char: string; length: number } | null = null;

  for (const line of lines) {
    if (fence) {
      output.push(line);
      // A closing fence uses the same char and is at least as long as the
      // opening one; a different char or a shorter run stays inside the block.
      const close = new RegExp(
        `^ {0,3}${fence.char}{${fence.length},}[ \\t]*$`,
      );
      if (close.test(line)) fence = null;
      continue;
    }

    const open = FENCE_OPEN_RE.exec(line);
    if (open) {
      fence = { char: open[1][0], length: open[1].length };
      output.push(line);
      continue;
    }

    output.push(
      splitInlineCode(line)
        .map((segment) =>
          segment.protected ? segment.text : rewritePlainText(segment.text),
        )
        .join(""),
    );
  }

  return output.join("\n");
}

const ArtifactChip: FC<{
  name: string;
  kind: "artifact" | "media";
  sessionId?: string | number | null;
}> = ({ name, kind, sessionId }) => {
  const [busy, setBusy] = useState(false);

  // Artifacts are served per platform session and ownership-checked, so a
  // download without a saved session id can only 404.  Show the hint instead.
  const hasSession =
    typeof sessionId === "number" && Number.isInteger(sessionId) && sessionId > 0;

  const handleDownload = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await chatArtifacts.download(sessionId, name);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "文件下载失败");
    } finally {
      setBusy(false);
    }
  }, [busy, name, sessionId]);

  if (!hasSession) {
    return (
      <span
        className="chat-artifact-chip mx-0.5 inline-flex max-w-full items-center gap-1 rounded-lg border border-dashed border-border/60 bg-surface-secondary/40 px-2 py-0.5 align-baseline text-[11.5px] font-medium text-text-secondary/80"
        title="请先保存会话后再下载产物"
      >
        <Lock className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="truncate">
          {kind === "media" ? "文件：" : "产物："}
          {name}
        </span>
        <span className="shrink-0 text-[10px] opacity-70">保存会话后可下载</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void handleDownload()}
      disabled={busy}
      className="chat-artifact-chip mx-0.5 inline-flex max-w-full items-center gap-1 rounded-lg border border-border/60 bg-surface-secondary/70 px-2 py-0.5 align-baseline text-[11.5px] font-medium text-interactive-primary transition-colors hover:border-interactive-primary/35 hover:bg-interactive-primary/10 disabled:opacity-60"
      title={kind === "media" ? `下载文件：${name}` : `下载产物：${name}`}
      aria-label={`下载 ${name}`}
    >
      {busy ? (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />
      ) : (
        <Download className="h-3 w-3 shrink-0" aria-hidden="true" />
      )}
      <span className="truncate">
        {kind === "media" ? "文件：" : "下载："}
        {name}
      </span>
    </button>
  );
};

interface LightboxImage {
  src: string;
  alt: string;
}

const ImageLightbox: FC<LightboxImage & { onClose: () => void }> = ({
  src,
  alt,
  onClose,
}) => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/75 p-5 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={alt || "图片预览"}
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute right-5 top-5 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white/90 transition-colors hover:bg-white/20"
        aria-label="关闭图片预览"
      >
        <X className="h-4.5 w-4.5" />
      </button>
      <img
        src={src}
        alt={alt}
        className="max-h-[88vh] max-w-[92vw] rounded-xl object-contain shadow-2xl ring-1 ring-white/15"
        onClick={(event) => event.stopPropagation()}
      />
      {alt && (
        <p className="absolute bottom-6 max-w-[80vw] truncate text-center text-[12px] text-white/70">
          {alt}
        </p>
      )}
    </div>,
    document.body,
  );
};

export const Markdown: FC<{
  content: string;
  /** Platform session id used in the artifact download URL (shape only). */
  sessionId?: string | number | null;
}> = memo(function Markdown({ content, sessionId }) {
  const [lightbox, setLightbox] = useState<LightboxImage | null>(null);
  const closeLightbox = useCallback(() => setLightbox(null), []);

  const components: Components = {
    /* Fenced code is promoted to CodeBlock by the `code` renderer below; the
     * default <pre> wrapper must not double-render it. */
    pre: ({ children }) => <>{children}</>,
    code: ({ className, children }) => {
      const text = nodeToText(children).replace(/\n$/, "");
      const match = /language-([\w+#.-]+)/.exec(className ?? "");
      const isBlock = Boolean(match) || text.includes("\n");
      if (isBlock) {
        return <CodeBlock code={text} language={match?.[1]} />;
      }
      return <code className="chat-inline-code">{children}</code>;
    },
    table: ({ children }) => (
      <div className="chat-table-wrap">
        <table>{children}</table>
      </div>
    ),
    a: ({ href, children, title }) => {
      if (href?.startsWith("#liumai-artifact:") || href?.startsWith("#liumai-media:")) {
        const kind = href.startsWith("#liumai-media:") ? "media" : "artifact";
        const raw = href.slice(href.indexOf(":") + 1);
        let name = raw;
        try {
          name = decodeURIComponent(raw);
        } catch {
          return <span>{children}</span>;
        }
        if (!safeArtifactName(name)) return <span>{children}</span>;
        return <ArtifactChip name={name} kind={kind} sessionId={sessionId} />;
      }
      const external = Boolean(href && /^https?:/i.test(href));
      return (
        <a
          href={href}
          title={title}
          target={external ? "_blank" : undefined}
          rel={external ? "noopener noreferrer" : undefined}
          className="chat-link"
        >
          {children}
          {external && (
            <ExternalLink
              className="ml-0.5 inline h-3 w-3 -translate-y-px opacity-55"
              aria-hidden="true"
            />
          )}
        </a>
      );
    },
    img: ({ src, alt }) => {
      const url = typeof src === "string" ? src : undefined;
      if (!url) return null;
      return (
        <img
          src={url}
          alt={alt ?? ""}
          loading="lazy"
          className="chat-image cursor-zoom-in"
          role="button"
          tabIndex={0}
          onClick={() => setLightbox({ src: url, alt: alt ?? "" })}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setLightbox({ src: url, alt: alt ?? "" });
            }
          }}
        />
      );
    },
  };

  return (
    <div className="chat-prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeSanitize]}
        components={components}
      >
        {withArtifactLinks(content)}
      </ReactMarkdown>
      {lightbox && (
        <ImageLightbox {...lightbox} onClose={closeLightbox} />
      )}
    </div>
  );
});

Markdown.displayName = "Markdown";
