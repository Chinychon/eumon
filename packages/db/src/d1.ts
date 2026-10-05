export interface D1Like {
  prepare(query: string): {
    bind(...args: unknown[]): {
      run(): Promise<unknown>;
      first<T = unknown>(): Promise<T | null>;
      all<T = unknown>(): Promise<{ results: T[] }>;
    };
    run(): Promise<unknown>;
    first<T = unknown>(): Promise<T | null>;
    all<T = unknown>(): Promise<{ results: T[] }>;
  };
  batch?(statements: unknown[]): Promise<unknown>;
}

type D1PreparedStatement = ReturnType<D1Like["prepare"]>;
type D1BoundStatement = ReturnType<D1PreparedStatement["bind"]>;

export function nowIso(): string {
  return new Date().toISOString();
}

export async function runStatements(
  db: D1Like,
  statements: D1BoundStatement[],
): Promise<void> {
  if (!statements.length) return;
  if (db.batch) {
    await db.batch(statements);
    return;
  }
  for (const statement of statements) await statement.run();
}

export function chunks<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}
