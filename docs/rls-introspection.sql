-- ============================================================================
-- READ-ONLY RLS introspection. Makes NO changes. Safe to run on production.
-- Paste into the Supabase SQL Editor and return the output of each block.
-- ============================================================================

-- A. The two helper functions every policy depends on.
--    Want: security_type = DEFINER, and config containing search_path.
select p.proname,
       case when p.prosecdef then 'DEFINER' else 'INVOKER' end as security_type,
       p.proconfig                                             as settings,
       pg_get_userbyid(p.proowner)                             as owner,
       pg_get_functiondef(p.oid)                               as definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('get_my_role','get_my_location')
 order by p.proname;

-- B. Every SECURITY DEFINER function in public, and whether search_path is pinned.
select p.proname,
       p.proconfig,
       case when p.proconfig::text like '%search_path%' then 'pinned' else 'UNPINNED' end as status
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prosecdef
 order by status, p.proname;

-- C. Full live policy dump. This is the ground truth for findings 1-6.
select tablename, policyname, cmd, roles, permissive, qual, with_check
  from pg_policies
 where schemaname = 'public'
 order by tablename, cmd, policyname;

-- D. Any surviving unconditional policy. Expect ZERO rows if 013 is applied.
select tablename, policyname, cmd, qual, with_check
  from pg_policies
 where schemaname = 'public'
   and ( coalesce(btrim(qual),'')       in ('true')
      or coalesce(btrim(with_check),'') in ('true') )
 order by tablename;

-- E. Is 013 applied? Expect ZERO rows.
select tablename, policyname, cmd from pg_policies
 where schemaname='public'
   and policyname in ('Authenticated full access','Read cost settings',
                      'Update cost settings','Profiles readable by authenticated',
                      'Users update own profile');

-- F. RLS enabled? And how many policies does each table actually have?
select c.relname                           as table_name,
       c.relrowsecurity                    as rls_enabled,
       c.relforcerowsecurity               as rls_forced,
       (select count(*) from pg_policies pp
         where pp.schemaname='public' and pp.tablename=c.relname) as policy_count
  from pg_class c
  join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relkind='r'
 order by rls_enabled, policy_count, c.relname;

-- G. finished_goods / raw_materials: do they hold data? (finding 3)
select 'finished_goods' as t, count(*) from finished_goods
union all
select 'raw_materials', count(*) from raw_materials;

-- H. Their shape and last activity, if they have rows.
select table_name, column_name, data_type
  from information_schema.columns
 where table_schema='public' and table_name in ('finished_goods','raw_materials')
 order by table_name, ordinal_position;

-- I. Column-level privileges. Is anything stopping a sales/manager user from
--    writing customers.balance or customers.location directly? (finding 2/6)
select grantee, table_name, column_name, privilege_type
  from information_schema.column_privileges
 where table_schema='public'
   and grantee in ('anon','authenticated')
   and table_name in ('customers','sales','payments')
   and privilege_type in ('UPDATE','INSERT')
 order by table_name, grantee, column_name;

-- J. Table-level grants to anon/authenticated. RLS only applies AFTER the GRANT
--    check, so a missing GRANT is a second line of defence and an extra one is a hole.
select grantee, table_name, string_agg(privilege_type, ', ' order by privilege_type) as privs
  from information_schema.role_table_grants
 where table_schema='public' and grantee in ('anon','authenticated')
 group by grantee, table_name
 order by table_name, grantee;

-- K. Does created_by default to auth.uid(), or is it purely client-supplied?
select table_name, column_name, column_default, is_nullable
  from information_schema.columns
 where table_schema='public' and column_name='created_by'
 order by table_name;

-- L. Do the money RPCs exist live, and are they INVOKER as 011 intends?
select p.proname,
       case when p.prosecdef then 'DEFINER' else 'INVOKER' end as security_type,
       p.proconfig
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public'
   and p.proname in ('record_sale','record_payment','delete_sale','delete_payment',
                     'consignment_post_sale','adjust_customer_balance','adjust_sale_paid',
                     'apply_inventory_deltas','set_inventory_value')
 order by p.proname;

-- M. EXECUTE grants on those RPCs — confirm anon is revoked everywhere.
select r.routine_name, g.grantee, g.privilege_type
  from information_schema.routine_privileges g
  join information_schema.routines r
    on r.specific_name = g.specific_name and r.specific_schema = g.specific_schema
 where r.specific_schema='public' and g.grantee in ('anon','authenticated','PUBLIC')
 order by r.routine_name, g.grantee;

-- ============================================================================
-- N. handle_new_user — the undocumented function that creates profiles rows.
--    Appears in no migration. This is the highest-priority remaining unknown:
--    if it derives profiles.role from auth.users.raw_user_meta_data, then
--    whoever can set that metadata can set their own role.
-- ============================================================================
select p.proname,
       case when p.prosecdef then 'DEFINER' else 'INVOKER' end as security_type,
       p.proconfig                                             as settings,
       pg_get_userbyid(p.proowner)                             as owner,
       pg_get_functiondef(p.oid)                               as definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'handle_new_user';

-- O. What fires it, and on which events? INSERT-only is containable while
--    signups are disabled; a trigger that also fires on UPDATE of auth.users
--    is a live escalation path for any existing staff login.
select c.relnamespace::regnamespace as table_schema,
       c.relname                    as table_name,
       t.tgname                     as trigger_name,
       t.tgenabled                  as enabled,
       pg_get_triggerdef(t.oid)     as definition
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
 where not t.tgisinternal
   and pg_get_triggerdef(t.oid) ilike '%handle_new_user%'
 order by table_schema, table_name, trigger_name;

-- P. All non-internal triggers on auth.users, in case others touch profiles.
select t.tgname, t.tgenabled, pg_get_triggerdef(t.oid)
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'auth' and c.relname = 'users' and not t.tgisinternal;

-- Q. Does any existing profile carry a role that did not come from an admin?
--    Compare profiles.role against the signup metadata that created the user.
select u.email,
       p.role,
       p.location,
       u.raw_user_meta_data,
       u.created_at,
       u.last_sign_in_at
  from auth.users u
  left join public.profiles p on p.id = u.id
 order by u.created_at;
