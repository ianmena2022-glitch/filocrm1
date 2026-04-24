const router = require('express').Router();
const auth = require('../middleware/auth');
const wpp = require('../services/whatsapp');

router.post('/send', auth, async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'phone y message requeridos' });
    const cleanPhone = String(phone).replace(/\D/g, '');
    if (!cleanPhone) return res.status(400).json({ error: 'phone inválido' });
    await wpp.sendText(req.shopId, cleanPhone, message);
    res.json({ ok: true, phone: cleanPhone });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
