import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class MockD1PreparedStatement {
  private db: DatabaseSync;
  private sql: string;
  private params: unknown[] = [];

  constructor(db: DatabaseSync, sql: string, params: unknown[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new MockD1PreparedStatement(this.db, this.sql, values) as unknown as D1PreparedStatement;
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    try {
      const stmt = this.db.prepare(this.sql);
      const row = stmt.get(...(this.params as any[])) as Record<string, unknown> | undefined;
      if (!row) return null;
      if (colName !== undefined) {
        return (row[colName] as unknown as T) ?? null;
      }
      return row as unknown as T;
    } catch (err: any) {
      throw new Error(`D1 query error in first(): ${err.message} [SQL: ${this.sql}]`);
    }
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    try {
      const stmt = this.db.prepare(this.sql);
      const result = stmt.run(...(this.params as any[]));
      return {
        results: [],
        success: true,
        meta: {
          duration: 0,
          size_after: 0,
          rows_read: 0,
          rows_written: Number(result.changes),
          last_row_id: Number(result.lastInsertRowid),
          changed_db: Number(result.changes) > 0,
          changes: Number(result.changes),
        },
      };
    } catch (err: any) {
      throw new Error(`D1 query error in run(): ${err.message} [SQL: ${this.sql}]`);
    }
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    try {
      const stmt = this.db.prepare(this.sql);
      const rows = stmt.all(...(this.params as any[])) as T[];
      return {
        results: rows,
        success: true,
        meta: {
          duration: 0,
          size_after: 0,
          rows_read: rows.length,
          rows_written: 0,
          last_row_id: 0,
          changed_db: false,
          changes: 0,
        },
      };
    } catch (err: any) {
      throw new Error(`D1 query error in all(): ${err.message} [SQL: ${this.sql}]`);
    }
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const res = await this.all<Record<string, unknown>>();
    return res.results.map((r) => Object.values(r) as T);
  }
}

export class MockD1Database {
  public rawDb: DatabaseSync;

  constructor(rawDb?: DatabaseSync) {
    this.rawDb = rawDb ?? new DatabaseSync(':memory:');
    this.rawDb.exec('PRAGMA foreign_keys = ON;');
  }

  prepare(query: string): D1PreparedStatement {
    return new MockD1PreparedStatement(this.rawDb, query) as unknown as D1PreparedStatement;
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const results: D1Result<T>[] = [];
    for (const stmt of statements) {
      const mock = stmt as any;
      if (mock.sql && /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(mock.sql)) {
        results.push(await mock.run());
      } else {
        results.push(await stmt.all<T>());
      }
    }
    return results;
  }

  async exec(query: string): Promise<D1ExecResult> {
    this.rawDb.exec(query);
    return {
      count: 1,
      duration: 0,
    };
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error('dump() is not implemented in mock');
  }

  withSession() {
    return this as any;
  }
}

export function createMockD1Database(applyMigrations = true): D1Database {
  const db = new MockD1Database();
  if (applyMigrations) {
    const migrationsDir = path.resolve(__dirname, '../../migrations');
    const migrationFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of migrationFiles) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      db.rawDb.exec(sql);
    }
  }
  return db as unknown as D1Database;
}
