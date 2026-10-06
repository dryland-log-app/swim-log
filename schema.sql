-- =========================================================
-- 수영 훈련 로그 DB 스키마 (Supabase / Postgres)
-- Supabase SQL Editor에 이 파일 전체를 붙여넣고 Run 하세요.
-- 원본 schema.sql에 보안 규칙(RLS)과 필요한 확장을 추가한 버전입니다.
-- =========================================================

create extension if not exists pgcrypto;

-- Supabase는 auth.users를 기본 제공하므로, 별도 users 테이블 없이
-- auth.users.id를 그대로 참조합니다.

-- ---------------------------------------------------------
-- 1. sessions: 하루 단위 훈련 세션
-- ---------------------------------------------------------
create table sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  session_date  date not null,
  weekday       text,                     -- '월'..'일' (표시용, date에서 계산 가능하지만 원본 라벨 보존용으로 저장)
  location      text,                     -- '충무', '성남' 등
  pool_length   int  default 25,          -- 25 or 50
  condition_note text,                    -- 컨디션/특이사항 메모
  total_distance int,                     -- 명시된 경우만 (예: 1200)
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
create index idx_sessions_user_date on sessions(user_id, session_date desc);

-- ---------------------------------------------------------
-- 2. sets: 세션 내 훈련 세트 (웜업/메인/스프린트 등)
-- ---------------------------------------------------------
create type set_type as enum ('warmup', 'main', 'sprint', 'underwater', 'dolphin', 'down', 'other');
create type stroke_type as enum ('free', 'fly', 'back', 'breast', 'im', 'mixed', 'unknown');
create type interval_mode as enum ('fixed_interval', 'fixed_rest', 'pace_only', 'none');

create table sets (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references sessions(id) on delete cascade,
  order_index     int not null,           -- 세션 내 세트 순서
  set_type        set_type not null default 'main',
  stroke          stroke_type not null default 'unknown',
  distance        int,                    -- 25/50/75/100 (랩당 거리)
  rep_count       int,                    -- 계획된 반복 횟수 (예: x8) — 실제 랩 수와 다를 수 있음
  interval_mode   interval_mode not null default 'none',
  interval_or_pace_sec numeric,           -- 인터벌/페이스 초 단위 (예: 1'40" -> 100)
  raw_header      text,                   -- 원본 헤더 텍스트 보존 (예: "50m x 8 (1'40")")
  note            text
);
create index idx_sets_session on sets(session_id, order_index);

-- ---------------------------------------------------------
-- 3. laps: 세트 내 실제 개별 기록
-- ---------------------------------------------------------
create table laps (
  id              uuid primary key default gen_random_uuid(),
  set_id          uuid not null references sets(id) on delete cascade,
  rep_no          int not null,           -- 세트 내 순번
  time_sec        numeric,                -- 기록 (초 단위로 정규화, 예: 1'06.89 -> 66.89)
  rest_sec        numeric,                -- 다음 랩까지의 휴식 (초 단위)
  stroke_override stroke_type,            -- 세트 내에서 종목이 섞이는 경우 (자/접 교차 등)
  stroke_count    int,                    -- 스트로크 수
  is_missing      boolean default false,  -- 기록 누락 표시 (예: 워치 이탈)
  needs_review    boolean default false,  -- 파서가 확신하지 못한 항목
  note            text,                   -- "핑거워치 빠져서 다시 잼" 등 원본 메모
  raw_text        text                    -- 원본 텍스트 라인 보존
);
create index idx_laps_set on laps(set_id, rep_no);

-- ---------------------------------------------------------
-- 4. 편의 뷰: 종목/거리별 최고 기록(PB) 조회
-- security_invoker: 뷰를 조회하는 사람의 권한(RLS)을 그대로 적용 — 없으면
-- 뷰 소유자 권한으로 실행돼 다른 사람 기록까지 보일 수 있음
-- ---------------------------------------------------------
create view personal_bests
with (security_invoker = true)
as
select
  se.user_id,
  st.stroke,
  st.distance,
  min(l.time_sec) as best_time_sec,
  (array_agg(se.session_date order by l.time_sec asc))[1] as best_date
from laps l
join sets st on l.set_id = st.id
join sessions se on st.session_id = se.id
where l.time_sec is not null and l.is_missing = false
group by se.user_id, st.stroke, st.distance;

-- ---------------------------------------------------------
-- 5. 자동 갱신: sessions.updated_at
-- ---------------------------------------------------------
create function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_sessions_updated_at
  before update on sessions
  for each row execute function set_updated_at();

-- =========================================================
-- 6. RLS(행 단위 보안): 로그인한 본인의 기록만 보고 쓸 수 있게 제한
-- 이게 없으면 anon 키를 쓰는 누구나 모든 사용자의 기록을 읽고 쓸 수 있습니다.
-- =========================================================
alter table sessions enable row level security;
alter table sets     enable row level security;
alter table laps     enable row level security;

create policy "본인 세션만 조회" on sessions
  for select using (auth.uid() = user_id);
create policy "본인 세션만 추가" on sessions
  for insert with check (auth.uid() = user_id);
create policy "본인 세션만 수정" on sessions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "본인 세션만 삭제" on sessions
  for delete using (auth.uid() = user_id);

create policy "본인 세트만 조회" on sets
  for select using (exists (select 1 from sessions se where se.id = sets.session_id and se.user_id = auth.uid()));
create policy "본인 세트만 추가" on sets
  for insert with check (exists (select 1 from sessions se where se.id = sets.session_id and se.user_id = auth.uid()));
create policy "본인 세트만 수정" on sets
  for update using (exists (select 1 from sessions se where se.id = sets.session_id and se.user_id = auth.uid()))
             with check (exists (select 1 from sessions se where se.id = sets.session_id and se.user_id = auth.uid()));
create policy "본인 세트만 삭제" on sets
  for delete using (exists (select 1 from sessions se where se.id = sets.session_id and se.user_id = auth.uid()));

create policy "본인 랩만 조회" on laps
  for select using (exists (
    select 1 from sets st join sessions se on se.id = st.session_id
    where st.id = laps.set_id and se.user_id = auth.uid()
  ));
create policy "본인 랩만 추가" on laps
  for insert with check (exists (
    select 1 from sets st join sessions se on se.id = st.session_id
    where st.id = laps.set_id and se.user_id = auth.uid()
  ));
create policy "본인 랩만 수정" on laps
  for update using (exists (
    select 1 from sets st join sessions se on se.id = st.session_id
    where st.id = laps.set_id and se.user_id = auth.uid()
  )) with check (exists (
    select 1 from sets st join sessions se on se.id = st.session_id
    where st.id = laps.set_id and se.user_id = auth.uid()
  ));
create policy "본인 랩만 삭제" on laps
  for delete using (exists (
    select 1 from sets st join sessions se on se.id = st.session_id
    where st.id = laps.set_id and se.user_id = auth.uid()
  ));
