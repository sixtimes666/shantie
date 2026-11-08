import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent, DragEvent, FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { destroyRoom, syncRoom } from "@/lib/transfer.functions";
import type { NearbyDevice, SyncResult } from "@/lib/transfer.functions";
import {
  b64UrlToBytes,
  decryptPayload,
  encryptPayload,
  isAesKey,
  isId,
  loadPairKeys,
  randomId,
  sharedAesKey,
} from "@/lib/transfer-crypto";
import type { Payload } from "@/lib/transfer-crypto";
import { assertText, fileToPayload } from "@/lib/pack-file";
import { HOST_ROOM_KEY, shareHref } from "@/lib/share-link";

type Phase = "boot" | "wait" | "live" | "down" | "ended" | "bad";
type Mode = "qr" | "search" | "pick" | "send";

type ViewItem = {
  id: string;
  direction: "in" | "out";
  status: "sending" | "sent" | "failed";
  error?: string;
  payload: Payload;
  href?: string;
  wire?: { iv: string; ciphertext: string };
};

type Pair = { publicKey: string; privateKey: string };

const KNOWN = new Set([
  "这个内容太大了",
  "这张照片打不开",
  "写短一点，太长了",
  "这个文件是空的",
  "先写点什么",
]);

function loadDeviceId(): string {
  const storageKey = "shantie-device";
  const existing = sessionStorage.getItem(storageKey);
  if (existing && isId(existing)) return existing;
  const id = randomId();
  sessionStorage.setItem(storageKey, id);
  return id;
}

function readKey(): string {
  if (typeof window === "undefined") return "";
  const raw = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}

function isHandset(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPod|Android.+Mobile|Windows Phone/i.test(navigator.userAgent);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function payloadBytes(payload: Payload): number {
  if (payload.kind === "text") return new TextEncoder().encode(payload.text).byteLength;
  const pad = payload.data.length % 4 === 0 ? 0 : 4 - (payload.data.length % 4);
  return Math.max(0, Math.floor(((payload.data.length + pad) * 3) / 4));
}

function friendly(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  return KNOWN.has(message) ? message : fallback;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "true");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.focus();
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function statusCopy(mode: Mode, phase: Phase): string {
  if (phase === "down") return "暂时连不上，正在重试";
  if (phase === "boot") return "正在连接";
  if (mode === "search") return "正在寻找同一网络的电脑";
  if (mode === "pick") return "同一网络里有几台电脑";
  if (phase === "live") return "已连上";
  if (mode === "send") return "正在连上电脑";
  return "用手机扫一扫";
}

export function RoomScreen({
  roomId,
  presetKey = "",
  initialQr = "",
  initialHref = "",
}: {
  roomId: string;
  presetKey?: string;
  initialQr?: string;
  initialHref?: string;
}) {
  const navigate = useNavigate();
  const sync = useServerFn(syncRoom);
  const destroy = useServerFn(destroyRoom);
  const syncRef = useRef(sync);
  const destroyRef = useRef(destroy);
  syncRef.current = sync;
  destroyRef.current = destroy;

  const key = presetKey || readKey();
  const linkOk = isId(roomId) && isAesKey(key);
  const handset = linkOk && isHandset();
  if (presetKey && typeof sessionStorage !== "undefined") {
    sessionStorage.setItem(HOST_ROOM_KEY, roomId);
  }
  const guest =
    linkOk &&
    typeof sessionStorage !== "undefined" &&
    sessionStorage.getItem(HOST_ROOM_KEY) !== roomId;
  const keyRef = useRef(key);
  const sendKeyRef = useRef(key);
  const targetRoomRef = useRef(roomId);
  const handsetRef = useRef(handset);
  const guestRef = useRef(guest);
  const deviceRef = useRef("");
  const pairRef = useRef<Pair | null>(null);
  const lanKeyRef = useRef<string[]>([]);
  const chosenRef = useRef("");
  const afterRef = useRef(0);
  const seenRef = useRef(new Set<string>());
  const failRef = useRef(new Map<string, number>());
  const closedRef = useRef(false);
  const urlsRef = useRef<string[]>([]);
  const queueRef = useRef(Promise.resolve());
  const qrPinned = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [phase, setPhase] = useState<Phase>(linkOk ? "wait" : "bad");
  const [mode, setMode] = useState<Mode>("qr");
  const [choices, setChoices] = useState<NearbyDevice[]>([]);
  const [items, setItems] = useState<ViewItem[]>([]);
  const [draft, setDraft] = useState("");
  const [showQr, setShowQr] = useState(true);
  const [qr, setQr] = useState(initialQr);
  const [shareUrl, setShareUrl] = useState(initialHref);
  const [copied, setCopied] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [destroying, setDestroying] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);

  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = queueRef.current.then(job, job);
    queueRef.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function materialize(payload: Payload): string | undefined {
    if (payload.kind === "text") return undefined;
    const bytes = b64UrlToBytes(payload.data);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const href = URL.createObjectURL(new Blob([copy], { type: payload.mime || "application/octet-stream" }));
    urlsRef.current.push(href);
    return href;
  }

  async function openCipher(iv: string, ciphertext: string): Promise<Payload | null> {
    const keys = [keyRef.current, ...lanKeyRef.current];
    for (const candidate of keys) {
      if (!candidate) continue;
      try {
        const payload = await decryptPayload(candidate, iv, ciphertext);
        if (payload) return payload;
      } catch {
        /* try the next key */
      }
    }
    return null;
  }

  async function ingest(result: SyncResult) {
    if (result.closed) {
      closedRef.current = true;
      setPhase("ended");
      return;
    }
    if (pairRef.current) {
      const keys: string[] = [];
      for (const peer of result.nearby) {
        try {
          keys.push(await sharedAesKey(pairRef.current.privateKey, peer.pubkey));
        } catch {
          /* skip a bad key */
        }
      }
      lanKeyRef.current = keys;
    }
    if (handsetRef.current && !guestRef.current && pairRef.current) {
      const computers = result.nearby.filter((peer) => peer.label === "电脑");
      if (computers.length === 1) {
        sendKeyRef.current = await sharedAesKey(pairRef.current.privateKey, computers[0].pubkey);
        targetRoomRef.current = computers[0].roomId;
        chosenRef.current = computers[0].deviceId;
        setMode("send");
        setPhase("live");
      } else if (computers.length > 1) {
        const chosen = computers.find((peer) => peer.deviceId === chosenRef.current);
        if (chosen) {
          sendKeyRef.current = await sharedAesKey(pairRef.current.privateKey, chosen.pubkey);
          targetRoomRef.current = chosen.roomId;
          setMode("send");
          setPhase("live");
        } else {
          targetRoomRef.current = roomId;
          sendKeyRef.current = keyRef.current;
          setChoices(computers);
          setMode("pick");
          setPhase("wait");
        }
      } else {
        targetRoomRef.current = roomId;
        sendKeyRef.current = keyRef.current;
        chosenRef.current = "";
        setMode("search");
        setPhase("wait");
      }
    } else {
      const online = result.peers > 0;
      setPhase(online ? "live" : "wait");
      if (online && !qrPinned.current) setShowQr(false);
    }

    const incoming: ViewItem[] = [];
    for (const message of result.messages) {
      if (seenRef.current.has(message.id)) {
        afterRef.current = Math.max(afterRef.current, message.seq);
        continue;
      }
      const payload = await openCipher(message.iv, message.ciphertext);
      if (!payload) {
        const fails = (failRef.current.get(message.id) ?? 0) + 1;
        failRef.current.set(message.id, fails);
        if (fails < 8) break;
        seenRef.current.add(message.id);
        afterRef.current = Math.max(afterRef.current, message.seq);
        continue;
      }
      seenRef.current.add(message.id);
      afterRef.current = Math.max(afterRef.current, message.seq);
      incoming.push({
        id: message.id,
        direction: "in",
        status: "sent",
        payload,
        href: materialize(payload),
      });
    }
    if (incoming.length > 0) setItems((current) => [...incoming.reverse(), ...current]);
  }

  useEffect(() => {
    sessionStorage.removeItem("shantie-boot");
    const phone = isHandset();
    handsetRef.current = phone;
    if (phone) setMode(guestRef.current ? "send" : "search");
  }, []);

  useEffect(() => {
    if (!linkOk || handset) return;
    const href = shareHref(roomId, keyRef.current);
    setShareUrl(href);
    let cancelled = false;
    QRCode.toDataURL(href, {
      margin: 1,
      width: 560,
      errorCorrectionLevel: "M",
      color: { dark: "#1a1814", light: "#fffcf8" },
    })
      .then((value) => {
        if (!cancelled) setQr(value);
      })
      .catch(() => {
        if (!cancelled) setQr("");
      });
    return () => {
      cancelled = true;
    };
  }, [handset, linkOk, roomId]);

  useEffect(() => {
    if (!linkOk) return;
    let stopped = false;
    let timer = 0;
    let running = false;
    const tick = async () => {
      if (stopped || closedRef.current || running) return;
      running = true;
      try {
        if (!deviceRef.current) deviceRef.current = loadDeviceId();
        if (!pairRef.current) pairRef.current = await loadPairKeys();
        const result = await enqueue(() =>
          syncRef.current({
            data: {
              roomId: targetRoomRef.current,
              deviceId: deviceRef.current,
              after: targetRoomRef.current === roomId ? afterRef.current : 9e15,
              outgoing: null,
              pubkey: pairRef.current?.publicKey ?? "",
              label: handsetRef.current ? "手机" : "电脑",
              homeRoomId: roomId,
            },
          }),
        );
        if (!stopped) await ingest(result);
      } catch {
        if (!stopped && !closedRef.current) setPhase("down");
      } finally {
        running = false;
      }
      if (stopped || closedRef.current) return;
      timer = window.setTimeout(() => void tick(), document.hidden ? 4000 : 1200);
    };
    void tick();
    const onVisible = () => {
      if (document.hidden || closedRef.current) return;
      window.clearTimeout(timer);
      void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      urlsRef.current.forEach((href) => URL.revokeObjectURL(href));
      urlsRef.current = [];
    };
  }, [linkOk, roomId]);

  async function transmit(item: ViewItem) {
    if (!item.wire) return;
    if (!deviceRef.current) deviceRef.current = loadDeviceId();
    if (!pairRef.current) pairRef.current = await loadPairKeys();
    setItems((current) =>
      current.map((entry) =>
        entry.id === item.id ? { ...entry, status: "sending", error: undefined } : entry,
      ),
    );
    try {
      const result = await enqueue(() =>
        syncRef.current({
          data: {
            roomId: targetRoomRef.current,
            deviceId: deviceRef.current,
            after: targetRoomRef.current === roomId ? afterRef.current : 9e15,
            outgoing: { id: item.id, iv: item.wire!.iv, ciphertext: item.wire!.ciphertext },
            pubkey: pairRef.current?.publicKey ?? "",
            label: handsetRef.current ? "手机" : "电脑",
            homeRoomId: roomId,
          },
        }),
      );
      await ingest(result);
      setItems((current) =>
        current.map((entry) => (entry.id === item.id ? { ...entry, status: "sent" } : entry)),
      );
    } catch (error) {
      setItems((current) =>
        current.map((entry) =>
          entry.id === item.id
            ? { ...entry, status: "failed", error: friendly(error, "没送出去") }
            : entry,
        ),
      );
    }
  }

  async function sendPayload(payload: Payload): Promise<boolean> {
    const wire = await encryptPayload(sendKeyRef.current, payload);
    if (wire.ciphertext.length > 3_400_000) throw new Error("这个内容太大了");
    const item: ViewItem = {
      id: randomId(),
      direction: "out",
      status: "sending",
      payload,
      href: materialize(payload),
      wire,
    };
    setItems((current) => [item, ...current]);
    await transmit(item);
    return true;
  }

  async function chooseComputer(peer: NearbyDevice) {
    if (!pairRef.current) pairRef.current = await loadPairKeys();
    chosenRef.current = peer.deviceId;
    sendKeyRef.current = await sharedAesKey(pairRef.current.privateKey, peer.pubkey);
    targetRoomRef.current = peer.roomId;
    setMode("send");
    setPhase("live");
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError("");
    try {
      const text = assertText(draft);
      setBusy(true);
      await sendPayload({ kind: "text", text });
      setDraft("");
    } catch (error) {
      setFormError(friendly(error, "没送出去"));
    } finally {
      setBusy(false);
    }
  }

  async function sendFiles(list: File[]) {
    setFormError("");
    setBusy(true);
    try {
      for (const file of list.slice(0, 6)) {
        try {
          const payload = await fileToPayload(file);
          await sendPayload(payload);
        } catch (error) {
          setFormError(friendly(error, "没能加上这个文件"));
        }
      }
    } finally {
      setBusy(false);
    }
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...event.clipboardData.files];
    if (files.length === 0) return;
    event.preventDefault();
    void sendFiles(files);
  }

  function onDrop(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    setDragOver(false);
    const files = [...event.dataTransfer.files];
    if (files.length) void sendFiles(files);
  }

  async function onCopyLink() {
    const ok = await copyText(shareUrl);
    setCopied(ok ? "link" : "fail");
    window.setTimeout(() => setCopied(""), 1600);
  }

  async function onCopyItem(id: string, text: string) {
    const ok = await copyText(text);
    setCopied(ok ? id : "fail");
    window.setTimeout(() => setCopied(""), 1600);
  }

  async function onDestroy() {
    setDestroying(true);
    closedRef.current = true;
    try {
      if (!handsetRef.current || guestRef.current) {
        await destroyRef.current({ data: { roomId } });
      }
    } catch {
      /* leave anyway */
    }
    await navigate({ to: "/" });
  }

  if (!linkOk || phase === "bad") {
    return (
      <main className="shell justify-center">
        <p className="font-display text-2xl tracking-wide">闪贴</p>
        <div className="flex flex-col gap-3">
          <h1 className="font-display text-3xl text-balance">这个链接不完整</h1>
          <p className="text-pretty text-muted">请重新扫电脑上的二维码。链接末尾那段不能丢掉。</p>
        </div>
        <Button className="w-full" onClick={() => void navigate({ to: "/" })}>
          回首页
        </Button>
      </main>
    );
  }

  if (phase === "ended") {
    return (
      <main className="shell justify-center">
        <p className="font-display text-2xl tracking-wide">闪贴</p>
        <div className="flex flex-col gap-3">
          <h1 className="font-display text-3xl text-balance">这次传送已经结束</h1>
          <p className="text-pretty text-muted">内容已经清掉。要再传一次，重新打开就好。</p>
        </div>
        <Button className="w-full" onClick={() => void navigate({ to: "/" })}>
          再开一次
        </Button>
      </main>
    );
  }

  if (mode === "search") {
    return (
      <main className="shell justify-center">
        <p className="font-display text-2xl tracking-wide">闪贴</p>
        <h1 className="font-display text-3xl text-balance">
          {phase === "down" ? "暂时连不上，正在重试" : "正在寻找同一网络的电脑"}
        </h1>
        <p className="text-pretty text-muted">也可以用相机扫电脑屏幕上的二维码。</p>
      </main>
    );
  }

  if (mode === "pick") {
    return (
      <main className="shell justify-center">
        <p className="font-display text-2xl tracking-wide">闪贴</p>
        <h1 className="font-display text-3xl text-balance">发到哪台电脑</h1>
        <div className="flex flex-col gap-2">
          {choices.map((peer, index) => (
            <Button key={peer.deviceId} className="w-full" onClick={() => void chooseComputer(peer)}>
              电脑 {index + 1}
            </Button>
          ))}
        </div>
      </main>
    );
  }

  const sending = mode === "send";
  const status = statusCopy(mode, phase);

  return (
    <main
      className="shell"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => event.preventDefault()}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-display text-2xl tracking-wide">{sending ? "发到电脑" : "闪贴"}</p>
        {sending ? (
          <Button variant="quiet" onClick={() => void onDestroy()} disabled={destroying}>
            结束
          </Button>
        ) : confirming ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted">确定销毁？</span>
            <Button onClick={() => void onDestroy()} disabled={destroying}>
              销毁
            </Button>
            <Button variant="quiet" onClick={() => setConfirming(false)} disabled={destroying}>
              取消
            </Button>
          </div>
        ) : (
          <Button variant="quiet" onClick={() => setConfirming(true)}>
            销毁
          </Button>
        )}
      </header>

      <p className="flex items-center gap-2 text-sm text-muted" aria-live="polite">
        {phase === "live" ? <span className="size-2 rounded-full bg-live" aria-hidden="true" /> : null}
        {status}
      </p>

      {!sending && showQr ? (
        <section className="rounded-card border border-line bg-sheet p-4">
          <div className="overflow-hidden rounded-control bg-sheet">
            {qr ? (
              <img src={qr} alt="用手机扫描这个二维码" className="mx-auto w-full max-w-64" />
            ) : (
              <div className="flex min-h-64 items-center justify-center text-sm text-muted">正在生成二维码</div>
            )}
          </div>
          <p className="mt-4 text-center text-pretty text-muted">
            同一网络的手机会自动连上。不在同一网络，把链接复制到手机的 Safari 或 Chrome 里打开。
          </p>
          <p className="mt-2 text-center text-pretty text-sm text-faint">
            用微信或 Grok 扫这个码，会跳去登录。请用手机浏览器打开。
          </p>
          <Button variant="line" className="mt-4 w-full" onClick={() => void onCopyLink()}>
            {copied === "link" ? "已复制" : "复制链接"}
          </Button>
          {copied === "fail" ? (
            <input
              readOnly
              value={shareUrl}
              onFocus={(event) => event.currentTarget.select()}
              aria-label="传送链接"
              className="mt-3 min-h-11 w-full rounded-control border border-line bg-paper px-3 text-sm text-ink"
            />
          ) : null}
        </section>
      ) : null}

      {!sending && !showQr ? (
        <Button
          variant="quiet"
          onClick={() => {
            qrPinned.current = true;
            setShowQr(true);
          }}
        >
          二维码
        </Button>
      ) : null}

      {items.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li key={item.id}>
              <ItemCard
                item={item}
                copied={copied === item.id}
                onCopy={onCopyItem}
                onRetry={(entry) => void transmit(entry)}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {sending || mode === "qr" ? (
        <form
          className={`rounded-card border bg-sheet p-4 ${dragOver ? "border-ink" : "border-line"}`}
          onSubmit={(event) => void onSubmit(event)}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <label className="sr-only" htmlFor="draft">
            要发送的文字
          </label>
          <textarea
            id="draft"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onPaste={onPaste}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            maxLength={8000}
            placeholder={sending ? "写点什么，发到电脑" : "也可以从这里发回去"}
            className="min-h-32 w-full resize-none rounded-control border border-line bg-sheet px-3 py-3 text-base text-ink outline-none placeholder:text-faint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          />
          <div className="mt-3 flex flex-col gap-2">
            <Button type="submit" className="w-full" disabled={busy || !draft.trim()}>
              {busy ? "发送中" : "发送"}
            </Button>
            <Button variant="line" className="w-full" disabled={busy} onClick={() => fileRef.current?.click()}>
              照片或文件
            </Button>
          </div>
          <input
            ref={fileRef}
            type="file"
            tabIndex={-1}
            aria-hidden="true"
            className="sr-only"
            onChange={(event) => {
              const list = event.target.files;
              if (list && list.length > 0) void sendFiles([...list]);
              event.target.value = "";
            }}
          />
          {formError ? (
            <p role="alert" className="mt-3 text-sm text-danger">
              {formError}
            </p>
          ) : sending ? (
            <p className="mt-3 text-sm text-faint">照片会自动缩小。</p>
          ) : null}
        </form>
      ) : null}
    </main>
  );
}

function labelFor(item: ViewItem): string {
  if (item.direction === "in") return "收到";
  if (item.status === "sending") return "发送中";
  if (item.status === "failed") return "没送出";
  return "已发出";
}

function ItemCard({
  item,
  copied,
  onCopy,
  onRetry,
}: {
  item: ViewItem;
  copied: boolean;
  onCopy: (id: string, text: string) => void;
  onRetry: (item: ViewItem) => void;
}) {
  const name = item.payload.kind === "text" ? "" : item.payload.name;
  return (
    <article className="item-in rounded-card border border-line bg-sheet p-4">
      <p className="text-sm text-muted">{labelFor(item)}</p>
      {item.payload.kind === "text" && item.payload.text ? (
        <p className="mt-2 whitespace-pre-wrap break-words">{item.payload.text}</p>
      ) : null}
      {item.payload.kind === "image" && item.href ? (
        <img
          src={item.href}
          alt={item.payload.name}
          className="mt-3 max-h-64 w-full rounded-control object-contain"
        />
      ) : null}
      {item.payload.kind !== "text" ? (
        <p className="mt-3 truncate text-sm text-muted">
          {name}
          <span className="tabular-nums"> · {formatSize(payloadBytes(item.payload))}</span>
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {item.payload.kind === "text" && item.payload.text ? (
          <Button variant="line" onClick={() => onCopy(item.id, item.payload.kind === "text" ? item.payload.text : "")}>
            {copied ? "已复制" : "复制"}
          </Button>
        ) : null}
        {item.href && item.payload.kind !== "text" ? (
          <a
            href={item.href}
            download={item.payload.name}
            className="press inline-flex min-h-11 items-center justify-center rounded-control border border-line bg-sheet px-4 text-base font-medium text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            保存
          </a>
        ) : null}
        {item.status === "failed" && item.direction === "out" ? (
          <Button variant="line" onClick={() => onRetry(item)}>
            再试一次
          </Button>
        ) : null}
      </div>
      {item.error ? <p className="mt-2 text-sm text-danger">{item.error}</p> : null}
    </article>
  );
}
