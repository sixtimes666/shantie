create table if not exists devices (
  device_id text primary key,
  ip_hash text not null,
  pubkey text not null,
  room_id text not null,
  label text not null,
  last_seen timestamptz not null default now()
);

create index if not exists devices_ip_idx on devices (ip_hash, last_seen);
