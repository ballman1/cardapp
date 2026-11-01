/**
 * Image ingest and deterministic photo checks (§3 Screen A/B, §11).
 * - Validates type by magic bytes (JPEG, PNG, HEIC/HEIF) and size.
 * - Keeps the original bytes immutable.
 * - Produces an analysis copy: EXIF-orientation applied, metadata (incl. GPS) stripped, JPEG.
 * - Measures resolution, blur (Laplacian variance), glare and exposure.
 * Never applies generative enhancement.
 */
import crypto from 'node:crypto';
import sharp from 'sharp';

export type ImageMime = 'image/jpeg' | 'image/png' | 'image/heic';

export function sniffImage(buf: Buffer): ImageMime | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis'].includes(brand)) return 'image/heic';
  }
  return null;
}

export const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

async function heicToJpeg(buf: Buffer): Promise<Buffer> {
  const mod: any = await import('heic-convert');
  const convert = mod.default ?? mod;
  const out = await convert({ buffer: buf, format: 'JPEG', quality: 0.95 });
  return Buffer.from(out);
}

export interface QualityReport {
  width: number;
  height: number;
  blurScore: number;
  glareFraction: number;
  meanLuminance: number;
  issues: { issue: string; detail: string }[];
}

export interface IngestResult {
  originalMime: ImageMime;
  analysisJpeg: Buffer;
  quality: QualityReport;
}

export async function ingestImage(buf: Buffer, maxPixels: number): Promise<IngestResult> {
  const mime = sniffImage(buf);
  if (!mime) throw new Error('Unsupported file type. Use JPEG, PNG or HEIC.');
  const decodable = mime === 'image/heic' ? await heicToJpeg(buf) : buf;
  const img = sharp(decodable, { limitInputPixels: maxPixels, failOn: 'error' }).rotate(); // apply EXIF orientation
  // Default sharp output drops all metadata (EXIF/GPS/XMP) — location never leaves the original.
  const analysisJpeg = await img.jpeg({ quality: 92, mozjpeg: false }).toBuffer();
  const quality = await assessQuality(analysisJpeg);
  return { originalMime: mime, analysisJpeg, quality };
}

export async function assessQuality(jpeg: Buffer): Promise<QualityReport> {
  const meta = await sharp(jpeg).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const W = 800;
  const { data, info } = await sharp(jpeg).resize({ width: W, height: W, fit: 'inside' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  let sum = 0;
  let bright = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i]!;
    if (data[i]! >= 250) bright++;
  }
  // Laplacian variance as a sharpness proxy.
  let lsum = 0;
  let lsq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * data[i]! - data[i - 1]! - data[i + 1]! - data[i - w]! - data[i + w]!;
      lsum += lap;
      lsq += lap * lap;
      n++;
    }
  }
  const mean = n ? lsum / n : 0;
  const blurScore = n ? lsq / n - mean * mean : 0;
  const glareFraction = bright / data.length;
  const meanLuminance = sum / data.length;
  const issues: QualityReport['issues'] = [];
  if (Math.min(width, height) < 700) issues.push({ issue: 'low_resolution', detail: `Short side ${Math.min(width, height)}px; use the camera's original resolution (≥1000px recommended).` });
  if (blurScore < 60) issues.push({ issue: 'blur', detail: `Sharpness score ${blurScore.toFixed(0)} is low; hold the camera steady and focus on the card.` });
  if (glareFraction > 0.03) issues.push({ issue: 'glare', detail: `${(glareFraction * 100).toFixed(1)}% of pixels are blown out; use diffuse light and tilt away from reflections.` });
  if (meanLuminance < 45) issues.push({ issue: 'too_dark', detail: 'Image is very dark.' });
  return { width, height, blurScore, glareFraction, meanLuminance, issues };
}

/** Labeled crop from a normalized bbox. Returns null for degenerate boxes. */
export async function cropRegion(jpeg: Buffer, bbox: { x: number; y: number; w: number; h: number }): Promise<Buffer | null> {
  const meta = await sharp(jpeg).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const pad = 0.02;
  const left = Math.max(0, Math.floor((bbox.x - pad) * W));
  const top = Math.max(0, Math.floor((bbox.y - pad) * H));
  const right = Math.min(W, Math.ceil((bbox.x + bbox.w + pad) * W));
  const bottom = Math.min(H, Math.ceil((bbox.y + bbox.h + pad) * H));
  if (right - left < 16 || bottom - top < 16) return null;
  return sharp(jpeg).extract({ left, top, width: right - left, height: bottom - top }).jpeg({ quality: 92 }).toBuffer();
}

/** Downscaled copy for model input (bounds cost); original analysis copy remains for display/crops. */
export async function modelInputDataUrl(jpeg: Buffer, maxSide = 2048): Promise<string> {
  const out = await sharp(jpeg).resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
  return `data:image/jpeg;base64,${out.toString('base64')}`;
}
