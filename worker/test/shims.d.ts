// Minimale Typen, damit Tests ohne @types/node (Konflikt mit workers-types) typechecken.
declare module "*.sql?raw" {
  const content: string;
  export default content;
}
declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): {
      all(...params: unknown[]): Record<string, unknown>[];
      get(...params: unknown[]): Record<string, unknown> | undefined;
      run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    };
  }
}
