// Pop-up "¿Quién sos?" para las páginas públicas (reservar y fila).
// Un número lo pueden compartir varias personas (ej: Pablo y su hijo Santino usan el del papá).
// Cuando el servidor responde 409 { code: 'WHO_IS', options: [{ id, name }] }, la página muestra
// esto y vuelve a mandar el pedido con client_choice (id de la ficha, o 'new' = otra persona).
//
//   const r = await filoWhoIs(options, nombreEscrito);
//   r === null                → canceló
//   r = { choice: 12 }        → es esa ficha
//   r = { choice: 'new', name } → otra persona, ficha nueva con ese nombre y el mismo número
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  window.filoWhoIs = function (options, typedName) {
    return new Promise(resolve => {
      document.getElementById('filo-whois')?.remove();
      const ov = document.createElement('div');
      ov.id = 'filo-whois';
      ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:100000;display:flex;align-items:center;justify-content:center;padding:16px;font-family:Barlow,sans-serif';
      const opt = 'width:100%;text-align:left;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.14);color:#fff;padding:14px 16px;border-radius:12px;cursor:pointer;font-family:inherit;font-size:15px;font-weight:700;margin-bottom:8px;display:block;min-height:48px';
      ov.innerHTML = `
        <div role="dialog" aria-modal="true" aria-labelledby="filo-whois-t" style="background:#0d1929;border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:22px;width:100%;max-width:400px;max-height:90vh;overflow:auto;color:#fff">
          <div id="filo-whois-t" style="font-size:18px;font-weight:700;margin-bottom:6px">📱 ¿Quién sos?</div>
          <div style="font-size:14px;color:rgba(255,255,255,.65);line-height:1.5;margin-bottom:16px">Este número ya está registrado. Elegí quién va a venir.</div>
          ${options.map(o => `<button type="button" data-id="${esc(o.id)}" style="${opt}">${esc(o.name)}</button>`).join('')}
          <button type="button" data-id="new" style="${opt};border-color:#FFD100;color:#FFD100">➕ Ninguno, soy otra persona</button>
          <div id="filo-whois-new" style="display:none;margin-top:4px">
            <label for="filo-whois-name" style="display:block;font-size:13px;color:rgba(255,255,255,.65);margin-bottom:6px">Tu nombre y apellido</label>
            <input id="filo-whois-name" type="text" maxlength="100" autocomplete="name" value="${esc(typedName || '')}"
              style="width:100%;box-sizing:border-box;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.18);border-radius:10px;padding:12px 14px;color:#fff;font-size:16px;font-family:inherit;outline:none">
            <div id="filo-whois-err" style="display:none;color:#ff8080;font-size:13px;margin-top:6px">Escribí tu nombre</div>
            <button type="button" id="filo-whois-ok" style="width:100%;margin-top:10px;background:#FFD100;border:none;color:#000;padding:13px;border-radius:12px;cursor:pointer;font-family:inherit;font-size:15px;font-weight:700;min-height:48px">Continuar</button>
          </div>
          <button type="button" data-id="cancel" style="width:100%;background:transparent;border:none;color:rgba(255,255,255,.6);padding:12px;cursor:pointer;font-family:inherit;font-size:14px;margin-top:4px">Cancelar</button>
        </div>`;
      document.body.appendChild(ov);
      const close = v => { ov.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = e => { if (e.key === 'Escape') close(null); };
      document.addEventListener('keydown', onKey);
      const nameIn = ov.querySelector('#filo-whois-name');
      const confirmNew = () => {
        const n = nameIn.value.replace(/[<>]/g, '').trim();
        if (!n) { ov.querySelector('#filo-whois-err').style.display = 'block'; nameIn.focus(); return; }
        close({ choice: 'new', name: n });
      };
      ov.querySelector('#filo-whois-ok').onclick = confirmNew;
      nameIn.addEventListener('keydown', e => { if (e.key === 'Enter') confirmNew(); });
      ov.addEventListener('click', e => {
        if (e.target === ov) return close(null);
        const b = e.target.closest('button[data-id]');
        if (!b) return;
        const id = b.dataset.id;
        if (id === 'cancel') return close(null);
        if (id === 'new') {
          ov.querySelector('#filo-whois-new').style.display = 'block';
          nameIn.focus(); nameIn.select();
          return;
        }
        close({ choice: parseInt(id) });
      });
      ov.querySelector('button[data-id]')?.focus();
    });
  };
})();
