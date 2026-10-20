// FILO custom <select>: auto-mejora todos los <select> de la página para que
// matcheen el design dark de la app en vez de usar el dropdown nativo del OS.
// - El <select> real queda en el DOM (hidden) para que forms funcionen igual.
// - Un wrapper visual se dibuja al lado y se sincroniza con el select.
// - Opt-out: agregar atributo data-no-filo-select al <select>.
(function(){
  // Scope: solo selects simples, no multiple ni con size>1
  function shouldEnhance(sel) {
    if (!(sel instanceof HTMLSelectElement)) return false;
    if (sel.dataset.noFiloSelect !== undefined) return false;
    if (sel.multiple) return false;
    if (sel.size > 1) return false;
    if (sel.dataset.filoEnhanced === '1') return false;
    return true;
  }

  function labelFor(sel) {
    const opt = sel.options[sel.selectedIndex];
    if (!opt) return '—';
    return opt.textContent.trim() || opt.value || '—';
  }

  function enhance(sel) {
    sel.dataset.filoEnhanced = '1';
    // Guardar el display original para restaurarlo si hiciera falta
    const origDisplay = sel.style.display || '';
    sel.style.display = 'none';
    sel.setAttribute('aria-hidden', 'true');

    const wrap = document.createElement('div');
    wrap.className = 'fs-wrap';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fs-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = `<span class="fs-label">${escapeHtml(labelFor(sel))}</span><span class="fs-caret">▾</span>`;

    const list = document.createElement('ul');
    list.className = 'fs-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('tabindex', '-1');

    function rebuildList() {
      list.innerHTML = '';
      Array.from(sel.options).forEach((opt, i) => {
        const li = document.createElement('li');
        li.className = 'fs-opt' + (i === sel.selectedIndex ? ' selected' : '') + (opt.disabled ? ' disabled' : '');
        li.setAttribute('role', 'option');
        li.setAttribute('data-value', opt.value);
        li.setAttribute('data-index', String(i));
        li.textContent = opt.textContent.trim();
        if (opt.disabled) li.setAttribute('aria-disabled', 'true');
        list.appendChild(li);
      });
    }
    function refreshLabel() {
      wrap.querySelector('.fs-label').textContent = labelFor(sel);
    }

    rebuildList();

    // Position relative hack: wrapper is positioned, list is absolute
    wrap.appendChild(btn);
    wrap.appendChild(list);
    sel.parentNode.insertBefore(wrap, sel.nextSibling);

    let open = false;
    function openList() {
      if (open) return;
      open = true;
      wrap.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      rebuildList();
      // Posicionar lista: por default debajo, pero si no entra, arriba
      positionList();
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onKey, true);
      // Focus el option seleccionado
      const selected = list.querySelector('.fs-opt.selected');
      if (selected) selected.classList.add('kb');
    }
    function closeList() {
      if (!open) return;
      open = false;
      wrap.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('keydown', onKey, true);
      list.querySelectorAll('.fs-opt.kb').forEach(x => x.classList.remove('kb'));
    }
    function positionList() {
      list.style.top = '';
      list.style.bottom = '';
      const rect = wrap.getBoundingClientRect();
      const listH = Math.min(list.scrollHeight, 280);
      const spaceBelow = window.innerHeight - rect.bottom;
      if (spaceBelow < listH + 20 && rect.top > listH + 20) {
        list.style.bottom = '100%';
        list.style.top = 'auto';
      } else {
        list.style.top = '100%';
        list.style.bottom = 'auto';
      }
    }
    function onDocClick(e) {
      if (!wrap.contains(e.target)) closeList();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); closeList(); btn.focus(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
        e.preventDefault();
        const opts = Array.from(list.querySelectorAll('.fs-opt:not(.disabled)'));
        if (!opts.length) return;
        let cur = opts.findIndex(o => o.classList.contains('kb'));
        if (cur < 0) cur = opts.findIndex(o => o.classList.contains('selected'));
        if (e.key === 'Enter' && cur >= 0) {
          pick(parseInt(opts[cur].dataset.index));
          return;
        }
        const next = e.key === 'ArrowDown'
          ? Math.min(opts.length - 1, (cur < 0 ? 0 : cur + 1))
          : Math.max(0, (cur < 0 ? 0 : cur - 1));
        opts.forEach(o => o.classList.remove('kb'));
        opts[next].classList.add('kb');
        opts[next].scrollIntoView({ block: 'nearest' });
      }
    }

    function pick(index) {
      if (sel.selectedIndex !== index) {
        sel.selectedIndex = index;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
      refreshLabel();
      closeList();
    }

    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (open) closeList(); else openList();
    });
    list.addEventListener('click', (e) => {
      const opt = e.target.closest('.fs-opt');
      if (!opt || opt.classList.contains('disabled')) return;
      pick(parseInt(opt.dataset.index));
    });

    // Si el <select> cambia programáticamente (ej. nuestro propio renderPaySplitRows
    // seteando value o reemplazando options), reflejar.
    const mo = new MutationObserver(() => { rebuildList(); refreshLabel(); if (open) positionList(); });
    mo.observe(sel, { attributes: true, childList: true, subtree: true, attributeFilter: ['value','selected','disabled'] });
    sel.addEventListener('change', refreshLabel);
    window.addEventListener('resize', () => { if (open) positionList(); });
  }

  function escapeHtml(s) {
    return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function scan(root = document) {
    root.querySelectorAll('select').forEach(sel => {
      if (shouldEnhance(sel)) enhance(sel);
    });
  }

  // Observer para auto-enhance de selects que se agregan dinámicamente
  const bodyObs = new MutationObserver(muts => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'SELECT' && shouldEnhance(node)) enhance(node);
        else if (node.querySelectorAll) scan(node);
      }
    }
  });

  function init() {
    // Inyectar estilos
    if (!document.getElementById('filo-select-styles')) {
      const st = document.createElement('style');
      st.id = 'filo-select-styles';
      st.textContent = `
.fs-wrap { position: relative; display: inline-block; width: 100%; font-family: inherit; }
.fs-btn {
  width: 100%; cursor: pointer; text-align: left;
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  background: rgba(255,255,255,.05); color: #fff;
  border: 1px solid rgba(255,255,255,.12); border-radius: 10px;
  padding: 9px 12px; font-size: 13.5px; font-family: inherit; line-height: 1.3;
  transition: border-color .15s, background .15s;
  box-sizing: border-box; min-height: 38px;
}
.fs-btn:hover { background: rgba(255,255,255,.07); border-color: rgba(255,255,255,.2); }
.fs-btn:focus-visible, .fs-wrap.open .fs-btn { outline: none; border-color: #FFD100; background: rgba(255,209,0,.06); }
.fs-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fs-caret { font-size: 10px; color: rgba(255,255,255,.5); transition: transform .15s; }
.fs-wrap.open .fs-caret { transform: rotate(180deg); color: #FFD100; }
.fs-list {
  position: absolute; left: 0; right: 0; z-index: 10000;
  margin: 4px 0; padding: 4px; list-style: none;
  background: rgba(10,20,38,.98); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  border: 1px solid rgba(255,255,255,.1); border-radius: 10px;
  box-shadow: 0 20px 60px rgba(0,0,0,.5);
  max-height: 280px; overflow-y: auto; overflow-x: hidden;
  display: none;
  scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.14) transparent;
}
.fs-list::-webkit-scrollbar { width: 6px; }
.fs-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,.14); border-radius: 3px; }
.fs-wrap.open .fs-list { display: block; animation: fsIn .15s cubic-bezier(.2,.9,.3,1); }
@keyframes fsIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
.fs-opt {
  padding: 9px 11px; cursor: pointer; color: rgba(255,255,255,.85);
  font-size: 13.5px; border-radius: 7px;
  display: flex; align-items: center; gap: 6px;
  transition: background .1s;
}
.fs-opt:hover, .fs-opt.kb { background: rgba(255,255,255,.07); color: #fff; }
.fs-opt.selected { background: rgba(255,209,0,.1); color: #FFD100; font-weight: 600; }
.fs-opt.selected::after { content: '✓'; margin-left: auto; opacity: .7; }
.fs-opt.disabled { color: rgba(255,255,255,.3); cursor: not-allowed; }
.fs-opt.disabled:hover { background: transparent; }
      `;
      document.head.appendChild(st);
    }
    scan();
    bodyObs.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
