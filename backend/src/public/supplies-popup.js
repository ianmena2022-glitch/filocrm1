// FILO — ventana "¿Usaste algún insumo?" que aparece al completar un turno.
// La usan el CRM y el panel del barbero:
//   FiloSupplies.open({ apptId, insumos, api, onSaved(result), onError(msg) })
// `api(method, path, body)` es el helper de cada página (lanza Error con el mensaje del servidor).
(function () {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function injectCss() {
    if (document.getElementById('supplies-popup-css')) return;
    const st = document.createElement('style');
    st.id = 'supplies-popup-css';
    st.textContent = `
@keyframes suppliesIn{from{opacity:0}to{opacity:1}}
.supplies-overlay{position:fixed;inset:0;background:rgba(0,0,0,.65);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex;align-items:flex-end;justify-content:center;padding:16px;z-index:9700;animation:suppliesIn .2s ease;font-family:'Barlow',sans-serif;color:#fff}
@media (min-width:640px){.supplies-overlay{align-items:center}}
.supplies-modal{background:#0a1828;border:1px solid rgba(255,255,255,.09);border-radius:18px;padding:20px 18px 14px;width:100%;max-width:420px;max-height:calc(100vh - 32px);display:flex;flex-direction:column;box-shadow:0 30px 80px rgba(0,0,0,.7)}
.supplies-title{font-family:'Oswald',sans-serif;font-size:19px;font-weight:700;letter-spacing:.3px}
.supplies-sub{font-size:12px;color:#7a8fa8;margin-top:3px}
.supplies-x{background:transparent;border:none;color:rgba(255,255,255,.45);font-size:26px;line-height:1;cursor:pointer;padding:0 4px;min-width:36px;min-height:36px}
.supplies-search{margin:12px 0 0;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:10px 12px;color:#fff;font-size:14px;outline:none}
.supplies-list{overflow-y:auto;margin:12px -4px 0;padding:0 4px;display:flex;flex-direction:column;gap:7px;min-height:0}
.supplies-row{display:flex;align-items:center;gap:10px;padding:9px 10px 9px 13px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:11px;transition:border-color .15s,background .15s}
.supplies-row.on{border-color:rgba(255,209,0,.45);background:rgba(255,209,0,.06)}
.supplies-row.over{border-color:rgba(255,67,67,.5);background:rgba(255,67,67,.06)}
.supplies-name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.supplies-stock{font-size:11px;color:#7a8fa8;margin-top:2px}
.supplies-stock.none{color:#FF4343}
.supplies-stepper{display:flex;align-items:center;gap:4px;flex-shrink:0}
.supplies-stepper button{width:36px;height:36px;border-radius:9px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:#fff;font-size:18px;cursor:pointer;line-height:1}
.supplies-stepper input{width:52px;height:36px;text-align:center;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:9px;color:#fff;font-size:15px;font-weight:700;-moz-appearance:textfield}
.supplies-stepper input::-webkit-outer-spin-button,.supplies-stepper input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.supplies-error{color:#FF4343;font-size:12px;min-height:16px;margin:10px 2px 2px}
.supplies-save{width:100%;background:#FFD100;color:#000;border:none;border-radius:12px;padding:14px;font-size:14px;font-weight:800;cursor:pointer;margin-top:4px}
.supplies-save:disabled{opacity:.45;cursor:not-allowed}
.supplies-skip{width:100%;background:transparent;border:none;color:rgba(255,255,255,.5);padding:11px;cursor:pointer;font-size:13px}`;
    document.head.appendChild(st);
  }

  function open({ apptId, insumos, api, onSaved }) {
    injectCss();
    document.getElementById('supplies-popup')?.remove();
    const pop = document.createElement('div');
    pop.id = 'supplies-popup';
    pop.className = 'supplies-overlay';
    pop.innerHTML = `
      <div class="supplies-modal" role="dialog" aria-modal="true" aria-labelledby="supplies-title">
        <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:4px">
          <div style="flex:1">
            <div id="supplies-title" class="supplies-title">🧴 ¿Usaste algún insumo?</div>
            <div class="supplies-sub">Cargá cuánto usaste en este turno y se descuenta del stock.</div>
          </div>
          <button type="button" class="supplies-x" data-close aria-label="Cerrar">×</button>
        </div>
        <input type="search" class="supplies-search" placeholder="Buscar insumo..." ${insumos.length > 6 ? '' : 'hidden'}>
        <div class="supplies-list">
          ${insumos.map((p) => {
            const stock = parseInt(p.stock || 0);
            const u = p.unidad && p.unidad !== 'unidad' ? p.unidad : 'u.';
            return `<div class="supplies-row" data-id="${parseInt(p.id)}" data-name="${esc((p.nombre || '').toLowerCase())}" data-max="${Math.max(stock, 0)}">
              <div style="flex:1;min-width:0">
                <div class="supplies-name">${esc(p.nombre)}</div>
                <div class="supplies-stock ${stock <= 0 ? 'none' : ''}">Stock: ${stock} ${esc(u)}</div>
              </div>
              <div class="supplies-stepper">
                <button type="button" data-step="-1" aria-label="Menos">−</button>
                <input type="number" inputmode="numeric" min="0" step="1" value="0" aria-label="Cantidad de ${esc(p.nombre)}">
                <button type="button" data-step="1" aria-label="Más">+</button>
              </div>
            </div>`;
          }).join('')}
        </div>
        <div class="supplies-error" aria-live="polite"></div>
        <button type="button" class="supplies-save" disabled>Descontar del stock</button>
        <button type="button" class="supplies-skip" data-close>No usé insumos</button>
      </div>`;

    const $ = (sel) => pop.querySelector(sel);
    const rows = () => [...pop.querySelectorAll('.supplies-row')];
    const close = () => pop.remove();
    const items = () => rows().map((r) => ({
      product_id: parseInt(r.dataset.id),
      cantidad: parseInt(r.querySelector('input').value) || 0,
    })).filter((it) => it.cantidad > 0);

    function refresh() {
      let over = false;
      rows().forEach((r) => {
        const q = parseInt(r.querySelector('input').value) || 0;
        const isOver = q > parseInt(r.dataset.max);
        r.classList.toggle('on', q > 0);
        r.classList.toggle('over', isOver);
        if (isOver) over = true;
      });
      const n = items().length;
      const btn = $('.supplies-save');
      btn.disabled = !n || over;
      btn.textContent = n ? `Descontar ${n === 1 ? '1 insumo' : n + ' insumos'} del stock` : 'Descontar del stock';
      $('.supplies-error').textContent = over ? 'Hay cantidades mayores al stock disponible.' : '';
    }

    pop.addEventListener('click', (e) => {
      if (e.target === pop || e.target.closest('[data-close]')) return close();
      const step = e.target.closest('[data-step]');
      if (step) {
        const input = step.parentElement.querySelector('input');
        input.value = Math.max(0, (parseInt(input.value) || 0) + parseInt(step.dataset.step));
        refresh();
      }
    });
    pop.addEventListener('input', (e) => {
      if (e.target.classList.contains('supplies-search')) {
        const q = e.target.value.toLowerCase().trim();
        rows().forEach((r) => { r.style.display = !q || r.dataset.name.includes(q) ? '' : 'none'; });
      } else refresh();
    });
    document.addEventListener('keydown', function onKey(e) {
      if (!document.body.contains(pop)) return document.removeEventListener('keydown', onKey);
      if (e.key === 'Escape') close();
    });

    let busy = false;
    $('.supplies-save').addEventListener('click', async () => {
      const list = items();
      if (busy || !list.length) return;
      busy = true;
      const btn = $('.supplies-save');
      btn.disabled = true;
      btn.textContent = 'Guardando...';
      try {
        const r = await api('POST', '/products/consume', { appointment_id: apptId, items: list });
        close();
        if (onSaved) onSaved(r);
      } catch (e) {
        $('.supplies-error').textContent = (e && e.message) || 'No se pudo guardar';
        btn.disabled = false;
        btn.textContent = 'Reintentar';
      } finally { busy = false; }
    });

    document.body.appendChild(pop);
  }

  window.FiloSupplies = { open };
})();
