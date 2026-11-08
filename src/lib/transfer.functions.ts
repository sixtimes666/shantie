import { createServerFn } from "@tanstack/react-start";

const ID_RE = /^[A-Za-z0-9_-]{20,48}$/;
const IV_RE = /^[A-Za-z0-9_-]{16}$/;
const MAX_CIPHER = 3_400_000;

type Outgoing = { id: string; iv: string; ciphertext: string };
type Announce = { pubkey: string; label: "电脑" | "手机"; homeRoomId: string };

export type SyncInput = {
  roomId: string;
  deviceId: string;
  after: number;
  outgoing: Outgoing | null;
  announce: Announce | null;
};

export type SyncMessage = {
  id: string;
  iv: string;
  ciphertext: string;
  seq: number;
};

export type NearbyDevice = {
  deviceId: string;
  pubkey: string;
  roomId: string;
  label: "电脑" | "手机";
};

export type SyncResult = {
  closed: boolean;
  peers: number;
  messages: SyncMessage[];
  nearby: NearbyDevice[];
};

function isToken(value: string, pattern: RegExp): boolean {
  return pattern.test(value);
}

function isB64Url(value: string): boolean {
  if (value.length === 0 || value.length > MAX_CIPHER) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const ok =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 45 ||
      code === 95;
    if (!ok) return false;
  }
  return true;
}

function readSync(input: unknown): SyncInput {
  if (!input || typeof input !== "object") throw new Error("无法同步");
  const record = input as Record<string, unknown>;
  if (typeof record.roomId !== "string" || !isToken(record.roomId, ID_RE)) throw new Error("无法同步");
  if (typeof record.deviceId !== "string" || !isToken(record.deviceId, ID_RE)) {
    throw new Error("无法同步");
  }
  if (typeof record.after !== "number" || !Number.isFinite(record.after) || record.after < 0) {
    throw new Error("无法同步");
  }
  let outgoing: Outgoing | null = null;
  if (record.outgoing != null) {
    if (typeof record.outgoing !== "object") throw new Error("无法同步");
    const message = record.outgoing as Record<string, unknown>;
    if (typeof message.id !== "string" || !isToken(message.id, ID_RE)) throw new Error("无法同步");
    if (typeof message.iv !== "string" || !isToken(message.iv, IV_RE)) throw new Error("无法同步");
    if (typeof message.ciphertext !== "string" || !isB64Url(message.ciphertext)) {
      throw new Error("这个内容太大了");
    }
    outgoing = { id: message.id, iv: message.iv, ciphertext: message.ciphertext };
  }
  let announce: Announce | null = null;
  if (
    typeof record.pubkey === "string" &&
    isB64Url(record.pubkey) &&
    record.pubkey.length >= 80 &&
    record.pubkey.length <= 120 &&
    (record.label === "电脑" || record.label === "手机") &&
    typeof record.homeRoomId === "string" &&
    isToken(record.homeRoomId, ID_RE)
  ) {
    announce = { pubkey: record.pubkey, label: record.label, homeRoomId: record.homeRoomId };
  }
  return {
    roomId: record.roomId,
    deviceId: record.deviceId,
    after: Math.floor(record.after),
    outgoing,
    announce,
  };
}

function readRoom(input: unknown): { roomId: string } {
  if (!input || typeof input !== "object") throw new Error("无法同步");
  const roomId = (input as Record<string, unknown>).roomId;
  if (typeof roomId !== "string" || !isToken(roomId, ID_RE)) throw new Error("无法同步");
  return { roomId };
}

function asNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

async function callerIp(): Promise<string> {
  try {
    const { getRequestIP } = await import("@tanstack/react-start/server");
    return getRequestIP({ xForwardedFor: true }) || getRequestIP() || "local";
  } catch {
    return "local";
  }
}

function hashIp(ip: string): Promise<string> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip)).then((digest) => {
    const bytes = new Uint8Array(digest);
    let hex = "";
    for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
    return hex;
  });
}

export const syncRoom = createServerFn({ method: "POST" })
  .validator(readSync)
  .handler(async ({ data }): Promise<SyncResult> => {
    const { getSql } = await import("@/lib/db");
    const sql = await getSql();
    const { roomId, deviceId, after, outgoing, announce } = data;
    try {
      await sql`delete from rooms where expires_at <= now()`;
      await sql`delete from ended where ended_at < now() - interval '1 day'`;
      await sql`delete from devices where last_seen < now() - interval '30 seconds'`;

      const closed = await sql<{ id: string }>`select id from ended where id = ${roomId}`;
      if (closed.length > 0) {
        await sql`delete from rooms where id = ${roomId}`;
        return { closed: true, peers: 0, messages: [], nearby: [] };
      }

      await sql`
        insert into rooms (id, expires_at)
        values (${roomId}, now() + interval '15 minutes')
        on conflict (id) do update set expires_at = now() + interval '15 minutes'
      `;
      await sql`
        insert into presence (room_id, device_id, last_seen)
        values (${roomId}, ${deviceId}, now())
        on conflict (room_id, device_id) do update set last_seen = now()
      `;
      if (outgoing) {
        await sql`
          insert into drops (id, room_id, device_id, iv, ciphertext)
          values (${outgoing.id}, ${roomId}, ${deviceId}, ${outgoing.iv}, ${outgoing.ciphertext})
          on conflict (id) do nothing
        `;
        await sql`
          delete from drops
          where room_id = ${roomId}
            and seq not in (
              select seq from drops where room_id = ${roomId} order by seq desc limit 40
            )
        `;
      }

      const peerRows = await sql<{ n: unknown }>`
        select count(*) as n from presence
        where room_id = ${roomId}
          and device_id <> ${deviceId}
          and last_seen > now() - interval '8 seconds'
      `;
      const heads = await sql<{ id: string; bytes: unknown }>`
        select id, char_length(ciphertext) as bytes
        from drops
        where room_id = ${roomId}
          and device_id <> ${deviceId}
          and seq > ${after}
        order by seq asc
        limit 12
      `;
      const picked: string[] = [];
      let total = 0;
      for (const head of heads) {
        const bytes = asNumber(head.bytes);
        if (picked.length > 0 && total + bytes > 2_000_000) break;
        picked.push(head.id);
        total += bytes;
        if (picked.length === 8) break;
      }
      const messages: SyncMessage[] = [];
      for (const id of picked) {
        const row = await sql<{ id: string; iv: string; ciphertext: string; seq: unknown }>`
          select id, iv, ciphertext, seq from drops where id = ${id}
        `;
        const item = row[0];
        if (!item) continue;
        messages.push({
          id: item.id,
          iv: item.iv,
          ciphertext: item.ciphertext,
          seq: asNumber(item.seq),
        });
      }
      let nearby: NearbyDevice[] = [];
      if (announce) {
        const ipHash = await hashIp(await callerIp());
        await sql`
          insert into devices (device_id, ip_hash, pubkey, room_id, label, last_seen)
          values (${deviceId}, ${ipHash}, ${announce.pubkey}, ${announce.homeRoomId}, ${announce.label}, now())
          on conflict (device_id) do update set
            ip_hash = excluded.ip_hash,
            pubkey = excluded.pubkey,
            room_id = excluded.room_id,
            label = excluded.label,
            last_seen = now()
        `;
        const rows = await sql<{ device_id: string; pubkey: string; room_id: string; label: string }>`
          select device_id, pubkey, room_id, label
          from devices
          where ip_hash = ${ipHash}
            and device_id <> ${deviceId}
            and last_seen > now() - interval '8 seconds'
          order by last_seen desc
          limit 8
        `;
        nearby = rows.flatMap((row) =>
          row.label === "电脑" || row.label === "手机"
            ? [{ deviceId: row.device_id, pubkey: row.pubkey, roomId: row.room_id, label: row.label }]
            : [],
        );
      }
      return {
        closed: false,
        peers: asNumber(peerRows[0]?.n),
        messages,
        nearby,
      };
    } catch (error) {
      if (error instanceof Error && error.message === "这个内容太大了") throw error;
      console.error(error);
      throw new Error("无法同步");
    }
  });

export const destroyRoom = createServerFn({ method: "POST" })
  .validator(readRoom)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { getSql } = await import("@/lib/db");
    const sql = await getSql();
    await sql`delete from rooms where id = ${data.roomId}`;
    await sql`
      insert into ended (id, ended_at)
      values (${data.roomId}, now())
      on conflict (id) do update set ended_at = now()
    `;
    return { ok: true };
  });
