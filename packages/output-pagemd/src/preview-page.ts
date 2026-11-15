// The Print Preview page (P10, D19): pagemd's HTML made loadable in the webview's frame. Pure string work, no Node.

/**
 * The HTML outside its `<script>` elements, as pieces: `[text, isScript]`. Scripts (Paged.js, pagemd's own) are left
 * exactly as they are.
 */
export function outsideScripts(html: string): Array<[string, boolean]> {
  const parts: Array<[string, boolean]> = [];
  const re = /<script\b[\s\S]*?<\/script\s*>/gi;
  let last = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m.index > last) parts.push([html.slice(last, m.index), false]);
    parts.push([m[0], true]);
    last = m.index + m[0].length;
  }
  if (last < html.length) parts.push([html.slice(last), false]);
  return parts;
}

/**
 * The `file://` addresses pagemd wrote outside scripts, with where each one is. pagemd writes them with the path as it is
 * (`file:///D:/My Documents/a.png`, spaces and all, not `%20`: renderer-pdf's `toFileUrl`), so an address in quotes ends at its
 * closing quote (or `&quot;`), one in an unquoted CSS `url(` at its `)`, any other at white space, a quote or a bracket.
 */
function fileUrlsIn(text: string): Array<{ from: number; to: number; url: string }> {
  const found: Array<{ from: number; to: number; url: string }> = [];
  const re = /(&quot;|&#39;|["'(])?file:\/\//g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const from = m.index + (m[1]?.length ?? 0);
    const opener = m[1];
    const close = opener === '"' || opener === "'" || opener === '&quot;' || opener === '&#39;' ? opener : opener === '(' ? ')' : undefined;
    let to: number;
    if (close) {
      const line = text.indexOf('\n', from);
      const end = text.indexOf(close, from);
      to = end < 0 ? (line < 0 ? text.length : line) : line >= 0 && line < end ? line : end;
      while (to > from && /\s/.test(text[to - 1]!)) to--; // `url( file:///a.png )`
    } else {
      const rest = /^file:\/\/[^\s"'()<>]+/.exec(text.slice(from));
      to = from + (rest?.[0].length ?? 0);
    }
    found.push({ from, to, url: text.slice(from, to) });
    re.lastIndex = Math.max(to, re.lastIndex);
  }
  return found;
}

function replaceUrls(text: string, swap: (url: string) => string | null | undefined): string {
  let out = '';
  let last = 0;
  for (const { from, to, url } of fileUrlsIn(text)) {
    out += text.slice(last, from) + (swap(url) ?? url);
    last = to;
  }
  return out + text.slice(last);
}

/**
 * D19: every `file://` address pagemd wrote (the `<base href>`, image `src`, CSS `url()` …) becomes the address the webview
 * loads it from; one the map can't place (outside the folders the webview may read) is left as it is (not shown).
 */
export function rewriteFileUrls(html: string, map: (fileUrl: string) => string | null): string {
  return outsideScripts(html)
    .map(([text, script]) => (script ? text : replaceUrls(text, map)))
    .join('');
}

/** What the host made of one file address for the preview page: the file itself (a `data:` address), a reason it can't be, or null (leave it). */
export type Embedded = { url: string } | { problem: string } | null;

/**
 * FIX-preview: the preview is a `srcdoc` frame, and VS Code's webview answers "not found" to every webview address such a frame
 * asks for (its service worker finds the webview from the asking page's own address, and a `srcdoc` page has none). So the page
 * carries its files itself: each `file://` address outside scripts is asked about once and replaced by what `embed` gives
 * (a `data:` address); the reasons for the files it couldn't give come back in `problems`, in page order.
 */
export async function embedFileUrls(html: string, embed: (fileUrl: string) => Promise<Embedded>): Promise<{ html: string; problems: string[] }> {
  const parts = outsideScripts(html);
  const answers = new Map<string, Embedded>();
  for (const [text, script] of parts) {
    if (script) continue;
    for (const { url } of fileUrlsIn(text)) if (!answers.has(url)) answers.set(url, await embed(url));
  }
  const problems = [...answers.values()].flatMap((a) => (a && 'problem' in a ? [a.problem] : []));
  const out = parts.map(([text, script]) => (script ? text : replaceUrls(text, (url) => { const a = answers.get(url); return a && 'url' in a ? a.url : null; }))).join('');
  return { html: out, problems };
}

/**
 * FIX-preview: a script put before Paged.js that notes the first error or failed promise in the page (`window.__pmdPreviewError`),
 * so the preview can say the layout failed instead of waiting for a completion flag that never comes. Carries the page's nonce.
 */
export function previewWatch(nonce: string): string {
  const n = nonce.replace(/[^A-Za-z0-9+/=_-]/g, '');
  return `<script nonce="${n}">
(function () {
  var note = function (what) { if (!window.__pmdPreviewError) window.__pmdPreviewError = String(what && what.message ? what.message : what); };
  window.addEventListener('error', function (e) { note(e.error || e.message); });
  window.addEventListener('unhandledrejection', function (e) { note(e.reason); });
})();
</script>`;
}

/**
 * The scripts that draw the preview's diagrams before Paged.js lays out the pages: the mermaid browser build shipped
 * with the extension (the version pagemd pins, C6), then a wrapper around Paged.js's `before` hook that replaces each
 * placeholder pagemd wrote (`<pre class="mermaid" data-mermaid-id>`) with its drawing. Both carry the page's nonce.
 */
export function mermaidRunner(nonce: string, scriptUrl: string, config: Readonly<Record<string, unknown>>): string {
  const n = nonce.replace(/[^A-Za-z0-9+/=_-]/g, '');
  const src = scriptUrl.replace(/"/g, '&quot;');
  return `<script nonce="${n}" src="${src}"></script>
<script nonce="${n}">
(function () {
  var config = window.PagedConfig || (window.PagedConfig = {});
  var before = config.before;
  config.before = async function (flow) {
    var pres = Array.prototype.slice.call(document.querySelectorAll('pre.mermaid[data-mermaid-id]'));
    if (pres.length && window.mermaid) {
      window.mermaid.initialize(${JSON.stringify(config)});
      for (var i = 0; i < pres.length; i++) {
        var pre = pres[i];
        try {
          var drawn = await window.mermaid.render(pre.getAttribute('data-mermaid-id'), pre.textContent || '');
          var holder = document.createElement('div');
          holder.innerHTML = drawn.svg;
          pre.replaceWith.apply(pre, Array.prototype.slice.call(holder.childNodes));
        } catch (e) {
          pre.classList.add('mermaid-error');
        }
      }
    }
    window.__pmdDiagrams = pres.length;
    if (before) return before(flow);
  };
})();
</script>`;
}
