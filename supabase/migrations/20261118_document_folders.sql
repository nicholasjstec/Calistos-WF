-- Document folders: managers create folders and move files into them.
-- Run this once in the Supabase SQL editor, AFTER 20261118_documents.sql. Safe to re-run.

create table if not exists public.document_folders (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) > 0),
  visibility  text not null default 'managers' check (visibility in ('managers', 'everyone')),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- Deleting a folder moves its files back to the main list (they are not deleted).
alter table public.documents
  add column if not exists folder_id uuid references public.document_folders(id) on delete set null;

alter table public.document_folders enable row level security;

drop policy if exists document_folders_select on public.document_folders;
create policy document_folders_select on public.document_folders for select to authenticated
  using (public.documents_is_manager() or visibility = 'everyone');

drop policy if exists document_folders_insert on public.document_folders;
create policy document_folders_insert on public.document_folders for insert to authenticated
  with check (public.documents_is_manager());

drop policy if exists document_folders_update on public.document_folders;
create policy document_folders_update on public.document_folders for update to authenticated
  using (public.documents_is_manager()) with check (public.documents_is_manager());

drop policy if exists document_folders_delete on public.document_folders;
create policy document_folders_delete on public.document_folders for delete to authenticated
  using (public.documents_is_manager());

-- A file is hidden from employees if its folder is managers-only, even if the file itself is shared.
create or replace function public.documents_folder_shared(fid uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select fid is null or exists (select 1 from public.document_folders where id = fid and visibility = 'everyone');
$$;

drop policy if exists documents_select on public.documents;
create policy documents_select on public.documents for select to authenticated
  using (
    public.documents_is_manager()
    or (visibility = 'everyone' and public.documents_folder_shared(folder_id))
  );

drop policy if exists documents_obj_select on storage.objects;
create policy documents_obj_select on storage.objects for select to authenticated
  using (
    bucket_id = 'documents' and (
      public.documents_is_manager()
      or exists (
        select 1 from public.documents d
        where d.path = storage.objects.name
          and d.visibility = 'everyone'
          and public.documents_folder_shared(d.folder_id)
      )
    )
  );

do $$ begin
  alter publication supabase_realtime add table public.document_folders;
exception when duplicate_object then null; end $$;
