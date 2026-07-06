import { deriveEids } from './assetEdit';

// Client-side edit view — the BrowserAdapter's equivalent of the server's
// `toEditView` (server/index.mjs). Parse first, derive data-eid from data-hs-id
// (or fresh), strip the asset's scripts, serialize for the iframe's srcdoc. MIRROR
// of the server function; if one changes, change both.
export function clientEditView(html: string): string {
  const dom = new DOMParser().parseFromString(html, 'text/html');
  deriveEids(dom);
  dom.querySelectorAll('script').forEach((s) => s.remove());
  const doctype = dom.doctype ? '<!doctype html>\n' : '';
  return doctype + dom.documentElement.outerHTML;
}

/** Does this HTML already conform to the asset contract (has at least one page)? */
export function isContract(html: string): boolean {
  return /class\s*=\s*["'][^"']*\bhs-page\b/.test(html);
}

/** Does this HTML build itself with scripts (so a static parse would miss the design)? */
export function needsRender(html: string): boolean {
  return !isContract(html) && /<script[\s>]/i.test(html);
}

// Script-built files (e.g. "standalone" AI exports that unpack themselves at load)
// have no design until their JS runs. Render once in a sandboxed iframe with an
// OPAQUE origin (sandbox="allow-scripts", no allow-same-origin: the file's code can
// never touch the app), wait for the DOM to go quiet, and take a static snapshot.
// The file's scripts are dropped from the snapshot — the editor edits DOM, not
// programs. Resolves with the original html if the file never reports back.
export function renderToStatic(html: string, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve) => {
    const nonce = crypto.randomUUID();
    const capture = `<script>(function () {
      var sent = false;
      // blob: URLs (bundlers unpack embedded images into them) die with this iframe,
      // so bake each one into a data URI before serializing.
      function inlineBlobs(cb) {
        var jobs = [];
        Array.prototype.forEach.call(document.querySelectorAll('img'), function (img) {
          if (/^blob:/.test(img.src)) jobs.push([img.src, function (uri) { img.src = uri; }]);
        });
        Array.prototype.forEach.call(document.querySelectorAll('*'), function (el) {
          var m = el.style && el.style.backgroundImage && el.style.backgroundImage.match(/url\\(["']?(blob:[^"')]+)["']?\\)/);
          if (m) jobs.push([m[1], function (uri) { el.style.backgroundImage = 'url("' + uri + '")'; }]);
        });
        var left = jobs.length;
        if (!left) return cb();
        jobs.forEach(function (job) {
          var doneOne = function () { if (--left === 0) cb(); };
          fetch(job[0]).then(function (r) { return r.blob(); }).then(function (b) {
            var fr = new FileReader();
            fr.onload = function () { job[1](fr.result); doneOne(); };
            fr.onerror = doneOne;
            fr.readAsDataURL(b);
          }).catch(doneOne);
        });
      }
      function send() {
        if (sent) return;
        sent = true;
        inlineBlobs(function () {
          document.querySelectorAll('script').forEach(function (s) { s.remove(); });
          parent.postMessage({ hsCapture: '${nonce}', html: '<!doctype html>\\n' + document.documentElement.outerHTML }, '*');
        });
      }
      window.addEventListener('load', function () {
        var last = Date.now();
        new MutationObserver(function () { last = Date.now(); })
          .observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
        var iv = setInterval(function () {
          if (Date.now() - last > 900) { clearInterval(iv); send(); }
        }, 250);
        setTimeout(function () { clearInterval(iv); send(); }, ${timeoutMs - 3000}); // never-quiet pages (rAF loops): snapshot anyway
      });
    })()</${'script'}>`;
    const at = html.toLowerCase().lastIndexOf('</body>');
    const doc = at === -1 ? html + capture : html.slice(0, at) + capture + html.slice(at);

    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    // Render at a full desktop viewport: dashboards and other horizontal designs
    // lay out (and JS-measure their charts) against this width — a narrow sandbox
    // bakes in cramped geometry that the freeze then cuts off.
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1920px;height:1200px;visibility:hidden;';
    const done = (out: string) => {
      window.removeEventListener('message', onMsg);
      frame.remove();
      resolve(out);
    };
    const timer = setTimeout(() => done(html), timeoutMs);
    const onMsg = (e: MessageEvent) => {
      if (e.source === frame.contentWindow && e.data?.hsCapture === nonce && typeof e.data.html === 'string') {
        clearTimeout(timer);
        done(e.data.html);
      }
    };
    window.addEventListener('message', onMsg);
    frame.srcdoc = doc;
    document.body.appendChild(frame);
  });
}
