import type { EnvmanDatabase } from "../../src/server/database.js";

export function installQueryCounter(db: EnvmanDatabase) {
  let count = 0;
  const original = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const statement = original(sql);
    return {
      get: (...params: unknown[]) => {
        count += 1;
        return statement.get(...params);
      },
      all: (...params: unknown[]) => {
        count += 1;
        return statement.all(...params);
      },
      run: (...params: unknown[]) => {
        count += 1;
        return statement.run(...params);
      },
    };
  }) as EnvmanDatabase["prepare"];
  return {
    get count() { return count; },
    reset() { count = 0; },
  };
}
