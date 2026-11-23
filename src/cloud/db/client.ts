import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './migrations.js';

let database: DatabaseSync | undefined;

export function getDb(path: string): DatabaseSync {
  if (database) return database;

  mkdirSync(dirname(path), { recursive: true });
  database = new DatabaseSync(path);
  database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  runMigrations(database, path);
  return database;
}

export function closeDb(): void {
  database?.close();
  database = undefined;
}
