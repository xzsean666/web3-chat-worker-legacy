import { DatabaseSync } from 'node:sqlite';
import type { Env } from '../../src/types';

export class MockWebSocket {
  public sentFrames: string[] = [];
  public closed = false;
  public closeCode?: number;
  public closeReason?: string;
  private attachment: any = null;

  send(data: string | ArrayBuffer): void {
    const str = typeof data === 'string' ? data : new TextDecoder().decode(data);
    this.sentFrames.push(str);
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
  }

  serializeAttachment(attachment: any): void {
    this.attachment = attachment;
  }

  deserializeAttachment(): any {
    return this.attachment;
  }

  getLastFrame<T = any>(): T | null {
    if (this.sentFrames.length === 0) return null;
    return JSON.parse(this.sentFrames[this.sentFrames.length - 1]);
  }
}

if (typeof (globalThis as any).WebSocketPair === 'undefined') {
  (globalThis as any).WebSocketPair = class MockWebSocketPair {
    0: MockWebSocket;
    1: MockWebSocket;
    constructor() {
      this[0] = new MockWebSocket();
      this[1] = new MockWebSocket();
    }
  };
}

export class MockSqlStorage {
  private db: DatabaseSync;

  constructor(db?: DatabaseSync) {
    this.db = db ?? new DatabaseSync(':memory:');
    this.db.exec('PRAGMA foreign_keys = ON;');
  }

  exec(query: string, ...params: any[]) {
    const trimmed = query.trim().toUpperCase();
    if (trimmed.startsWith('SELECT')) {
      const stmt = this.db.prepare(query);
      const rows = stmt.all(...params) as Record<string, unknown>[];
      return {
        toArray: () => rows,
      };
    } else {
      // DDL or Mutation
      this.db.exec(query);
      return {
        toArray: () => [],
      };
    }
  }

  // 辅助方法，直接执行带参数的 mutation
  execWithParams(query: string, ...params: any[]) {
    const stmt = this.db.prepare(query);
    stmt.run(...params);
    return {
      toArray: () => [],
    };
  }
}

export class MockDurableObjectState {
  public storage: {
    sql: any;
    transactionSync?: (cb: () => void) => void;
  };
  private webSockets: MockWebSocket[] = [];

  constructor(db?: DatabaseSync) {
    const rawDb = db ?? new DatabaseSync(':memory:');
    const sqlStorage = new MockSqlStorage(rawDb);
    
    // 拦截 exec 以支持参数化 INSERT/UPDATE
    const originalExec = sqlStorage.exec.bind(sqlStorage);
    sqlStorage.exec = (query: string, ...params: any[]) => {
      const trimmed = query.trim().toUpperCase();
      if (params.length > 0 && !trimmed.startsWith('SELECT')) {
        const stmt = rawDb.prepare(query);
        stmt.run(...params);
        return { toArray: () => [] };
      }
      return originalExec(query, ...params);
    };

    this.storage = {
      sql: sqlStorage,
      transactionSync: (callback: () => void) => {
        rawDb.exec('BEGIN TRANSACTION;');
        try {
          callback();
          rawDb.exec('COMMIT;');
        } catch (e) {
          rawDb.exec('ROLLBACK;');
          throw e;
        }
      },
    };
  }

  acceptWebSocket(ws: any, tags?: string[]): void {
    if (!this.webSockets.includes(ws)) {
      this.webSockets.push(ws);
    }
  }

  getWebSockets(): MockWebSocket[] {
    return this.webSockets.filter((ws) => !ws.closed);
  }

  public waitUntilPromises: Promise<any>[] = [];

  waitUntil(promise: Promise<any>): void {
    this.waitUntilPromises.push(promise);
  }
}

export class MockDurableObjectStub {
  constructor(
    public readonly name: string,
    private readonly instanceGetter: () => any
  ) {}

  async fetch(input: string | Request, init?: RequestInit): Promise<Response> {
    const instance = this.instanceGetter();
    let req: Request;
    if (typeof input === 'string') {
      req = new Request(input, init);
    } else {
      req = input;
    }
    return instance.fetch(req);
  }
}

export class MockDurableObjectNamespace {
  private instances = new Map<string, any>();

  constructor(
    private readonly DOClass: new (ctx: any, env: any) => any,
    private readonly getEnv: () => Env
  ) {}

  idFromName(name: string): { name: string } {
    return { name };
  }

  get(id: { name: string }): MockDurableObjectStub {
    return new MockDurableObjectStub(id.name, () => {
      let inst = this.instances.get(id.name);
      if (!inst) {
        const ctx = new MockDurableObjectState();
        inst = new this.DOClass(ctx, this.getEnv());
        this.instances.set(id.name, inst);
      }
      return inst;
    });
  }

  getExistingInstance(name: string): any | undefined {
    return this.instances.get(name);
  }
}
