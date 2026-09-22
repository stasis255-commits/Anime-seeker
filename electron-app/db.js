/* ============================================================================
 * db.js — SQLiteベースの永続化層(ブラウザ版のPART2 IndexedDBヘルパーの置き換え)
 * ----------------------------------------------------------------------------
 * ブラウザ版で発生していた「曲数が増えると音響指紋インデックス(hashIndex)を
 * JSヒープに全曲分保持しなければならずメモリ不足でクラッシュする」問題を
 * 解決するため、hashesテーブルをディスクベースのSQLiteインデックスとして持ち、
 * 認識のたび(1ティックごと)に必要な分だけをクエリする設計にしている。
 * レンダラのメモリ使用量は曲数に関係なく「1ティック分」でほぼ一定になる。
 *
 * 実装は Node.js 組み込みの node:sqlite (DatabaseSync) を第一候補として使う
 * (ネイティブアドオンのABI一致問題が原理的に発生しない)。もし実機の
 * Electronビルドで node:sqlite が使えないと判明した場合は、このファイルを
 * better-sqlite3 版に差し替えるだけで済むよう、他のファイルからはこの
 * ファイルがエクスポートする関数群(openHashDb/insertSong/insertSongHashes/
 * lookupHashes/listSongs/...)だけを通して呼び出すようにしてある。
 * ========================================================================== */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS songs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT NOT NULL,
  dedupeKey       TEXT NOT NULL UNIQUE,
  relativePath    TEXT NOT NULL,
  rootKey         TEXT NOT NULL,
  rootLabel       TEXT NOT NULL,
  filePath        TEXT NOT NULL,
  durationSeconds REAL
);

CREATE TABLE IF NOT EXISTS hashes (
  hash        INTEGER NOT NULL,
  songId      INTEGER NOT NULL,
  anchorFrame INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hashes_hash ON hashes(hash);
CREATE INDEX IF NOT EXISTS idx_hashes_songId ON hashes(songId);

CREATE TABLE IF NOT EXISTS roots (
  key   TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  path  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// SQLiteの「?」プレースホルダ数には上限があるビルドもあるため、IN句に渡す
// 個数を安全側に倍数チャンクへ分割する(念のため保守的な値にしている)。
const IN_CLAUSE_CHUNK_SIZE = 500;

function openHashDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_SQL);
  return db;
}

function closeHashDb(db) {
  db.close();
}

// ---- songs ----

function findSongByDedupeKey(db, dedupeKey) {
  return db.prepare('SELECT * FROM songs WHERE dedupeKey = ?').get(dedupeKey) || null;
}

function insertSong(db, song) {
  const stmt = db.prepare(`
    INSERT INTO songs (title, dedupeKey, relativePath, rootKey, rootLabel, filePath, durationSeconds)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    song.title, song.dedupeKey, song.relativePath, song.rootKey, song.rootLabel,
    song.filePath, song.durationSeconds ?? null,
  );
  return Number(info.lastInsertRowid);
}

// 曲を1曲登録するたびに呼ぶ。ハッシュ挿入は1トランザクションにまとめることで、
// 曲数・ハッシュ数が多くても1曲あたりの保存コストは軽いまま保たれる
// (ブラウザ版のpersistSongIncrementalと同じ考え方)。
function insertSongHashes(db, songId, hashes) {
  db.exec('BEGIN');
  try {
    const stmt = db.prepare('INSERT INTO hashes (hash, songId, anchorFrame) VALUES (?, ?, ?)');
    for (const h of hashes) {
      stmt.run(h.hash, songId, h.anchorFrame);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// 曲1件+そのハッシュ一覧をまとめて登録する(ライブラリ構築中に1曲ごとに呼ぶ)。
function addSongWithHashes(db, song, hashes) {
  const songId = insertSong(db, song);
  insertSongHashes(db, songId, hashes);
  return songId;
}

function listSongs(db) {
  return db.prepare('SELECT * FROM songs ORDER BY id').all();
}

function deleteSong(db, songId) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM hashes WHERE songId = ?').run(songId);
    db.prepare('DELETE FROM songs WHERE id = ?').run(songId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function clearAll(db) {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM hashes');
    db.exec('DELETE FROM songs');
    db.exec('DELETE FROM roots');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---- hashes: 認識の1ティックごとに呼ばれるホットパス ----
// hashValues: 数値の配列(呼び出し側で重複除去しておくことを推奨するが、
// ここでも念のため重複除去する)。
// 戻り値: [{hash, songId, anchorFrame}, ...] (matchHashes()に渡す前提の生データ)
function lookupHashes(db, hashValues) {
  const unique = Array.from(new Set(hashValues));
  if (unique.length === 0) return [];
  const results = [];
  for (let i = 0; i < unique.length; i += IN_CLAUSE_CHUNK_SIZE) {
    const chunk = unique.slice(i, i + IN_CLAUSE_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    const stmt = db.prepare(`SELECT hash, songId, anchorFrame FROM hashes WHERE hash IN (${placeholders})`);
    const rows = stmt.all(...chunk);
    for (const r of rows) results.push(r);
  }
  return results;
}

// ---- roots ----

function listRoots(db) {
  return db.prepare('SELECT * FROM roots ORDER BY rowid').all();
}

function upsertRoot(db, root) {
  db.prepare('INSERT INTO roots (key, label, path) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET label=excluded.label, path=excluded.path')
    .run(root.key, root.label, root.path);
}

function removeRoot(db, key) {
  db.prepare('DELETE FROM roots WHERE key = ?').run(key);
}

// ---- config ----

function loadConfig(db) {
  const rec = db.prepare('SELECT value FROM config WHERE key = ?').get('config');
  return rec ? JSON.parse(rec.value) : null;
}

function saveConfig(db, config) {
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run('config', JSON.stringify(config));
}

module.exports = {
  openHashDb,
  closeHashDb,
  findSongByDedupeKey,
  insertSong,
  insertSongHashes,
  addSongWithHashes,
  listSongs,
  deleteSong,
  clearAll,
  lookupHashes,
  listRoots,
  upsertRoot,
  removeRoot,
  loadConfig,
  saveConfig,
  IN_CLAUSE_CHUNK_SIZE,
};
