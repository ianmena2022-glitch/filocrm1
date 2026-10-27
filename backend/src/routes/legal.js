// Botón de arrepentimiento (Res. SCI 424/2020 y art. 34 de la Ley 24.240).
// Cualquiera puede pedir la revocación sin iniciar sesión. Cada pedido recibe un código de
// constancia, se le manda por mail a quien lo pidió y se avisa al equipo de FILO.
const router    = require('express').Router();
const rateLimit = require('express-rate-limit');
const crypto    = require('crypto');
const pool      = require('../db/pool');

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Ya recibimos varios pedidos desde esta conexión. Probá de nuevo en un rato o escribinos a soporte@filocrm.com.ar.' },
});

const clean = (v, max) => String(v || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

// POST /api/legal/arrepentimiento { name, email, phone?, reason? }
router.post('/arrepentimiento', limiter, async (req, res) => {
  const name   = clean(req.body?.name, 120);
  const email  = clean(req.body?.email, 160).toLowerCase();
  const phone  = clean(req.body?.phone, 40);
  const reason = clean(req.body?.reason, 1000);
  if (name.length < 2) return res.status(400).json({ error: 'Ingresá tu nombre' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Ingresá un email válido' });

  try {
    const shop = await pool.query('SELECT id FROM shops WHERE LOWER(email)=$1 ORDER BY id LIMIT 1', [email]);
    const shopId = shop.rows[0]?.id || null;
    let code, row;
    for (let i = 0; i < 5 && !row; i++) {
      code = 'ARR-' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
      const ins = await pool.query(
        `INSERT INTO revocation_requests (code, name, email, phone, reason, shop_id)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (code) DO NOTHING RETURNING id, created_at`,
        [code, name, email, phone || null, reason || null, shopId]
      );
      row = ins.rows[0];
    }
    if (!row) throw new Error('no se pudo generar el código');

    // Avisos: no frenan la respuesta si fallan (el pedido ya quedó registrado)
    try { await require('../services/email').sendRevocationEmails({ code, name, email, phone, reason, shopId, createdAt: row.created_at }); }
    catch (e) { console.error('[ARREPENTIMIENTO] mail:', e.message); }
    try {
      await require('../services/push').sendToAdmins({
        title: '↩️ Botón de arrepentimiento',
        body:  `${name} (${email}) pidió revocar la contratación · ${code}`,
        icon:  '/favicon.ico', data: { url: '/admin', type: 'revocation.requested' },
      });
    } catch (_) {}
    console.log(`[ARREPENTIMIENTO] ${code} · cuenta ${shopId || 'no encontrada'}`);
    res.json({ ok: true, code });
  } catch (e) {
    console.error('[ARREPENTIMIENTO]', e.message);
    res.status(500).json({ error: 'No pudimos registrar el pedido. Escribinos a soporte@filocrm.com.ar.' });
  }
});

module.exports = router;
