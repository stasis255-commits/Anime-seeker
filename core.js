/* ==========================================================================
 * PART 1: core.js の内容（音響指紋のコアアルゴリズム）
 * デスクトップ版(Python) fingerprint.py / matcher.py と同じロジック・
 * 同じパラメータを JavaScript に移植したもの。Node.js上で合成音声を使い、
 * 複数曲・複数オフセット・複数雑音レベルの組み合わせで動作検証済み。
 * ========================================================================== */
/* ============================================================================
 * core.js
 * ----------------------------------------------------------------------------
 * 音響指紋（Shazam方式のランドマークハッシュ）のコアアルゴリズム。
 * ブラウザ / Node.js の両方で動く純粋なJavaScript関数のみで構成しており、
 * DOMやWeb Audio APIには一切依存しない（テスト可能にするため）。
 *
 * Pythonデスクトップ版(anisong_vj_sync)で実測・検証済みのパラメータを
 * そのまま移植している。
 * ==========================================================================*/

// ---- パラメータ（Python版 fingerprint.py と同じ値） -----------------------
const TARGET_SAMPLE_RATE = 11025;
const FFT_WINDOW_SIZE = 4096;
const FFT_HOP_SIZE = 2048;
const PEAK_NEIGHBORHOOD_FREQ = 18;
const PEAK_NEIGHBORHOOD_TIME = 18;
const AMPLITUDE_PERCENTILE = 90;
const FAN_VALUE = 8;
const MIN_TIME_DELTA_FRAMES = 1;
const MAX_TIME_DELTA_FRAMES = 20;
const FREQ_BITS = 10;
const DELTA_BITS = 12;

const DELTA_BUCKET_FRAMES = 3;
const MIN_SCORE_MARGIN_RATIO = 1.3;

// ----------------------------------------------------------------------------
// FFT (反復版 radix-2 Cooley-Tukey, サイズは2の累乗前提)
// ----------------------------------------------------------------------------
function fftInPlace(re, im) {
  const n = re.length;
  // ビット反転並べ替え
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k], uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        const nextIm = curRe * wIm + curIm * wRe;
        curRe = nextRe; curIm = nextIm;
      }
    }
  }
}

// Hann窓（あらかじめ計算してキャッシュする）
const _hannCache = new Map();
function hannWindow(size) {
  if (_hannCache.has(size)) return _hannCache.get(size);
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  }
  _hannCache.set(size, w);
  return w;
}

/**
 * モノラルPCM(Float32Array, 11025Hz前提)からスペクトログラム(dB)を計算する。
 * 戻り値: { numFrames, numBins, data } data は Float32Array([frame*numBins+bin])
 */
function computeSpectrogram(samples, windowSize = FFT_WINDOW_SIZE, hopSize = FFT_HOP_SIZE) {
  const n = samples.length;
  const numBins = windowSize / 2 + 1;
  if (n < windowSize) {
    return { numFrames: 0, numBins, data: new Float32Array(0) };
  }
  const numFrames = Math.floor((n - windowSize) / hopSize) + 1;
  const data = new Float32Array(numFrames * numBins);
  const win = hannWindow(windowSize);

  const re = new Float64Array(windowSize);
  const im = new Float64Array(windowSize);

  for (let f = 0; f < numFrames; f++) {
    const start = f * hopSize;
    for (let i = 0; i < windowSize; i++) {
      re[i] = samples[start + i] * win[i];
      im[i] = 0;
    }
    fftInPlace(re, im);
    const rowOffset = f * numBins;
    for (let b = 0; b < numBins; b++) {
      const mag = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
      data[rowOffset + b] = 20 * Math.log10(mag + 1e-6);
    }
  }
  return { numFrames, numBins, data };
}

// ----------------------------------------------------------------------------
// ピーク検出: 2次元の局所最大値を「分離可能な移動最大値フィルタ」で高速に
// 求める（フレーム軸→周波数軸の順に1次元の移動最大値を適用すると、2次元の
// 矩形窓での最大値フィルタと数学的に同じ結果になる。O(N)のモノトニック
// デックで計算するので、ナイーブなO(N*window^2)実装より大幅に高速）。
// ----------------------------------------------------------------------------
function slidingMax1D(arr, length, windowSize) {
  // 対称に近い窓（前方 floor((w-1)/2), 後方 ceil((w-1)/2)）
  const before = Math.floor((windowSize - 1) / 2);
  const after = windowSize - 1 - before;
  const out = new Float32Array(length);
  const dq = new Int32Array(length);
  let head = 0, tail = 0; // [head, tail)

  for (let i = 0; i < length + after; i++) {
    if (i < length) {
      while (tail > head && arr[dq[tail - 1]] <= arr[i]) tail--;
      dq[tail++] = i;
    }
    const outIdx = i - after;
    if (outIdx >= 0 && outIdx < length) {
      while (dq[head] < outIdx - before) head++;
      out[outIdx] = arr[dq[head]];
    }
  }
  return out;
}

function findPeaks(spec) {
  const { numFrames, numBins, data } = spec;
  if (numFrames === 0) return [];

  // 1) フレーム軸(時間方向)にスライディング最大値
  const stepMax = new Float32Array(numFrames * numBins);
  {
    const col = new Float32Array(numFrames);
    for (let b = 0; b < numBins; b++) {
      for (let f = 0; f < numFrames; f++) col[f] = data[f * numBins + b];
      const maxed = slidingMax1D(col, numFrames, PEAK_NEIGHBORHOOD_TIME);
      for (let f = 0; f < numFrames; f++) stepMax[f * numBins + b] = maxed[f];
    }
  }
  // 2) 周波数軸にスライディング最大値 → 2次元の局所最大値が完成
  const localMax = new Float32Array(numFrames * numBins);
  {
    for (let f = 0; f < numFrames; f++) {
      const row = stepMax.subarray(f * numBins, f * numBins + numBins);
      const maxed = slidingMax1D(row, numBins, PEAK_NEIGHBORHOOD_FREQ);
      localMax.set(maxed, f * numBins);
    }
  }

  // 振幅の閾値(パーセンタイル)
  const threshold = percentile(data, AMPLITUDE_PERCENTILE);

  const peaks = [];
  for (let f = 0; f < numFrames; f++) {
    const rowOffset = f * numBins;
    for (let b = 0; b < numBins; b++) {
      const v = data[rowOffset + b];
      if (v === localMax[rowOffset + b] && v > threshold) {
        peaks.push({ frame: f, bin: b });
      }
    }
  }
  // 時間順（フレーム→ビン）にソート
  peaks.sort((a, b) => (a.frame - b.frame) || (a.bin - b.bin));
  return peaks;
}

function percentile(float32arr, pct) {
  // 大きい配列でのフルソートは重いので、必要なら間引いてから計算する
  const n = float32arr.length;
  if (n === 0) return 0;
  const maxSamples = 200000;
  let sample;
  if (n > maxSamples) {
    const stride = Math.ceil(n / maxSamples);
    sample = new Float32Array(Math.ceil(n / stride));
    let j = 0;
    for (let i = 0; i < n; i += stride) sample[j++] = float32arr[i];
  } else {
    sample = float32arr.slice();
  }
  const arr = Array.from(sample);
  arr.sort((a, b) => a - b);
  const idx = Math.min(arr.length - 1, Math.max(0, Math.floor((pct / 100) * arr.length)));
  return arr[idx];
}

// ----------------------------------------------------------------------------
// ハッシュ生成（アンカー×ターゲットゾーンのファンアウト）
// ----------------------------------------------------------------------------
function packHash(freq1, freq2, deltaFrames) {
  const f1 = freq1 & ((1 << FREQ_BITS) - 1);
  const f2 = freq2 & ((1 << FREQ_BITS) - 1);
  const dt = deltaFrames & ((1 << DELTA_BITS) - 1);
  return (((f1 << (FREQ_BITS + DELTA_BITS)) | (f2 << DELTA_BITS) | dt) >>> 0);
}

// ----------------------------------------------------------------------------
// hashIndex のメモリ節約用パッキング
// ----------------------------------------------------------------------------
// hashIndex は本来 Map<hash, Array<[songId, anchorFrame]>> という形が自然だが、
// hash値は32bitのほぼ全域(FREQ_BITS*2+DELTA_BITS=32bit)を使って分散するため、
// 曲数・ハッシュ数が非常に多い大規模ライブラリ(数百万〜数千万エントリ)では
// 「ほぼ1エントリにつき1つの配列オブジェクト+その中の2要素配列」という
// 入れ子配列だらけの表現になり、配列オブジェクトの生成コスト(V8のオブジェクト
// ヘッダ等のオーバーヘッド)がメモリ使用量の大半を占めてしまう。これが原因で
// ライブラリの曲数が一定数を超えるとブラウザタブがメモリ不足でクラッシュする
// 不具合が起きていた。
//
// そこで、(songId, anchorFrame) の組を1つの数値に詰めて(パックして)持たせる
// ことで、他の曲と衝突しない大多数のハッシュ値(統計的にはほぼ全体)については
// 配列を一切生成せず、Mapの値として数値を1つだけ持たせるようにする。衝突時
// (同じhash値が複数の曲・位置から生成された場合)だけ配列に格上げする。
//   packed = songId * ANCHOR_FRAME_MULT + anchorFrame
// ANCHOR_FRAME_MULT=2^24なので、1曲あたり最大で約1677万フレーム(1フレームは
// 約0.186秒なので、約866時間・36日分の音声)まで対応でき、実用上まず問題にならない。
const ANCHOR_FRAME_BITS = 24;
const ANCHOR_FRAME_MULT = Math.pow(2, ANCHOR_FRAME_BITS); // 2^24 = 16,777,216

function packHashEntry(songId, anchorFrame) {
  return songId * ANCHOR_FRAME_MULT + anchorFrame;
}
function unpackHashEntry(packed) {
  const songId = Math.floor(packed / ANCHOR_FRAME_MULT);
  const anchorFrame = packed - songId * ANCHOR_FRAME_MULT;
  return [songId, anchorFrame];
}
// hashIndexへ1件のエントリを追加する共通ヘルパー(ライブラリ構築中の逐次
// 追加・保存済みデータからの再構築のどちらからも使う)。
function addHashEntry(hashIndex, hash, songId, anchorFrame) {
  const packed = packHashEntry(songId, anchorFrame);
  const existing = hashIndex.get(hash);
  if (existing === undefined) {
    hashIndex.set(hash, packed);
  } else if (Array.isArray(existing)) {
    existing.push(packed);
  } else {
    hashIndex.set(hash, [existing, packed]);
  }
}

/**
 * ピーク列からハッシュを生成する。
 * 戻り値: [{hash, anchorFrame}, ...]
 */
function generateHashes(peaks) {
  const hashes = [];
  const n = peaks.length;
  for (let i = 0; i < n; i++) {
    const anchor = peaks[i];
    let paired = 0;
    for (let j = i + 1; j < n; j++) {
      const target = peaks[j];
      const dt = target.frame - anchor.frame;
      if (dt < MIN_TIME_DELTA_FRAMES) continue;
      if (dt > MAX_TIME_DELTA_FRAMES) break;
      const h = packHash(anchor.bin, target.bin, dt);
      hashes.push({ hash: h, anchorFrame: anchor.frame });
      paired++;
      if (paired >= FAN_VALUE) break;
    }
  }
  return hashes;
}

function frameToSeconds(frame, sampleRate = TARGET_SAMPLE_RATE) {
  return (frame * FFT_HOP_SIZE) / sampleRate;
}
function secondsToFrame(seconds, sampleRate = TARGET_SAMPLE_RATE) {
  return Math.round((seconds * sampleRate) / FFT_HOP_SIZE);
}

/**
 * サンプル配列(11025Hzのモノラル)から直接ハッシュ列を得るユーティリティ。
 */
function fingerprintSamples(samples) {
  if (!samples || samples.length === 0) return [];
  const spec = computeSpectrogram(samples);
  const peaks = findPeaks(spec);
  return generateHashes(peaks);
}

// ----------------------------------------------------------------------------
// マッチング（投票 + バケツ丸め + マージン判定）。Python版 matcher.py と同じロジック。
// ----------------------------------------------------------------------------
/**
 * hashIndex: Map<hash:number, number | number[]>
 *   (値は packHashEntry(songId, anchorFrame) でパックした数値。衝突が無ければ
 *    数値1つ、衝突があれば数値の配列。詳細はaddHashEntry/unpackHashEntry参照)
 * queryHashes: [{hash, anchorFrame}, ...]
 *
 * 戻り値:
 *   {
 *     matched: boolean,
 *     songId, score, referenceOffsetSeconds,
 *     candidates: [[songId, score], ...]  (上位、デバッグ用)
 *   }
 */
function matchHashes(hashIndex, queryHashes, minConfidence = 8, requireMargin = true) {
  if (!queryHashes.length) return { matched: false, candidates: [] };

  // (songId, bucket) -> [deltaFrames, ...]
  const rawDeltas = new Map();
  for (const qh of queryHashes) {
    const matches = hashIndex.get(qh.hash);
    if (matches === undefined) continue;
    // hashIndexの値は、メモリ節約のため「衝突が無ければ数値1つ、衝突があれば
    // 数値の配列」というパック形式になっている(addHashEntry/packHashEntry参照)。
    const packedList = Array.isArray(matches) ? matches : [matches];
    for (const packed of packedList) {
      const [songId, dbAnchorFrame] = unpackHashEntry(packed);
      const delta = dbAnchorFrame - qh.anchorFrame;
      const bucket = Math.round(delta / DELTA_BUCKET_FRAMES);
      const key = songId + ':' + bucket;
      let arr = rawDeltas.get(key);
      if (!arr) { arr = { songId, bucket, deltas: [] }; rawDeltas.set(key, arr); }
      arr.deltas.push(delta);
    }
  }

  if (rawDeltas.size === 0) return { matched: false, candidates: [] };

  const ranked = Array.from(rawDeltas.values()).sort((a, b) => b.deltas.length - a.deltas.length);

  const bestPerSong = new Map();
  for (const entry of ranked) {
    const cur = bestPerSong.get(entry.songId) || 0;
    if (entry.deltas.length > cur) bestPerSong.set(entry.songId, entry.deltas.length);
  }
  const candidateSummary = Array.from(bestPerSong.entries()).sort((a, b) => b[1] - a[1]);

  const top = ranked[0];
  const topScore = top.deltas.length;
  const meanDelta = top.deltas.reduce((a, b) => a + b, 0) / top.deltas.length;
  const referenceOffsetSeconds = frameToSeconds(meanDelta);

  // 最有力候補(トップ候補)のスコア・推定位置は、最小信頼度スコアやスコア差の
  // 判定(matched)に関わらず常に含めておく。「照合候補ログ」の表示に使うのは
  // もちろん、matchedがfalseの場合でも「3回連続で1位候補だった」といった
  // 即時ロック判定など、呼び出し側の補助的な判定に使えるようにするため。
  const base = {
    candidates: candidateSummary,
    songId: top.songId,
    score: topScore,
    totalQueryHashes: queryHashes.length,
    referenceOffsetSeconds,
  };

  if (topScore < minConfidence) {
    return { matched: false, ...base };
  }

  if (requireMargin && candidateSummary.length >= 2) {
    const [secondSongId, secondScore] = candidateSummary[1];
    if (secondSongId !== top.songId && topScore < secondScore * MIN_SCORE_MARGIN_RATIO) {
      return { matched: false, ...base };
    }
  }

  return { matched: true, ...base };
}


// ----------------------------------------------------------------------------
// Node.js からテストできるようにエクスポート（ブラウザでは module は未定義
// なので単に無視される。グローバル関数として動く）
// ----------------------------------------------------------------------------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TARGET_SAMPLE_RATE, FFT_WINDOW_SIZE, FFT_HOP_SIZE,
    PEAK_NEIGHBORHOOD_FREQ, PEAK_NEIGHBORHOOD_TIME, AMPLITUDE_PERCENTILE,
    FAN_VALUE, MIN_TIME_DELTA_FRAMES, MAX_TIME_DELTA_FRAMES,
    DELTA_BUCKET_FRAMES, MIN_SCORE_MARGIN_RATIO,
    ANCHOR_FRAME_BITS, ANCHOR_FRAME_MULT,
    fftInPlace, computeSpectrogram, findPeaks, generateHashes, packHash,
    frameToSeconds, secondsToFrame, fingerprintSamples, matchHashes,
    slidingMax1D, percentile,
    packHashEntry, unpackHashEntry, addHashEntry,
  };
}

// ----------------------------------------------------------------------------
// Electronレンダラ / ブラウザから <script src="core.js"> で読み込んだ場合、
// module は存在しない(nodeIntegration:false のレンダラでは undefined)ので、
// 代わりに window.AnisongCore として同じ関数群をグローバル公開する。
// ----------------------------------------------------------------------------
if (typeof window !== 'undefined') {
  window.AnisongCore = {
    TARGET_SAMPLE_RATE, FFT_WINDOW_SIZE, FFT_HOP_SIZE,
    PEAK_NEIGHBORHOOD_FREQ, PEAK_NEIGHBORHOOD_TIME, AMPLITUDE_PERCENTILE,
    FAN_VALUE, MIN_TIME_DELTA_FRAMES, MAX_TIME_DELTA_FRAMES,
    DELTA_BUCKET_FRAMES, MIN_SCORE_MARGIN_RATIO,
    ANCHOR_FRAME_BITS, ANCHOR_FRAME_MULT,
    fftInPlace, computeSpectrogram, findPeaks, generateHashes, packHash,
    frameToSeconds, secondsToFrame, fingerprintSamples, matchHashes,
    slidingMax1D, percentile,
    packHashEntry, unpackHashEntry, addHashEntry,
  };
}
