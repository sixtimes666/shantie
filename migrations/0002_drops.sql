create table if not exists rooms (
  id text primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists rooms_expires_idx on rooms (expires_at);

create table if not exists ended (
  id text primary key,
  ended_at timestamptz not null default now()
);

create table if not exists presence (
  room_id text not null references rooms (id) on delete cascade,
  device_id text not null,
  last_seen timestamptz not null default now(),
  primary key (room_id, device_id)
);

create table if not exists drops (
  seq bigserial primary key,
  id text not null unique,
  room_id text not null references rooms (id) on delete cascade,
  device_id text not null,
  iv text not null,
  ciphertext text not null,
  created_at timestamptz not null default now()
);

create index if not exists drops_room_seq_idx on drops (room_id, seq);
