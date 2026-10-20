/* ==========================================================================
 *  Clipboard helper — works outside secure contexts
 *
 *  ``navigator.clipboard`` is only exposed in secure contexts (HTTPS or
 *  localhost).  Over plain HTTP on an intranet address it is ``undefined``, so
 *  the previous ``navigator.clipboard.writeText(...)`` calls either threw or
 *  quietly did nothing while the UI still reported "已复制".
 *
 *  ``copyText`` feature-detects the modern API and falls back to a hidden
 *  ``<textarea>`` + ``document.execCommand("copy")``, which browsers still
 *  support in insecure contexts.
 * ========================================================================== */

/**
 * Copy *text* to the clipboard.
 *
 * @returns ``true`` when a copy path reported success, ``false`` otherwise.
 *          Callers should only show a "已复制" confirmation on ``true``.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;

  const clipboard =
    typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (clipboard && typeof clipboard.writeText === "function") {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied / insecure context — try the legacy path below.
    }
  }

  return legacyCopy(text);
}

/** Hidden-textarea + ``execCommand("copy")`` fallback. */
function legacyCopy(text: string): boolean {
  if (typeof document === "undefined" || !document.body) return false;

  const selection = document.getSelection();
  const savedRange =
    selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";

  document.body.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
    // Restore the user's previous selection, if any.
    if (savedRange && selection) {
      try {
        selection.removeAllRanges();
        selection.addRange(savedRange);
      } catch {
        /* selection may belong to a detached node */
      }
    }
  }
}
