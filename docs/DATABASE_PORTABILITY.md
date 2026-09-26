# Database portability guardrails

Aubrieta's production database is SQLite today. PostgreSQL is a future scale-out
option, not a second supported backend yet. The goal of these guardrails is to
keep that future move bounded without paying the cost of a PostgreSQL adapter,
dual-database CI, an ORM rewrite, or a second migration system now.

## Application SQL contract

Shared server/domain code should stay inside the SQL subset supported by both
modern SQLite and PostgreSQL:

- SELECT / INSERT / UPDATE / DELETE
- JOINs, CTEs, CASE, COALESCE, aggregate functions
- bound parameters (Aubrieta currently writes `?`; a future PostgreSQL Db adapter
  may translate the application placeholder convention to its driver syntax)
- `ON CONFLICT (...) DO UPDATE/NOTHING` using explicit conflict targets
- ISO-8601 UTC timestamps treated as application values rather than database
  clock/date arithmetic
- integer cents for money

Do not add SQLite-only constructs to shared server/domain or API code, including:

- `PRAGMA`
- `sqlite_master`
- `last_insert_rowid()`
- `INSERT OR IGNORE`
- SQLite `datetime()` modifier arithmetic

`tests/db-portability.test.ts` enforces this rule for shared application code.

## Intentional SQLite-only areas

These are backend/storage implementation details and may use SQLite-specific SQL:

- `src/server/db/**` — SQLite adapters and connection setup
- `src/server/domain/backup.ts` — file-level SQLite backup/WAL checkpointing
- `src/server/domain/solo-backup.ts` — standalone/mobile SQLite restore mechanics
- `migrations/**` and the generated migration bundle — current SQLite schema

A PostgreSQL deployment would provide PostgreSQL-specific implementations for
those storage operations rather than pretending SQLite file operations are
portable.

## What a future PostgreSQL move still requires

This guardrail does not make PostgreSQL a supported backend. A future migration
still needs:

1. a `PgDb` implementation of the existing `Db` interface;
2. placeholder/result normalization in that adapter (especially PostgreSQL
   `bigint` values used for integer cents);
3. PostgreSQL schema migrations and an SQLite-to-PostgreSQL data migration;
4. PostgreSQL-native backup/restore and operational tooling;
5. integration tests against a real PostgreSQL instance.

Until scale-out actually requires those things, SQLite remains the only supported
server database.
