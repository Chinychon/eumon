import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { D1Like } from "./d1.js";

type Param = string | number | bigint | null | Uint8Array;
const toParam = (value: unknown): Param => (value === undefined ? null : typeof value === "boolean" ? Number(value) : value as Param);

/**
 * A D1-compatible database on Node's built-in SQLite with every migration
 * applied, for tests and command-line tools. Not for use inside Workers.
 */
export function openSqliteD1(path = ":memory:"): D1Like {
  const sqlite = new DatabaseSync(path);
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
  }
  const statement = (query: string, args: unknown[] = []) => ({
    run: async () => sqlite.prepare(query).run(...args.map(toParam)),
    first: async <T>() => (sqlite.prepare(query).get(...args.map(toParam)) ?? null) as T | null,
    all: async <T>() => ({ results: sqlite.prepare(query).all(...args.map(toParam)) as T[] }),
  });
  return {
    prepare: (query: string) => ({ ...statement(query), bind: (...args: unknown[]) => statement(query, args) }),
    batch: async (statements: unknown[]) => {
      for (const entry of statements) await (entry as { run(): Promise<unknown> }).run();
    },
  };
}
