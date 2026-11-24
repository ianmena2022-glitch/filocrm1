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
      // Tarjeta dentro del dashboard
      '#onb-card{display:none;margin:0 20px 14px;background:linear-gradient(180deg,rgba(255,209,0,.06),rgba(255,255,255,.02));border:1px solid rgba(255,209,0,.22);border-radius:14px;padding:14px 16px 12px;font-family:Barlow,sans-serif;color:#fff}',
      '#onb-card.show{display:block}',
      '.onb-head{display:flex;align-items:center;gap:12px;margin-bottom:10px}',
      '.onb-title{font-family:Oswald,sans-serif;font-size:17px;font-weight:700;letter-spacing:.3px;white-space:nowrap}',
      '.onb-prog{flex:1;min-width:0;display:flex;align-items:center;gap:10px}',
      '.onb-bar{flex:1;height:6px;background:rgba(255,255,255,.08);border-radius:99px;overflow:hidden;max-width:260px}',
      '.onb-bar>div{height:100%;background:var(--yellow,#FFD100);border-radius:99px;transition:width .3s}',
      '.onb-sub{font-size:12px;color:rgba(255,255,255,.6);white-space:nowrap}',
      '.onb-x{background:transparent;border:none;color:rgba(255,255,255,.55);font-size:20px;line-height:1;cursor:pointer;min-width:36px;min-height:36px;border-radius:8px;margin-left:auto}',
      '.onb-x:hover{color:#fff;background:rgba(255,255,255,.06)}',
      '.onb-x:focus-visible{outline:2px solid var(--yellow,#FFD100)}',
      '.onb-grid{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:8px}',
      '.onb-step{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:10px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);min-width:0}',
      '.onb-check{flex:0 0 24px;height:24px;border-radius:50%;border:2px solid rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700}',
      '.onb-step.done .onb-check{background:#22c55e;border-color:#22c55e;color:#0a1628}',
      '.onb-txt{flex:1;min-width:0}',
      '.onb-st{font-size:13px;font-weight:700;line-height:1.25}',
      '.onb-step.done .onb-st{color:rgba(255,255,255,.45);text-decoration:line-through}',
      '.onb-sd{font-size:11px;color:rgba(255,255,255,.5);margin-top:2px;line-height:1.35}',
      '.onb-go{flex:0 0 auto;background:var(--yellow,#FFD100);color:#0a1628;border:none;border-radius:8px;padding:7px 10px;font:800 11px "Barlow Condensed",sans-serif;letter-spacing:.3px;text-transform:uppercase;cursor:pointer;min-height:34px;white-space:nowrap}',
      '.onb-go:hover{filter:brightness(1.07)}',
      '.onb-go:focus-visible{outline:2px solid #fff;outline-offset:2px}',
      '.onb-step.done .onb-go{display:none}',
      '.onb-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:10px;font-size:11px;color:rgba(255,255,255,.45)}',
      '.onb-hide{background:transparent;border:none;color:rgba(255,255,255,.5);font:600 12px Barlow,sans-serif;cursor:pointer;text-decoration:underline;padding:6px 0;min-height:32px}',
      '.onb-hide:hover{color:#fff}',
      '#onb-card .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',
      '.onb-done-box{padding:10px 12px;border-radius:10px;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3);font-size:13px;line-height:1.5;margin-bottom:8px}',
      '@media (max-width:768px){',
      '  #onb-card{margin:0 12px 12px;padding:12px}',
      '  .onb-head{flex-wrap:wrap;gap:6px 10px}',
      '  .onb-prog{order:3;flex-basis:100%}',
      '  .onb-bar{max-width:none}',
      '  .onb-grid{grid-template-columns:1fr;gap:6px}',
      '  .onb-sd{display:none}',
      '  .onb-step{padding:6px 8px;gap:8px}',
      '  .onb-check{flex-basis:22px;height:22px;font-size:11px}',
      '  .onb-go{padding:6px 9px;min-height:32px}',
      '  .onb-head{margin-bottom:8px}',
      '  .onb-foot{margin-top:6px}',
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

  function render() {
    if (!state) return;
    ensureDom();
    var n = doneCount(), total = STEPS.length, all = n === total;
    document.getElementById('onb-pill').innerHTML = '🚀 Primeros pasos <span class="onb-pill-n">' + n + '/' + total + '</span>';
    var html = '<div class="onb-head"><div class="onb-title">🚀 Primeros pasos</div>' +
      '<div class="onb-prog"><div class="onb-bar" role="progressbar" aria-label="Progreso" aria-valuemin="0" aria-valuemax="' + total + '" aria-valuenow="' + n + '"><div style="width:' + Math.round(n / total * 100) + '%"></div></div>' +
      '<span class="onb-sub">' + (all ? '¡Completaste todo!' : n + ' de ' + total + ' listos') + '</span></div>' +
      '<button class="onb-x" type="button" aria-label="Cerrar primeros pasos" onclick="FiloOnboarding.collapse()">×</button></div>';
    if (all) {
      html += '<div class="onb-done-box">🎉 <strong>FILO ya está andando.</strong> Tus clientes pueden reservar solos y les llegan los recordatorios por WhatsApp.</div>';
    }
    html += '<ol class="onb-grid">' + STEPS.map(function (st, i) {
      var d = isDone(st.id);
      return '<li class="onb-step' + (d ? ' done' : '') + '">' +
        '<span class="onb-check" aria-hidden="true">' + (d ? '✓' : (i + 1)) + '</span>' +
        '<div class="onb-txt"><div class="onb-st">' + st.icon + ' ' + esc(st.title) + (d ? '<span class="sr-only"> (listo)</span>' : '') + '</div>' +
        (d ? '' : '<div class="onb-sd">' + esc(st.desc) + '</div>') + '</div>' +
        (d ? '' : '<button class="onb-go" type="button" onclick="FiloOnboarding.go(\'' + st.id + '\')" aria-label="' + esc(st.btn + ': ' + st.title) + '">' + esc(st.btn) + '</button>') +
        '</li>';
    }).join('') + '</ol>' +
      '<div class="onb-foot"><span>¿Dudas? Escribinos por WhatsApp.</span>' +
      '<button class="onb-hide" type="button" onclick="FiloOnboarding.hide()">' + (all ? 'Listo, ocultar' : 'No mostrar más') + '</button></div>';
    document.getElementById('onb-card').innerHTML = html;
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
