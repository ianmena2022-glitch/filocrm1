// Primeros pasos: checklist para dejar FILO andando en una cuenta nueva.
// Reemplaza al tour del primer login. Cada paso tiene un botón que lleva a la pantalla
// donde se hace, y se marca solo cuando el dato ya está cargado (GET /api/settings/onboarding).
//
// Se ve como una tarjeta dentro del dashboard (entre el saludo y las pestañas). Si el dueño
// la cierra o se va a otra pantalla, queda una píldora con el progreso; tocándola vuelve
// al dashboard con la tarjeta abierta.
//
// Usa las funciones globales del CRM: api, showSection, cfgGoToItem, showToast y la variable currentShop.
(function () {
  'use strict';

  var MAX_DAYS = 30; // después de un mes ya no se muestra
  var state = null;  // respuesta del servidor
  var loading = null;

  var STEPS = [
    { id: 'local',    icon: '📍', title: 'Completá los datos de tu local',
      desc: 'Dirección y ciudad. Aparecen en tu página de reservas.',
      btn: 'Completar', go: function () { goCfg('local'); } },
    { id: 'schedule', icon: '🕒', title: 'Configurá tus horarios',
      desc: 'Los días y horas en que atendés. Con esto se arman los turnos disponibles.',
      btn: 'Configurar', go: function () { goCfg('schedule'); } },
    { id: 'services', icon: '✂️', title: 'Cargá tus servicios y precios',
      desc: 'Te dejamos algunos de ejemplo: cambialos por los tuyos.',
      btn: 'Cargar', go: function () { goCfg('services'); } },
    { id: 'whatsapp', icon: '💬', title: 'Conectá tu WhatsApp',
      desc: 'Así FILO manda solo las confirmaciones y los recordatorios.',
      btn: 'Conectar', go: function () { goCfg('whatsapp'); } },
    { id: 'link',     icon: '🔗', title: 'Poné tu link de reservas en Instagram',
      desc: 'Copialo y pegalo en la bio para que tus clientes reserven solos.',
      btn: 'Copiar link', go: copyLink },
    { id: 'online',   icon: '📅', title: 'Recibí tu primer turno online',
      desc: 'Pasale el link a un cliente, o reservá vos para probar.',
      btn: 'Abrir mi página', go: openBookingPage },
  ];

  function shop() { try { return typeof currentShop !== 'undefined' ? currentShop : null; } catch (_) { return null; } }
  function shopKey(k) { var s = shop(); return 'filo_onb_' + k + '_' + ((s && s.id) || ''); }
  function lsGet(k) { try { return localStorage.getItem(shopKey(k)); } catch (_) { return null; } }
  function lsSet(k, v) { try { if (v) localStorage.setItem(shopKey(k), v); else localStorage.removeItem(shopKey(k)); } catch (_) {} }

  function isDone(id) {
    if (!state) return false;
    var s = state.steps || {};
    if (id === 'link') return !!lsGet('link') || !!s.online;
    // Horarios: distinto del de ejemplo, o guardado con la pantalla de Horarios abierta
    if (id === 'schedule') return !!s.schedule || (!!s.schedule_saved && !!lsGet('schedule'));
    return !!s[id];
  }
  function doneCount() { return STEPS.filter(function (st) { return isDone(st.id); }).length; }

  function currentSection() {
    var sec = document.querySelector('.section.active');
    return sec ? sec.id.replace(/^sec-/, '') : '';
  }

  function goCfg(item) {
    // En el mismo paso, así el menú de la izquierda no muestra un instante "Datos del local"
    try { showSection('configuracion'); } catch (_) {}
    try { cfgGoToItem(item); } catch (_) {}
    syncView();
  }

  function bookingUrl() {
    return state && state.slug ? location.origin + '/reservar/' + state.slug : null;
  }

  function copyLink() {
    var url = bookingUrl();
    if (!url) { goCfg('booking-link'); return; }
    var ok = function () {
      lsSet('link', '1');
      try { showToast('✅', 'Link copiado', 'Pegalo en la bio de tu Instagram'); } catch (_) {}
      render();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(ok, function () { goCfg('booking-link'); });
    } else { goCfg('booking-link'); }
  }

  function openBookingPage() {
    var url = bookingUrl();
    if (!url) { goCfg('booking-link'); return; }
    window.open(url, '_blank', 'noopener');
  }

  // ── UI ──────────────────────────────────────────────────────────────────
  function injectCss() {
    if (document.getElementById('onb-css')) return;
    var css = document.createElement('style');
    css.id = 'onb-css';
    css.textContent = [
      // Píldora (fuera del dashboard o con la tarjeta cerrada)
      '#onb-pill{position:fixed;right:84px;bottom:22px;z-index:900;display:none;align-items:center;gap:8px;background:#0d1f38;border:1px solid rgba(255,209,0,.45);color:#fff;border-radius:999px;padding:10px 16px;font:700 13px Barlow,sans-serif;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.4);min-height:44px}',
      '#onb-pill:hover{border-color:var(--yellow,#FFD100)}',
      '#onb-pill:focus-visible{outline:2px solid var(--yellow,#FFD100);outline-offset:2px}',
      '#onb-pill .onb-pill-n{background:var(--yellow,#FFD100);color:#0a1628;border-radius:999px;padding:2px 8px;font-size:12px}',
      // Tarjeta dentro del dashboard: un paso a la vez
      '#onb-card{display:none;margin:0 20px 14px;background:linear-gradient(180deg,rgba(255,209,0,.07),rgba(255,255,255,.02));border:1px solid rgba(255,209,0,.22);border-radius:14px;padding:12px 14px;font-family:Barlow,sans-serif;color:#fff;max-width:720px;overflow:hidden}',
      '#onb-card.show{display:block}',
      '.onb-head{display:flex;align-items:center;gap:10px}',
      '.onb-title{font-family:Oswald,sans-serif;font-size:15px;font-weight:700;letter-spacing:.3px;white-space:nowrap}',
      '.onb-sub{font-size:12px;color:rgba(255,255,255,.6);white-space:nowrap}',
      '.onb-x{background:transparent;border:none;color:rgba(255,255,255,.55);font-size:20px;line-height:1;cursor:pointer;min-width:36px;min-height:36px;border-radius:8px;margin-left:auto}',
      '.onb-x:hover{color:#fff;background:rgba(255,255,255,.06)}',
      '.onb-x:focus-visible{outline:2px solid var(--yellow,#FFD100)}',
      // Barra de progreso en segmentos (uno por paso)
      '.onb-seg{display:flex;gap:4px;margin:6px 0 10px}',
      '.onb-seg i{flex:1;height:5px;border-radius:99px;background:rgba(255,255,255,.1);position:relative;overflow:hidden}',
      '.onb-seg i::after{content:"";position:absolute;inset:0;background:var(--yellow,#FFD100);transform:scaleX(0);transform-origin:left;transition:transform .5s cubic-bezier(.2,.8,.2,1)}',
      '.onb-seg i.on::after{transform:scaleX(1)}',
      '.onb-seg i.cur{background:rgba(255,209,0,.25)}',
      // El paso actual
      '.onb-stage{position:relative}',
      '.onb-cur{display:flex;align-items:center;gap:12px}',
      '.onb-num{flex:0 0 32px;height:32px;border-radius:50%;border:2px solid rgba(255,209,0,.5);color:var(--yellow,#FFD100);display:flex;align-items:center;justify-content:center;font:800 14px "Barlow Condensed",sans-serif;transition:background .25s,border-color .25s,color .25s}',
      '.onb-txt{flex:1;min-width:0}',
      '.onb-st{font-size:15px;font-weight:700;line-height:1.25}',
      '.onb-sd{font-size:12px;color:rgba(255,255,255,.6);margin-top:2px;line-height:1.4}',
      '.onb-acts{display:flex;align-items:center;gap:6px;flex:0 0 auto}',
      '.onb-go{background:var(--yellow,#FFD100);color:#0a1628;border:none;border-radius:8px;padding:9px 14px;font:800 12px "Barlow Condensed",sans-serif;letter-spacing:.3px;text-transform:uppercase;cursor:pointer;min-height:40px;white-space:nowrap}',
      '.onb-go:hover{filter:brightness(1.07)}',
      '.onb-go:focus-visible{outline:2px solid #fff;outline-offset:2px}',
      '.onb-later{background:transparent;border:none;color:rgba(255,255,255,.5);font:600 12px Barlow,sans-serif;cursor:pointer;padding:8px 6px;min-height:40px;white-space:nowrap}',
      '.onb-later:hover{color:#fff}',
      '.onb-later:focus-visible{outline:2px solid var(--yellow,#FFD100);border-radius:6px}',
      // Animación: el paso hecho se tilda y sale; el siguiente entra desde la derecha
      '.onb-cur.done .onb-num{background:#22c55e;border-color:#22c55e;color:#0a1628;animation:onbPop .35s ease-out}',
      '.onb-cur.out{animation:onbOut .3s ease-in forwards}',
      '.onb-cur.in{animation:onbIn .35s cubic-bezier(.2,.8,.2,1)}',
      '@keyframes onbPop{0%{transform:scale(.6)}60%{transform:scale(1.15)}100%{transform:scale(1)}}',
      '@keyframes onbOut{to{opacity:0;transform:translateX(-24px)}}',
      '@keyframes onbIn{from{opacity:0;transform:translateX(24px)}to{opacity:1;transform:none}}',
      '@media (prefers-reduced-motion: reduce){.onb-cur.out,.onb-cur.in,.onb-cur.done .onb-num{animation:none}.onb-seg i::after{transition:none}}',
      '.onb-done{display:flex;align-items:center;gap:12px;font-size:13px;line-height:1.45}',
      '.onb-done .onb-num{background:#22c55e;border-color:#22c55e;color:#0a1628}',
      '.onb-hide{background:transparent;border:none;color:rgba(255,255,255,.45);font:600 11px Barlow,sans-serif;cursor:pointer;text-decoration:underline;padding:4px 0;margin-top:6px}',
      '.onb-hide:hover{color:#fff}',
      '#onb-card .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',
      '@media (max-width:768px){',
      '  #onb-card{margin:0 12px 12px;padding:10px 12px}',
      '  .onb-cur{flex-wrap:wrap;gap:8px 10px}',
      '  .onb-num{flex-basis:28px;height:28px;font-size:13px}',
      '  .onb-st{font-size:14px}',
      '  .onb-acts{flex-basis:100%;padding-left:38px}',
      '  .onb-go{flex:1}',
      '  #onb-pill{right:12px;bottom:calc(96px + env(safe-area-inset-bottom,0px));padding:8px 12px;font-size:12px}',
      '}',
    ].join('\n');
    document.head.appendChild(css);
  }

  function ensureDom() {
    injectCss();
    if (!document.getElementById('onb-pill')) {
      var pill = document.createElement('button');
      pill.id = 'onb-pill';
      pill.type = 'button';
      pill.setAttribute('aria-label', 'Ver primeros pasos');
      pill.onclick = function () { expand(); };
      document.body.appendChild(pill);
    }
    if (!document.getElementById('onb-card')) {
      var card = document.createElement('section');
      card.id = 'onb-card';
      card.setAttribute('aria-label', 'Primeros pasos');
      var dash = document.getElementById('sec-dashboard');
      var tabs = dash && dash.querySelector('.dash-tabs');
      if (tabs) tabs.parentNode.insertBefore(card, tabs);
      else if (dash) dash.insertBefore(card, dash.firstChild ? dash.firstChild.nextSibling : null);
      else document.body.appendChild(card);
    }
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // Paso que se muestra: el primero sin hacer (los que dejó "para más tarde" van al final)
  function currentStep() {
    var skipped = (lsGet('later') || '').split(',');
    var pending = STEPS.filter(function (st) { return !isDone(st.id); });
    var now = pending.filter(function (st) { return skipped.indexOf(st.id) === -1; });
    return now[0] || pending[0] || null;
  }

  var _shownStep = null;   // id del paso que está en pantalla
  var _animating = false;

  function stepHtml(st, idx, cls) {
    return '<div class="onb-cur' + (cls ? ' ' + cls : '') + '" data-step="' + st.id + '">' +
      '<span class="onb-num" aria-hidden="true">' + (idx + 1) + '</span>' +
      '<div class="onb-txt"><div class="onb-st">' + st.icon + ' ' + esc(st.title) + '</div>' +
      '<div class="onb-sd">' + esc(st.desc) + '</div></div>' +
      '<div class="onb-acts">' +
      '<button class="onb-go" type="button" onclick="FiloOnboarding.go(\'' + st.id + '\')">' + esc(st.btn) + '</button>' +
      '<button class="onb-later" type="button" onclick="FiloOnboarding.later(\'' + st.id + '\')" aria-label="Dejar para más tarde: ' + esc(st.title) + '">Más tarde</button>' +
      '</div></div>';
  }

  function doneHtml() {
    return '<div class="onb-done"><span class="onb-num" aria-hidden="true">✓</span><div>🎉 <strong>FILO ya está andando.</strong> Tus clientes pueden reservar solos y les llegan los recordatorios por WhatsApp.</div></div>';
  }

  function render() {
    if (!state) return;
    ensureDom();
    var n = doneCount(), total = STEPS.length, all = n === total;
    var cur = currentStep();
    var idx = cur ? STEPS.indexOf(cur) : total;
    document.getElementById('onb-pill').innerHTML = '🚀 Primeros pasos <span class="onb-pill-n">' + n + '/' + total + '</span>';

    var card = document.getElementById('onb-card');
    var stage = card.querySelector('.onb-stage');
    if (!stage) {
      card.innerHTML =
        '<div class="onb-head"><div class="onb-title">🚀 Primeros pasos</div><span class="onb-sub"></span>' +
        '<button class="onb-x" type="button" aria-label="Cerrar primeros pasos" onclick="FiloOnboarding.collapse()">×</button></div>' +
        '<div class="onb-seg" role="progressbar" aria-label="Progreso de primeros pasos" aria-valuemin="0" aria-valuemax="' + total + '">' +
        STEPS.map(function () { return '<i></i>'; }).join('') + '</div>' +
        '<div class="onb-stage" aria-live="polite"></div>' +
        '<button class="onb-hide" type="button" onclick="FiloOnboarding.hide()"></button>';
      stage = card.querySelector('.onb-stage');
    }
    // Encabezado y barra (los segmentos se llenan con transición)
    card.querySelector('.onb-sub').textContent = all ? '¡Completaste todo!' : 'Paso ' + (idx + 1) + ' de ' + total + ' · ' + n + ' listos';
    var seg = card.querySelector('.onb-seg');
    seg.setAttribute('aria-valuenow', String(n));
    seg.querySelectorAll('i').forEach(function (el, i) {
      el.classList.toggle('on', isDone(STEPS[i].id));
      el.classList.toggle('cur', !!cur && STEPS[i].id === cur.id);
    });
    card.querySelector('.onb-hide').textContent = all ? 'Listo, ocultar' : 'No mostrar más';

    var nextId = cur ? cur.id : '__all';
    if (_animating || nextId === _shownStep) { syncView(); return; }

    var prevEl = stage.querySelector('.onb-cur');
    var prevId = _shownStep;
    var swap = function (animate) {
      stage.innerHTML = cur ? stepHtml(cur, idx, animate ? 'in' : '') : doneHtml();
      _shownStep = nextId;
    };
    // Si el paso que estaba en pantalla se completó: se tilda, sale y entra el siguiente
    var cardVisible = card.classList.contains('show') && currentSection() === 'dashboard';
    if (prevEl && prevId && prevId !== '__all' && isDone(prevId) && cardVisible) {
      _animating = true;
      prevEl.classList.remove('in');
      prevEl.classList.add('done');
      prevEl.querySelector('.onb-num').textContent = '✓';
      setTimeout(function () {
        prevEl.classList.add('out');
        setTimeout(function () { swap(true); _animating = false; render(); }, 280);
      }, 550);
    } else {
      swap(!!prevEl);
    }
    syncView();
  }

  // Tarjeta en el dashboard (si no la cerró) o píldora en cualquier otro caso
  function syncView() {
    var card = document.getElementById('onb-card');
    var pill = document.getElementById('onb-pill');
    if (!card || !pill) return;
    if (!eligible()) { card.classList.remove('show'); pill.style.display = 'none'; return; }
    var onDash = currentSection() === 'dashboard';
    var showCard = onDash && !lsGet('collapsed');
    card.classList.toggle('show', showCard);
    pill.style.display = showCard ? 'none' : 'inline-flex';
  }

  function fetchState() {
    if (loading) return loading;
    loading = api('GET', '/settings/onboarding').then(function (d) {
      state = d; loading = null; return d;
    }, function () { loading = null; return null; });
    return loading;
  }

  function eligible() {
    return state && state.applies && state.account_days <= MAX_DAYS && !lsGet('hidden');
  }

  // Píldora → volver al dashboard con la tarjeta abierta
  function expand() {
    lsSet('collapsed', '');
    if (currentSection() !== 'dashboard') { try { showSection('dashboard'); } catch (_) {} }
    render();
    fetchState().then(render);
    var card = document.getElementById('onb-card');
    if (card) {
      try { card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (_) {}
      var first = card.querySelector('.onb-go') || card.querySelector('.onb-x');
      if (first) setTimeout(function () { try { first.focus({ preventScroll: true }); } catch (_) {} }, 50);
    }
  }

  // Cerrar la tarjeta: queda la píldora
  function collapse() {
    lsSet('collapsed', '1');
    syncView();
    var pill = document.getElementById('onb-pill');
    if (pill && pill.style.display !== 'none') { try { pill.focus({ preventScroll: true }); } catch (_) {} }
  }

  function hide() {
    lsSet('hidden', '1');
    syncView();
  }

  // Después de guardar algo (configuración, servicios, WhatsApp…), actualizar el progreso enseguida.
  // Envuelve la función global api() del CRM.
  var _refreshTimer = null;
  function hookApi() {
    if (typeof window.api !== 'function' || window.api.__onb) return;
    var orig = window.api;
    var wrapped = function (method, path) {
      var p = orig.apply(this, arguments);
      if (method && method !== 'GET') {
        // Guardó la configuración con la pantalla de Horarios abierta: el horario cuenta como revisado
        var onSchedule = false;
        try { onSchedule = typeof _cfgActiveItem !== 'undefined' && _cfgActiveItem === 'schedule'; } catch (_) {}
        Promise.resolve(p).then(function () {
          if (method === 'PUT' && path === '/settings' && onSchedule) lsSet('schedule', '1');
          if (!state || !eligible()) return;
          clearTimeout(_refreshTimer);
          _refreshTimer = setTimeout(function () { fetchState().then(render); }, 300);
        }, function () {});
      }
      return p;
    };
    wrapped.__onb = true;
    window.api = wrapped;
  }

  // Se llama al entrar al CRM (después del login o del registro)
  function init() {
    hookApi();
    fetchState().then(function () {
      if (!eligible()) { syncView(); return; }
      // Ya completó todo en una visita anterior: no molestar
      if (doneCount() === STEPS.length && lsGet('seen_all')) { hide(); return; }
      if (doneCount() === STEPS.length) lsSet('seen_all', '1');
      render();
    });
  }

  // Al volver a la pestaña (p.ej. después de conectar WhatsApp), refrescar el progreso
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && state && eligible()) fetchState().then(render);
  });

  // Si ya había sesión abierta (recarga o volver a entrar), mostrar el progreso al cargar.
  // El login nuevo y el registro lo arrancan desde el CRM.
  window.addEventListener('load', function () {
    setTimeout(function () {
      var auth = document.getElementById('auth-screen');
      var loggedIn = !!shop() && auth && auth.style.display === 'none';
      var justRegistered = false;
      try { justRegistered = !!sessionStorage.getItem('filo_just_registered'); } catch (_) {}
      if (loggedIn && !justRegistered) init();
    }, 1200);
  });

  window.FiloOnboarding = {
    init: init,
    open: expand,       // compat
    expand: expand,
    minimize: collapse, // compat
    collapse: collapse,
    hide: hide,
    // Dejar el paso para más tarde: pasa al siguiente y vuelve cuando no queden otros
    later: function (id) {
      var list = (lsGet('later') || '').split(',').filter(Boolean).filter(function (x) { return x !== id; });
      list.push(id);
      lsSet('later', list.join(','));
      render();
    },
    // Lo llama el CRM al cambiar de sección (antes del cambio): se acomoda después
    refresh: function () {
      setTimeout(syncView, 0);
      if (state && eligible()) fetchState().then(render);
    },
    go: function (id) {
      var st = STEPS.filter(function (x) { return x.id === id; })[0];
      if (st) st.go();
    },
  };
})();
