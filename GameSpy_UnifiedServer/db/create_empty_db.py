#!/usr/bin/env python3
"""Create empty Rising2 SQLite databases from the schema files next to this script.

    python create_empty_db.py                 # -> ./LoginDatabase.db3 and ./rising2_stats.db
    python create_empty_db.py --out /data     # into another folder
    python create_empty_db.py --force         # overwrite existing files (makes a .bak first)

The server copies this script and the two .sql files into its data folder on
every start, so a fresh template can always be made next to the live databases.
Standard library only.
"""
import argparse
import os
import shutil
import sqlite3
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
TARGETS = [
    ("schema_login.sql", "LoginDatabase.db3"),
    ("schema_stats.sql", "rising2_stats.db"),
]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=HERE, help="output folder (default: next to this script)")
    ap.add_argument("--force", action="store_true", help="replace existing files (a timestamped .bak is kept)")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    for schema, dbname in TARGETS:
        schema_path = os.path.join(HERE, schema)
        db_path = os.path.join(args.out, dbname)
        if os.path.exists(db_path):
            if not args.force:
                print(f"skip   {db_path} (exists, use --force to replace)")
                continue
            bak = f"{db_path}.{time.strftime('%Y%m%d-%H%M%S')}.bak"
            shutil.move(db_path, bak)
            print(f"backup {db_path} -> {bak}")
        with open(schema_path, encoding="utf-8") as f:
            sql = f.read()
        con = sqlite3.connect(db_path)
        con.executescript(sql)
        con.commit()
        con.close()
        print(f"create {db_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
