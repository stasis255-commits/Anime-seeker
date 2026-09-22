/* ============================================================================
 * importExport.js — ブラウザ版からエクスポートしたNDJSONライブラリのインポート
 * ----------------------------------------------------------------------------
 * ブラウザ版anisong_vj_web.htmlに追加した「ライブラリをエクスポート」機能が
 * 書き出すNDJSON(1行1JSON、1行目がメタ情報、以降1行1曲)をストリーム読み込み
 * しながらSQLiteへ流し込む。JSON.parse()をファイル全体に対して一度に行うと
 * ブラウザ版と同じメモリ問題を再発させるため、1行ずつ読み、1曲ずつ
 * トランザクションでコミットする。
 * ========================================================================== */
'use strict';

const fs = require('node:fs');
const readline = require('node:readline');
const db = require('./db.js');

// filePath: NDJSONファイルの絶対パス
// resolveFilePath(song): songのrelativePath/rootKey等から実際の動画ファイルの
//   絶対パスを求めるコールバック(ルートフォルダの実体は新アプリ側で選び直す
//   必要があるため、呼び出し側が渡す)。nullを返した場合はその曲をスキップする。
// onProgress(songsDone, songCount): 進捗コールバック(任意)
async function importLibraryFromNdjson(hashDb, ndjsonPath, resolveFilePath, onProgress) {
  const rl = readline.createInterface({
    input: fs.createReadStream(ndjsonPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  let songCount = 0;
  let songsDone = 0;
  let importedCount = 0;
  let skippedCount = 0;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (e) {
      // 壊れた行は無視して続行する(エクスポート側の不具合・手動編集ミス等に
      // 備えて、インポート全体を止めない)。
      continue;
    }

    if (obj.type === 'meta') {
      songCount = obj.songCount || 0;
      continue;
    }

    if (obj.type === 'song') {
      const filePath = resolveFilePath(obj);
      if (!filePath) {
        skippedCount++;
      } else {
        const existing = db.findSongByDedupeKey(hashDb, obj.dedupeKey);
        if (!existing) {
          const songId = db.insertSong(hashDb, {
            title: obj.title,
            dedupeKey: obj.dedupeKey,
            relativePath: obj.relativePath,
            rootKey: obj.rootKey,
            rootLabel: obj.rootLabel,
            filePath,
            durationSeconds: obj.durationSeconds,
          });
          const hashes = (obj.hashes || []).map(([hash, anchorFrame]) => ({ hash, anchorFrame }));
          db.insertSongHashes(hashDb, songId, hashes);
          importedCount++;
        } else {
          skippedCount++;
        }
      }
      songsDone++;
      if (onProgress) {
        try { onProgress(songsDone, songCount); } catch (e) { /* ignore */ }
      }
    }
  }

  return { songCount, songsDone, importedCount, skippedCount };
}

module.exports = { importLibraryFromNdjson };
