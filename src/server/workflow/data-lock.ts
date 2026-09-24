import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface DataLock { release(): Promise<void> }

async function rejectSymlink(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) throw new Error(`Refusing symlink data lock path: ${path}`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export async function acquireDataLock(dataDir: string): Promise<DataLock> {
  await rejectSymlink(dataDir);
  await mkdir(dataDir, { recursive: true });
  await rejectSymlink(dataDir);
  const path = join(dataDir, ".owner-lock.sqlite");
  await rejectSymlink(path);
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=0");
    db.exec("CREATE TABLE IF NOT EXISTS owner (pid INTEGER NOT NULL, started_at TEXT NOT NULL)");
    // SQLite releases its OS lock on process death. No stale-file unlink race
    // can give two processes ownership at once.
    db.exec("BEGIN EXCLUSIVE");
    db.exec("DELETE FROM owner");
    db.prepare("INSERT INTO owner (pid, started_at) VALUES (?, ?)").run(process.pid, new Date().toISOString());
    let released = false;
    return { release: async () => {
      if (released) return;
      released = true;
      try { db.exec("ROLLBACK"); }
      finally { db.close(); }
    } };
  } catch (error) {
    db.close();
    throw new Error(`Data directory is already owned or its lock is unavailable: ${path}`, { cause: error });
  }
}
