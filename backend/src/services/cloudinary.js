// Cloudinary helpers sin SDK (ahorramos dependencia).
// Flujo: el server firma params → el frontend sube el archivo directo a Cloudinary.
// Env vars requeridas: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET

const crypto = require('crypto');

const CLOUD = process.env.CLOUDINARY_CLOUD_NAME || '';
const KEY   = process.env.CLOUDINARY_API_KEY    || '';
const SECRET= process.env.CLOUDINARY_API_SECRET || '';

function isConfigured() {
  return Boolean(CLOUD && KEY && SECRET);
}

/**
 * Devuelve params firmados para que el frontend suba un archivo directo a Cloudinary.
 * @param {{ folder?: string, publicId?: string }} opts
 */
function signUploadParams(opts = {}) {
  if (!isConfigured()) throw new Error('Cloudinary no está configurado (faltan CLOUDINARY_* env vars)');
  const timestamp = Math.floor(Date.now() / 1000);
  // Params que se incluyen en la firma (orden alfabético, sin api_key/signature/file/resource_type).
  const params = {};
  if (opts.folder)    params.folder    = opts.folder;
  if (opts.publicId)  params.public_id = opts.publicId;
  params.timestamp = timestamp;

  // Firma: SHA1(sortedParams + api_secret). Formato: k=v&k=v...&secret
  const toSign = Object.keys(params)
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
  const signature = crypto.createHash('sha1').update(toSign + SECRET).digest('hex');

  return {
    cloudName:  CLOUD,
    apiKey:     KEY,
    timestamp,
    signature,
    folder:     opts.folder     || null,
    publicId:   opts.publicId   || null,
    uploadUrl:  `https://api.cloudinary.com/v1_1/${CLOUD}/image/upload`,
  };
}

/**
 * Valida que una URL devuelta por el cliente efectivamente venga de nuestra cuenta de Cloudinary.
 * Previene que el frontend guarde URLs arbitrarias en nuestra DB.
 */
function isOurCloudinaryUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (!CLOUD) return false;
  const expected = `https://res.cloudinary.com/${CLOUD}/`;
  return url.startsWith(expected);
}

module.exports = { isConfigured, signUploadParams, isOurCloudinaryUrl };
