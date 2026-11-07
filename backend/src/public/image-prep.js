// Prepara una foto antes de subirla a Cloudinary (CRM y panel del barbero).
// - La achica a un máximo de 2000 px de lado: las fotos de celular (12 MP, 3-15 MB) quedan en
//   unos cientos de KB y suben rápido, sin que se note en el logo, la portada o el portfolio.
// - Si no se puede achicar (formato que el navegador no abre, ej. HEIC en Chrome) sube el original
//   si entra en el límite.
// - Errores con mensajes claros: "La foto pesa 12,4 MB…", "Ese archivo no es una imagen…".
(function () {
  const MAX_SIDE = 2000;                    // px del lado más largo
  const MAX_BYTES = 8 * 1024 * 1024;        // lo que aceptamos subir sin achicar
  const IMG_EXT = /\.(jpe?g|png|webp|gif|heic|heif|bmp|avif)$/i;

  const mb = n => (n / 1024 / 1024).toLocaleString('es-AR', { maximumFractionDigits: 1 }) + ' MB';

  function isImage(file) {
    return /^image\//.test(file.type || '') || (!file.type && IMG_EXT.test(file.name || ''));
  }

  async function decode(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (_) {}
      try { return await createImageBitmap(file); } catch (_) {}
    }
    // Respaldo: <img> (Safari viejo)
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }

  window.filoPrepareImage = async function (file) {
    if (!file) throw new Error('No elegiste ninguna foto');
    if (!isImage(file)) {
      throw new Error(`"${file.name || 'Ese archivo'}" no es una imagen. Elegí una foto (JPG o PNG).`);
    }
    let img;
    try { img = await decode(file); } catch (_) { img = null; }

    if (!img) {
      // El navegador no puede abrirla (ej. HEIC en una PC): subir la original si entra
      if (file.size <= MAX_BYTES) return file;
      throw new Error(`La foto pesa ${mb(file.size)} y este navegador no la puede achicar (formato ${(file.name || '').split('.').pop().toUpperCase() || 'desconocido'}). Probá con una en JPG o sacale una captura.`);
    }

    const w = img.width || img.naturalWidth, h = img.height || img.naturalHeight;
    const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
    // Ya es chica y liviana: subirla tal cual (no recomprimir de más)
    if (scale === 1 && file.size <= 1.5 * 1024 * 1024) { img.close?.(); return file; }

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    img.close?.();

    // PNG (logos con fondo transparente) sigue en PNG; el resto pasa a JPG.
    // Una foto guardada como PNG puede seguir pesando mucho: si pasa de 3 MB, a JPG también.
    const toBlob = (t, q) => new Promise(r => canvas.toBlob(r, t, q));
    let keepPng = file.type === 'image/png';
    let blob = keepPng ? await toBlob('image/png') : null;
    if (keepPng && (!blob || blob.size > 3 * 1024 * 1024)) keepPng = false;
    const type = keepPng ? 'image/png' : 'image/jpeg';
    if (!keepPng) blob = await toBlob('image/jpeg', 0.85);
    if (!blob) {
      if (file.size <= MAX_BYTES) return file;
      throw new Error(`La foto pesa ${mb(file.size)} y no se pudo achicar. Probá con otra.`);
    }
    // Si por algún motivo quedó más pesada que la original, quedarse con la original
    const out = blob.size < file.size || file.size > MAX_BYTES ? blob : file;
    if (out.size > MAX_BYTES) {
      throw new Error(`La foto pesa ${mb(out.size)} aun achicada (máximo 8 MB). Probá con otra.`);
    }
    const base = (file.name || 'foto').replace(/\.[^.]+$/, '');
    return out === file ? file : new File([out], `${base}.${keepPng ? 'png' : 'jpg'}`, { type });
  };

  // Convierte el error de Cloudinary/red en un mensaje que se entienda
  window.filoUploadError = function (data, status) {
    const m = (data && data.error && data.error.message) || '';
    if (/file size too large/i.test(m)) return 'La foto es demasiado pesada para subirla. Probá con otra.';
    if (/invalid image file|unsupported/i.test(m)) return 'Ese archivo no se pudo leer como imagen. Probá con una foto en JPG o PNG.';
    if (/stale request|timestamp/i.test(m)) return 'La hora de este equipo está mal y la subida se rechazó. Corregí la hora y volvé a intentar.';
    return m ? `No se pudo subir la foto: ${m}` : `No se pudo subir la foto (error ${status || 'de conexión'}). Probá de nuevo.`;
  };
})();
