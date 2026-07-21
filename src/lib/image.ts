/**
 * Client-side image downscaling.
 *
 * Uploaded photos are stored as Base64 in LocalStorage and re-decoded on every
 * render. A full-resolution phone photo (10–50 MB decoded) is a classic cause of
 * out-of-memory crashes in Android WebViews. We shrink every upload to a small,
 * capped JPEG before it ever touches storage, so memory and quota stay bounded.
 */
export async function downscaleImage(
  file: File,
  maxDim = 512,
  quality = 0.82,
): Promise<string> {
  const dataUrl = await readAsDataUrl(file);
  const img = await loadImage(dataUrl);

  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl; // Extremely unlikely; fall back to the original.
  ctx.drawImage(img, 0, 0, w, h);

  // JPEG keeps the payload tiny; a transparent source just gets a black matte,
  // which is fine for avatars. Fall back to the original on any encode error.
  try {
    return canvas.toDataURL('image/jpeg', quality);
  } catch {
    return dataUrl;
  }
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode the image.'));
    img.src = src;
  });
}
