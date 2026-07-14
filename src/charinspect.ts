// Character inspector: the status-bar codepoint segment's popup, showing a
// character's exact byte sequence under UTF-8 and (if different) the
// document's own save encoding (ROADMAP.md v0.4 Track A). Mirrors
// detectcard.ts's encoding-detection diagnostics popup pattern (same
// anchored-panel positioning, same away-click/Escape close handling) —
// read-only, never changes the open document.
import { t } from "./i18n";
import { encodeChar, type EncodeCharResult } from "./ipc";
import { formatCodePoint } from "./statusbar";

export interface CharInspectRow {
  label: string;
  value: string;
  /** True for the one row that reports an unrepresentable character —
   *  styled as a warning rather than a plain value. */
  warn?: boolean;
}

export interface CharInspectModel {
  title: string;
  rows: CharInspectRow[];
}

/**
 * Pure formatter: assemble the popup's rows from already-fetched byte
 * results. `target` is `null` when the document's current save encoding is
 * UTF-8 (the UTF-8 row already covers it — see spec point 3, "目前儲存編碼
 * bytes（若非 UTF-8）"), otherwise the `{encoding} Bytes` row shows either
 * the hex bytes or, when unrepresentable, a "cannot be represented" message
 * in place of bytes (never encoding_rs's own HTML-entity fallback — see
 * src-tauri/src/charinspect.rs's module doc comment).
 */
export function formatCharInspect(
  char: string,
  currentEncoding: string,
  utf8Hex: string,
  target: { hex: string; lossy: boolean } | null,
): CharInspectModel {
  const codepoint = formatCodePoint(char);
  const rows: CharInspectRow[] = [
    { label: t("charinspect.labelChar"), value: char },
    { label: t("charinspect.labelCodePoint"), value: codepoint },
    { label: t("charinspect.labelUtf8Bytes"), value: utf8Hex },
  ];
  if (target) {
    rows.push({
      label: t("charinspect.labelEncodingBytes", currentEncoding),
      value: target.lossy ? t("charinspect.lossyValue", currentEncoding) : target.hex,
      // Only present (never `warn: false`) so a representable target
      // encoding's row is a plain, unflagged {label, value} like every
      // other row above.
      ...(target.lossy ? { warn: true } : {}),
    });
  }
  return { title: t("charinspect.title", codepoint), rows };
}

function renderCard(panel: HTMLElement, model: CharInspectModel): void {
  panel.innerHTML = "";

  // Reuses detectcard.ts's own header/row CSS classes verbatim (purely
  // visual, no "already open" guard logic keys off them) — only the outer
  // panel below gets its own class, so the two features' guards can never
  // see each other's popup (see styles.css's shared `.detectcard-panel,
  // .charinspect-panel` selector).
  const header = document.createElement("div");
  header.className = "detectcard-header";
  header.textContent = model.title;
  panel.appendChild(header);

  const table = document.createElement("dl");
  table.className = "detectcard-rows";
  for (const row of model.rows) {
    const dt = document.createElement("dt");
    dt.textContent = row.label;
    const dd = document.createElement("dd");
    dd.textContent = row.value;
    if (row.warn) dd.className = "charinspect-lossy";
    table.appendChild(dt);
    table.appendChild(dd);
  }
  panel.appendChild(table);
}

/**
 * Show the character-inspector popup for `char`, anchored above `anchor`
 * like every other status-bar popup (no full-screen overlay). `char` is the
 * single code point last shown in the status-bar segment (see
 * statusbar.ts's `currentInspectedChar`); `currentEncoding` is the active
 * document's own save encoding (`doc.encoding`) — valid even for a
 * large-file (truncated) window, since the character's bytes under that
 * encoding don't depend on how much of the file is currently loaded.
 */
export function showCharInspector(anchor: HTMLElement, char: string, currentEncoding: string): void {
  if (document.querySelector(".charinspect-panel")) return;

  const panel = document.createElement("div");
  panel.className = "charinspect-panel";
  panel.textContent = t("common.loading");

  const close = (): void => {
    document.removeEventListener("mousedown", onAway);
    document.removeEventListener("keydown", onKey);
    panel.remove();
  };
  const onAway = (event: MouseEvent): void => {
    if (!panel.contains(event.target as Node)) close();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };

  document.body.appendChild(panel);
  const rect = anchor.getBoundingClientRect();
  panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - panel.offsetWidth - 8))}px`;
  panel.style.bottom = `${window.innerHeight - rect.top + 6}px`;
  // Deferred so the click that opened the popup doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener("mousedown", onAway);
    document.addEventListener("keydown", onKey);
  }, 0);

  const targetPromise: Promise<EncodeCharResult | null> =
    currentEncoding === "UTF-8" ? Promise.resolve(null) : encodeChar(char, currentEncoding);

  void Promise.all([encodeChar(char, "UTF-8"), targetPromise])
    .then(([utf8, target]) => {
      renderCard(
        panel,
        formatCharInspect(
          char,
          currentEncoding,
          utf8.bytesHex,
          target ? { hex: target.bytesHex, lossy: target.lossy } : null,
        ),
      );
    })
    .catch((error) => {
      panel.textContent = String(error);
    });
}
