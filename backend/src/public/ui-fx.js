// ─────────────────────────────────────────────────────────────────────────────
// FILO · efectos de interfaz (ui-fx)
// Se agrega a una página con <script src="/ui-icons.js"> y <script src="/ui-fx.js"> (defer).
// No toca la lógica de la app: observa el DOM y le suma animaciones. Si falla, la app sigue igual.
//   • Íconos SVG en lugar de los emojis al principio de botones y títulos
//   • Números que suben animados (y odómetro en la caja)
//   • Listas que aparecen escalonadas (solo las filas nuevas)
//   • Tarjetas con luz que sigue al mouse
//   • Esqueletos de carga en lugar de "Cargando..."
//   • Brillo en el botón principal, confeti al reservar o cobrar
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';
  // Interruptor de emergencia: ?nofx en la URL (queda guardado en este dispositivo; ?fx lo vuelve a prender)
  try {
    if (/[?&]nofx\b/.test(location.search)) localStorage.setItem('filo_fx_off', '1');
    if (/[?&]fx\b/.test(location.search)) localStorage.removeItem('filo_fx_off');
    if (localStorage.getItem('filo_fx_off') === '1') return;
  } catch (_) {}
  const REDUCED = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const FINE_POINTER = window.matchMedia && matchMedia('(pointer: fine)').matches;
  const PAGE = (location.pathname.split('/').pop() || '').replace('.html', '') || 'index';
  const safe = (fn) => { try { fn(); } catch (e) { console.warn('[ui-fx]', e && e.message); } };

  // Qué se anima en cada página
  const CONFIG = {
    // (el dashboard del CRM ya anima sus números: acá solo los paneles que no lo hacían)
    count: ['stat-turnos', 'stat-completados', 'stat-pendientes', 'stat-comision', 'stat-pending'],
    odometer: ['caja-neto-val', 'ent-caja-neto-val'],
    lists: ['dash-appointments', 'agenda-list', 'agenda-list-mobile', 'clients-list', 'fila-list', 'fila-queue-list',
            'fila-called-list', 'service-grid', 'slots-container', 'barber-grid', 'branch-grid', 'team-list', 'prize-list'],
    // (las secciones de Configuración no: tienen desplegables que tienen que poder salirse)
    spot: ['.dash-sidebar-kpi', '.caja-neto', '.meta-soon-card', '.stat-card'],
    shine: ['.btn-primary'],
  };

  // ── 1. Íconos ──────────────────────────────────────────────────────────────
  const ICONS = window.FILO_ICONS || {};
  const EMOJI = window.FILO_EMOJI_ICON || {};
  const ICON_TARGETS = 'button, a.done-btn, .btn, .action-btn, .btn-motor, summary, label, th, h1, h2, h3, h4, ' +
    '.settings-section-title, .cfg-item-title, .wpp-fold-title, .kicker, .step-dot, #toast-icon, ' +
    '[class*="title"], [class*="-label"], [class*="tab"], [class*="pill"], [class*="chip"], [class*="icon"], ' +
    '[onclick], [role="button"], ' +
    // títulos en negrita de ventanas emergentes ("💳 ¿Cómo pagó el cliente?")
    'div[style*="font-weight:700"], div[style*="font-weight: 700"], strong, b';
  // Bloques con varias líneas que empiezan con emoji (ficha del turno: "📅 martes…<br>✂️ Con…")
  const ICON_LINES = '.success-detail, .fx-icon-lines';
  const SKIP_ICONS = '.wpp-preview, [contenteditable], textarea, .no-fx-icons, .chat-bubble, .msg-bubble, pre, code';
  const EMOJI_RE = /^(\s*)(\p{Extended_Pictographic}|[✓✗✕])(️)?\s*/u;
  const svg = (name, extra) => `<svg class="fx-ico${extra ? ' ' + extra : ''}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

  function iconize(el) {
    if (el.__fxIco === el.textContent) return;
    if (el.closest(SKIP_ICONS)) return;
    const tn = [...el.childNodes].find(n => n.nodeType === 3 ? n.nodeValue.trim() : n.nodeType === 1);
    if (!tn || tn.nodeType !== 3) { el.__fxIco = el.textContent; return; }
    const m = tn.nodeValue.match(EMOJI_RE);
    if (!m) { el.__fxIco = el.textContent; return; }
    const name = EMOJI[m[2]];
    if (!name || !ICONS[name]) { el.__fxIco = el.textContent; return; }
    const rest = tn.nodeValue.slice(m[0].length);
    const onlyIcon = !rest.trim() && !tn.nextSibling;
    const wrap = document.createElement('span');
    wrap.innerHTML = svg(name, onlyIcon ? 'fx-ico-only' : '');
    el.insertBefore(wrap.firstChild, tn);
    tn.nodeValue = m[1] + rest;
    if (el.id === 'toast-icon') el.classList.toggle('fx-err', m[2] === '❌');
    // Etiquetas cortas (pestañas, botones): ícono y texto en el mismo renglón
    if (!onlyIcon && rest.trim().length <= 16 && !el.querySelector('br, div, p')) el.classList.add('fx-nowrap');
    el.__fxIco = el.textContent;
  }
  // Cada línea (texto al principio o después de un <br>) que empieza con emoji
  function iconizeLines(el) {
    if (el.__fxLines === el.textContent || el.closest(SKIP_ICONS)) return;
    [...el.childNodes].forEach(n => {
      if (n.nodeType !== 3) return;
      const prev = n.previousSibling;
      if (prev && !(prev.nodeType === 1 && prev.tagName === 'BR')) return;
      const m = n.nodeValue.match(EMOJI_RE);
      const name = m && EMOJI[m[2]];
      if (!name || !ICONS[name]) return;
      const wrap = document.createElement('span');
      wrap.innerHTML = svg(name);
      el.insertBefore(wrap.firstChild, n);
      n.nodeValue = m[1] + n.nodeValue.slice(m[0].length);
    });
    el.__fxLines = el.textContent;
  }
  function iconizeIn(root) {
    if (!Object.keys(ICONS).length) return;
    if (root.nodeType !== 1) root = root.parentElement;
    if (!root) return;
    if (root.matches && root.matches(ICON_TARGETS)) iconize(root);
    root.querySelectorAll && root.querySelectorAll(ICON_TARGETS).forEach(iconize);
    if (root.matches && root.matches(ICON_LINES)) iconizeLines(root);
    if (root.closest) { const up = root.closest(ICON_LINES); if (up && up !== root) iconizeLines(up); }
    root.querySelectorAll && root.querySelectorAll(ICON_LINES).forEach(iconizeLines);
  }

  // ── 2. Números que suben ───────────────────────────────────────────────────
  // Lee "$30.500", "11", "- $1.200,50"... y anima desde el valor anterior
  function parseNum(t) {
    const m = String(t).match(/^([^\d-]*?)(-?\d[\d.]*(?:,\d+)?)(.*)$/s);
    if (!m) return null;
    const n = parseFloat(m[2].replace(/\./g, '').replace(',', '.'));
    if (!isFinite(n)) return null;
    const dec = (m[2].split(',')[1] || '').length;
    return { pre: m[1], n, dec, post: m[3] };
  }
  const fmt = (n, dec) => n.toLocaleString('es-AR', { minimumFractionDigits: dec, maximumFractionDigits: dec });

  function watchCount(el) {
    if (el.__fxCount) return;
    el.__fxCount = { last: 0, raf: 0, wrote: null };
    const st = el.__fxCount;
    const run = () => {
      // Los cambios que hacemos nosotros mientras anima se ignoran (el observer avisa tarde)
      if (st.wrote !== null && el.textContent === st.wrote) return;
      const p = parseNum(el.textContent);
      if (!p) return;
      const from = st.last, to = p.n;
      st.last = to;
      if (REDUCED || from === to || Math.abs(to - from) < 1) return;
      cancelAnimationFrame(st.raf);
      const t0 = performance.now(), dur = 750;
      const step = (now) => {
        const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
        const v = from + (to - from) * e;
        st.wrote = p.pre + fmt(p.dec ? v : Math.round(v), p.dec) + p.post;
        el.textContent = st.wrote;
        if (k < 1) st.raf = requestAnimationFrame(step);
      };
      st.raf = requestAnimationFrame(step);
    };
    new MutationObserver(run).observe(el, { childList: true, characterData: true, subtree: true });
    run();
  }

  // ── 3. Odómetro ────────────────────────────────────────────────────────────
  function watchOdometer(el) {
    if (el.__fxOdo) return;
    el.__fxOdo = { writing: false, text: '' };
    const st = el.__fxOdo;
    const render = () => {
      if (st.writing) return;
      const text = el.textContent;
      if (text === st.text || !/\d/.test(text)) { st.text = text; return; }
      st.text = text;
      if (REDUCED) return;
      st.writing = true;
      // Dígitos anteriores alineados a la derecha (unidades con unidades)
      const prevDigits = st.digits || [];
      const newDigits = [...text].filter(ch => /\d/.test(ch));
      const offset = newDigits.length - prevDigits.length;
      const prev = newDigits.map((_, i) => ({ dataset: { d: prevDigits[i - offset] ?? 0 } }));
      st.digits = newDigits;
      el.setAttribute('aria-label', text);
      const html = [...text].map(ch => /\d/.test(ch)
        ? `<span class="fx-odo-d"><span class="fx-odo-col" data-d="${ch}">${'0123456789'.split('').map(d => `<span>${d}</span>`).join('')}</span></span>`
        : `<span>${ch === ' ' ? '&nbsp;' : ch.replace(/[<>&]/g, '')}</span>`).join('');
      el.innerHTML = `<span class="fx-odo" aria-hidden="true">${html}</span>`;
      const cols = el.querySelectorAll('.fx-odo-col');
      cols.forEach((c, i) => { c.style.transition = 'none'; c.style.transform = `translateY(-${(prev[i] ? +prev[i].dataset.d : 0) * 10}%)`; });
      void el.offsetHeight;
      cols.forEach(c => { c.style.transition = ''; c.style.transform = `translateY(-${+c.dataset.d * 10}%)`; });
      st.text = el.textContent;
      st.writing = false;
    };
    new MutationObserver(render).observe(el, { childList: true, characterData: true, subtree: true });
    render();
  }

  // ── 4. Listas escalonadas (solo filas nuevas) ──────────────────────────────
  function watchList(el) {
    if (el.__fxList) return;
    el.__fxList = { seen: new Set() };
    const st = el.__fxList;
    const key = (c) => (c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const run = () => {
      const kids = [...el.children].filter(c => c.offsetParent !== null || el.offsetParent === null);
      let i = 0;
      const now = new Set();
      kids.forEach(c => {
        const k = key(c); now.add(k);
        if (!REDUCED && !st.seen.has(k) && !c.classList.contains('fx-in') && i < 14) {
          c.style.animationDelay = (i * 32) + 'ms';
          c.classList.add('fx-in');
          c.addEventListener('animationend', () => { c.classList.remove('fx-in'); c.style.animationDelay = ''; }, { once: true });
          i++;
        }
      });
      st.seen = now;
    };
    new MutationObserver(run).observe(el, { childList: true });
    run();
  }

  // ── 5. Luz que sigue al mouse ──────────────────────────────────────────────
  function addSpot(el) {
    if (el.__fxSpot || REDUCED || !FINE_POINTER) return;
    el.__fxSpot = true;
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    el.classList.add('fx-spot');
    const g = document.createElement('span');
    g.className = 'fx-spot-glow';
    el.insertBefore(g, el.firstChild);
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      g.style.setProperty('--mx', (e.clientX - r.left) + 'px');
      g.style.setProperty('--my', (e.clientY - r.top) + 'px');
    });
  }

  // ── 6. Esqueletos en lugar de "Cargando..." ───────────────────────────────
  const LOADING_RE = /^\s*(⏳\s*)?Cargando(\.\.\.|…)?\s*$/i;
  function skeletonize(el) {
    if (el.children.length || !LOADING_RE.test(el.textContent)) return;
    if (el.closest('button, option, select, .no-fx-skel')) return;
    const inline = getComputedStyle(el).display.startsWith('inline') || el.tagName === 'P' || el.tagName === 'SPAN' || el.offsetWidth < 160;
    el.setAttribute('aria-busy', 'true');
    el.setAttribute('aria-label', 'Cargando');
    el.innerHTML = inline
      ? '<span class="fx-skel inline"></span>'
      : '<span class="fx-skel" style="width:92%"></span><span class="fx-skel" style="width:78%"></span><span class="fx-skel" style="width:60%"></span>';
  }
  function skeletonizeIn(root) {
    if (root.nodeType === 3) root = root.parentElement;
    if (!root || root.nodeType !== 1) return;
    if (LOADING_RE.test(root.textContent || '') && !root.children.length) return skeletonize(root);
    if ((root.textContent || '').indexOf('Cargando') === -1) return;
    root.querySelectorAll('div, p, span, td, small').forEach(skeletonize);
  }

  // ── 7. Confeti ─────────────────────────────────────────────────────────────
  function confetti(opts) {
    if (REDUCED) return;
    const o = Object.assign({ count: 110, x: innerWidth / 2, y: innerHeight * 0.35 }, opts || {});
    const cv = document.createElement('canvas');
    cv.className = 'fx-confetti';
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
    document.body.appendChild(cv);
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    const colors = ['#FFD100', '#FFE45C', '#ffffff', '#60a5fa', '#4ade80', '#f472b6'];
    const ps = Array.from({ length: o.count }, () => {
      const a = Math.random() * Math.PI * 2, v = 4 + Math.random() * 7;
      return { x: o.x, y: o.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 4, r: 3 + Math.random() * 4,
               c: colors[(Math.random() * colors.length) | 0], rot: Math.random() * 6, vr: (Math.random() - .5) * .3 };
    });
    const t0 = performance.now();
    const tick = (now) => {
      const t = now - t0;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      ps.forEach(p => {
        p.vy += 0.22; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        ctx.save(); ctx.globalAlpha = Math.max(0, 1 - t / 1700);
        ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.c;
        ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r); ctx.restore();
      });
      if (t < 1700) requestAnimationFrame(tick); else cv.remove();
    };
    requestAnimationFrame(tick);
  }
  window.filoConfetti = confetti;

  // Confeti al terminar una reserva y al cobrar (envuelve funciones de la página si existen)
  function hookCelebrations() {
    if (typeof window.showBookingDone === 'function' && !window.showBookingDone.__fx) {
      const orig = window.showBookingDone;
      window.showBookingDone = function () { const r = orig.apply(this, arguments); setTimeout(() => confetti(), 150); return r; };
      window.showBookingDone.__fx = true;
    }
    if (typeof window.showSuccessPop === 'function' && !window.showSuccessPop.__fx) {
      const orig = window.showSuccessPop;
      window.showSuccessPop = function (o) {
        const r = orig.apply(this, arguments);
        if (o && /cobrad/i.test(o.title || '')) setTimeout(() => confetti({ count: 70 }), 120);
        return r;
      };
      window.showSuccessPop.__fx = true;
    }
    // Panel del barbero: el cobro termina con el aviso "✅ Turno completado"
    if (PAGE === 'barber' && typeof window.showToast === 'function' && !window.showToast.__fx) {
      const orig = window.showToast;
      window.showToast = function (msg) {
        const r = orig.apply(this, arguments);
        if (typeof msg === 'string' && /turno completado/i.test(msg) && !/deuda/i.test(msg)) setTimeout(() => confetti({ count: 70 }), 120);
        return r;
      };
      window.showToast.__fx = true;
    }
  }

  // ── 8. Desenfoque sobre la barra de abajo en el celular ────────────────────
  function blurEdge() {
    const bar = document.querySelector('.sidebar');
    if (!bar) return;
    let edge = document.querySelector('.fx-blur-edge');
    const place = () => {
      const fixedBottom = getComputedStyle(bar).position === 'fixed' && innerWidth <= 768;
      if (!fixedBottom) { edge && (edge.style.display = 'none'); return; }
      if (!edge) { edge = document.createElement('div'); edge.className = 'fx-blur-edge'; document.body.appendChild(edge); }
      edge.style.display = '';
      edge.style.bottom = bar.getBoundingClientRect().height + 'px';
    };
    place();
    addEventListener('resize', place);
  }

  // ── Arranque ───────────────────────────────────────────────────────────────
  function scanStatic() {
    CONFIG.count.forEach(id => { const el = document.getElementById(id); el && watchCount(el); });
    CONFIG.odometer.forEach(id => { const el = document.getElementById(id); el && watchOdometer(el); });
    CONFIG.lists.forEach(id => { const el = document.getElementById(id); el && watchList(el); });
    CONFIG.spot.forEach(sel => document.querySelectorAll(sel).forEach(addSpot));
    CONFIG.shine.forEach(sel => document.querySelectorAll(sel).forEach(b => b.classList.add('fx-shine')));
  }

  let queue = new Set(), scheduled = false;
  function flush() {
    scheduled = false;
    const roots = [...queue]; queue.clear();
    roots.forEach(r => { safe(() => iconizeIn(r)); safe(() => skeletonizeIn(r)); });
    safe(scanStatic);
    safe(hookCelebrations);
  }
  // requestAnimationFrame no corre con la pestaña en segundo plano: un temporizador de respaldo
  // asegura que los íconos y esqueletos se apliquen igual (flush es idempotente)
  function schedule(node) {
    queue.add(node);
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => scheduled && flush());
    setTimeout(() => scheduled && flush(), 120);
  }

  function start() {
    document.documentElement.classList.add('fx-on');
    safe(() => iconizeIn(document.body));
    safe(() => skeletonizeIn(document.body));
    safe(scanStatic);
    safe(hookCelebrations);
    safe(blurEdge);
    new MutationObserver(muts => {
      for (const m of muts) {
        if (m.type === 'characterData') schedule(m.target.parentElement || m.target);
        else m.addedNodes.forEach(n => schedule(n.nodeType === 3 ? n.parentElement || n : n));
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
