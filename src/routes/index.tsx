import { createFileRoute } from "@tanstack/react-router";
import { RoomScreen } from "@/components/room-screen";
import { prepareRoom } from "@/lib/open-room";

async function pageOrigin(): Promise<string> {
  if (typeof window !== "undefined") return window.location.origin;
  const configured = process.env.VITE_PUBLIC_HOSTNAME?.trim();
  if (configured) {
    return `https://${configured.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  }
  const { getRequest } = await import("@tanstack/react-start/server");
  const request = getRequest();
  const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
  if (forwarded && !forwarded.endsWith(".vercel.app")) return `${proto}://${forwarded}`;
  return new URL(request.url).origin;
}

export const Route = createFileRoute("/")({
  loader: async () => prepareRoom(await pageOrigin()),
  component: Home,
});

function Home() {
  const room = Route.useLoaderData();
  return (
    <RoomScreen roomId={room.id} presetKey={room.key} initialQr={room.qr} initialHref={room.href} />
  );
}
