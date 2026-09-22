const core = require('./core.js');

// 単純な信号でFFTの正しさを検証する（DFTの定義どおりに計算した結果と比較）
function naiveDFT(reIn, imIn) {
  const n = reIn.length;
  const reOut = new Float64Array(n);
  const imOut = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sr = 0, si = 0;
    for (let t = 0; t < n; t++) {
      const ang = (-2 * Math.PI * k * t) / n;
      const c = Math.cos(ang), s = Math.sin(ang);
      sr += reIn[t] * c - imIn[t] * s;
      si += reIn[t] * s + imIn[t] * c;
    }
    reOut[k] = sr; imOut[k] = si;
  }
  return [reOut, imOut];
}

const n = 64;
const re = new Float64Array(n);
const im = new Float64Array(n);
for (let i = 0; i < n; i++) {
  re[i] = Math.sin((2 * Math.PI * 5 * i) / n) + 0.5 * Math.cos((2 * Math.PI * 11 * i) / n);
}
const re2 = re.slice(), im2 = im.slice();
const [expRe, expIm] = naiveDFT(re, im);
core.fftInPlace(re2, im2);

let maxErr = 0;
for (let i = 0; i < n; i++) {
  maxErr = Math.max(maxErr, Math.abs(re2[i] - expRe[i]), Math.abs(im2[i] - expIm[i]));
}
console.log('FFT max error vs naive DFT:', maxErr);
if (maxErr > 1e-6) {
  console.log('FFT TEST FAILED');
  process.exit(1);
} else {
  console.log('FFT TEST PASSED');
}

// slidingMax1D の正しさをブルートフォースと比較
function bruteMax1D(arr, windowSize) {
  const n = arr.length;
  const before = Math.floor((windowSize - 1) / 2);
  const after = windowSize - 1 - before;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = -Infinity;
    for (let k = Math.max(0, i - before); k <= Math.min(n - 1, i + after); k++) {
      if (arr[k] > m) m = arr[k];
    }
    out[i] = m;
  }
  return out;
}

const testArr = new Float32Array(200);
for (let i = 0; i < testArr.length; i++) testArr[i] = Math.sin(i * 0.3) * 10 + (Math.random() - 0.5) * 3;
for (const w of [1, 2, 5, 18, 19]) {
  const a = core.slidingMax1D(testArr, testArr.length, w);
  const b = bruteMax1D(testArr, w);
  let diff = 0;
  for (let i = 0; i < testArr.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
  console.log(`slidingMax1D window=${w} maxdiff=${diff}`);
  if (diff > 1e-6) {
    console.log('SLIDING MAX TEST FAILED for window', w);
    process.exit(1);
  }
}
console.log('SLIDING MAX TEST PASSED');
