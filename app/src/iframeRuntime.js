// Runs INSIDE the asset iframe. Injected by the editor (never saved into the
// source). Moveable runs here so it measures in the iframe's own untransformed
// space (the parent scales the whole iframe), correct at any zoom.
//
// Emits ONE command per gesture/action into the editor's append-only log:
//   { op: 'style'|'html'|'reorder'|'insert'|'delete', deltas: [{ eid, before, after }] }
// Elements are addressed by `data-eid` ATTRIBUTE (never array index) so structural
// ops (duplicate/delete/reorder) stay correct. Duplicated elements get fresh eids
// above the original count. Undo/redo (applyOp) replays before/after in place.
(function () {
  if (window.__hsEditor) return;
  var Moveable = window.Moveable;
  if (!Moveable) return;

  // Selection chrome matches the FixHTML accent (Moveable reads this CSS var).
  document.documentElement.style.setProperty('--moveable-color', '#2b5bff');

  var moveable = null;
  var currentPage = null;
  var selected = [];
  var gesture = null;
  var editing = false;
  var maxEid = -1;
  Array.prototype.forEach.call(document.querySelectorAll('.hs-el'), function (el) {
    var n = Number(el.getAttribute('data-eid'));
    if (n > maxEid) maxEid = n;
  });

  // --- small helpers ---------------------------------------------------------
  function host() { return window.__hsHost || {}; }
  function round(n) { return Math.round(n * 100) / 100; }
  function eidOf(el) { return Number(el.getAttribute('data-eid')); }
  function findEl(eid) { return document.querySelector('.hs-el[data-eid="' + eid + '"]'); }
  function pageList() { return document.querySelectorAll('.hs-page'); }
  function pageIndexOf(page) { return Array.prototype.indexOf.call(pageList(), page); }
  function isHs(n) { return n && n.nodeType === 1 && n.classList && n.classList.contains('hs-el'); }
  function nextHsEl(el) { var s = el.nextSibling; while (s && !isHs(s)) s = s.nextSibling; return s; }
  function prevHsEl(el) { var s = el.previousSibling; while (s && !isHs(s)) s = s.previousSibling; return s; }
  function nextHsEid(el) { var n = nextHsEl(el); return n ? eidOf(n) : null; }
  function precedingComment(el) {
    var s = el.previousSibling;
    while (s && s.nodeType === 3 && !s.textContent.trim()) s = s.previousSibling;
    return s && s.nodeType === 8 ? s : null;
  }
  function emit(cmd) { if (host().onCommand) host().onCommand(cmd); }
  var INLINE = { EM: 1, STRONG: 1, SPAN: 1, A: 1, B: 1, I: 1, U: 1, CODE: 1, SMALL: 1, MARK: 1, SUP: 1, SUB: 1 };
  function isInline(el) { return el && el.nodeType === 1 && INLINE[el.tagName] === 1; }

  function rotationOf(el) {
    var m = /rotate\(([-0-9.]+)deg\)/.exec(el.style.transform || '');
    return m ? parseFloat(m[1]) : 0;
  }
  function setRotation(el, deg) {
    var rest = (el.style.transform || '').replace(/rotate\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
    el.style.transform = 'rotate(' + deg + 'deg)' + (rest ? ' ' + rest : '');
  }

  // --- command capture -------------------------------------------------------
  var OP_PROPS = {
    drag: ['left', 'top'],
    resize: ['left', 'top', 'width', 'height'],
    rotate: ['transform'],
  };
  function captureDelta(el, props) {
    var d = {};
    for (var i = 0; i < props.length; i++) {
      var v = el.style.getPropertyValue(props[i]);
      d[props[i]] = v === '' ? null : v;
    }
    return d;
  }
  function startGesture(kind, targets) {
    var before = {};
    for (var i = 0; i < targets.length; i++) before[eidOf(targets[i])] = captureDelta(targets[i], OP_PROPS[kind]);
    gesture = { kind: kind, before: before };
  }
  function endGesture(kind, targets) {
    if (!gesture) return;
    var deltas = [];
    for (var i = 0; i < targets.length; i++) {
      var eid = eidOf(targets[i]);
      deltas.push({ eid: eid, before: gesture.before[eid], after: captureDelta(targets[i], OP_PROPS[kind]) });
    }
    gesture = null;
    emit({ op: 'style', deltas: deltas });
  }

  // --- sidebar snapshot ------------------------------------------------------
  function snapshot(el) {
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return {
      eid: eidOf(el),
      left: round(parseFloat(el.style.left) || 0),
      top: round(parseFloat(el.style.top) || 0),
      width: round(el.style.width ? parseFloat(el.style.width) : r.width),
      height: round(el.style.height ? parseFloat(el.style.height) : r.height),
      rotation: round(rotationOf(el)),
      style: styleOf(el),
    };
  }
  // Current text style for the style panel (computed, so it reflects classes too).
  function styleOf(el) {
    var cs = getComputedStyle(el);
    return {
      fontSize: Math.round(parseFloat(cs.fontSize) || 0),
      fontWeight: cs.fontWeight,
      opacity: Math.round((parseFloat(cs.opacity) || 1) * 100) / 100,
      lineHeight: cs.lineHeight === 'normal' ? 'normal' : Math.round(parseFloat(cs.lineHeight) || 0) + 'px',
      color: cs.color,
      fontFamily: cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(),
    };
  }
  function reportSelect() {
    if (host().onSelect) host().onSelect(selected.length === 1 ? snapshot(selected[0]) : null, selected.length);
  }
  function reportLive(el) { if (host().onLiveChange) host().onLiveChange(snapshot(el)); }

  // --- Moveable --------------------------------------------------------------
  function buildMoveable(page) {
    if (moveable) moveable.destroy();
    moveable = new Moveable(page, {
      draggable: true, resizable: true, rotatable: true, snappable: true,
      keepRatio: false, origin: false, dragArea: true,
      renderDirections: ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'],
      // No bounds / explicit rootContainer under the scaled iframe (they corrupt
      // Moveable's matrix math). Page edge/center snapping via guidelines.
      snapDirections: { top: true, left: true, bottom: true, right: true, center: true, middle: true },
      elementSnapDirections: { top: true, left: true, bottom: true, right: true, center: true, middle: true },
      snapThreshold: 6, isDisplaySnapDigit: true,
      zoom: window.__hsZoom ? 1 / window.__hsZoom : 1,
    });

    moveable.on('dragStart', function (e) { startGesture('drag', [e.target]); });
    moveable.on('drag', function (e) {
      e.target.style.left = e.left + 'px'; e.target.style.top = e.top + 'px'; reportLive(e.target);
    });
    moveable.on('dragEnd', function (e) { endGesture('drag', [e.target]); });

    moveable.on('resizeStart', function (e) { startGesture('resize', [e.target]); });
    moveable.on('resize', function (e) {
      e.target.style.width = e.width + 'px'; e.target.style.height = e.height + 'px';
      e.target.style.left = e.drag.left + 'px'; e.target.style.top = e.drag.top + 'px'; reportLive(e.target);
    });
    moveable.on('resizeEnd', function (e) { endGesture('resize', [e.target]); });

    moveable.on('rotateStart', function (e) { startGesture('rotate', [e.target]); });
    moveable.on('rotate', function (e) { setRotation(e.target, round(e.rotation)); reportLive(e.target); });
    moveable.on('rotateEnd', function (e) { endGesture('rotate', [e.target]); });

    moveable.on('dragGroupStart', function (e) { startGesture('drag', e.targets); });
    moveable.on('dragGroup', function (e) {
      e.events.forEach(function (ev) { ev.target.style.left = ev.left + 'px'; ev.target.style.top = ev.top + 'px'; });
    });
    moveable.on('dragGroupEnd', function (e) { endGesture('drag', e.targets); });

    moveable.on('resizeGroupStart', function (e) { startGesture('resize', e.targets); });
    moveable.on('resizeGroup', function (e) {
      e.events.forEach(function (ev) {
        ev.target.style.width = ev.width + 'px'; ev.target.style.height = ev.height + 'px';
        ev.target.style.left = ev.drag.left + 'px'; ev.target.style.top = ev.drag.top + 'px';
      });
    });
    moveable.on('resizeGroupEnd', function (e) { endGesture('resize', e.targets); });

    moveable.on('rotateGroupStart', function (e) { startGesture('rotate', e.targets); });
    moveable.on('rotateGroup', function (e) {
      e.events.forEach(function (ev) { setRotation(ev.target, round(ev.rotation)); });
    });
    moveable.on('rotateGroupEnd', function (e) { endGesture('rotate', e.targets); });
  }

  function applyGuidelines(page) {
    moveable.elementGuidelines = Array.prototype.filter.call(page.querySelectorAll('.hs-el'), function (x) {
      return selected.indexOf(x) === -1;
    });
    moveable.verticalGuidelines = [0, page.clientWidth / 2, page.clientWidth];
    moveable.horizontalGuidelines = [0, page.clientHeight / 2, page.clientHeight];
  }
  function setSelection(els) {
    selected = els.filter(function (el) { return el && document.contains(el); });
    if (selected.length === 0) { if (moveable) moveable.target = []; reportSelect(); return; }
    var page = selected[0].closest('.hs-page');
    if (page !== currentPage || !moveable) { buildMoveable(page); currentPage = page; }
    applyGuidelines(page);
    moveable.target = selected.length === 1 ? selected[0] : selected;
    reportSelect();
  }

  // --- selection input -------------------------------------------------------
  function hsElsAt(x, y) {
    var stack = document.elementsFromPoint(x, y), out = [];
    for (var i = 0; i < stack.length; i++) {
      var el = stack[i].closest ? stack[i].closest('.hs-el') : null;
      if (el && out.indexOf(el) === -1) out.push(el);
    }
    return out;
  }
  document.addEventListener('pointerdown', function (e) {
    if (editing) return;
    var t = e.target;
    if (t.closest && t.closest('.moveable-control-box')) return;
    var stack = hsElsAt(e.clientX, e.clientY);
    if (stack.length === 0) { setSelection([]); startMarquee(e); return; }
    var top = stack[0];
    if (e.shiftKey) {
      var idx = selected.indexOf(top), next = selected.slice();
      if (idx === -1) next.push(top); else next.splice(idx, 1);
      setSelection(next); return;
    }
    if (selected.length === 1 && selected[0] === top) {
      if (stack.length > 1) setSelection([stack[1]]); // click-through cycling
      return;
    }
    setSelection([top]);
  });

  // --- marquee multi-select (hand-rolled Selecto fallback) ----------
  function startMarquee(startEvent) {
    var page = (startEvent.target.closest && startEvent.target.closest('.hs-page')) || currentPage;
    if (!page) return;
    var pr = page.getBoundingClientRect();
    var x0 = startEvent.clientX - pr.left, y0 = startEvent.clientY - pr.top;
    var band = document.createElement('div');
    band.style.cssText = 'position:absolute;z-index:9998;border:1px solid #7c5cff;background:rgba(124,92,255,0.12);pointer-events:none;';
    page.appendChild(band);
    var candidates = Array.prototype.slice.call(page.querySelectorAll('.hs-el'));
    function rectFor(x1, y1) {
      var l = Math.min(x0, x1), t = Math.min(y0, y1), w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
      band.style.left = l + 'px'; band.style.top = t + 'px'; band.style.width = w + 'px'; band.style.height = h + 'px';
      return { left: l, top: t, right: l + w, bottom: t + h };
    }
    function onMove(ev) {
      var box = rectFor(ev.clientX - pr.left, ev.clientY - pr.top);
      band.__hits = candidates.filter(function (el) {
        var r = el.getBoundingClientRect();
        var b = { left: r.left - pr.left, top: r.top - pr.top, right: r.right - pr.left, bottom: r.bottom - pr.top };
        return !(b.right < box.left || b.left > box.right || b.bottom < box.top || b.top > box.bottom);
      });
    }
    function onUp() {
      document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp);
      var hits = band.__hits || []; band.remove();
      if (hits.length) setSelection(hits);
    }
    document.addEventListener('pointermove', onMove); document.addEventListener('pointerup', onUp);
  }

  // --- inline text editing (op:'html') ---------------------------------------
  document.addEventListener('dblclick', function (e) {
    var target = e.target, viaOverlay = false;
    var hsEl = target.closest && target.closest('.hs-el');
    if (!hsEl) {
      // On an already-selected element the dblclick target is unreliable:
      // Moveable's dragArea overlay sits on top and its first-click handling can
      // leave the event targeting the overlay or even the page. Resolve by
      // geometry instead: take the topmost .hs-el at the pointer position,
      // skipping Moveable chrome. Empty-space dblclicks find nothing and return.
      var under = document.elementsFromPoint(e.clientX, e.clientY);
      for (var u = 0; u < under.length; u++) {
        if (under[u].closest && !under[u].closest('.moveable-control-box')) {
          var cand = under[u].closest('.hs-el');
          if (cand) { target = under[u]; hsEl = cand; viaOverlay = true; break; }
        }
      }
    }
    if (!hsEl) return;
    // Editable = deepest block under the cursor; climb out of inline runs so we
    // edit the whole line (e.g. headline with an <em>), never a bare <em>.
    var editable = target.nodeType === 3 ? target.parentElement : target;
    while (editable && editable !== hsEl && isInline(editable)) editable = editable.parentElement;
    if (!editable) editable = hsEl;

    var beforeHtml = hsEl.innerHTML;
    editing = true;
    if (moveable) moveable.target = [];
    editable.setAttribute('contenteditable', 'plaintext-only');
    editable.style.whiteSpace = 'pre-wrap';
    editable.focus();
    // Leave the caret where the double-click landed (browser selects the word);
    // do NOT select-all, which would let the first keystroke wipe inline markup.
    // When resolved through the overlay, the native word-selection never reached
    // the text — place the caret ourselves. Do it on the NEXT FRAME: the Moveable
    // overlay is still at the pointer during this event (caretRangeFromPoint would
    // anchor the caret in the overlay div and typing would go nowhere). Verify the
    // caret landed inside the editable; otherwise fall back to end-of-text.
    if (viaOverlay) {
      requestAnimationFrame(function () {
        var caret = document.caretRangeFromPoint
          ? document.caretRangeFromPoint(e.clientX, e.clientY)
          : null;
        if (!(caret && editable.contains(caret.startContainer))) {
          caret = document.createRange();
          caret.selectNodeContents(editable);
          caret.collapse(false);
        }
        var winSel = window.getSelection();
        winSel.removeAllRanges();
        winSel.addRange(caret);
        editable.focus();
      });
    }

    function finish() {
      editable.removeEventListener('blur', finish);
      editable.removeEventListener('keydown', onKey);
      editable.removeAttribute('contenteditable');
      editable.style.removeProperty('white-space');
      editing = false;
      var afterHtml = hsEl.innerHTML;
      if (afterHtml !== beforeHtml) {
        emit({ op: 'html', deltas: [{ eid: eidOf(hsEl), before: { html: beforeHtml }, after: { html: afterHtml } }] });
      }
      setSelection([hsEl]);
    }
    function onKey(ev) { if (ev.key === 'Escape') { ev.preventDefault(); editable.blur(); } }
    editable.addEventListener('blur', finish);
    editable.addEventListener('keydown', onKey);
  });

  // --- structural actions ----------------------------------------------------
  function specOf(el) {
    var c = precedingComment(el);
    return {
      eid: eidOf(el), html: el.outerHTML, pageIndex: pageIndexOf(el.closest('.hs-page')),
      beforeEid: nextHsEid(el), commentBefore: c ? c.textContent : null,
    };
  }
  function duplicate() {
    if (selected.length !== 1) return;
    var src = selected[0], newEid = ++maxEid;
    var clone = src.cloneNode(true);
    clone.setAttribute('data-eid', String(newEid));
    // The clone must NOT inherit the source's persisted id; save assigns a fresh
    // data-hs-id = its eid, so dropping it here keeps ids unique end to end.
    clone.removeAttribute('data-hs-id');
    var l = parseFloat(clone.style.left) || 0, t = parseFloat(clone.style.top) || 0;
    clone.style.left = (l + 24) + 'px'; clone.style.top = (t + 24) + 'px';
    src.parentNode.insertBefore(clone, src.nextSibling);
    emit({ op: 'insert', deltas: [{ eid: newEid, before: { removed: true }, after: { spec: specOf(clone) } }] });
    setSelection([clone]);
  }
  function removeSelected() {
    if (!selected.length) return;
    var deltas = selected.map(function (el) { return { eid: eidOf(el), before: { spec: specOf(el) }, after: { removed: true } }; });
    selected.forEach(function (el) { var c = precedingComment(el); if (c) c.remove(); el.remove(); });
    emit({ op: 'delete', deltas: deltas });
    setSelection([]);
  }
  function zorder(dir) {
    if (selected.length !== 1) return;
    var el = selected[0], oldBefore = nextHsEid(el);
    if (dir > 0) { var n = nextHsEl(el); if (!n) return; el.parentNode.insertBefore(el, n.nextSibling); }
    else { var p = prevHsEl(el); if (!p) return; el.parentNode.insertBefore(el, p); }
    emit({ op: 'reorder', deltas: [{ eid: eidOf(el), before: { beforeEid: oldBefore }, after: { beforeEid: nextHsEid(el) } }] });
    if (moveable && moveable.updateRect) moveable.updateRect();
  }

  // --- freeze: the flow-element lift, run in the editor iframe so the
  // browser demo needs no server/Playwright. This is the SINGLE copy of the lift
  // (the old server freeze path was removed once both adapters use this). Converts
  // a free-form page to contract form and returns the contract HTML. A slide deck
  // (stacked same-class siblings where only the current slide is shown, driven by
  // a navigation script the edit view strips) becomes one hs-page PER SLIDE;
  // anything else becomes a single page. --------------------------------------
  function freeze() {
    return document.fonts.ready.then(function () {
      // finish() throws on infinite animations — skip those, they have no end state.
      var finishAnims = function () {
        document.getAnimations().forEach(function (a) { try { a.finish(); } catch (e) { /* infinite */ } });
      };
      finishAnims();
      // Count-up counters (data-count / data-target with a bare-number text) that
      // the stripped controller script would have animated: bake the target in.
      Array.prototype.forEach.call(document.querySelectorAll('[data-count],[data-target]'), function (el) {
        if (el.children.length) return;
        var t = parseFloat(el.getAttribute('data-count') || el.getAttribute('data-target'));
        var raw = (el.textContent || '').replace(/[,\s]/g, '');
        var cur = parseFloat(raw);
        if (!isFinite(t) || !isFinite(cur) || cur === t || String(cur) !== raw) return;
        el.textContent = t.toLocaleString('en-US');
      });
      var skip = function (n) { return n.tagName === 'SCRIPT' || n.tagName === 'STYLE'; };
      var kids = function (el) { return Array.prototype.filter.call(el.children, function (n) { return !skip(n); }); };
      // An element worth keeping as its own box (a card/panel), vs a bare layout
      // wrapper we can pass through: has a background, border, shadow, or padding.
      var styled = function (el) {
        var s = getComputedStyle(el);
        if (s.backgroundImage && s.backgroundImage !== 'none') return true;
        if (s.backgroundColor && s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent') return true;
        if (s.boxShadow && s.boxShadow !== 'none') return true;
        if ((parseFloat(s.borderTopWidth) || 0) + (parseFloat(s.borderRightWidth) || 0) + (parseFloat(s.borderBottomWidth) || 0) + (parseFloat(s.borderLeftWidth) || 0) > 0) return true;
        if ((parseFloat(s.paddingTop) || 0) + (parseFloat(s.paddingRight) || 0) + (parseFloat(s.paddingBottom) || 0) + (parseFloat(s.paddingLeft) || 0) > 0) return true;
        return false;
      };
      var shown = function (el) {
        var s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || (parseFloat(s.opacity) || 0) < 0.05) return false;
        var r = el.getBoundingClientRect();
        return r.width > 1 && r.height > 1;
      };

      // Deck detection: walk down through wrapper layers looking for >=2 siblings
      // sharing tag+class where at least one is shown at panel scale and at least
      // one is hidden — slides waiting for a navigation script we stripped.
      function findSlides() {
        var node = document.body;
        for (var depth = 0; node && depth < 6; depth++) {
          var ch = kids(node);
          var groups = {};
          ch.forEach(function (el) {
            Array.prototype.forEach.call(el.classList, function (t) {
              var k = el.tagName + '.' + t;
              (groups[k] = groups[k] || []).push(el);
            });
          });
          var best = null;
          Object.keys(groups).forEach(function (k) {
            var g = groups[k];
            if (g.length < 2 || (best && g.length <= best.length)) return;
            var vis = g.filter(shown);
            if (vis.length === 0 || vis.length === g.length) return;
            var r = vis[0].getBoundingClientRect();
            if (r.width < 320 || r.height < 240) return; // slides are panel-scale
            best = g;
          });
          if (best) return best;
          // No group here — descend into the largest child (the wrapper/stage).
          var next = null, area = 0;
          ch.forEach(function (c) {
            var r = c.getBoundingClientRect(), a = r.width * r.height;
            if (a > area) { area = a; next = c; }
          });
          node = next;
        }
        return null;
      }

      // The deck's controller marked the current slide with a state class
      // (.active/.visible/…). Recover that "on" state for every slide: any class
      // that alone flips a hidden slide to shown is a state class. Tested one at a
      // time on a hidden probe so identity classes (.cover, .closing) never leak.
      function stateClasses(slides) {
        var probe = null;
        for (var i = 0; i < slides.length; i++) { if (!shown(slides[i])) { probe = slides[i]; break; } }
        if (!probe) return [];
        var cand = {};
        slides.forEach(function (s) {
          Array.prototype.forEach.call(s.classList, function (t) { cand[t] = 1; });
        });
        // Classes a controller adds only at runtime never appear in the static
        // markup — probe the common names too.
        ['active', 'visible', 'current', 'show', 'shown', 'on'].forEach(function (t) { cand[t] = 1; });
        var found = [];
        Object.keys(cand).forEach(function (t) {
          if (probe.classList.contains(t)) return;
          probe.classList.add(t);
          if (shown(probe)) found.push(t);
          probe.classList.remove(t);
        });
        return found;
      }

      // Turn every slide "on", then re-plumb the deck for flow: slides become
      // in-flow pages stacked vertically; the wrapper chain (fixed viewports,
      // scaled stages) is neutralized so nothing clips, scales, or overlaps.
      function prepareDeck(slides) {
        var states = stateClasses(slides);
        slides.forEach(function (s) {
          states.forEach(function (t) { s.classList.add(t); });
          if (getComputedStyle(s).display === 'none') s.style.display = 'block';
          s.style.visibility = 'visible';
          s.style.opacity = '1';
          s.style.pointerEvents = 'auto';
        });
        finishAnims(); // the class flips may have started entrance transitions
        // Elements still waiting for an entrance the controller would have run
        // (opacity-0 with a transition/animation, e.g. .reveal): jump them to
        // their shown state — frozen output has no scripts to reveal them later.
        slides.forEach(function (s) {
          Array.prototype.forEach.call(s.querySelectorAll('*'), function (el) {
            var c = getComputedStyle(el);
            var animated = /opacity|transform|all/.test(c.transitionProperty) || c.animationName !== 'none';
            if (!animated) return;
            if ((parseFloat(c.opacity) || 0) < 0.05 || c.visibility === 'hidden') {
              el.style.opacity = '1';
              el.style.visibility = 'visible';
              el.style.transform = 'none';
            }
          });
        });
        // Layout size (offsetWidth ignores ancestor scale transforms), measured
        // while the deck geometry is still intact.
        var sizes = slides.map(function (s) { return { w: s.offsetWidth, h: s.offsetHeight }; });
        // Deck chrome: siblings of the slides (page numbers, nav) and fixed
        // overlays up the chain (buttons, hotzones) don't belong in frozen pages.
        var container = slides[0].parentElement;
        kids(container).forEach(function (c) { if (slides.indexOf(c) === -1) c.remove(); });
        var anc = container;
        while (anc && anc !== document.documentElement) {
          if (anc.parentElement) {
            kids(anc.parentElement).forEach(function (sib) {
              if (sib !== anc && getComputedStyle(sib).position === 'fixed') sib.style.display = 'none';
            });
          }
          anc.style.position = 'static';
          anc.style.transform = 'none';
          anc.style.overflow = 'visible';
          anc.style.width = 'auto';
          anc.style.height = 'auto';
          anc.style.left = anc.style.top = anc.style.right = anc.style.bottom = 'auto';
          anc = anc.parentElement;
        }
        slides.forEach(function (s, i) {
          s.style.position = 'relative';
          s.style.left = s.style.top = s.style.right = s.style.bottom = 'auto';
          s.style.transform = 'none';
          s.style.width = sizes[i].w + 'px';
          s.style.height = sizes[i].h + 'px';
          s.style.margin = '0';
        });
      }

      // The lift: pin pageEl's blocks in place as absolutely-positioned hs-els.
      // For a deck, each slide IS the artboard (never re-rooted); free-form pages
      // keep the original descend-and-re-root behavior.
      function liftPage(pageEl, isSlide) {
        var page = pageEl;
        var blocks = kids(page);
        // Descend through single-wrapper layers so a one-container design still
        // yields individually draggable blocks. A styled single child (a card/
        // panel) becomes the artboard so its box is preserved — except in a slide,
        // where it stays whole as one block. A bare wrapper is passed through and
        // pruned below. Capped so we never shatter a deeply-nested component; a
        // level with multiple siblings (a grid, etc.) stops the descent.
        for (var depth = 0; blocks.length === 1 && depth < 4; depth++) {
          var single = blocks[0];
          var inner = kids(single);
          if (inner.length === 0) break; // leaf — nothing to descend into
          if (styled(single)) {
            if (isSlide) break; // keep the card whole; the slide stays the page
            page = single;
          }
          blocks = inner;
        }

        page.style.position = 'relative';
        var pageW = page.offsetWidth, pageH = page.offsetHeight;
        var cs = getComputedStyle(page);
        var bl = parseFloat(cs.borderLeftWidth) || 0, bt = parseFloat(cs.borderTopWidth) || 0;

        // Measure untransformed boxes relative to the page's padding box BEFORE any
        // reparenting (moving elements would change layout).
        var saved = blocks.map(function (b) { return b.style.transform; });
        blocks.forEach(function (b) { b.style.transform = 'none'; });
        var pr = page.getBoundingClientRect();
        var measured = blocks.map(function (b) {
          var r = b.getBoundingClientRect();
          return { el: b, x: r.left - pr.left - bl, y: r.top - pr.top - bt, w: r.width, h: r.height };
        });
        blocks.forEach(function (b, i) { b.style.transform = saved[i]; });

        // Reparent blocks to be DIRECT children of the page (contract shape — keeps
        // z-order/reorder sibling logic correct), then drop the emptied wrapper chain
        // we descended through. Appending each in order preserves their order.
        var origChildren = kids(page);
        blocks.forEach(function (b) { page.appendChild(b); });
        origChildren.forEach(function (c) { if (blocks.indexOf(c) === -1) c.remove(); });

        var px = function (n) { return Math.round(n * 100) / 100 + 'px'; };
        measured.forEach(function (m) {
          m.el.classList.add('hs-el');
          m.el.style.left = px(m.x); m.el.style.top = px(m.y);
          m.el.style.width = px(m.w); m.el.style.height = px(m.h); m.el.style.margin = '0';
        });
        page.classList.add('hs-page');
        page.setAttribute('data-size', pageW + 'x' + pageH);
        page.style.width = pageW + 'px'; page.style.height = pageH + 'px';
      }

      var slides = findSlides();
      if (slides) {
        prepareDeck(slides);
        slides.forEach(function (s) { liftPage(s, true); });
      } else {
        var top = kids(document.body);
        liftPage(top.length === 1 ? top[0] : document.body, false);
      }

      var style = document.createElement('style');
      style.textContent = '.hs-page{position:relative;overflow:hidden}.hs-el{position:absolute;margin:0;box-sizing:border-box}';
      document.head.appendChild(style);
      // Serialize a clean copy: strip our injected editor scripts/eids.
      var clone = document.documentElement.cloneNode(true);
      Array.prototype.forEach.call(clone.querySelectorAll('script'), function (s) { s.remove(); });
      Array.prototype.forEach.call(clone.querySelectorAll('[data-eid]'), function (e) { e.removeAttribute('data-eid'); });
      return '<!doctype html>\n' + clone.outerHTML;
    });
  }

  // --- undo/redo (replay before/after in place) ------------------------------
  function applyStyle(el, delta) {
    for (var prop in delta) {
      if (!Object.prototype.hasOwnProperty.call(delta, prop)) continue;
      var v = delta[prop];
      if (v === null || v === '') el.style.removeProperty(prop); else el.style.setProperty(prop, v);
    }
  }
  function placeBefore(el, beforeEid) {
    var page = el.closest('.hs-page'); if (!page) return;
    var ref = beforeEid == null ? null : findEl(beforeEid);
    if (ref && ref.parentElement === page) page.insertBefore(el, ref); else page.appendChild(el);
  }
  function insertSpec(spec) {
    if (findEl(spec.eid)) return;
    var page = pageList()[spec.pageIndex]; if (!page) return;
    var tmp = document.createElement('div'); tmp.innerHTML = spec.html;
    var el = tmp.firstElementChild; if (!el) return;
    if (Number(spec.eid) > maxEid) maxEid = Number(spec.eid);
    var ref = spec.beforeEid == null ? null : findEl(spec.beforeEid);
    if (ref && ref.parentElement === page) page.insertBefore(el, ref); else page.appendChild(el);
    if (spec.commentBefore != null) page.insertBefore(document.createComment(spec.commentBefore), el);
  }
  function applyOp(cmd, dir) {
    if (cmd.op === 'font') {
      (cmd.fonts || []).forEach(function (f) { applyFont(f.family, dir === 'after' ? f.after : f.before); });
      return;
    }
    cmd.deltas.forEach(function (d) {
      var state = dir === 'after' ? d.after : d.before, el = findEl(d.eid);
      switch (cmd.op) {
        case 'style': if (el) applyStyle(el, state); break;
        case 'html': if (el) el.innerHTML = state.html; break;
        case 'reorder': if (el) placeBefore(el, state.beforeEid); break;
        case 'insert': case 'delete':
          if (state.removed) { if (el) { var pc = precedingComment(el); if (pc) pc.remove(); el.remove(); } }
          else insertSpec(state.spec);
          break;
      }
    });
    if (cmd.op === 'insert' || cmd.op === 'delete') setSelection([]);
    else setSelection(selected.slice());
  }

  // --- style panel (M11): token-bound palette + apply -------------------------
  // Discover the design palette. Brand mode: --brand-* custom properties from the
  // :root rules of linked stylesheets. Demo mode (no brand): the colours/fonts
  // already present in the imported document — "recolor with what's there".
  function tokens() {
    var props = {};
    try {
      Array.prototype.forEach.call(document.styleSheets, function (sheet) {
        var rules;
        try { rules = sheet.cssRules; } catch (e) { return; }
        Array.prototype.forEach.call(rules, function (rule) {
          if (rule.selectorText === ':root' && rule.style) {
            for (var i = 0; i < rule.style.length; i++) {
              var n = rule.style[i];
              if (n.indexOf('--brand-') === 0) props[n] = rule.style.getPropertyValue(n).trim();
            }
          }
        });
      });
    } catch (e) { /* ignore */ }

    var names = Object.keys(props), colors = [], fonts = [], weights = [];
    if (names.length) {
      names.forEach(function (n) {
        var v = props[n];
        if (n.indexOf('--brand-font-') === 0) fonts.push({ name: n.slice(13), value: 'var(' + n + ')', raw: v });
        else if (n.indexOf('--brand-weight-') === 0) weights.push({ name: n.slice(15), value: 'var(' + n + ')', raw: v });
        else if (/^#|^rgb|^hsl/.test(v)) colors.push({ name: n.slice(8), value: 'var(' + n + ')', raw: v });
      });
      return { mode: 'brand', colors: colors, fonts: fonts, weights: weights };
    }
    // demo fallback
    var colorSet = {}, fontSet = {};
    Array.prototype.forEach.call(document.querySelectorAll('.hs-el, .hs-el *'), function (el) {
      var cs = getComputedStyle(el);
      [cs.color, cs.backgroundColor].forEach(function (c) {
        if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') colorSet[c] = 1;
      });
      var ff = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
      if (ff) fontSet[ff] = 1;
    });
    colors = Object.keys(colorSet).slice(0, 12).map(function (c) { return { name: c, value: c, raw: c }; });
    fonts = Object.keys(fontSet).slice(0, 8).map(function (f) { return { name: f, value: '"' + f + '", sans-serif', raw: f }; });
    weights = ['400', '500', '600', '700', '800', '900'].map(function (w) { return { name: w, value: w, raw: w }; });
    return { mode: 'demo', colors: colors, fonts: fonts, weights: weights };
  }

  // Apply an inline-style patch (kebab props) to the single selection; one command.
  function setStyle(patch) {
    if (selected.length !== 1) return;
    var el = selected[0], keys = Object.keys(patch), before = {}, after = {};
    keys.forEach(function (p) { var v = el.style.getPropertyValue(p); before[p] = v === '' ? null : v; });
    keys.forEach(function (p) {
      var val = patch[p];
      if (val == null || val === '') el.style.removeProperty(p);
      else el.style.setProperty(p, val);
      var nv = el.style.getPropertyValue(p);
      after[p] = nv === '' ? null : nv;
    });
    emit({ op: 'style', deltas: [{ eid: eidOf(el), before: before, after: after }] });
    if (moveable && moveable.updateRect) moveable.updateRect();
    reportLive(el);
  }

  // Wrap the current text selection in <span class="hs-accent"> (or unwrap if it is
  // already accented). Recorded as an html op on the containing .hs-el.
  function toggleAccent(color, weight) {
    var sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    var range = sel.getRangeAt(0);
    var node = range.commonAncestorContainer;
    var host2 = (node.nodeType === 3 ? node.parentElement : node);
    var hsEl = host2 && host2.closest ? host2.closest('.hs-el') : null;
    if (!hsEl) return;
    var before = hsEl.innerHTML;
    var existing = host2.closest ? host2.closest('.hs-accent') : null;
    if (existing) {
      // unwrap
      var parent = existing.parentNode;
      while (existing.firstChild) parent.insertBefore(existing.firstChild, existing);
      parent.removeChild(existing);
    } else {
      var span = document.createElement('span');
      span.className = 'hs-accent';
      span.style.color = color;
      if (weight) span.style.fontWeight = weight;
      try {
        range.surroundContents(span);
      } catch (e) {
        span.appendChild(range.extractContents());
        range.insertNode(span);
      }
    }
    sel.removeAllRanges();
    var after = hsEl.innerHTML;
    if (after !== before) emit({ op: 'html', deltas: [{ eid: eidOf(hsEl), before: { html: before }, after: { html: after } }] });
    setSelection([hsEl]);
  }

  // --- keyboard --------------------------------------------------------------
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Shift' && moveable) moveable.keepRatio = true;
    if (editing) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected.length) { e.preventDefault(); removeSelected(); }
  });
  window.addEventListener('keyup', function (e) {
    if (e.key === 'Shift' && moveable) moveable.keepRatio = false;
  });

  // --- imported-font fidelity (M18) ------------------------------------------
  // Detect families the design USES but that fall back (render as a substitute).
  // NOTE: document.fonts.check() is NOT sufficient — it returns TRUE for a family
  // with no @font-face at all (the custom/handwritten case, M18's main target), so
  // it only catches declared-but-unloaded faces. We measure actual rendered width
  // against generic fallbacks instead: if the family can't change the metrics of
  // any generic, it isn't rendering. Run after document.fonts.ready so declared
  // (Google-Fonts / self-hosted) faces have loaded first — that's what prevents
  // false positives on a Google-Fonts-linked file.
  var GENERIC = {
    serif: 1, 'sans-serif': 1, monospace: 1, cursive: 1, fantasy: 1, 'system-ui': 1,
    'ui-serif': 1, 'ui-sans-serif': 1, 'ui-monospace': 1, 'ui-rounded': 1, math: 1,
    emoji: 1, '-apple-system': 1, blinkmacsystemfont: 1, inherit: 1, initial: 1, unset: 1, '': 1,
  };
  var _measureCtx = null;
  function measureWidth(stack) {
    if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d');
    _measureCtx.font = '72px ' + stack;
    return _measureCtx.measureText('wwwmmmiiilllWMILgjpqy0123456789').width;
  }
  function familyAvailable(family) {
    var q = '"' + family.replace(/"/g, '\\"') + '"';
    return ['monospace', 'sans-serif', 'serif'].some(function (g) {
      return Math.abs(measureWidth(q + ',' + g) - measureWidth(g)) > 0.5;
    });
  }
  function usedFamilies() {
    var set = {}, root = document.querySelector('.hs-page') || document.body;
    function consider(el) {
      var hasText = false;
      for (var i = 0; i < el.childNodes.length; i++) {
        var n = el.childNodes[i];
        if (n.nodeType === 3 && n.textContent && n.textContent.trim()) { hasText = true; break; }
      }
      if (!hasText) return;
      var fam = String(getComputedStyle(el).fontFamily || '').split(',')[0].trim().replace(/^["']|["']$/g, '');
      if (fam && !GENERIC[fam.toLowerCase()]) set[fam] = 1;
    }
    if (root) consider(root);
    var all = (root || document.body).getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) consider(all[i]);
    return Object.keys(set);
  }
  function detectFonts() {
    return document.fonts.ready.then(function () {
      return usedFamilies().filter(function (f) { return !familyAvailable(f); });
    });
  }
  // The [data-hs-font="family"] fix element currently in <head>, if any.
  function fontEl(family) {
    var head = document.head || document.documentElement;
    var els = head.querySelectorAll('[data-hs-font]');
    for (var i = 0; i < els.length; i++) if (els[i].getAttribute('data-hs-font') === family) return els[i];
    return null;
  }
  function applyFont(family, html) {
    var head = document.head || document.documentElement;
    var ex = fontEl(family); if (ex) ex.remove();
    if (html != null) {
      var t = document.createElement('div'); t.innerHTML = html;
      var el = t.firstElementChild; if (el) head.appendChild(el);
    }
  }
  // Apply a font fix live AND record it as one 'font' command (persists via save,
  // reverses via undo — same pipeline as every other edit).
  function setFont(family, afterHtml) {
    var ex = fontEl(family);
    applyFont(family, afterHtml);
    emit({ op: 'font', deltas: [], fonts: [{ family: family, before: ex ? ex.outerHTML : null, after: afterHtml }] });
  }

  // --- browser export (M9/M18): snapdom runs HERE, in the iframe --------------
  // snapdom reads @font-face from the global `document`, so it must run inside the
  // iframe where the asset's fonts live (a parent-side capture embeds nothing —
  // the required-family scan comes back empty cross-document). window.snapdom is
  // injected by the host (browser build only).
  function capture(pageIndex, opts) {
    if (!window.snapdom) return Promise.reject(new Error('snapdom not loaded'));
    var page = pageList()[pageIndex];
    if (!page) return Promise.resolve(null);
    setSelection([]); // no Moveable handles in the shot
    return document.fonts.ready.then(function () {
      return window.snapdom.toBlob(page, {
        scale: opts.scale,
        dpr: 1, // scale is the sole multiplier (not × devicePixelRatio)
        type: opts.type,
        embedFonts: true, // snapdom defaults this off — custom faces need it
        backgroundColor: opts.backgroundColor,
        exclude: ['.moveable-control-box'],
      });
    });
  }

  // --- host API --------------------------------------------------------------
  window.__hsEditor = {
    select: function (el) { setSelection(el ? [el] : []); },
    deselect: function () { setSelection([]); },
    setZoom: function (z) { window.__hsZoom = z; if (moveable) moveable.zoom = z ? 1 / z : 1; },
    duplicate: duplicate,
    remove: removeSelected,
    bringForward: function () { zorder(1); },
    bringBackward: function () { zorder(-1); },
    undo: function (cmd) { applyOp(cmd, 'before'); },
    redo: function (cmd) { applyOp(cmd, 'after'); },
    pageCount: function () { return pageList().length; },
    hasSelection: function () { return selected.length > 0; },
    freeze: freeze,
    tokens: tokens,
    setStyle: setStyle,
    toggleAccent: toggleAccent,
    detectFonts: detectFonts,
    setFont: setFont,
    capture: capture,
  };
})();
