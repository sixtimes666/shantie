import { bytesToB64Url } from "@/lib/transfer-crypto";
import type { Payload } from "@/lib/transfer-crypto";

export const MAX_RAW_BYTES = 1_800_000;
const TEXT_LIMIT = 8000;

export function fileBaseName(name: string): string {
  const clean = name.split(/[/\\]/).pop()?.replaceAll("\0", "").trim() || "file";
  return clean.slice(0, 120);
}

export function assertText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("先写点什么");
  if (trimmed.length > TEXT_LIMIT) throw new Error("写短一点，太长了");
  return trimmed;
}

async function decodeImage(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      /* fall through to Image */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("这张照片打不开"));
      el.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function imageSize(source: ImageBitmap | HTMLImageElement): { width: number; height: number } {
  return { width: source.width, height: source.height };
}

async function renderJpeg(source: CanvasImageSource, width: number, height: number, quality: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("这张照片打不开");
  ctx.fillStyle = "#fffcf8";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", quality);
  });
  if (!blob) throw new Error("这张照片打不开");
  return blob;
}

async function compressImage(file: File): Promise<{ blob: Blob; name: string; mime: string }> {
  const source = await decodeImage(file);
  try {
    const size = imageSize(source);
    const passes = [
      [1600, 0.86],
      [1280, 0.8],
      [1024, 0.72],
      [800, 0.64],
    ] as const;
    let best: Blob | null = null;
    for (const [edge, quality] of passes) {
      const scale = Math.min(1, edge / Math.max(size.width, size.height, 1));
      const width = Math.max(1, Math.round(size.width * scale));
      const height = Math.max(1, Math.round(size.height * scale));
      best = await renderJpeg(source, width, height, quality);
      if (best.size <= MAX_RAW_BYTES) break;
    }
    if (!best || best.size > MAX_RAW_BYTES) throw new Error("这个内容太大了");
    const stem = fileBaseName(file.name).replace(/\.[^.]+$/, "") || "photo";
    return { blob: best, name: `${stem}.jpg`, mime: "image/jpeg" };
  } finally {
    if ("close" in source && typeof source.close === "function") source.close();
  }
}

async function blobToPayload(
  blob: Blob,
  name: string,
  mime: string,
  kind: "image" | "file",
): Promise<Payload> {
  if (blob.size <= 0) throw new Error("这个文件是空的");
  if (blob.size > MAX_RAW_BYTES) throw new Error("这个内容太大了");
  const data = bytesToB64Url(new Uint8Array(await blob.arrayBuffer()));
  return { kind, name, mime, data };
}

export async function fileToPayload(file: File): Promise<Payload> {
  const name = fileBaseName(file.name);
  const mime = file.type || "application/octet-stream";
  if (mime.startsWith("image/")) {
    try {
      const compressed = await compressImage(file);
      if (file.size > 0 && file.size < compressed.blob.size && file.size <= MAX_RAW_BYTES) {
        return blobToPayload(file, name, mime, "image");
      }
      return blobToPayload(compressed.blob, compressed.name, compressed.mime, "image");
    } catch (error) {
      if (error instanceof Error && error.message === "这个内容太大了") throw error;
      if (file.size > 0 && file.size <= MAX_RAW_BYTES) {
        return blobToPayload(file, name, mime, "file");
      }
      throw new Error("这张照片打不开");
    }
  }
  return blobToPayload(file, name, mime, "file");
}
