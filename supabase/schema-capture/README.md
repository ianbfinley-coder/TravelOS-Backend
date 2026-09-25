# Schema capture — 2026-09-25

## What happened

Until today the TravelOS database schema existed in exactly one place: Supabase's
cloud. `supabase migration list` showed **152 migrations recorded remotely and
zero on disk**, going back to 7 September. No history, no diff, no rollback, and
no way to review a change before it shipped.

The cause was a corrupt `.gitignore`: two lines had been saved as UTF-16, leaving
a stray NUL byte that git treated as a pattern matching **every untracked
directory**. `supabase/` was never excluded by anyone's decision — a bad byte was
silently swallowing it. That file has been repaired.

## What these files are

`supabase db dump` requires Docker, which was not available on the machine, so
these were generated from the system catalogs instead.

| File | Contents |
|---|---|
| `schema_tables_2026-09-25.sql` | 223 tables, 2 enums, 737 constraints, 312 indexes, 25 triggers |
| `rls_policies_2026-09-25.sql` | 220 tables with RLS enabled, 383 policies |
| `functions_2026-09-25.sql` | 41 functions, 20 of them `SECURITY DEFINER` |

## What they are NOT

**Not migrations.** Objects are grouped by class — types, then tables, then
constraints, then indexes — not sorted by dependency, so this will not replay
end to end without work. Treat them as a record and a diff target.

**Not complete.** No row data, no grants, no publications, no storage or auth
schema config. `--data-only` was not captured, so the reference data
(`fx_rates` 14,206 rows, `emergency_numbers`, `playbooks`, `safety_rules`,
`cost_index`, `currencies`) is still uncaptured and still exists only in the
cloud.

## Replace these as soon as Docker is available

```
npx supabase db dump -f supabase/schema.sql
npx supabase db dump -f supabase/roles.sql --role-only
npx supabase db dump -f supabase/seed.sql --data-only --schema public
```

A real dump is dependency-ordered, replayable, and captures what this misses.
When it exists, delete this folder.

## Do not run `supabase migration repair`

When `db pull` fails with "the remote database's migration history does not
match local files", the CLI suggests `migration repair --status reverted` for
every migration. **Do not.** That advice assumes local files are the source of
truth and the remote drifted. Here the inverse is true: the remote history is
complete and correct, and local has nothing. Running it would erase the record
that 152 migrations were ever applied.

## Note on the last two migrations

`20260925171233` and `20260925171250` (2026-09-25 17:12 UTC) replaced 15 SELECT
policies whose `USING` expression was literally `true` applying to PUBLIC — and
therefore readable with the published anon key — with real membership checks
scoped to `authenticated`. Full account in
`claude/RLS_FIX_public_read_policies_2026-09-25.sql`.

A useful property of `rls_policies_2026-09-25.sql`: it contains exactly **three**
`TO PUBLIC / USING (true)` policies, on `embassies`, `taxonomy_versions` and
`recommendation_trending`. Those three are intentionally public. Any future
capture showing more than three is a regression worth investigating.
