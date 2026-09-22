/* デスクトップアプリ版の核心である「SQLite(ディスク)から1ティック分だけ
 * ハッシュを引き、使い捨てMapを組み立ててmatchHashes()へ渡す」という経路
 * (db.lookupHashes -> addHashEntry -> matchHashes)が、旧ブラウザ版と同じ
 * 「全曲分のハッシュをあらかじめ1つの巨大なMapに常駐させておく」経路と
 * 完全に同じ判定結果(matched/songId/score/referenceOffsetSeconds)になる
 * ことを確認する diff テスト。
 *
 * これが一致することで、「matchHashes()自体は一切変更していない」という
 * 前提のもと、レンダラ側のメモリ使用量だけを曲数に依存しない設計に
 * 変えられたことを検証したことになる。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const core = require('../core.js');
const db = require('./db.js');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randn(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function synthMusic(durationS, sr, seed, baseNotes) {
  const rng = mulberry32(seed);
  const n = Math.floor(durationS * sr);
  const noteLen = 0.4;
  const samplesPerNote = Math.floor(noteLen * sr);
  const numNotes = Math.floor(durationS / noteLen) + 1;
  const notesHz = new Float64Array(numNotes);
  for (let i = 0; i < numNotes; i++) notesHz[i] = baseNotes[Math.floor(rng() * baseNotes.length)];
  const freq = new Float64Array(n);
  for (let i = 0; i < n; i++) freq[i] = notesHz[Math.min(numNotes - 1, Math.floor(i / samplesPerNote))];
  const signal = new Float32Array(n);
  let phase = 0;
  const kickPeriod = Math.floor(0.5 * sr);
  const decayLen = Math.floor(0.15 * sr);
  const decay = new Float64Array(decayLen);
  for (let i = 0; i < decayLen; i++) decay[i] = Math.exp(-i / (0.03 * sr));
  for (let i = 0; i < n; i++) {
    phase += (2 * Math.PI * freq[i]) / sr;
    signal[i] = 0.35 * Math.sin(phase) + 0.18 * Math.sin(2 * phase) + 0.10 * Math.sin(3 * phase) + 0.06 * Math.sin(4 * phase);
  }
  for (let start = 0; start < n; start += kickPeriod) {
    for (let k = 0; k < decayLen && start + k < n; k++) signal[start + k] += 0.6 * decay[k] * randn(rng);
  }
  for (let i = 0; i < n; i++) signal[i] += 0.01 * randn(rng);
  let maxAbs = 0;
  for (let i = 0; i < n; i++) maxAbs = Math.max(maxAbs, Math.abs(signal[i]));
  const scale = 0.8 / (maxAbs + 1e-9);
  for (let i = 0; i < n; i++) signal[i] *= scale;
  return signal;
}

const SR = core.TARGET_SAMPLE_RATE;

const SONGS_SPEC = {
  'OP TestAnime1': [90.0, 1, [220, 247, 262, 294, 330, 349, 392, 440, 494]],
  'ED TestAnime2': [75.0, 2, [196, 220, 233, 262, 294, 311, 349, 392]],
  'OP TestAnime3': [60.0, 3, [246, 277, 294, 329, 370, 415, 440, 494]],
};

// ---- ベースライン: 旧ブラウザ版方式(全曲分を1つのMapに常駐) ----
function buildBaselineIndex() {
  const hashIndex = new Map();
  const songs = {};
  let nextId = 1;
  for (const [title, [dur, seed, notes]] of Object.entries(SONGS_SPEC)) {
    const samples = synthMusic(dur, SR, seed, notes);
    const hashes = core.fingerprintSamples(samples);
    const songId = nextId++;
    songs[songId] = { title, samples, dur };
    for (const h of hashes) core.addHashEntry(hashIndex, h.hash, songId, h.anchorFrame);
  }
  return { hashIndex, songs };
}

// ---- 新方式: SQLiteへ永続化してから、1ティックごとに使い捨てMapを組み立てる ----
function buildSqliteDb(songs, tmpDbPath) {
  const hashDb = db.openHashDb(tmpDbPath);
  for (const [songId, s] of Object.entries(songs)) {
    const hashes = core.fingerprintSamples(s.samples);
    // songsテーブルへは最小限のダミーメタ情報を入れる(このテストの対象は
    // hashルックアップ経路なので、動画ファイルパス等はダミーでよい)。
    const insertedId = db.insertSong(hashDb, {
      title: s.title,
      dedupeKey: 'dedupe_' + songId,
      relativePath: s.title + '.mp4',
      rootKey: 'root1',
      rootLabel: 'テスト用フォルダ',
      filePath: '/dummy/' + s.title + '.mp4',
      durationSeconds: s.dur,
    });
    if (String(insertedId) !== String(songId)) {
      throw new Error(`songId不一致: SQLite側=${insertedId}, ベースライン側=${songId} (テストの前提が崩れています)`);
    }
    db.insertSongHashes(hashDb, insertedId, hashes);
  }
  return hashDb;
}

// app.js の buildTickHashIndex() と同じロジック: そのティックのクエリハッシュ
// だけをSQLiteへ問い合わせ、使い捨てのMapを組み立てる。
function buildTickHashIndexFromDb(hashDb, queryHashes) {
  const uniqueHashValues = Array.from(new Set(queryHashes.map((h) => h.hash)));
  const rows = db.lookupHashes(hashDb, uniqueHashValues);
  const tickIndex = new Map();
  for (const row of rows) {
    core.addHashEntry(tickIndex, row.hash, row.songId, row.anchorFrame);
  }
  return tickIndex;
}

function resultsEqual(a, b) {
  if (a.matched !== b.matched) return false;
  if (a.matched) {
    if (a.songId !== b.songId) return false;
    if (a.score !== b.score) return false;
    if (Math.abs(a.referenceOffsetSeconds - b.referenceOffsetSeconds) > 1e-9) return false;
  }
  return true;
}

function main() {
  console.log('=== SQLiteパイプライン diff テスト ===');
  const { hashIndex: baselineIndex, songs } = buildBaselineIndex();
  console.log('ベースライン(全曲常駐Map)構築完了。曲数=' + Object.keys(songs).length);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anisong-sqlite-test-'));
  const tmpDbPath = path.join(tmpDir, 'library.sqlite');
  const hashDb = buildSqliteDb(songs, tmpDbPath);
  console.log('SQLite側の構築完了: ' + tmpDbPath);

  const targetTitle = 'OP TestAnime1';
  const targetId = Object.keys(songs).find((id) => songs[id].title === targetTitle);
  const full = songs[targetId].samples;
  const dur = songs[targetId].dur;

  const offsets = [5, 15, 30, 45, 60, 75];
  const noiseLevels = [0.0, 0.1, 0.2, 0.35];
  const queryDurs = [5, 8, 10];
  const master = mulberry32(123);

  let total = 0, agree = 0, disagreements = [];

  for (const offset of offsets) {
    for (const noiseLevel of noiseLevels) {
      for (const qd of queryDurs) {
        if (offset + qd > dur - 1) continue;
        total++;
        const startSample = Math.floor(offset * SR);
        const clip = full.slice(startSample, startSample + Math.floor(qd * SR));
        const query = new Float32Array(clip.length);
        for (let i = 0; i < clip.length; i++) query[i] = clip[i] + noiseLevel * randn(master);

        const queryHashes = core.fingerprintSamples(query);

        const baselineResult = core.matchHashes(baselineIndex, queryHashes, 8);
        const tickIndex = buildTickHashIndexFromDb(hashDb, queryHashes);
        const sqliteResult = core.matchHashes(tickIndex, queryHashes, 8);

        if (resultsEqual(baselineResult, sqliteResult)) {
          agree++;
        } else {
          disagreements.push({ offset, noiseLevel, qd, baselineResult, sqliteResult });
        }
      }
    }
  }

  // 無関係な雑音(負例)でも一致するか確認する。
  {
    total++;
    const noiseRng = mulberry32(7);
    const noise = new Float32Array(Math.floor(10 * SR));
    for (let i = 0; i < noise.length; i++) noise[i] = 0.3 * randn(noiseRng);
    const noiseHashes = core.fingerprintSamples(noise);
    const baselineResult = core.matchHashes(baselineIndex, noiseHashes, 8);
    const tickIndex = buildTickHashIndexFromDb(hashDb, noiseHashes);
    const sqliteResult = core.matchHashes(tickIndex, noiseHashes, 8);
    if (resultsEqual(baselineResult, sqliteResult)) agree++;
    else disagreements.push({ offset: 'noise', noiseLevel: '-', qd: '-', baselineResult, sqliteResult });
  }

  db.closeHashDb(hashDb);
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n一致: ${agree}/${total}`);
  if (disagreements.length > 0) {
    console.log('不一致の詳細:');
    for (const d of disagreements) {
      console.log(JSON.stringify(d));
    }
    console.log('\nFAIL: SQLite経由の結果がベースライン(全曲常駐Map)と一致しないケースがあります。');
    process.exit(1);
  }
  console.log('\nPASS: 全ケースでSQLite経由(1ティックごとの使い捨てMap)とベースライン(全曲常駐Map)の判定結果が完全一致しました。');
}

main();
