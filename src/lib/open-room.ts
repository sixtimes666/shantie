import QRCode from "qrcode";
import { randomId, randomKey } from "@/lib/transfer-crypto";

export async function prepareRoom(origin: string): Promise<{
  id: string;
  key: string;
  href: string;
  qr: string;
}> {
  const id = randomId();
  const key = randomKey();
  const href = `${origin.replace(/\/$/, "")}/r/${id}#${key}`;
  const toSvg = QRCode.toString as unknown as (
    text: string,
    options: {
      type: "svg";
      margin: number;
      width: number;
      errorCorrectionLevel: "M";
      color: { dark: string; light: string };
    },
  ) => Promise<string>;
  const svg = await toSvg(href, {
    type: "svg",
    margin: 1,
    width: 280,
    errorCorrectionLevel: "M",
    color: { dark: "#1a1814", light: "#fffcf8" },
  });
  return {
    id,
    key,
    href,
    qr: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
  };
}
