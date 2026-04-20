const router = require('express').Router();
const pool   = require('../db/pool');
const auth   = require('../middleware/auth');

// ── GET /api/products — listar productos activos ───────────────────────────
router.get('/', auth, async (req, res) => {
  // Los barberos ven los productos del shop padre
  const shopId = req.isBarber && req.parentShopId ? req.parentShopId : req.shopId;
  try {
    const result = await pool.query(
      `SELECT * FROM products
       WHERE shop_id=$1 AND active=TRUE
       ORDER BY categoria, nombre`,
      [shopId]
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/products/ventas — historial de ventas ─────────────────────────
router.get('/ventas', auth, async (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  try {
    const result = await pool.query(
      `SELECT ps.*, s.name AS barber_name
       FROM product_sales ps
       LEFT JOIN shops s ON s.id = ps.barber_id
       WHERE ps.shop_id=$1
       ORDER BY ps.sold_at DESC
       LIMIT $2`,
      [req.shopId, limit]
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/products — crear producto ────────────────────────────────────
router.post('/', auth, async (req, res) => {
  const { nombre, categoria, unidad, precio_costo, precio_venta, stock, stock_min, descripcion } = req.body;
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
  try {
    const result = await pool.query(
      `INSERT INTO products
         (shop_id, nombre, categoria, unidad, precio_costo, precio_venta, stock, stock_min, descripcion)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [req.shopId, nombre, categoria||'otros', unidad||'unidad',
       precio_costo||0, precio_venta||0, stock||0, stock_min||3, descripcion||null]
    );
    // Registrar movimiento inicial si hay stock
    if (parseInt(stock) > 0) {
      await pool.query(
        `INSERT INTO product_stock_movements
           (shop_id, product_id, tipo, cantidad, stock_antes, stock_despues, nota)
         VALUES ($1,$2,'entrada',$3,0,$3,'Stock inicial')`,
        [req.shopId, result.rows[0].id, parseInt(stock)]
      );
    }
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/products/:id — editar producto ────────────────────────────────
router.put('/:id', auth, async (req, res) => {
  const { nombre, categoria, unidad, precio_costo, precio_venta, stock, stock_min, descripcion } = req.body;
  try {
    // Si cambia el stock, registrar movimiento
    const prev = await pool.query(
      'SELECT stock FROM products WHERE id=$1 AND shop_id=$2',
      [req.params.id, req.shopId]
    );
    if (!prev.rows.length) return res.status(404).json({ error: 'Producto no encontrado' });

    const result = await pool.query(
      `UPDATE products SET
         nombre        = COALESCE($1, nombre),
         categoria     = COALESCE($2, categoria),
         unidad        = COALESCE($3, unidad),
         precio_costo  = COALESCE($4, precio_costo),
         precio_venta  = COALESCE($5, precio_venta),
         stock         = COALESCE($6, stock),
         stock_min     = COALESCE($7, stock_min),
         descripcion   = COALESCE($8, descripcion)
       WHERE id=$9 AND shop_id=$10
       RETURNING *`,
      [nombre||null, categoria||null, unidad||null,
       precio_costo!=null?precio_costo:null,
       precio_venta!=null?precio_venta:null,
       stock!=null?parseInt(stock):null,
       stock_min!=null?parseInt(stock_min):null,
       descripcion!=null?descripcion:null,
       req.params.id, req.shopId]
    );

    // Registrar ajuste si el stock cambió
    const stockAntes  = parseInt(prev.rows[0].stock);
    const stockDespues = stock != null ? parseInt(stock) : stockAntes;
    if (stockDespues !== stockAntes) {
      const diff = stockDespues - stockAntes;
      await pool.query(
        `INSERT INTO product_stock_movements
           (shop_id, product_id, tipo, cantidad, stock_antes, stock_despues, nota)
         VALUES ($1,$2,'ajuste',$3,$4,$5,'Edición manual')`,
        [req.shopId, req.params.id, Math.abs(diff), stockAntes, stockDespues]
      );
    }

    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/products/:id — desactivar producto ─────────────────────────
router.delete('/:id', auth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE products SET active=FALSE WHERE id=$1 AND shop_id=$2',
      [req.params.id, req.shopId]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/products/:id/sell — registrar venta ─────────────────────────
router.post('/:id/sell', auth, async (req, res) => {
  const { quantity, unit_price, payment_method, client_name, barber_id, barber_commission_pct } = req.body;
  const qty = parseInt(quantity) || 1;

  // Si el que vende es un barbero, la venta va al shop padre y el barbero se asigna automáticamente
  const isBarber  = req.isBarber && req.parentShopId;
  const shopId    = isBarber ? req.parentShopId : req.shopId;
  const autoBarberId   = isBarber ? req.shopId : (barber_id ? parseInt(barber_id) : null);
  const autoCommPct    = isBarber ? null : (barber_commission_pct ? parseFloat(barber_commission_pct) : null);

  try {
    // Verificar stock
    const prod = await pool.query(
      'SELECT nombre, stock, precio_venta, precio_costo FROM products WHERE id=$1 AND shop_id=$2 AND active=TRUE',
      [req.params.id, shopId]
    );
    if (!prod.rows.length) return res.status(404).json({ error: 'Producto no encontrado' });
    const p = prod.rows[0];
    if (qty > parseInt(p.stock)) {
      return res.status(400).json({ error: `Stock insuficiente. Disponible: ${p.stock}` });
    }

    const precio = parseFloat(unit_price) || parseFloat(p.precio_venta);
    const total  = precio * qty;
    const stockAntes   = parseInt(p.stock);
    const stockDespues = stockAntes - qty;

    // Resolver comisión del barbero
    // product_sale_commission_pct tiene prioridad; si es null, cae a barber_commission_pct
    let barberId = autoBarberId;
    let commPct  = autoCommPct;
    let barberName = null;
    if (barberId) {
      const barberRow = await pool.query(
        'SELECT name, barber_commission_pct, product_sale_commission_pct FROM shops WHERE id=$1',
        [barberId]
      );
      barberName = barberRow.rows[0]?.name || null;
      if (isBarber || commPct === null) {
        // Usar product_sale_commission_pct si está definido, si no barber_commission_pct
        const prodPct    = barberRow.rows[0]?.product_sale_commission_pct;
        const apptPct    = barberRow.rows[0]?.barber_commission_pct;
        commPct = prodPct != null ? parseFloat(prodPct) : parseFloat(apptPct || 0);
      }
    }
    commPct = commPct || 0;
    const commAmt = barberId ? (total * commPct / 100) : 0;

    // Registrar venta
    const venta = await pool.query(
      `INSERT INTO product_sales
         (shop_id, product_id, product_name, quantity, unit_price, total_price, payment_method, client_name,
          barber_id, barber_commission_pct, barber_commission_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [shopId, req.params.id, p.nombre, qty, precio, total,
       payment_method||'cash', client_name||null,
       barberId, commPct, commAmt]
    );

    // Descontar stock
    await pool.query(
      'UPDATE products SET stock=stock-$1 WHERE id=$2 AND shop_id=$3',
      [qty, req.params.id, shopId]
    );

    // Movimiento de stock
    await pool.query(
      `INSERT INTO product_stock_movements
         (shop_id, product_id, tipo, cantidad, stock_antes, stock_despues, nota)
       VALUES ($1,$2,'venta',$3,$4,$5,$6)`,
      [shopId, req.params.id, qty, stockAntes, stockDespues,
       `Venta a ${client_name||'cliente'}`]
    );

    // Registrar ingreso en caja
    const ventaDesc = `Venta ${p.nombre} x${qty}`
      + (client_name ? ' — ' + client_name : '')
      + (barberName  ? ' · ✂️ ' + barberName : '')
      + (commAmt > 0 ? ' · Comisión $' + commAmt.toFixed(0) : '');
    await pool.query(
      `INSERT INTO expenses (shop_id, amount, category, description, is_income, source_type, source_id, payment_method)
       VALUES ($1,$2,'ventas',$3,TRUE,'product_sale',$4,$5)`,
      [shopId, total, ventaDesc, venta.rows[0].id, payment_method || 'cash']
    );

    res.json({ ok: true, venta: venta.rows[0], stock_restante: stockDespues });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/products/:id/stock — ajuste de stock ────────────────────────
router.post('/:id/stock', auth, async (req, res) => {
  const { tipo, cantidad, nota } = req.body;
  const qty = parseInt(cantidad) || 0;
  const validTipos = ['entrada','salida','ajuste'];
  if (!validTipos.includes(tipo)) return res.status(400).json({ error: 'Tipo inválido' });

  try {
    const prod = await pool.query(
      'SELECT stock, nombre, precio_costo FROM products WHERE id=$1 AND shop_id=$2 AND active=TRUE',
      [req.params.id, req.shopId]
    );
    if (!prod.rows.length) return res.status(404).json({ error: 'Producto no encontrado' });
    const stockAntes = parseInt(prod.rows[0].stock);
    const prodNombre = prod.rows[0].nombre;
    const precioCosto = parseFloat(prod.rows[0].precio_costo) || 0;

    let stockDespues;
    if (tipo === 'entrada') stockDespues = stockAntes + qty;
    else if (tipo === 'salida') {
      if (qty > stockAntes) return res.status(400).json({ error: 'Stock insuficiente' });
      stockDespues = stockAntes - qty;
    } else {
      // ajuste manual — qty es el nuevo valor absoluto
      stockDespues = qty;
    }

    await pool.query(
      'UPDATE products SET stock=$1 WHERE id=$2 AND shop_id=$3',
      [stockDespues, req.params.id, req.shopId]
    );

    await pool.query(
      `INSERT INTO product_stock_movements
         (shop_id, product_id, tipo, cantidad, stock_antes, stock_despues, nota)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [req.shopId, req.params.id, tipo,
       tipo === 'ajuste' ? Math.abs(stockDespues - stockAntes) : qty,
       stockAntes, stockDespues, nota||null]
    );

    // Auto-registrar gasto en caja cuando es una entrada de stock
    let gastoRegistrado = false;
    if (tipo === 'entrada' && precioCosto > 0) {
      const montoGasto = precioCosto * qty;
      const descGasto = nota
        ? `Stock ${prodNombre} x${qty} — ${nota}`
        : `Stock ${prodNombre} x${qty}`;
      await pool.query(
        `INSERT INTO expenses (shop_id, amount, category, description, date)
         VALUES ($1, $2, 'insumos', $3, CURRENT_DATE)`,
        [req.shopId, montoGasto, descGasto]
      );
      gastoRegistrado = true;
    }

    res.json({ ok: true, stock_antes: stockAntes, stock_despues: stockDespues, gasto_registrado: gastoRegistrado });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
