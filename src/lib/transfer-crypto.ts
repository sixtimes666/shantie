export type Payload =
  | { kind: "text"; text: string }
  | { kind: "image"; name: string; mime: string; data: string }
  | { kind: "file"; name: string; mime: string; data: string };

const ID_RE = /^[A-Za-z0-9_-]{20,48}$/;

export function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function bytesToB64Url(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

export function b64UrlToBytes(value: string): Uint8Array {
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  const b64 = value.replaceAll("-", "+").replaceAll("_", "/") + pad;
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function randomId(): string {
  return bytesToB64Url(randomBytes(16));
}

export function randomKey(): string {
  return bytesToB64Url(randomBytes(32));
}

export function isId(value: string): boolean {
  return ID_RE.test(value);
}

export function isAesKey(value: string): boolean {
  if (!ID_RE.test(value)) return false;
  try {
    return b64UrlToBytes(value).byteLength === 32;
  } catch {
    return false;
  }
}

function asPayload(value: unknown): Payload | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "text" && typeof record.text === "string") {
    return { kind: "text", text: record.text };
  }
  if (
    (record.kind === "image" || record.kind === "file") &&
    typeof record.name === "string" &&
    typeof record.mime === "string" &&
    typeof record.data === "string"
  ) {
    return { kind: record.kind, name: record.name, mime: record.mime, data: record.data };
  }
  return null;
}

async function importKey(keyB64: string): Promise<CryptoKey> {
  const raw = b64UrlToBytes(keyB64);
  return crypto.subtle.importKey("raw", toBuffer(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptPayload(
  keyB64: string,
  payload: Payload,
): Promise<{ iv: string; ciphertext: string }> {
  const key = await importKey(keyB64);
  const iv = randomBytes(12);
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: toBuffer(iv) }, key, plain);
  return { iv: bytesToB64Url(iv), ciphertext: bytesToB64Url(new Uint8Array(cipher)) };
}

export async function decryptPayload(
  keyB64: string,
  ivB64: string,
  ciphertextB64: string,
): Promise<Payload | null> {
  const key = await importKey(keyB64);
  const iv = b64UrlToBytes(ivB64);
  const cipher = b64UrlToBytes(ciphertextB64);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toBuffer(iv) },
    key,
    toBuffer(cipher),
  );
  const parsed: unknown = JSON.parse(new TextDecoder().decode(plain));
  return asPayload(parsed);
}

export async function loadPairKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const storageKey = "shantie-pair";
  const existing = sessionStorage.getItem(storageKey);
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as { publicKey?: unknown; privateKey?: unknown };
      if (typeof parsed.publicKey === "string" && typeof parsed.privateKey === "string") {
        return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
      }
    } catch {
      /* make a new pair */
    }
  }
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const saved = {
    publicKey: bytesToB64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    privateKey: bytesToB64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))),
  };
  sessionStorage.setItem(storageKey, JSON.stringify(saved));
  return saved;
}

export async function sharedAesKey(privateKeyB64: string, publicKeyB64: string): Promise<string> {
  const mine = await crypto.subtle.importKey(
    "pkcs8",
    toBuffer(b64UrlToBytes(privateKeyB64)),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const theirs = await crypto.subtle.importKey(
    "raw",
    toBuffer(b64UrlToBytes(publicKeyB64)),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: theirs }, mine, 256);
  const digest = await crypto.subtle.digest("SHA-256", bits);
  return bytesToB64Url(new Uint8Array(digest));
}
