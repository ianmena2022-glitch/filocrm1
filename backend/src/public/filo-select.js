// FILO custom <select>: reemplaza el dropdown nativo del OS por uno que matchea el tema dark.
// - El <select> real queda en el DOM (oculto visualmente, pero enfocable y validable), así que
//   formularios, .value, .selectedIndex, 'change' y 'required' siguen funcionando igual.
// - Listas largas (>= 8 opciones) traen un buscador (sin acentos, por cualquier parte del texto).
// - Listas cortas: escribir una letra salta a la opción (como el select nativo).
// - Opt-out: atributo data-no-filo-select en el <select>.
(function () {
  if (window.__filoSelectLoaded) return;
  window.__filoSelectLoaded = true;

  var SEARCH_MIN = 8;
  var protoValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  var protoIndex = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
  var current = null; // instancia con la lista abierta

  function norm(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  function shouldEnhance(sel) {
    return sel instanceof HTMLSelectElement &&
      sel.dataset.noFiloSelect === undefined &&
      !sel.multiple && !(sel.size > 1) &&
      sel.dataset.filoEnhanced !== '1' &&
      !!sel.parentNode;
  }

  function enhance(sel) {
    sel.dataset.filoEnhanced = '1';

    // ── Layout: copiar cómo se comportaba el <select> original ────────────────
    var cs = getComputedStyle(sel);
    var parent = sel.parentElement;
    var wrap = document.createElement('div');
    wrap.className = 'fs-wrap';
    if (parseFloat(cs.flexGrow) > 0) {
      wrap.style.flex = cs.flex; wrap.style.width = 'auto'; wrap.style.minWidth = '0';
    } else if (sel.offsetWidth > 0 && parent) {
      var pcs = getComputedStyle(parent);
      var pw = parent.clientWidth - (parseFloat(pcs.paddingLeft) || 0) - (parseFloat(pcs.paddingRight) || 0);
      if (sel.offsetWidth < pw - 6) {
        wrap.style.width = sel.offsetWidth + 'px'; wrap.style.maxWidth = '100%'; wrap.style.flex = '0 0 auto';
      }
    } else if (/px$/.test(cs.width)) {
      wrap.style.width = cs.width; wrap.style.maxWidth = '100%'; wrap.style.flex = '0 0 auto';
    }

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fs-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    if (parseFloat(cs.fontSize) <= 13) { btn.style.fontSize = cs.fontSize; btn.style.minHeight = '34px'; }
    var labelEl = document.createElement('span'); labelEl.className = 'fs-label';
    var caret = document.createElement('span'); caret.className = 'fs-caret'; caret.textContent = '▾';
    btn.appendChild(labelEl); btn.appendChild(caret);
    wrap.appendChild(btn);
    sel.parentNode.insertBefore(wrap, sel.nextSibling);
    sel.classList.add('fs-native');
    sel.setAttribute('tabindex', '-1');
    sel.setAttribute('aria-hidden', 'true');
    sel._fsWrap = wrap;

    var panel = null, listEl = null, searchEl = null;
    var open = false, kb = -1, visible = [], typeBuf = '', typeTimer = null;

    function labelText() {
      var l = null;
      if (sel.id) { try { l = document.querySelector('label[for="' + CSS.escape(sel.id) + '"]'); } catch (_) {} }
      if (!l) { var f = sel.closest('.form-field, .field, .form-group'); if (f) l = f.querySelector('label'); }
      return l ? l.textContent.trim() : '';
    }
    function optText(o) { return (o.textContent || '').trim(); }

    function refresh() {
      var o = sel.options[sel.selectedIndex];
      var t = o ? optText(o) : '';
      labelEl.textContent = t || (o ? '—' : '—');
      btn.classList.toggle('empty', !sel.value);
      btn.disabled = sel.disabled;
      wrap.classList.toggle('disabled', sel.disabled);
      var lt = labelText();
      btn.setAttribute('aria-label', (lt ? lt + ': ' : '') + t);
      wrap.style.display = (sel.style.display === 'none' || sel.hidden) ? 'none' : '';
      if (open) render(searchEl ? searchEl.value : '');
    }

    // ── Panel (flotante, fuera de cualquier overflow:hidden) ──────────────────
    function render(q) {
      var nq = norm(q).trim();
      var tokens = nq ? nq.split(/\s+/) : [];
      listEl.innerHTML = '';
      visible = [];
      var rows = [];
      Array.prototype.forEach.call(sel.options, function (o, i) {
        var txt = optText(o);
        var rank = 0;
        if (tokens.length) {
          var n = norm(txt);
          for (var k = 0; k < tokens.length; k++) if (n.indexOf(tokens[k]) === -1) return;
          // coincidencias al inicio de una palabra primero (stable: respeta el orden original)
          rank = (' ' + n).indexOf(' ' + tokens[0]) !== -1 ? 0 : 1;
        }
        rows.push({ o: o, i: i, txt: txt, rank: rank });
      });
      if (tokens.length) {
        rows = rows.map(function (r, idx) { r.idx = idx; return r; })
                   .sort(function (a, b) { return a.rank - b.rank || a.idx - b.idx; });
      }
      rows.forEach(function (row) {
        var o = row.o, i = row.i, txt = row.txt;
        var li = document.createElement('li');
        li.className = 'fs-opt' + (i === sel.selectedIndex ? ' selected' : '') + (o.disabled ? ' disabled' : '');
        li.setAttribute('role', 'option');
        li.setAttribute('data-index', String(i));
        li.textContent = txt || '—';
        listEl.appendChild(li);
        if (!o.disabled) visible.push(li);
      });
      if (!listEl.children.length) {
        var e = document.createElement('li'); e.className = 'fs-empty'; e.textContent = 'Sin resultados';
        listEl.appendChild(e);
      }
      var selLi = tokens.length ? null : visible.filter(function (x) { return x.classList.contains('selected'); })[0];
      setKb(selLi ? visible.indexOf(selLi) : 0, !!selLi);
      position();
    }

    function setKb(i, scroll) {
      visible.forEach(function (x) { x.classList.remove('kb'); });
      kb = visible.length ? Math.max(0, Math.min(visible.length - 1, i)) : -1;
      if (kb >= 0) {
        visible[kb].classList.add('kb');
        if (scroll !== false) visible[kb].scrollIntoView({ block: 'nearest' });
      }
    }

    function position() {
      if (!panel) return;
      var r = btn.getBoundingClientRect();
      var vh = window.innerHeight, vw = window.innerWidth;
      var below = vh - r.bottom - 8, above = r.top - 8;
      var w = Math.max(r.width, 160);
      panel.style.width = w + 'px';
      panel.style.left = Math.max(8, Math.min(r.left, vw - w - 8)) + 'px';
      panel.style.maxHeight = '320px';
      var h = panel.offsetHeight;
      if (h <= below || below >= above) {
        panel.style.maxHeight = Math.min(320, Math.max(120, below)) + 'px';
        panel.style.top = (r.bottom + 4) + 'px'; panel.style.bottom = 'auto';
      } else {
        panel.style.maxHeight = Math.min(320, Math.max(120, above)) + 'px';
        panel.style.bottom = (vh - r.top + 4) + 'px'; panel.style.top = 'auto';
      }
    }

    function onDocDown(e) {
      if (panel && (panel.contains(e.target) || wrap.contains(e.target))) return;
      close();
    }
    var raf = 0;
    function onReflow(e) {
      if (e && e.target && panel && panel.contains(e.target)) return;
      cancelAnimationFrame(raf); raf = requestAnimationFrame(position);
    }

    function onKey(e) {
      var k = e.key;
      if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); btn.focus(); return; }
      if (k === 'Tab') { close(); return; }
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        setKb(kb < 0 ? 0 : kb + (k === 'ArrowDown' ? 1 : -1));
        return;
      }
      if (k === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        if (kb >= 0) pick(parseInt(visible[kb].getAttribute('data-index'), 10));
        return;
      }
      if (!searchEl && k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        var i = typeAhead(k);
        if (i >= 0) { e.preventDefault(); setKb(i); }
      }
    }

    function typeAhead(ch) {
      typeBuf += norm(ch);
      clearTimeout(typeTimer); typeTimer = setTimeout(function () { typeBuf = ''; }, 700);
      var start = kb >= 0 && typeBuf.length === 1 ? kb + 1 : Math.max(kb, 0);
      for (var n = 0; n < visible.length; n++) {
        var idx = (start + n) % visible.length;
        if (norm(visible[idx].textContent).indexOf(typeBuf) === 0) return idx;
      }
      return -1;
    }

    function openList() {
      if (open || sel.disabled) return;
      if (current && current !== api) current.close();
      open = true; current = api;
      panel = document.createElement('div');
      panel.className = 'fs-panel';
      if (sel.options.length >= SEARCH_MIN) {
        var sw = document.createElement('div'); sw.className = 'fs-search';
        searchEl = document.createElement('input');
        searchEl.type = 'text'; searchEl.placeholder = 'Buscar…'; searchEl.autocomplete = 'off';
        searchEl.setAttribute('aria-label', 'Buscar');
        searchEl.addEventListener('input', function () { render(searchEl.value); });
        sw.appendChild(searchEl); panel.appendChild(sw);
      }
      listEl = document.createElement('ul');
      listEl.className = 'fs-list'; listEl.setAttribute('role', 'listbox');
      panel.appendChild(listEl);
      ['click', 'mousedown'].forEach(function (ev) { panel.addEventListener(ev, function (e) { e.stopPropagation(); }); });
      listEl.addEventListener('click', function (e) {
        var li = e.target.closest('.fs-opt');
        if (!li || li.classList.contains('disabled')) return;
        pick(parseInt(li.getAttribute('data-index'), 10));
      });
      listEl.addEventListener('mousemove', function (e) {
        var li = e.target.closest('.fs-opt');
        if (!li || li.classList.contains('disabled')) return;
        var i = visible.indexOf(li); if (i >= 0 && i !== kb) setKb(i, false);
      });
      document.body.appendChild(panel);
      wrap.classList.add('open'); btn.setAttribute('aria-expanded', 'true');
      render('');
      document.addEventListener('pointerdown', onDocDown, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('resize', onReflow);
      document.addEventListener('scroll', onReflow, true);
      if (searchEl) searchEl.focus();
    }

    function close() {
      if (!open) return;
      open = false; if (current === api) current = null;
      document.removeEventListener('pointerdown', onDocDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onReflow);
      document.removeEventListener('scroll', onReflow, true);
      if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
      panel = listEl = searchEl = null; visible = []; kb = -1;
      wrap.classList.remove('open'); btn.setAttribute('aria-expanded', 'false');
    }

    function pick(index) {
      var o = sel.options[index];
      if (o && !o.disabled) {
        if (sel.selectedIndex !== index) {
          protoIndex.set.call(sel, index);
          refresh();
          sel.dispatchEvent(new Event('input', { bubbles: true }));
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      close();
      try { btn.focus({ preventScroll: true }); } catch (_) { btn.focus(); }
    }

    var api = { close: close, refresh: refresh };

    btn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      if (open) close(); else openList();
    });

    // Teclado con la lista cerrada (como el select nativo)
    btn.addEventListener('keydown', function (e) {
      if (open) return;
      var k = e.key;
      if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter' || k === ' ') {
        e.preventDefault(); openList(); return;
      }
      if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (sel.options.length >= SEARCH_MIN) {
          e.preventDefault(); openList();
          if (searchEl) { searchEl.value = k; render(k); }
        } else {
          typeBuf += norm(k);
          clearTimeout(typeTimer); typeTimer = setTimeout(function () { typeBuf = ''; }, 700);
          for (var i = 0; i < sel.options.length; i++) {
            var o = sel.options[i];
            if (!o.disabled && norm(optText(o)).indexOf(typeBuf) === 0) { pick(i); break; }
          }
        }
      }
    });

    // ── Que el <select> real siga comportándose como siempre ──────────────────
    Object.defineProperty(sel, 'value', {
      configurable: true, enumerable: true,
      get: function () { return protoValue.get.call(sel); },
      set: function (v) { protoValue.set.call(sel, v); refresh(); }
    });
    Object.defineProperty(sel, 'selectedIndex', {
      configurable: true, enumerable: true,
      get: function () { return protoIndex.get.call(sel); },
      set: function (v) { protoIndex.set.call(sel, v); refresh(); }
    });
    sel.focus = function (opts) { btn.focus(opts); };
    sel.addEventListener('focus', function () { btn.focus(); });   // validación 'required' / <label for>
    sel.addEventListener('change', refresh);
    if (sel.form) sel.form.addEventListener('reset', function () { setTimeout(refresh, 0); });
    new MutationObserver(refresh).observe(sel, {
      attributes: true, childList: true, subtree: true, characterData: true,
      attributeFilter: ['value', 'selected', 'disabled', 'label', 'style', 'hidden']
    });

    refresh();
  }

  function scan(root) {
    (root || document).querySelectorAll('select').forEach(function (sel) {
      if (shouldEnhance(sel)) enhance(sel);
    });
  }

  var bodyObs = new MutationObserver(function (muts) {
    muts.forEach(function (m) {
      m.addedNodes.forEach(function (node) {
        if (node.nodeType !== 1) return;
        if (node.tagName === 'SELECT') { if (shouldEnhance(node)) enhance(node); }
        else if (node.querySelectorAll) scan(node);
      });
      m.removedNodes.forEach(function (node) {
        if (node.nodeType !== 1) return;
        var list = node.tagName === 'SELECT' ? [node] : (node.querySelectorAll ? Array.prototype.slice.call(node.querySelectorAll('select')) : []);
        list.forEach(function (s) {
          if (s._fsWrap && !s.isConnected && s._fsWrap.parentNode) s._fsWrap.parentNode.removeChild(s._fsWrap);
        });
      });
    });
  });

  function init() {
    var st = document.getElementById('filo-select-styles');
    if (!st) { st = document.createElement('style'); st.id = 'filo-select-styles'; document.head.appendChild(st); }
    st.textContent = [
      '.fs-native{position:absolute!important;opacity:0!important;pointer-events:none!important;width:1px!important;height:1px!important;margin:0!important;padding:0!important;border:0!important;overflow:hidden!important;clip:rect(0,0,0,0)!important}',
      '.fs-wrap{position:relative;display:inline-block;width:100%;font-family:inherit;vertical-align:middle}',
      '.fs-btn{width:100%;cursor:pointer;text-align:left;display:flex;align-items:center;justify-content:space-between;gap:8px;background:rgba(255,255,255,.05);color:#fff;border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:9px 12px;font-size:13.5px;font-family:inherit;line-height:1.3;transition:border-color .15s,background .15s;box-sizing:border-box;min-height:38px}',
      '.fs-btn:hover{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.2)}',
      '.fs-btn:focus-visible,.fs-wrap.open .fs-btn{outline:none;border-color:#FFD100;background:rgba(255,209,0,.06)}',
      '.fs-btn.empty .fs-label{color:rgba(255,255,255,.5)}',
      '.fs-wrap.disabled .fs-btn{opacity:.5;cursor:not-allowed}',
      '.fs-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.fs-caret{font-size:10px;color:rgba(255,255,255,.5);transition:transform .15s}',
      '.fs-wrap.open .fs-caret{transform:rotate(180deg);color:#FFD100}',
      '.fs-panel{position:fixed;z-index:100000;display:flex;flex-direction:column;overflow:hidden;background:rgba(10,20,38,.98);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border:1px solid rgba(255,255,255,.1);border-radius:10px;box-shadow:0 20px 60px rgba(0,0,0,.5);font-family:inherit;animation:fsIn .15s cubic-bezier(.2,.9,.3,1)}',
      '.fs-search{padding:6px;border-bottom:1px solid rgba(255,255,255,.08);flex:0 0 auto}',
      '.fs-search input{width:100%;box-sizing:border-box;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:8px 10px;color:#fff;font-size:16px;font-family:inherit;outline:none}',
      '.fs-search input:focus{border-color:#FFD100}',
      '.fs-search input::placeholder{color:rgba(255,255,255,.4)}',
      '.fs-list{list-style:none;margin:0;padding:4px;overflow-y:auto;overflow-x:hidden;flex:1 1 auto;min-height:0;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.14) transparent}',
      '.fs-list::-webkit-scrollbar{width:6px}',
      '.fs-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:3px}',
      '@keyframes fsIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}',
      '.fs-opt{padding:9px 11px;cursor:pointer;color:rgba(255,255,255,.85);font-size:13.5px;border-radius:7px;display:flex;align-items:center;gap:6px;transition:background .1s}',
      '.fs-opt.kb{background:rgba(255,255,255,.07);color:#fff}',
      '.fs-opt.selected{background:rgba(255,209,0,.1);color:#FFD100;font-weight:600}',
      '.fs-opt.selected::after{content:"✓";margin-left:auto;opacity:.7}',
      '.fs-opt.disabled{color:rgba(255,255,255,.3);cursor:not-allowed}',
      '.fs-empty{padding:12px;color:rgba(255,255,255,.4);font-size:13px;text-align:center}'
    ].join('\n');
    scan();
    bodyObs.observe(document.body, { childList: true, subtree: true });
  }

  window.FiloSelect = { scan: scan };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
