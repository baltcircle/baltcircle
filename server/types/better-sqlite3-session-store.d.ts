declare module "better-sqlite3-session-store" {
  import type { Store } from "express-session";
  import type { Database } from "better-sqlite3";

  interface SqliteStoreOptions {
    client: Database;
    expired?: {
      clear?: boolean;
      intervalMs?: number;
    };
  }

  type SqliteStoreClass = new (options: SqliteStoreOptions) => Store;

  export default function (session: { Store: typeof Store }): SqliteStoreClass;
}
