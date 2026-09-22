/* ブラウザ版の「ライブラリをエクスポート」機能が書き出すNDJSON形式を模した
 * ファイルを実際に生成し、importExport.js の importLibraryFromNdjson() で
 * SQLiteへ正しく取り込めるか(曲メタ・ハッシュが欠落・破損しないか)を
 * 検証するラウンドトリップテスト。
 *
 * ブラウザのIndexedDB/showSaveFilePickerはNode上で再現できないため、
 * anisong_vj_web.html の exportLibraryNdjson() が実際に書き出す1行ごとの
 * JSON形状(type:'meta' / type:'song', hashesは[[hash,anchorFrame],...]の
 * コンパクト配列)を直接ここで組み立てて疑似的なエクスポートファイルとする。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const core = require('../core.js');
const db = require('./db.js');
const { importLibraryFromNdjson } = require('./importExport.js');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function synthNoise(durationS, sr, seed) {
  const rng = mulberry32(seed);
  const n = Math.floor(durationS * sr);
  const signal = new Float32Array(n);
  for (let i = 0; i < n; i++) signal[i] = 0.5 * (rng() * 2 - 1);
  return signal;
}

const SR = core.TARGET_SAMPLE_RATE;

async function main() {
  console.log('=== NDJSONエクスポート/インポート ラウンドトリップテスト ===');

  // ---- 疑似的な「ブラウザ版ライブラリ」を3曲分、擬似合成音声から作る ----
  const fakeSongs = [
    { title: 'OP FakeAnimeA', relativePath: 'FakeAnimeA/op.mp4', rootKey: 'rootA', rootLabel: 'Eドライブ/Anime', seed: 11, dur: 20 },
    { title: 'ED FakeAnimeB', relativePath: 'FakeAnimeB/ed1.webm', rootKey: 'rootA', rootLabel: 'Eドライブ/Anime', seed: 22, dur: 15 },
    { title: 'OP FakeAnimeC', relativePath: 'FakeAnimeC/sub/op2.mp4', rootKey: 'rootB', rootLabel: '内蔵フォルダ', seed: 33, dur: 25 },
  ];

  const ndjsonLines = [];
  ndjsonLines.push(JSON.stringify({ type: 'meta', songCount: fakeSongs.length, exportedAt: new Date().toISOString() }));

  const expectedHashCounts = {};
  for (const s of fakeSongs) {
    const samples = synthNoise(s.dur, SR, s.seed);
    const hashes = core.fingerprintSamples(samples);
    const compact = hashes.map((h) => [h.hash, h.anchorFrame]);
    expectedHashCounts[s.relativePath] = compact.length;
    ndjsonLines.push(JSON.stringify({
      type: 'song',
      title: s.title,
      dedupeKey: s.rootKey + '::' + s.relativePath,
      relativePath: s.relativePath,
      rootKey: s.rootKey,
      rootLabel: s.rootLabel,
      durationSeconds: s.dur,
      hashes: compact,
    }));
  }
  // 壊れた行(手動編集ミス等を想定)も1行混ぜて、スキップされることを確認する。
  ndjsonLines.push('{this is not valid json');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anisong-ndjson-test-'));
  const ndjsonPath = path.join(tmpDir, 'export.ndjson');
  fs.writeFileSync(ndjsonPath, ndjsonLines.join('\n') + '\n', 'utf-8');
  console.log('疑似エクスポートファイルを作成: ' + ndjsonPath);

  const dbPath = path.join(tmpDir, 'library.sqlite');
  const hashDb = db.openHashDb(dbPath);

  // resolveFilePath: rootKeyごとに1回だけ「フォルダ選択」した体で、固定の
  // 絶対パスを返す(main.jsのimport:runハンドラのロジックを模している)。
  const rootAbsByKey = { rootA: '/fake/E/Anime', rootB: '/fake/internal' };
  const resolveFilePath = (songObj) => {
    const rootAbs = rootAbsByKey[songObj.rootKey];
    if (!rootAbs) return null;
    return path.posix.join(rootAbs, songObj.relativePath);
  };

  const progressCalls = [];
  const result = await importLibraryFromNdjson(hashDb, ndjsonPath, resolveFilePath, (songsDone, songCount) => {
    progressCalls.push([songsDone, songCount]);
  });

  console.log('インポート結果:', result);
  console.log('進捗コールバック呼び出し回数:', progressCalls.length);

  let ok = true;
  if (result.importedCount !== fakeSongs.length) {
    console.log(`FAIL: importedCount=${result.importedCount} (期待=${fakeSongs.length})`);
    ok = false;
  }
  if (result.songCount !== fakeSongs.length) {
    console.log(`FAIL: songCount=${result.songCount} (期待=${fakeSongs.length})`);
    ok = false;
  }
  if (progressCalls.length !== fakeSongs.length) {
    console.log(`FAIL: 進捗コールバックの呼び出し回数=${progressCalls.length} (期待=${fakeSongs.length})`);
    ok = false;
  }

  // SQLiteに実際に書き込まれた内容を検証する。
  const rows = db.listSongs(hashDb);
  if (rows.length !== fakeSongs.length) {
    console.log(`FAIL: SQLiteのsongs行数=${rows.length} (期待=${fakeSongs.length})`);
    ok = false;
  }
  for (const row of rows) {
    const spec = fakeSongs.find((s) => s.title === row.title);
    if (!spec) { console.log(`FAIL: 想定外の曲が登録されている: ${row.title}`); ok = false; continue; }
    const expectedAbs = path.posix.join(rootAbsByKey[spec.rootKey], spec.relativePath);
    if (row.filePath !== expectedAbs) {
      console.log(`FAIL: filePath不一致 title=${row.title} got=${row.filePath} want=${expectedAbs}`);
      ok = false;
    }
    if (Math.abs(row.durationSeconds - spec.dur) > 1e-6) {
      console.log(`FAIL: durationSeconds不一致 title=${row.title} got=${row.durationSeconds} want=${spec.dur}`);
      ok = false;
    }
    const hashRows = db.lookupHashes(hashDb, []); // dummy call just to ensure no throw
    const hashCountStmt = hashDb.prepare('SELECT COUNT(*) AS c FROM hashes WHERE songId = ?').get(row.id);
    const gotCount = hashCountStmt.c;
    const wantCount = expectedHashCounts[spec.relativePath];
    if (gotCount !== wantCount) {
      console.log(`FAIL: ハッシュ数不一致 title=${row.title} got=${gotCount} want=${wantCount}`);
      ok = false;
    }
  }

  // 同じファイルをもう一度インポートすると、dedupeKeyで全曲スキップされる
  // (二重インポートしても重複登録されない)ことを確認する。
  const result2 = await importLibraryFromNdjson(hashDb, ndjsonPath, resolveFilePath, () => {});
  if (result2.importedCount !== 0 || result2.skippedCount !== fakeSongs.length) {
    console.log(`FAIL: 再インポート時の重複排除が機能していない: ${JSON.stringify(result2)}`);
    ok = false;
  }
  const rowsAfterReimport = db.listSongs(hashDb);
  if (rowsAfterReimport.length !== fakeSongs.length) {
    console.log(`FAIL: 再インポート後にsongs行数が変化した: ${rowsAfterReimport.length}`);
    ok = false;
  }

  db.closeHashDb(hashDb);
  fs.rmSync(tmpDir, { recursive: true, force: true });

  if (!ok) {
    console.log('\nFAIL: NDJSONラウンドトリップテストに失敗しました。');
    process.exit(1);
  }
  console.log('\nPASS: NDJSONエクスポート形式 -> インポート -> SQLite の内容が期待通りでした(壊れた行のスキップ・重複排除も含む)。');
}

main();
