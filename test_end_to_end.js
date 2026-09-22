/* core.js（フィンガープリント/マッチングのコアロジック）のエンドツーエンド検証。
 * Python版で使ったのと同じ「倍音+打楽器的アタック+ノイズ床」の合成音声を
 * JSでも生成し、複数曲・複数オフセット・複数ノイズレベルで正しく曲と
 * 再生位置を言い当てられるかを検証する。
 */
const core = require('./core.js');

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
  // Box-Muller
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
  for (let i = 0; i < numNotes; i++) {
    notesHz[i] = baseNotes[Math.floor(rng() * baseNotes.length)];
  }
  const freq = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const noteIdx = Math.min(numNotes - 1, Math.floor(i / samplesPerNote));
    freq[i] = notesHz[noteIdx];
  }
  const signal = new Float32Array(n);
  let phase = 0;
  const kickPeriod = Math.floor(0.5 * sr);
  const decayLen = Math.floor(0.15 * sr);
  const decay = new Float64Array(decayLen);
  for (let i = 0; i < decayLen; i++) decay[i] = Math.exp(-i / (0.03 * sr));

  // ノートによる倍音波形
  for (let i = 0; i < n; i++) {
    phase += (2 * Math.PI * freq[i]) / sr;
    signal[i] = 0.35 * Math.sin(phase) + 0.18 * Math.sin(2 * phase) + 0.10 * Math.sin(3 * phase) + 0.06 * Math.sin(4 * phase);
  }
  // キック(打楽器的アタック)
  for (let start = 0; start < n; start += kickPeriod) {
    for (let k = 0; k < decayLen && start + k < n; k++) {
      signal[start + k] += 0.6 * decay[k] * randn(rng);
    }
  }
  // ノイズ床
  for (let i = 0; i < n; i++) signal[i] += 0.01 * randn(rng);

  // 正規化
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

function buildLibrary() {
  const hashIndex = new Map();
  const songs = {}; // id -> {title, fullSamples}
  let nextId = 1;
  for (const [title, [dur, seed, notes]] of Object.entries(SONGS_SPEC)) {
    const samples = synthMusic(dur, SR, seed, notes);
    const hashes = core.fingerprintSamples(samples);
    const songId = nextId++;
    songs[songId] = { title, samples, dur };
    for (const h of hashes) {
      core.addHashEntry(hashIndex, h.hash, songId, h.anchorFrame);
    }
    console.log(`[登録] ${title}: hashes=${hashes.length}`);
  }
  return { hashIndex, songs };
}

function runMainTest(hashIndex, songs) {
  const targetTitle = 'OP TestAnime1';
  const targetId = Object.keys(songs).find((id) => songs[id].title === targetTitle);
  const full = songs[targetId].samples;

  const startS = 30.0, clipDur = 10.0;
  const startSample = Math.floor(startS * SR);
  const clip = full.slice(startSample, startSample + Math.floor(clipDur * SR));

  const rng = mulberry32(999);
  const query = new Float32Array(clip.length);
  for (let i = 0; i < clip.length; i++) query[i] = clip[i] + 0.2 * randn(rng);

  const queryHashes = core.fingerprintSamples(query);
  const result = core.matchHashes(hashIndex, queryHashes, 8);
  console.log('[主テスト] candidates=', result.candidates);

  if (!result.matched) {
    console.log('NO MATCH -- FAIL');
    process.exit(1);
  }
  const matchedTitle = songs[result.songId].title;
  const err = Math.abs(result.referenceOffsetSeconds - startS);
  console.log(`[主テスト] title=${matchedTitle} score=${result.score} offset=${result.referenceOffsetSeconds.toFixed(2)}s (期待=${startS}s, 誤差=${err.toFixed(2)}s)`);

  if (matchedTitle !== targetTitle) { console.log('FAIL: 別の曲に一致'); process.exit(1); }
  if (err >= 1.0) { console.log('FAIL: 誤差が大きすぎる'); process.exit(1); }
  console.log('主テスト PASS');

  // 負例
  const noiseRng = mulberry32(7);
  const noise = new Float32Array(Math.floor(10 * SR));
  for (let i = 0; i < noise.length; i++) noise[i] = 0.3 * randn(noiseRng);
  const noiseHashes = core.fingerprintSamples(noise);
  const negResult = core.matchHashes(hashIndex, noiseHashes, 8);
  console.log('[負例テスト] candidates=', negResult.candidates, 'matched=', negResult.matched);
  if (negResult.matched) { console.log('FAIL: 無関係な雑音を誤検出'); process.exit(1); }
  console.log('負例テスト PASS');
}

function runStressTest(hashIndex, songs) {
  const targetTitle = 'OP TestAnime1';
  const targetId = Object.keys(songs).find((id) => songs[id].title === targetTitle);
  const full = songs[targetId].samples;
  const dur = songs[targetId].dur;

  const offsets = [5, 15, 30, 45, 60, 75];
  const noiseLevels = [0.0, 0.1, 0.2, 0.35];
  const queryDurs = [5, 8, 10];

  const master = mulberry32(123);
  let total = 0, passed = 0, wrongSong = 0;

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
        const result = core.matchHashes(hashIndex, queryHashes, 8);

        let ok = false;
        if (result.matched) {
          const matchedTitle = songs[result.songId].title;
          const err = Math.abs(result.referenceOffsetSeconds - offset);
          if (matchedTitle === targetTitle && err < 1.0) ok = true;
          else if (matchedTitle !== targetTitle) wrongSong++;
        }
        if (ok) passed++;
      }
    }
  }
  console.log(`\nストレステスト: ${passed}/${total} PASS (${((passed / total) * 100).toFixed(1)}%), 誤って別曲に一致した回数=${wrongSong}`);
  return { total, passed, wrongSong };
}

console.log('=== ライブラリ構築 ===');
const t0 = Date.now();
const { hashIndex, songs } = buildLibrary();
console.log(`ライブラリ構築時間: ${((Date.now() - t0) / 1000).toFixed(2)}s\n`);

console.log('=== 主テスト ===');
runMainTest(hashIndex, songs);

console.log('\n=== ストレステスト ===');
const stress = runStressTest(hashIndex, songs);

if (stress.wrongSong > 0) {
  console.log('\n警告: 誤って別の曲に一致したケースがあります(false positive)。要確認。');
  process.exit(1);
}
console.log('\n全体として false positive (誤って別曲に一致) はゼロでした。');
console.log('ALL TESTS DONE');
