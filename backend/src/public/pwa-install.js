// FILO PWA install prompt — Android (nativo) + iOS (visual) + desktop silencioso.
// Autoinvocado. No requiere orden ni acciones del dev — basta con cargar el script.
(function(){
  const DISMISS_KEY = 'filo_pwa_dismissed_at';
  const DISMISS_DAYS = 7;
  const SHOW_AFTER_MS = 4000;

  const isStandalone = () =>
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;

  if (isStandalone()) return; // ya instalada

  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  const isAndroid = /Android/.test(ua);
  const isDesktop = !isIOS && !isAndroid;

  // Respetar dismiss previo
  try {
    const d = localStorage.getItem(DISMISS_KEY);
    if (d && (Date.now() - Number(d)) < DISMISS_DAYS * 86400000) return;
  } catch(_) {}

  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    maybeShow();
  });

  // iOS Safari no dispara beforeinstallprompt. Lo mostramos de todas formas.
  // Desktop sin prompt capturado: no mostramos (no suma).
  setTimeout(() => maybeShow(), SHOW_AFTER_MS);

  let shown = false;
  function maybeShow() {
    if (shown || isStandalone()) return;
    if (!isIOS && !deferredPrompt) return; // Android sin prompt / desktop: skip
    shown = true;
    renderBanner();
  }

  function dismiss() {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch(_) {}
    document.getElementById('pwa-install-banner')?.remove();
    document.getElementById('pwa-install-modal')?.remove();
  }

  function renderBanner() {
    const b = document.createElement('div');
    b.id = 'pwa-install-banner';
    b.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px">
        <div style="width:42px;height:42px;flex-shrink:0;background:#050d18;border:1px solid rgba(255,255,255,.1);border-radius:11px;display:flex;align-items:center;justify-content:center;font-weight:900;color:#FFD100;font-size:22px;font-family:'Barlow',sans-serif">F</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:700;color:#fff;line-height:1.2">Instalá FILO</div>
          <div style="font-size:12px;color:rgba(255,255,255,.6);line-height:1.3;margin-top:2px">Más rápido · notificaciones · modo pantalla completa</div>
        </div>
        <button id="pwa-install-btn" style="background:#FFD100;color:#000;border:none;padding:9px 14px;border-radius:9px;font-weight:800;font-size:13px;cursor:pointer;font-family:'Barlow',sans-serif;flex-shrink:0;letter-spacing:.2px">Instalar</button>
        <button id="pwa-install-x" aria-label="Cerrar" style="background:transparent;border:none;color:rgba(255,255,255,.4);font-size:22px;cursor:pointer;padding:0 4px;line-height:1;flex-shrink:0">×</button>
      </div>`;
    Object.assign(b.style, {
      position:'fixed', left:'16px', right:'16px',
      bottom:'calc(16px + env(safe-area-inset-bottom))',
      maxWidth:'440px', margin:'0 auto',
      background:'rgba(10,20,36,.96)',
      border:'1px solid rgba(255,255,255,.08)',
      borderRadius:'14px', padding:'12px 14px',
      boxShadow:'0 24px 80px rgba(0,0,0,.6)',
      backdropFilter:'blur(14px)', WebkitBackdropFilter:'blur(14px)',
      zIndex:'10000',
      animation:'pwaIn .4s cubic-bezier(.2,.9,.3,1) both'
    });
    if (!document.getElementById('pwa-install-anim')) {
      const st = document.createElement('style'); st.id = 'pwa-install-anim';
      st.textContent = '@keyframes pwaIn{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:translateY(0)}}';
      document.head.appendChild(st);
    }
    document.body.appendChild(b);

    document.getElementById('pwa-install-x').onclick = dismiss;
    document.getElementById('pwa-install-btn').onclick = async () => {
      if (deferredPrompt) {
        // Android/Chrome: prompt nativo
        try {
          deferredPrompt.prompt();
          const choice = await deferredPrompt.userChoice;
          deferredPrompt = null;
          if (choice?.outcome === 'accepted') dismiss();
          else document.getElementById('pwa-install-banner')?.remove();
        } catch(_) { dismiss(); }
      } else if (isIOS) {
        // iOS: modal con pasos visuales
        showIOSModal();
      } else {
        dismiss();
      }
    };
  }

  function showIOSModal() {
    document.getElementById('pwa-install-banner')?.remove();
    const m = document.createElement('div');
    m.id = 'pwa-install-modal';
    const menuIcon  = `<span style="display:inline-flex;flex-direction:column;align-items:center;gap:2.5px;vertical-align:middle;padding:3px 4px;border:1px solid rgba(255,255,255,.3);border-radius:5px;margin:0 2px"><span style="width:11px;height:1.5px;background:#fff;border-radius:1px"></span><span style="width:7px;height:1.5px;background:#fff;border-radius:1px"></span><span style="width:11px;height:1.5px;background:#fff;border-radius:1px"></span></span>`;
    const shareIcon = `<svg width="14" height="17" viewBox="0 0 50 60" style="vertical-align:middle;margin:0 2px"><path fill="#0a84ff" d="M25 40c-1.1 0-2-.9-2-2V11.4l-4.6 4.6c-.8.8-2 .8-2.8 0s-.8-2 0-2.8l8-8c.8-.8 2-.8 2.8 0l8 8c.8.8.8 2 0 2.8s-2 .8-2.8 0L27 11.4V38c0 1.1-.9 2-2 2z"/><path fill="#0a84ff" d="M42 56H8c-3.3 0-6-2.7-6-6V26c0-3.3 2.7-6 6-6h7c1.1 0 2 .9 2 2s-.9 2-2 2H8c-1.1 0-2 .9-2 2v24c0 1.1.9 2 2 2h34c1.1 0 2-.9 2-2V26c0-1.1-.9-2-2-2h-7c-1.1 0-2-.9-2-2s.9-2 2-2h7c3.3 0 6 2.7 6 6v24c0 3.3-2.7 6-6 6z"/></svg>`;
    m.innerHTML = `
      <div style="background:rgba(10,20,36,.98);max-width:380px;width:100%;border-radius:18px;padding:22px 20px;border:1px solid rgba(255,255,255,.08);box-shadow:0 30px 80px rgba(0,0,0,.7);animation:pwaIn .35s cubic-bezier(.2,.9,.3,1) both">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
          <div style="width:48px;height:48px;background:#050d18;border:1px solid rgba(255,255,255,.1);border-radius:12px;display:flex;align-items:center;justify-content:center;font-weight:900;color:#FFD100;font-size:26px;font-family:'Barlow',sans-serif">F</div>
          <div style="flex:1">
            <div style="font-size:16px;font-weight:800;color:#fff">Instalar FILO</div>
            <div style="font-size:12px;color:rgba(255,255,255,.55)">Agregalo a tu pantalla de inicio</div>
          </div>
          <button id="pwa-ios-x" style="background:transparent;border:none;color:rgba(255,255,255,.45);font-size:26px;cursor:pointer;line-height:1;padding:0 4px">×</button>
        </div>
        <ol style="color:rgba(255,255,255,.85);font-size:14px;line-height:1.65;padding-left:22px;margin:0 0 10px">
          <li>Tocá el ícono ${menuIcon} del <strong>menú</strong> abajo en Safari.</li>
          <li>Tocá ${shareIcon}<strong style="color:#0a84ff">Compartir</strong>.</li>
          <li>Tocá <strong>“Ver más”</strong>.</li>
          <li>Tocá <strong>“Agregar a inicio”</strong>.</li>
        </ol>
        <div style="font-size:11.5px;color:rgba(255,255,255,.4);margin-top:12px;line-height:1.4">Tiene que estar abierto en <strong style="color:rgba(255,255,255,.6)">Safari</strong>. Si estás en otro navegador, abrilo en Safari primero.</div>
      </div>`;
    Object.assign(m.style, {
      position:'fixed', inset:'0', background:'rgba(0,0,0,.65)',
      backdropFilter:'blur(6px)', WebkitBackdropFilter:'blur(6px)',
      display:'flex', alignItems:'flex-end', justifyContent:'center',
      padding:'20px', zIndex:'10001', animation:'pwaIn .3s ease both'
    });
    document.body.appendChild(m);
    document.getElementById('pwa-ios-x').onclick = dismiss;
    m.addEventListener('click', (e) => { if (e.target === m) dismiss(); });
  }

  window.addEventListener('appinstalled', () => {
    dismiss();
  });
})();
