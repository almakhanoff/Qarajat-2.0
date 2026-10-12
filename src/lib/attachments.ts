import type { Attachment } from '../domain/types';
import { newId } from '../domain/ids';

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_STORED_BYTES = 2 * 1024 * 1024;

export class FileError extends Error {}

export function validateImageFile(file: File): void {
  if (!IMAGE_TYPES.includes(file.type)) throw new FileError('Допустимы только JPG, PNG или WEBP');
  if (file.size > MAX_UPLOAD_BYTES) throw new FileError('Файл больше 10 МБ');
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new FileError('Не удалось прочитать изображение'));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new FileError('Ошибка сжатия'))), type, quality));
}

/** Уменьшает изображение (по длинной стороне) и пережимает в JPEG/WEBP, чтобы не переполнять хранилище. */
export async function compressImage(file: Blob, maxSide = 1600, crop?: { x: number; y: number; width: number; height: number }): Promise<Blob> {
  const img = await loadImage(file);
  const sx = crop?.x ?? 0;
  const sy = crop?.y ?? 0;
  const sw = crop?.width ?? img.naturalWidth;
  const sh = crop?.height ?? img.naturalHeight;
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new FileError('Canvas недоступен');
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  let quality = 0.85;
  let blob = await canvasToBlob(canvas, 'image/jpeg', quality);
  while (blob.size > MAX_STORED_BYTES && quality > 0.4) {
    quality -= 0.15;
    blob = await canvasToBlob(canvas, 'image/jpeg', quality);
  }
  if (blob.size > MAX_STORED_BYTES) throw new FileError('Изображение слишком большое даже после сжатия');
  return blob;
}

export async function makeAttachment(file: File, opts?: { maxSide?: number; crop?: { x: number; y: number; width: number; height: number } }): Promise<Attachment> {
  validateImageFile(file);
  const blob = await compressImage(file, opts?.maxSide, opts?.crop);
  return { id: newId(), name: file.name.replace(/\.[^.]+$/, '') + '.jpg', type: blob.type, size: blob.size, blob, createdAt: Date.now() };
}
