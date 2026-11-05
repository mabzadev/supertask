#!/usr/bin/env python3
"""
migrate_pg_to_d1.py — Migration des données PostgreSQL Baserow → Cloudflare D1
Usage:
  python3 migrate_pg_to_d1.py --export    # Export PG → JSON files
  python3 migrate_pg_to_d1.py --import    # Import JSON → D1 via wrangler
  python3 migrate_pg_to_d1.py --full      # Export + Import complet
"""

import os
import sys
import json
import subprocess
import argparse
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────
PG_HOST = os.getenv("PG_HOST", "localhost")
PG_PORT = os.getenv("PG_PORT", "5432")
PG_DB   = os.getenv("PG_DB", "baserow")
PG_USER = os.getenv("PG_USER", "baserow")
PG_PASS = os.getenv("PG_PASS", "baserow")
D1_DB   = os.getenv("D1_DB", "supertask-db")
EXPORT_DIR = Path("./migration_data")

# Tables systèmes à migrer (dans l'ordre pour respecter les FK)
SYSTEM_TABLES = [
    "auth_user",
    "core_userprofile",
    "core_workspace",
    "core_workspaceuser",
    "core_application",
    "database_table",
    "database_field",
    "database_view",
    "database_viewfilter",
    "database_viewsort",
    "database_gridviewfieldoptions",
    "database_tablewebhook",
    "database_token",
]

# ── Export PG → JSON ──────────────────────────────────────────────────────────

def export_pg_to_json():
    try:
        import psycopg2
        import psycopg2.extras
    except ImportError:
        print("❌ Install psycopg2: pip install psycopg2-binary")
        sys.exit(1)

    EXPORT_DIR.mkdir(exist_ok=True)
    conn = psycopg2.connect(
        host=PG_HOST, port=PG_PORT, dbname=PG_DB,
        user=PG_USER, password=PG_PASS
    )
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # Export system tables
    for table in SYSTEM_TABLES:
        try:
            cur.execute(f"SELECT * FROM {table} LIMIT 50000")
            rows = cur.fetchall()
            data = [dict(r) for r in rows]
            # Convert non-serializable types
            for row in data:
                for k, v in row.items():
                    if hasattr(v, 'isoformat'):
                        row[k] = v.isoformat()
                    elif isinstance(v, (bytes, memoryview)):
                        row[k] = None
            out_path = EXPORT_DIR / f"{table}.json"
            out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2))
            print(f"  ✅ {table}: {len(data)} rows → {out_path}")
        except Exception as e:
            print(f"  ⚠️  {table}: {e}")

    # Export dynamic user tables (database_table_<id>)
    cur.execute("SELECT id FROM database_table WHERE trashed = false")
    table_ids = [r["id"] for r in cur.fetchall()]
    for tid in table_ids:
        tn = f"database_table_{tid}"
        try:
            cur.execute(f"SELECT * FROM {tn} LIMIT 100000")
            rows = [dict(r) for r in cur.fetchall()]
            for row in rows:
                for k, v in row.items():
                    if hasattr(v, 'isoformat'):
                        row[k] = v.isoformat()
            out_path = EXPORT_DIR / f"{tn}.json"
            out_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2))
            print(f"  ✅ {tn}: {len(rows)} rows")
        except Exception as e:
            print(f"  ⚠️  {tn}: {e}")

    conn.close()
    print(f"\n✅ Export terminé → {EXPORT_DIR}/")


# ── Import JSON → D1 ──────────────────────────────────────────────────────────

BATCH_SIZE = 50  # D1 limite ~100 statements par batch

def d1_execute(sql: str):
    result = subprocess.run(
        ["npx", "wrangler@4.68.1", "d1", "execute", D1_DB, "--remote", "--command", sql],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        raise RuntimeError(f"D1 error: {result.stderr[:200]}")


def import_table(table: str, rows: list):
    if not rows:
        return 0

    columns = list(rows[0].keys())
    # Quote reserved keywords
    quoted_cols = []
    for c in columns:
        if c.lower() in ("order", "primary", "index", "select", "where"):
            quoted_cols.append(f'[{c}]')
        else:
            quoted_cols.append(f'"{c}"')

    cols_str = ", ".join(quoted_cols)
    inserted = 0

    for i in range(0, len(rows), BATCH_SIZE):
        batch = rows[i:i + BATCH_SIZE]
        statements = []
        for row in batch:
            values = []
            for v in row.values():
                if v is None:
                    values.append("NULL")
                elif isinstance(v, bool):
                    values.append("1" if v else "0")
                elif isinstance(v, (int, float)):
                    values.append(str(v))
                else:
                    escaped = str(v).replace("'", "''")
                    values.append(f"'{escaped}'")
            vals_str = ", ".join(values)
            statements.append(
                f"INSERT OR IGNORE INTO {table} ({cols_str}) VALUES ({vals_str})"
            )
        sql = "; ".join(statements)
        d1_execute(sql)
        inserted += len(batch)

    return inserted


def import_json_to_d1():
    if not EXPORT_DIR.exists():
        print(f"❌ Export dir not found: {EXPORT_DIR}. Run --export first.")
        sys.exit(1)

    # Import system tables in order
    for table in SYSTEM_TABLES:
        path = EXPORT_DIR / f"{table}.json"
        if not path.exists():
            print(f"  ⚠️  {table}: no export file, skipping")
            continue
        rows = json.loads(path.read_text())
        try:
            n = import_table(table, rows)
            print(f"  ✅ {table}: {n} rows imported")
        except Exception as e:
            print(f"  ❌ {table}: {e}")

    # Import dynamic user tables
    for path in sorted(EXPORT_DIR.glob("database_table_*.json")):
        table = path.stem
        rows = json.loads(path.read_text())
        if not rows:
            continue
        try:
            # Create the physical table first if needed
            d1_execute(
                f'CREATE TABLE IF NOT EXISTS "{table}" '
                f'(id INTEGER PRIMARY KEY AUTOINCREMENT, [order] REAL NOT NULL DEFAULT 10000, '
                f'_created_on TEXT, _updated_on TEXT, _created_by_id INTEGER, _last_modified_by_id INTEGER)'
            )
            # Add field columns
            cols_in_data = [c for c in rows[0].keys() if c.startswith("field_")]
            for col in cols_in_data:
                try:
                    d1_execute(f'ALTER TABLE "{table}" ADD COLUMN "{col}" TEXT')
                except:
                    pass  # Column already exists
            n = import_table(f'"{table}"', rows)
            print(f"  ✅ {table}: {n} rows imported")
        except Exception as e:
            print(f"  ❌ {table}: {e}")

    print("\n✅ Import terminé !")


# ── Main ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Migrate Baserow PG data to Cloudflare D1")
    parser.add_argument("--export", action="store_true", help="Export PG data to JSON files")
    parser.add_argument("--import", dest="do_import", action="store_true", help="Import JSON to D1")
    parser.add_argument("--full", action="store_true", help="Run both export and import")
    args = parser.parse_args()

    if args.full or args.export:
        print("\n🔄 Exporting PostgreSQL data...")
        export_pg_to_json()

    if args.full or args.do_import:
        print("\n🔄 Importing to Cloudflare D1...")
        import_json_to_d1()

    if not any([args.export, args.do_import, args.full]):
        parser.print_help()
