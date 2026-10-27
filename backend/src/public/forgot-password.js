// "¿Olvidaste tu contraseña?" — compartido por el login del CRM (/app) y el de barberos (/barber).
// Paso 1: email → se manda un código de 6 dígitos. Paso 2: código + contraseña nueva.
// Uso: <script src="/forgot-password.js"></script> y openForgotPassword(emailOpcional)
(function () {
  const css = `
    #fp-overlay{position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:100000;display:flex;align-items:center;justify-content:center;padding:16px;font-family:inherit}
    #fp-box{background:#0d1f38;border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:24px;width:100%;max-width:380px;color:#fff;box-sizing:border-box;max-height:92dvh;overflow-y:auto}
    #fp-box h3{margin:0 0 6px;font-size:18px}
    #fp-box p{margin:0 0 16px;font-size:13px;color:rgba(255,255,255,.6);line-height:1.5}
    #fp-box label{display:block;font-size:12px;color:rgba(255,255,255,.6);margin:0 0 6px}
    #fp-box input{width:100%;box-sizing:border-box;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:12px 14px;color:#fff;font-size:16px;outline:none;margin-bottom:12px}
    #fp-box input:focus{border-color:rgba(255,209,0,.6)}
    #fp-box .fp-code{letter-spacing:8px;text-align:center;font-size:22px;font-weight:700}
    #fp-box .fp-btn{width:100%;background:#FFD100;color:#000;border:none;border-radius:12px;padding:13px;font-size:15px;font-weight:700;cursor:pointer;margin-top:4px}
    #fp-box .fp-btn[disabled]{opacity:.6;cursor:default}
    #fp-box .fp-link{background:none;border:none;color:rgba(255,255,255,.55);font-size:13px;cursor:pointer;padding:10px 0 0;width:100%;text-decoration:underline}
    #fp-box .fp-msg{font-size:13px;border-radius:10px;padding:10px 12px;margin-bottom:12px;line-height:1.4;display:none}
    #fp-box .fp-msg.err{display:block;background:rgba(255,67,67,.12);border:1px solid rgba(255,67,67,.35);color:#ff9a9a}
    #fp-box .fp-msg.ok{display:block;background:rgba(74,222,128,.1);border:1px solid rgba(74,222,128,.3);color:#86efac}`;

  let state = { email: '' };

  function el(id) { return document.getElementById(id); }
  function msg(text, kind) {
    const m = el('fp-msg'); if (!m) return;
    m.className = 'fp-msg' + (text ? ' ' + (kind || 'err') : '');
    m.textContent = text || '';
  }
  async function post(path, body) {
    const r = await fetch('/api/auth/' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'No se pudo completar. Probá de nuevo.');
    return data;
  }
  function busy(btn, on, label) {
    if (!btn) return;
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.disabled = on;
    btn.textContent = on ? (label || 'Enviando…') : btn.dataset.label;
  }
  function close() { el('fp-overlay')?.remove(); }

  function stepEmail() {
    el('fp-box').innerHTML = `
      <h3>🔑 Recuperar contraseña</h3>
      <p>Ingresá el email con el que entrás a FILO y te mandamos un código para elegir una contraseña nueva.</p>
      <div id="fp-msg" class="fp-msg"></div>
      <label for="fp-email">Tu email</label>
      <input type="email" id="fp-email" autocomplete="email" placeholder="tu@email.com" value="${(state.email || '').replace(/"/g, '&quot;')}">
      <button class="fp-btn" id="fp-send">Enviarme el código</button>
      <button class="fp-link" id="fp-cancel">Volver a iniciar sesión</button>`;
    el('fp-cancel').onclick = close;
    const send = async () => {
      const email = el('fp-email').value.trim();
      if (!email || !email.includes('@')) return msg('Ingresá un email válido');
      msg('');
      busy(el('fp-send'), true);
      try {
        await post('forgot-password', { email });
        state.email = email;
        stepCode();
      } catch (e) { msg(e.message); busy(el('fp-send'), false); }
    };
    el('fp-send').onclick = send;
    el('fp-email').onkeydown = (e) => { if (e.key === 'Enter') send(); };
    setTimeout(() => el('fp-email')?.focus(), 50);
  }

  function stepCode() {
    el('fp-box').innerHTML = `
      <h3>📩 Revisá tu email</h3>
      <p>Si hay una cuenta con <strong style="color:#fff">${state.email.replace(/</g, '&lt;')}</strong>, te llegó un código de 6 dígitos (vence en 15 minutos). Revisá también la carpeta de Spam.</p>
      <div id="fp-msg" class="fp-msg"></div>
      <label for="fp-code">Código</label>
      <input id="fp-code" class="fp-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••">
      <label for="fp-pass">Contraseña nueva</label>
      <input type="password" id="fp-pass" autocomplete="new-password" placeholder="Mínimo 6 caracteres">
      <label for="fp-pass2">Repetí la contraseña nueva</label>
      <input type="password" id="fp-pass2" autocomplete="new-password" placeholder="••••••••">
      <button class="fp-btn" id="fp-save">Cambiar contraseña</button>
      <button class="fp-link" id="fp-resend">No me llegó: mandar otro código</button>
      <button class="fp-link" id="fp-cancel" style="padding-top:2px">Cancelar</button>`;
    el('fp-cancel').onclick = close;
    el('fp-code').oninput = (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); };
    el('fp-resend').onclick = async () => {
      busy(el('fp-resend'), true, 'Enviando…');
      try { await post('forgot-password', { email: state.email }); msg('Te mandamos un código nuevo. El anterior ya no sirve.', 'ok'); }
      catch (e) { msg(e.message); }
      busy(el('fp-resend'), false);
    };
    const save = async () => {
      const code = el('fp-code').value.trim();
      const p1 = el('fp-pass').value, p2 = el('fp-pass2').value;
      if (code.length !== 6) return msg('Ingresá el código de 6 dígitos');
      if (p1.length < 6) return msg('La contraseña tiene que tener al menos 6 caracteres');
      if (p1 !== p2) return msg('Las contraseñas no coinciden');
      msg('');
      busy(el('fp-save'), true, 'Guardando…');
      try {
        await post('reset-password', { email: state.email, code, password: p1 });
        stepDone(p1);
      } catch (e) { msg(e.message); busy(el('fp-save'), false); }
    };
    el('fp-save').onclick = save;
    el('fp-pass2').onkeydown = (e) => { if (e.key === 'Enter') save(); };
    setTimeout(() => el('fp-code')?.focus(), 50);
  }

  function stepDone(newPass) {
    el('fp-box').innerHTML = `
      <h3>✅ Listo</h3>
      <p>Tu contraseña se cambió. Ya podés entrar con la nueva.</p>
      <button class="fp-btn" id="fp-login">Iniciar sesión</button>`;
    el('fp-login').onclick = () => {
      // Completar el login con el email y la contraseña nueva
      const le = document.getElementById('login-email'), lp = document.getElementById('login-pass');
      if (le) le.value = state.email;
      if (lp) lp.value = newPass;
      close();
      if (typeof window.login === 'function') window.login();
    };
  }

  window.openForgotPassword = function (prefill) {
    if (!document.getElementById('fp-style')) {
      const st = document.createElement('style'); st.id = 'fp-style'; st.textContent = css;
      document.head.appendChild(st);
    }
    close();
    state = { email: (prefill || document.getElementById('login-email')?.value || '').trim() };
    const ov = document.createElement('div');
    ov.id = 'fp-overlay';
    ov.innerHTML = '<div id="fp-box"></div>';
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    document.body.appendChild(ov);
    stepEmail();
  };
})();
