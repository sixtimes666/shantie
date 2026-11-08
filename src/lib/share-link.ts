import { isAesKey, isId } from "@/lib/transfer-crypto";
import { previewPathPrefix } from "@/lib/preview-path-prefix";

export const HOST_ROOM_KEY = "shantie-host-room";

export function shareHref(roomId: string, key: string): string {
  const url = new URL(window.location.href);
  const prefix = previewPathPrefix(url.hostname, url.pathname) ?? "";
  url.pathname = `${prefix}/r/${roomId}`;
  url.search = "";
  url.hash = key;
  return url.toString();
}

export function assignRoom(roomId: string, key: string, replace = false) {
  const href = shareHref(roomId, key);
  if (replace) window.location.replace(href);
  else window.location.assign(href);
}

export function parseShareTarget(
  raw: string,
): { href: string } | { roomId: string; key: string } | null {
  const text = raw.trim();
  const hashAt = text.indexOf("#");
  if (hashAt < 0) return null;
  let key = text.slice(hashAt + 1).trim();
  try {
    key = decodeURIComponent(key);
  } catch {
    return null;
  }
  if (!isAesKey(key)) return null;
  const before = text.slice(0, hashAt);
  const match = before.match(/\/r\/([A-Za-z0-9_-]{20,48})\/?$/);
  if (!match || !isId(match[1])) return null;
  if (/^https?:\/\//i.test(text)) return { href: text };
  return { roomId: match[1], key };
}
