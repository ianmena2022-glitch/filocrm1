// Primeros pasos: checklist para dejar FILO andando en una cuenta nueva.
// Reemplaza al tour del primer login. Cada paso tiene un botón que lleva a la pantalla
// donde se hace, y se marca solo cuando el dato ya está cargado (GET /api/settings/onboarding).
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
  function lsSet(k, v) { try { localStorage.setItem(shopKey(k), v); } catch (_) {} }

  function isDone(id) {
    if (!state) return false;
    var s = state.steps || {};
    if (id === 'link') return !!lsGet('link') || !!s.online;
    return !!s[id];
  }
  function doneCount() { return STEPS.filter(function (st) { return isDone(st.id); }).length; }

  function goCfg(item) {
    minimize();
    try { showSection('configuracion'); } catch (_) {}
    setTimeout(function () { try { cfgGoToItem(item); } catch (_) {} }, 60);
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
      '#onb-pill{position:fixed;right:84px;bottom:22px;z-index:900;display:none;align-items:center;gap:8px;background:#0d1f38;border:1px solid rgba(255,209,0,.45);color:#fff;border-radius:999px;padding:10px 16px;font:700 13px Barlow,sans-serif;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.4);min-height:44px}',
      '#onb-pill:hover{border-color:var(--yellow,#FFD100)}',
      '#onb-pill:focus-visible{outline:2px solid var(--yellow,#FFD100);outline-offset:2px}',
      '#onb-pill .onb-pill-n{background:var(--yellow,#FFD100);color:#0a1628;border-radius:999px;padding:2px 8px;font-size:12px}',
      '#onb-panel{position:fixed;right:20px;bottom:88px;z-index:950;width:380px;max-width:calc(100vw - 32px);max-height:calc(100vh - 108px);overflow-y:auto;background:#0d1f38;border:1px solid rgba(255,255,255,.1);border-radius:16px;box-shadow:0 20px 50px rgba(0,0,0,.55);font-family:Barlow,sans-serif;color:#fff;display:none}',
      '#onb-panel.open{display:block;animation:onbIn .2s ease-out}',
      '@keyframes onbIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}',
      '@media (prefers-reduced-motion: reduce){#onb-panel.open{animation:none}}',
      '.onb-head{padding:18px 18px 12px;display:flex;align-items:flex-start;justify-content:space-between;gap:10px}',
      '.onb-title{font-family:Oswald,sans-serif;font-size:19px;font-weight:700;letter-spacing:.3px}',
      '.onb-sub{font-size:12px;color:rgba(255,255,255,.55);margin-top:3px}',
      '.onb-x{background:transparent;border:none;color:rgba(255,255,255,.55);font-size:20px;cursor:pointer;min-width:36px;min-height:36px;border-radius:8px}',
      '.onb-x:hover{color:#fff;background:rgba(255,255,255,.06)}',
      '.onb-bar{height:6px;background:rgba(255,255,255,.08);border-radius:99px;margin:0 18px 8px;overflow:hidden}',
      '.onb-bar>div{height:100%;background:var(--yellow,#FFD100);border-radius:99px;transition:width .3s}',
      '.onb-list{list-style:none;margin:0;padding:6px 12px 8px}',
      '.onb-step{display:flex;align-items:center;gap:12px;padding:11px 8px;border-bottom:1px solid rgba(255,255,255,.05)}',
      '.onb-step:last-child{border-bottom:none}',
      '.onb-check{flex:0 0 26px;height:26px;border-radius:50%;border:2px solid rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;font-size:13px}',
      '.onb-step.done .onb-check{background:#22c55e;border-color:#22c55e;color:#0a1628;font-weight:800}',
      '.onb-txt{flex:1;min-width:0}',
      '.onb-st{font-size:14px;font-weight:700;line-height:1.3}',
      '.onb-step.done .onb-st{color:rgba(255,255,255,.5);text-decoration:line-through}',
      '.onb-sd{font-size:12px;color:rgba(255,255,255,.55);margin-top:2px;line-height:1.4}',
      '.onb-go{flex:0 0 auto;background:var(--yellow,#FFD100);color:#0a1628;border:none;border-radius:8px;padding:8px 12px;font:800 12px "Barlow Condensed",sans-serif;letter-spacing:.3px;text-transform:uppercase;cursor:pointer;min-height:36px;white-space:nowrap}',
      '.onb-go:hover{filter:brightness(1.07)}',
      '.onb-go:focus-visible{outline:2px solid #fff;outline-offset:2px}',
      '.onb-step.done .onb-go{background:transparent;color:rgba(255,255,255,.55);border:1px solid rgba(255,255,255,.15)}',
      '.onb-foot{padding:6px 18px 16px;display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:12px;color:rgba(255,255,255,.5)}',
      '.onb-hide{background:transparent;border:none;color:rgba(255,255,255,.5);font:600 12px Barlow,sans-serif;cursor:pointer;text-decoration:underline;padding:6px 0}',
      '.onb-hide:hover{color:#fff}',
      '.onb-done-box{margin:4px 18px 14px;padding:14px;border-radius:12px;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3);font-size:13px;line-height:1.5}',
      '@media (max-width:768px){#onb-panel{left:12px;right:12px;bottom:calc(96px + env(safe-area-inset-bottom,0px));width:auto;max-width:none;max-height:calc(100vh - 120px)}#onb-pill{right:12px;bottom:calc(96px + env(safe-area-inset-bottom,0px));padding:8px 12px;font-size:12px}}',
    ].join('\n');
    document.head.appendChild(css);
  }

  function ensureDom() {
    injectCss();
    if (!document.getElementById('onb-pill')) {
      var pill = document.createElement('button');
      pill.id = 'onb-pill';
      pill.type = 'button';
      pill.setAttribute('aria-label', 'Abrir primeros pasos');
      pill.onclick = function () { open(); };
      document.body.appendChild(pill);
    }
    if (!document.getElementById('onb-panel')) {
      var panel = document.createElement('div');
      panel.id = 'onb-panel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', 'Primeros pasos');
      document.body.appendChild(panel);
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && panel.classList.contains('open')) minimize();
      });
    }
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function render() {
    if (!state) return;
    ensureDom();
    var n = doneCount(), total = STEPS.length, all = n === total;
    var pill = document.getElementById('onb-pill');
    pill.innerHTML = '🚀 Primeros pasos <span class="onb-pill-n">' + n + '/' + total + '</span>';
    var panel = document.getElementById('onb-panel');
    var html = '<div class="onb-head"><div><div class="onb-title">🚀 Primeros pasos</div>' +
      '<div class="onb-sub">' + (all ? '¡Completaste todo!' : n + ' de ' + total + ' listos · dejá FILO andando en 10 minutos') + '</div></div>' +
      '<button class="onb-x" type="button" aria-label="Minimizar" onclick="FiloOnboarding.minimize()">×</button></div>' +
      '<div class="onb-bar" role="progressbar" aria-valuemin="0" aria-valuemax="' + total + '" aria-valuenow="' + n + '"><div style="width:' + Math.round(n / total * 100) + '%"></div></div>';
    if (all) {
      html += '<div class="onb-done-box">🎉 <strong>FILO ya está andando.</strong> Tus clientes pueden reservar solos y les llegan los recordatorios por WhatsApp.</div>';
    }
    html += '<ol class="onb-list">' + STEPS.map(function (st, i) {
      var d = isDone(st.id);
      return '<li class="onb-step' + (d ? ' done' : '') + '">' +
        '<span class="onb-check" aria-hidden="true">' + (d ? '✓' : (i + 1)) + '</span>' +
        '<div class="onb-txt"><div class="onb-st">' + st.icon + ' ' + esc(st.title) + '</div>' +
        (d ? '' : '<div class="onb-sd">' + esc(st.desc) + '</div>') + '</div>' +
        '<button class="onb-go" type="button" onclick="FiloOnboarding.go(\'' + st.id + '\')"' +
        ' aria-label="' + esc(st.btn + ': ' + st.title) + '">' + (d ? 'Ver' : esc(st.btn)) + '</button></li>';
    }).join('') + '</ol>' +
      '<div class="onb-foot"><span>¿Dudas? Escribinos por WhatsApp.</span>' +
      '<button class="onb-hide" type="button" onclick="FiloOnboarding.hide()">' + (all ? 'Cerrar' : 'No mostrar más') + '</button></div>';
    panel.innerHTML = html;
    var panelOpen = panel.classList.contains('open');
    pill.style.display = panelOpen ? 'none' : 'inline-flex';
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

  function open() {
    ensureDom();
    var panel = document.getElementById('onb-panel');
    panel.classList.add('open');
    render();
    fetchState().then(function () { render(); });
    var first = panel.querySelector('.onb-go');
    if (first) setTimeout(function () { try { first.focus({ preventScroll: true }); } catch (_) {} }, 50);
  }

  function minimize() {
    var panel = document.getElementById('onb-panel');
    if (panel) panel.classList.remove('open');
    if (eligible()) render(); else teardown();
  }

  function hide() {
    lsSet('hidden', '1');
    teardown();
  }

  function teardown() {
    var p = document.getElementById('onb-panel'); if (p) p.classList.remove('open');
    var pill = document.getElementById('onb-pill'); if (pill) pill.style.display = 'none';
  }

  // Se llama al entrar al CRM (después del login o del registro)
  function init() {
    fetchState().then(function () {
      if (!eligible()) { teardown(); return; }
      // Ya completó todo en una visita anterior: no molestar
      if (doneCount() === STEPS.length && lsGet('opened')) { teardown(); return; }
      if (!lsGet('opened')) { lsSet('opened', '1'); open(); }
      else render();
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
    open: open,
    minimize: minimize,
    hide: hide,
    refresh: function () { if (state && eligible()) fetchState().then(render); },
    go: function (id) {
      var st = STEPS.filter(function (x) { return x.id === id; })[0];
      if (st) st.go();
    },
  };
})();
