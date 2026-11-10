// FILO · efectos de la landing. Trabaja sobre lo que ya dibujó el bundle (no lo modifica por dentro).
// Si algo no se encuentra, simplemente no hace nada.
(function () {
  'use strict';
  const REDUCED = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const FINE = window.matchMedia && matchMedia('(pointer: fine)').matches;
  const safe = (fn) => { try { fn(); } catch (e) { console.warn('[ui-landing]', e && e.message); } };

  // 1. Aurora detrás del hero
  function aurora() {
    const hero = document.querySelector('#root section');
    if (!hero || hero.querySelector('.fx-aurora')) return;
    hero.classList.add('fx-hero-host');
    const a = document.createElement('div');
    a.className = 'fx-aurora'; a.setAttribute('aria-hidden', 'true');
    a.innerHTML = '<i></i><i></i><i></i>';
    hero.insertBefore(a, hero.firstChild);
  }

  // 2. "Automático." rota con otras promesas
  function rotateWord() {
    const h1 = document.querySelector('#root h1');
    const target = h1 && [...h1.querySelectorAll('span')].find(s => /autom[aá]tico/i.test(s.textContent));
    if (!target || target.querySelector('.fx-rotate')) return;
    const words = ['Automático.', 'Sin ausencias.', 'Sin planillas.', 'Todo el día.'];
    target.setAttribute('aria-label', words.join(' '));
    target.innerHTML = `<span class="fx-rotate"><span class="fx-rotate-word">${words[0]}</span></span>`;
    if (REDUCED) return;
    const w = target.querySelector('.fx-rotate-word');
    let i = 0;
    setInterval(() => {
      w.classList.add('out');
      setTimeout(() => {
        i = (i + 1) % words.length;
        w.textContent = words[i];
        w.classList.remove('out'); w.classList.add('in-start');
        void w.offsetWidth;
        w.classList.remove('in-start');
      }, 380);
    }, 2600);
  }

  // 3. Cinta con las funciones debajo del hero
  function marquee() {
    const hero = document.querySelector('#root section');
    if (!hero || document.querySelector('.fx-marquee')) return;
    const items = [['✓', 'Recordatorios por WhatsApp'], ['✓', 'Reservas online 24/7'], ['✓', 'Fila virtual'], ['✓', 'Caja y gastos'],
      ['✓', 'Comisiones de barberos'], ['✓', 'Membresías'], ['✓', 'Puntos y premios'], ['✓', 'Varias sucursales'], ['✓', 'Clientes en fuga']];
    const row = items.map(([b, t]) => `<span><b>${b}</b>${t}</span>`).join('');
    const m = document.createElement('div');
    m.className = 'fx-marquee'; m.setAttribute('aria-hidden', 'true');
    m.innerHTML = `<div class="fx-marquee-track">${row}${row}</div>`;
    hero.insertAdjacentElement('afterend', m);
  }

  // 4. Grilla de funciones en formato bento con luz que sigue al mouse
  function bento() {
    // La grilla de funciones no tiene clase propia: es la grilla de la sección "TODO EN UN SOLO LUGAR"
    const sec = [...document.querySelectorAll('#root section')].find(x => /SOLO\s*LUGAR/i.test(x.textContent));
    const grid = document.querySelector('.filo-features-grid') ||
      (sec && [...sec.querySelectorAll('div')].find(d => getComputedStyle(d).display === 'grid' && d.children.length >= 6));
    if (!grid || grid.classList.contains('fx-bento')) return;
    grid.classList.add('fx-bento');
    // Bento: algunas tarjetas ocupan dos columnas y las filas quedan completas (4 por fila)
    const kids = [...grid.children];
    const wide = kids.length === 8 ? [0, 5, 6, 7] : kids.length === 6 ? [0, 5] : [0];
    wide.forEach(i => kids[i] && kids[i].classList.add('fx-wide'));
    if (REDUCED || !FINE) return;
    [...grid.children].forEach(card => {
      const g = document.createElement('span');
      g.className = 'fx-spot-glow';
      card.appendChild(g);
      card.addEventListener('pointermove', e => {
        const r = card.getBoundingClientRect();
        g.style.setProperty('--mx', (e.clientX - r.left) + 'px');
        g.style.setProperty('--my', (e.clientY - r.top) + 'px');
      });
    });
  }

  function run() { safe(aurora); safe(rotateWord); safe(marquee); safe(bento); }
  // El bundle dibuja después de cargar: se reintenta unos segundos
  let tries = 0;
  const t = setInterval(() => { run(); if (++tries > 60 || (document.querySelector('.fx-marquee') && document.querySelector('.fx-bento'))) clearInterval(t); }, 300);
})();
