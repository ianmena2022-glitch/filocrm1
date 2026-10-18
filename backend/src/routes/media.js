// Rutas de media: firma uploads de Cloudinary + persistencia de URLs.
const router = require('express').Router();
const pool   = require('../db/pool');
const auth   = require('../middleware/auth');
const cloud  = require('../services/cloudinary');

function ownerShopId(req) {
  return req.isBarber && req.parentShopId ? req.parentShopId : req.shopId;
}

// Carpeta por shop en Cloudinary → fácil de ver/limpiar y evita colisiones.
function folderFor(shopId, scope) {
  return `filo/shop_${shopId}/${scope}`;
}

// ─── POST /api/media/sign-upload ───
// Body: { scope: 'branding'|'barber' , barberId?: number }
// Devuelve params firmados para que el frontend suba directo a Cloudinary.
router.post('/sign-upload', auth, async (req, res) => {
  if (!cloud.isConfigured()) {
    return res.status(503).json({ error: 'Cloudinary no está configurado en el servidor' });
  }
  const scope = (req.body?.scope || '').toString();
  if (!['branding','barber'].includes(scope)) {
    return res.status(400).json({ error: 'scope inválido' });
  }
  const shopId = ownerShopId(req);
  let folderScope = scope;

  // Si viene con barberId, validar y usar carpeta por barbero
  if (scope === 'barber') {
    const barberId = parseInt(req.body?.barberId);
    if (!Number.isFinite(barberId)) return res.status(400).json({ error: 'barberId requerido' });

    // Permisos: dueño siempre; barbero solo sobre sí mismo Y si el shop lo permite
    if (req.isBarber) {
      if (barberId !== req.shopId) return res.status(403).json({ error: 'No autorizado' });
      const sh = await pool.query('SELECT barber_self_upload_enabled FROM shops WHERE id=$1', [shopId]);
      if (!sh.rows[0]?.barber_self_upload_enabled) {
        return res.status(403).json({ error: 'La barbería no habilitó la carga de fotos para barberos' });
      }
    } else {
      // Dueño: validar que el barbero pertenece a su shop
      const b = await pool.query(
        'SELECT 1 FROM shops WHERE id=$1 AND parent_shop_id=$2 AND is_barber=TRUE',
        [barberId, shopId]
      );
      if (!b.rows.length) return res.status(404).json({ error: 'Barbero no encontrado' });
    }
    folderScope = `barber_${barberId}`;
  } else {
    // scope=branding: solo dueño
    if (req.isBarber) return res.status(403).json({ error: 'Solo el dueño puede modificar el branding' });
  }

  try {
    const signed = cloud.signUploadParams({ folder: folderFor(shopId, folderScope) });
    return res.json(signed);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Guard común: valida que la URL sea de nuestra cuenta
function guardUrl(url) {
  if (url === null) return { ok: true, value: null }; // permite borrar
  if (!cloud.isOurCloudinaryUrl(url)) return { ok: false, error: 'URL inválida' };
  return { ok: true, value: url };
}

// ─── PUT /api/media/shop/profile ───
router.put('/shop/profile', auth, async (req, res) => {
  if (req.isBarber) return res.status(403).json({ error: 'No autorizado' });
  const g = guardUrl(req.body?.url ?? null);
  if (!g.ok) return res.status(400).json({ error: g.error });
  const shopId = ownerShopId(req);
  await pool.query('UPDATE shops SET profile_photo_url=$1 WHERE id=$2', [g.value, shopId]);
  res.json({ ok: true, url: g.value });
});

// ─── PUT /api/media/shop/banner ───
router.put('/shop/banner', auth, async (req, res) => {
  if (req.isBarber) return res.status(403).json({ error: 'No autorizado' });
  const g = guardUrl(req.body?.url ?? null);
  if (!g.ok) return res.status(400).json({ error: g.error });
  const shopId = ownerShopId(req);
  await pool.query('UPDATE shops SET banner_photo_url=$1 WHERE id=$2', [g.value, shopId]);
  res.json({ ok: true, url: g.value });
});

// ─── PUT /api/media/shop/self-upload-toggle ───
router.put('/shop/self-upload-toggle', auth, async (req, res) => {
  if (req.isBarber) return res.status(403).json({ error: 'No autorizado' });
  const enabled = Boolean(req.body?.enabled);
  const shopId = ownerShopId(req);
  await pool.query('UPDATE shops SET barber_self_upload_enabled=$1 WHERE id=$2', [enabled, shopId]);
  res.json({ ok: true, enabled });
});

// Helper permisos para endpoints de barbero
async function canEditBarber(req, barberId) {
  const shopId = ownerShopId(req);
  if (req.isBarber) {
    if (barberId !== req.shopId) return { ok: false, code: 403, error: 'No autorizado' };
    const sh = await pool.query('SELECT barber_self_upload_enabled FROM shops WHERE id=$1', [shopId]);
    if (!sh.rows[0]?.barber_self_upload_enabled) {
      return { ok: false, code: 403, error: 'La barbería no habilitó la carga de fotos para barberos' };
    }
    return { ok: true, shopId };
  }
  const b = await pool.query(
    'SELECT 1 FROM shops WHERE id=$1 AND parent_shop_id=$2 AND is_barber=TRUE',
    [barberId, shopId]
  );
  if (!b.rows.length) return { ok: false, code: 404, error: 'Barbero no encontrado' };
  return { ok: true, shopId };
}

// ─── PUT /api/media/barber/:id/profile ───
router.put('/barber/:id/profile', auth, async (req, res) => {
  const barberId = parseInt(req.params.id);
  if (!Number.isFinite(barberId)) return res.status(400).json({ error: 'id inválido' });
  const perm = await canEditBarber(req, barberId);
  if (!perm.ok) return res.status(perm.code).json({ error: perm.error });
  const g = guardUrl(req.body?.url ?? null);
  if (!g.ok) return res.status(400).json({ error: g.error });
  await pool.query('UPDATE shops SET profile_photo_url=$1 WHERE id=$2', [g.value, barberId]);
  res.json({ ok: true, url: g.value });
});

// ─── PUT /api/media/barber/:id/photos ───
// Body: { urls: string[] }  — reemplaza todo el array (ordenado).
const MAX_WORK_PHOTOS = 10;
router.put('/barber/:id/photos', auth, async (req, res) => {
  const barberId = parseInt(req.params.id);
  if (!Number.isFinite(barberId)) return res.status(400).json({ error: 'id inválido' });
  const perm = await canEditBarber(req, barberId);
  if (!perm.ok) return res.status(perm.code).json({ error: perm.error });

  const urls = Array.isArray(req.body?.urls) ? req.body.urls : null;
  if (!urls) return res.status(400).json({ error: 'urls debe ser un array' });
  if (urls.length > MAX_WORK_PHOTOS) {
    return res.status(400).json({ error: `Máximo ${MAX_WORK_PHOTOS} fotos` });
  }
  for (const u of urls) {
    if (!cloud.isOurCloudinaryUrl(u)) return res.status(400).json({ error: 'URL inválida en la lista' });
  }
  await pool.query(
    'UPDATE shops SET work_photos=$1::jsonb WHERE id=$2',
    [JSON.stringify(urls), barberId]
  );
  res.json({ ok: true, urls });
});

module.exports = router;
