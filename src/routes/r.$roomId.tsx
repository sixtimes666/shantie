import { ClientOnly, Link, createFileRoute } from "@tanstack/react-router";
import { RoomScreen } from "@/components/room-screen";

export const Route = createFileRoute("/r/$roomId")({ component: RoomPage });

function RoomPage() {
  const { roomId } = Route.useParams();
  return (
    <ClientOnly fallback={<RoomFallback />}>
      <RoomScreen roomId={roomId} />
    </ClientOnly>
  );
}

function RoomFallback() {
  return (
    <main className="shell">
      <Link to="/" className="font-display text-2xl tracking-wide">
        闪贴
      </Link>
      <p className="text-muted">正在打开这一次传送</p>
    </main>
  );
}
