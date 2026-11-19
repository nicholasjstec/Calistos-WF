-- Documents section: managers upload / rename / delete files and choose who can see each one.
-- Run this once in the Supabase SQL editor. Safe to re-run.

create table if not exists public.documents (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) > 0),
  path        text not null unique,            -- key inside the "documents" storage bucket
  mime        text,
  size        bigint,
  visibility  text not null default 'managers' check (visibility in ('managers', 'everyone')),
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- "Manager" in this app means profiles.access = 'employer' (same rule the rest of the app uses).
create or replace function public.documents_is_manager()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and access = 'employer');
$$;

alter table public.documents enable row level security;

drop policy if exists documents_select on public.documents;
create policy documents_select on public.documents for select to authenticated
  using (public.documents_is_manager() or visibility = 'everyone');

drop policy if exists documents_insert on public.documents;
create policy documents_insert on public.documents for insert to authenticated
  with check (public.documents_is_manager());

drop policy if exists documents_update on public.documents;
create policy documents_update on public.documents for update to authenticated
  using (public.documents_is_manager()) with check (public.documents_is_manager());

drop policy if exists documents_delete on public.documents;
create policy documents_delete on public.documents for delete to authenticated
  using (public.documents_is_manager());

-- Private storage bucket. Files are only reachable through short-lived signed links.
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

drop policy if exists documents_obj_select on storage.objects;
create policy documents_obj_select on storage.objects for select to authenticated
  using (
    bucket_id = 'documents' and (
      public.documents_is_manager()
      or exists (select 1 from public.documents d where d.path = storage.objects.name and d.visibility = 'everyone')
    )
  );

drop policy if exists documents_obj_insert on storage.objects;
create policy documents_obj_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and public.documents_is_manager());

drop policy if exists documents_obj_delete on storage.objects;
create policy documents_obj_delete on storage.objects for delete to authenticated
  using (bucket_id = 'documents' and public.documents_is_manager());

-- Live updates (the app already listens for table changes).
do $$ begin
  alter publication supabase_realtime add table public.documents;
exception when duplicate_object then null; end $$;
