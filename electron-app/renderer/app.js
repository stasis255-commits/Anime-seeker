/* ============================================================================
 * app.js — Anime Seeker デスクトップ版レンダラプロセスのメインスクリプト
 * ----------------------------------------------------------------------------
 * ブラウザ版 anisong_vj_web.html の PART3/5/6/7/8/9 を移植したもの。
 * PART1(音響指紋コア)は core.js としてそのまま同梱。
 * PART2(IndexedDB)・PART4(File System Access API)はメインプロセス側の
 * db.js/scan.jsに置き換わり、レンダラからは window.anisong.* 経由で呼び出す。
 *
 * 最大の変更点: 音響指紋インデックス(hashIndex)を全曲分レンダラのJSヒープに
 * 保持する代わりに、認識の1ティックごとにそのティックで必要な分だけを
 * メインプロセス(SQLite)へ問い合わせ、使い捨ての小さなMapを組み立てて
 * core.jsのmatchHashes()にそのまま渡す。これによりレンダラのメモリ使用量は
 * 曲数に関係なくほぼ一定になる(ブラウザ版で発生していたメモリ不足クラッシュ
 * の根本的な解決)。matchHashes()自体のロジックは一切変更していない。
 * ========================================================================== */
(function () {
  'use strict';

  const {
    TARGET_SAMPLE_RATE, fingerprintSamples, matchHashes, addHashEntry,
  } = window.AnisongCore;

  /* ==========================================================================
   * PART 3相当: 音声デコード・リサンプル
   * (file.arrayBuffer()の代わりに、メインプロセスから受け取ったArrayBufferを
   * 直接使う点のみブラウザ版と異なる)
   * ========================================================================== */
  let _sharedAudioCtx = null;
  function getSharedAudioContext() {
    if (!_sharedAudioCtx) {
      _sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return _sharedAudioCtx;
  }

  async function decodeArrayBufferToMono(arrayBuffer) {
    const ctx = getSharedAudioContext();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    const numCh = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;
    const mono = new Float32Array(length);
    for (let ch = 0; ch < numCh; ch++) {
      const chData = audioBuffer.getChannelData(ch);
      for (let i = 0; i < length; i++) mono[i] += chData[i] / numCh;
    }
    return { mono, sampleRate: audioBuffer.sampleRate };
  }

  async function resampleTo(monoFloat32, srcRate, dstRate) {
    if (srcRate === dstRate) return monoFloat32;
    const durationSec = monoFloat32.length / srcRate;
    const dstLength = Math.max(1, Math.ceil(durationSec * dstRate));
    const offlineCtx = new OfflineAudioContext(1, dstLength, dstRate);
    const srcBuffer = offlineCtx.createBuffer(1, monoFloat32.length, srcRate);
    srcBuffer.copyToChannel(monoFloat32, 0);
    const src = offlineCtx.createBufferSource();
    src.buffer = srcBuffer;
    src.connect(offlineCtx.destination);
    src.start();
    const rendered = await offlineCtx.startRendering();
    return rendered.getChannelData(0).slice();
  }

  async function decodeAndResampleArrayBuffer(arrayBuffer, maxDurationSeconds) {
    const { mono, sampleRate } = await decodeArrayBufferToMono(arrayBuffer);
    let trimmed = mono;
    if (maxDurationSeconds) {
      const maxSamples = Math.floor(maxDurationSeconds * sampleRate);
      if (trimmed.length > maxSamples) trimmed = trimmed.subarray(0, maxSamples);
    }
    return resampleTo(trimmed, sampleRate, TARGET_SAMPLE_RATE);
  }

  // ブラウザ版PART4のguessTitle()と全く同じロジック(IPC往復を避けるため、
  // 単純な文字列処理なのでここに直接持たせる。electron-app/scan.jsにも
  // 同一実装があり、メインプロセス側のテストで検証済み)。
  function guessTitle(relativePath) {
    return relativePath.replace(/\.[^./]+$/, '').replace(/[_/]/g, ' ').trim();
  }

  /* ==========================================================================
   * PART 5相当: マイク入力キャプチャ(ブラウザ版から無変更)
   * ========================================================================== */
  class MicCapture {
    constructor() {
      this.chunks = [];
      this.totalDuration = 0;
      this.bufferSeconds = 15;
      this.stream = null;
      this.audioCtx = null;
      this.sourceNode = null;
      this.processor = null;
      this.silentGain = null;
      this.sampleRate = null;
      this.silenceThresholdRms = 0.01;
      this.lastLoudWallclock = null;
    }

    async start(deviceId) {
      const audioConstraints = {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      };
      if (deviceId) audioConstraints.deviceId = { exact: deviceId };
      const constraints = { audio: audioConstraints };
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      this.sampleRate = this.audioCtx.sampleRate;
      this.sourceNode = this.audioCtx.createMediaStreamSource(this.stream);
      this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
      this.silentGain = this.audioCtx.createGain();
      this.silentGain.gain.value = 0;

      this.chunks = [];
      this.totalDuration = 0;
      this.lastLoudWallclock = Date.now() / 1000;

      this.processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        const copy = new Float32Array(input.length);
        copy.set(input);
        const chunkDuration = copy.length / this.audioCtx.sampleRate;
        const chunkStartWallclock = Date.now() / 1000 - chunkDuration;
        this.chunks.push({ t: chunkStartWallclock, samples: copy });
        this.totalDuration += chunkDuration;
        while (this.totalDuration > this.bufferSeconds && this.chunks.length > 1) {
          const old = this.chunks.shift();
          this.totalDuration -= old.samples.length / this.audioCtx.sampleRate;
        }

        let sumSq = 0;
        for (let i = 0; i < copy.length; i++) sumSq += copy[i] * copy[i];
        const rms = Math.sqrt(sumSq / copy.length);
        if (rms >= this.silenceThresholdRms) {
          this.lastLoudWallclock = Date.now() / 1000;
        }
      };

      this.sourceNode.connect(this.processor);
      this.processor.connect(this.silentGain);
      this.silentGain.connect(this.audioCtx.destination);
    }

    stop() {
      if (this.processor) { try { this.processor.disconnect(); } catch (e) {} }
      if (this.sourceNode) { try { this.sourceNode.disconnect(); } catch (e) {} }
      if (this.silentGain) { try { this.silentGain.disconnect(); } catch (e) {} }
      if (this.stream) { for (const track of this.stream.getTracks()) track.stop(); }
      if (this.audioCtx) { try { this.audioCtx.close(); } catch (e) {} }
      this.stream = null; this.audioCtx = null; this.sourceNode = null; this.processor = null;
      this.chunks = []; this.totalDuration = 0;
      this.lastLoudWallclock = null;
    }

    getSilenceDurationSeconds() {
      if (this.lastLoudWallclock === null) return 0;
      return Math.max(0, Date.now() / 1000 - this.lastLoudWallclock);
    }

    getRecentAudio(seconds) {
      if (this.chunks.length === 0) return null;
      const chunksCopy = this.chunks.slice();
      const collected = [];
      let collectedDuration = 0;
      let startWallclock = null;
      for (let i = chunksCopy.length - 1; i >= 0; i--) {
        const c = chunksCopy[i];
        collected.push(c.samples);
        collectedDuration += c.samples.length / this.sampleRate;
        startWallclock = c.t;
        if (collectedDuration >= seconds) break;
      }
      if (collectedDuration < seconds * 0.5) return null;
      collected.reverse();
      let total = 0;
      for (const s of collected) total += s.length;
      const audio = new Float32Array(total);
      let offset = 0;
      for (const s of collected) { audio.set(s, offset); offset += s.length; }

      const maxSamples = Math.floor(seconds * this.sampleRate);
      let finalAudio = audio;
      if (audio.length > maxSamples) {
        const trimmed = audio.length - maxSamples;
        finalAudio = audio.subarray(trimmed);
        startWallclock += trimmed / this.sampleRate;
      }
      return { samples: finalAudio, wallclockStart: startWallclock, sampleRate: this.sampleRate };
    }
  }

  /* ==========================================================================
   * hashLookupFn: 1ティックごとに、そのティックのクエリハッシュだけを
   * メインプロセス(SQLite)へ問い合わせ、使い捨ての小さなMapを組み立てる。
   * これがブラウザ版のstate.hashIndex(全曲分を保持する巨大なMap)を
   * 置き換える、今回の移行の核心部分。
   * ========================================================================== */
  async function buildTickHashIndex(queryHashes) {
    const uniqueHashValues = Array.from(new Set(queryHashes.map((h) => h.hash)));
    const rows = await window.anisong.lookupHashes(uniqueHashValues);
    const hashIndex = new Map();
    for (const r of rows) addHashEntry(hashIndex, r.hash, r.songId, r.anchorFrame);
    return hashIndex;
  }

  /* ==========================================================================
   * PART 6相当: ストリーミング認識
   * (hashIndexRef(同期Getter)の代わりにhashLookupFn(非同期関数)を使う点、
   * push()/pushQuick()がasyncになった点以外はブラウザ版から無変更。
   * ロック閾値等のチューニング済みの値も一切変更していない)
   * ========================================================================== */
  class StreamingRecognizer {
    constructor(hashLookupFn, opts) {
      this.hashLookupFn = hashLookupFn;
      this.minConfidence = opts.minConfidence;
      this.agreementRequired = opts.agreementRequired;
      this.agreementTolerance = opts.agreementToleranceSeconds;
      this.history = [];
      this.historySize = 5;
      this.locked = null;
      this.quickHistory = [];
      this.quickHistorySize = 3;
      this.switchConfirmCount = 2;
      this.instantSwitchMarginRatio = 3.0;
      this.instantSwitchMinScore = 10;
      this.instantLockScoreThreshold = 15;
      this.instantLockStreakRequired = 3;
      this.topStreakSongId = null;
      this.topStreakCount = 0;
    }

    _applySwitch(matchResult) {
      this.locked = matchResult;
      this.history = [matchResult];
      this.quickHistory = [];
    }

    _makeMatchResult(result, queryWallclockStart) {
      return {
        songId: result.songId,
        score: result.score,
        totalQueryHashes: result.totalQueryHashes,
        referenceOffsetSeconds: result.referenceOffsetSeconds,
        queryWallclockStart,
        referencePositionAt(t) { return this.referenceOffsetSeconds + (t - this.queryWallclockStart); },
      };
    }

    async push(hashes, queryWallclockStart) {
      const hashIndex = await this.hashLookupFn(hashes);
      const result = matchHashes(hashIndex, hashes, this.minConfidence);
      let matchResult = null;
      if (result.matched) {
        matchResult = this._makeMatchResult(result, queryWallclockStart);
        this.history.push(matchResult);
        if (this.history.length > this.historySize) this.history.shift();
      }
      this._updateInstantLockStreak(result, queryWallclockStart);
      const locked = this._updateLock();
      return { latestMatch: matchResult, lockedMatch: locked, candidates: result.candidates };
    }

    _updateInstantLockStreak(result, queryWallclockStart) {
      if (!result.candidates.length) {
        this.topStreakSongId = null;
        this.topStreakCount = 0;
        return;
      }
      const [topSongId, topScore] = result.candidates[0];

      if (topScore >= this.instantLockScoreThreshold) {
        this._applyInstantLock(topSongId, topScore, result, queryWallclockStart);
        return;
      }

      if (topScore >= this.minConfidence && topSongId === this.topStreakSongId) {
        this.topStreakCount++;
      } else if (topScore >= this.minConfidence) {
        this.topStreakSongId = topSongId;
        this.topStreakCount = 1;
      } else {
        this.topStreakSongId = null;
        this.topStreakCount = 0;
        return;
      }

      if (this.topStreakCount >= this.instantLockStreakRequired) {
        this._applyInstantLock(topSongId, topScore, result, queryWallclockStart);
      }
    }

    _applyInstantLock(songId, score, result, queryWallclockStart) {
      this.topStreakSongId = null;
      this.topStreakCount = 0;
      if (this.locked && this.locked.songId === songId) return;
      const matchResult = this._makeMatchResult(
        { songId, score, totalQueryHashes: result.totalQueryHashes, referenceOffsetSeconds: result.referenceOffsetSeconds },
        queryWallclockStart
      );
      this._applySwitch(matchResult);
    }

    async pushQuick(hashes, queryWallclockStart, minConfidence) {
      const hashIndex = await this.hashLookupFn(hashes);
      const threshold = minConfidence != null ? minConfidence : this.minConfidence;
      const result = matchHashes(hashIndex, hashes, threshold);
      if (!result.matched) return null;
      const matchResult = this._makeMatchResult(result, queryWallclockStart);

      if (this.locked && matchResult.songId !== this.locked.songId) {
        const runnerUp = result.candidates.find((c) => c[0] !== matchResult.songId);
        const runnerUpScore = runnerUp ? runnerUp[1] : 0;
        const dominant = matchResult.score >= this.instantSwitchMinScore
          && matchResult.score >= runnerUpScore * this.instantSwitchMarginRatio;
        if (dominant) {
          this._applySwitch(matchResult);
          return this.locked;
        }
      }

      this.quickHistory.push(matchResult);
      if (this.quickHistory.length > this.quickHistorySize) this.quickHistory.shift();
      return this._maybeFastSwitch();
    }

    _maybeFastSwitch() {
      if (!this.locked) return null;
      if (this.quickHistory.length < this.switchConfirmCount) return null;
      const tail = this.quickHistory.slice(-this.switchConfirmCount);
      const candidateSongId = tail[tail.length - 1].songId;
      if (candidateSongId === this.locked.songId) return null;
      if (!tail.every((m) => m.songId === candidateSongId)) return null;

      const now = Date.now() / 1000;
      const positions = tail.map((m) => m.referencePositionAt(now));
      const spread = Math.max(...positions) - Math.min(...positions);
      if (spread > this.agreementTolerance * 2) return null;

      this._applySwitch(tail[tail.length - 1]);
      return this.locked;
    }

    _updateLock() {
      if (this.history.length === 0) { this.locked = null; return null; }
      const latest = this.history[this.history.length - 1];
      const now = Date.now() / 1000;
      const latestPosNow = latest.referencePositionAt(now);
      let agreeing = 0;
      for (const past of this.history) {
        if (past.songId !== latest.songId) continue;
        const predictedNow = past.referencePositionAt(now);
        if (Math.abs(predictedNow - latestPosNow) <= this.agreementTolerance) agreeing++;
      }
      if (agreeing >= this.agreementRequired) this.locked = latest;
      return this.locked;
    }

    reset() {
      this.history = [];
      this.locked = null;
      this.quickHistory = [];
      this.topStreakSongId = null;
      this.topStreakCount = 0;
    }
  }

  /* ==========================================================================
   * PART 7相当: 動画再生・同期
   * (playSong()がfileHandle.getFile()の代わりにwindow.anisong.toVideoUrl()を
   * 使う点以外はブラウザ版から無変更)
   * ========================================================================== */
  class VideoPlayer {
    constructor(videoEl, config) {
      this.video = videoEl;
      this.config = config;
      this.currentSongId = null;
      this.videoUrls = new Map();
      this.video.loop = true;
      this.video.muted = !config.unmuteVideoAudio;
      this.onSourceChanged = null;
      this.onBlackoutChanged = null;
      this.blackedOut = false;
      this.wrapEl = this.video.parentElement && this.video.parentElement.classList.contains('video-wrap')
        ? this.video.parentElement
        : null;

      this.soft = 0.3;
      this.speedAdjustTolerance = 1.5;
      this.hardReseekTolerance = 1.5;
      this.maxSpeedOffset = 0.05;
      this.speedGain = 0.05;
    }

    async playSong(songId, filePath, startSeconds) {
      if (this.currentSongId !== songId) {
        let url = this.videoUrls.get(songId);
        if (!url) {
          url = await window.anisong.toVideoUrl(filePath);
          this.videoUrls.set(songId, url);
        }
        this.video.src = url;
        await new Promise((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            this.video.removeEventListener('loadedmetadata', finish);
            this.video.removeEventListener('error', finish);
            resolve();
          };
          this.video.addEventListener('loadedmetadata', finish);
          this.video.addEventListener('error', finish);
          setTimeout(finish, 5000);
        });
        this.currentSongId = songId;
        if (this.onSourceChanged) {
          try { this.onSourceChanged(); } catch (e) { /* ignore */ }
        }
      }
      this._seekWithWrap(startSeconds);
      this.video.playbackRate = 1.0;
      this.video.muted = !this.config.unmuteVideoAudio;
      try { await this.video.play(); } catch (e) { /* 自動再生がブロックされた場合はUIで案内 */ }
    }

    _seekWithWrap(seconds) {
      let target = Math.max(0, seconds);
      const dur = this.video.duration;
      if (dur && isFinite(dur) && dur > 0) target = target % dur;
      this.video.currentTime = target;
    }

    syncTo(targetSeconds) {
      if (this.currentSongId === null) return;
      const current = this.video.currentTime;
      let target = targetSeconds;
      const dur = this.video.duration;
      if (dur && isFinite(dur) && dur > 0) target = target % dur;

      let drift = target - current;
      if (dur && isFinite(dur) && dur > 0) {
        if (drift > dur / 2) drift -= dur;
        if (drift < -dur / 2) drift += dur;
      }

      if (Math.abs(drift) > this.hardReseekTolerance) {
        this._seekWithWrap(targetSeconds);
        this.video.playbackRate = 1.0;
        return;
      }
      if (Math.abs(drift) <= this.soft) {
        this.video.playbackRate = 1.0;
        return;
      }
      if (Math.abs(drift) <= this.speedAdjustTolerance) {
        const adj = Math.max(-this.maxSpeedOffset, Math.min(this.maxSpeedOffset, drift * this.speedGain));
        this.video.playbackRate = 1.0 + adj;
      }
    }

    pause() { this.video.pause(); }

    stop() {
      this.video.pause();
      this.currentSongId = null;
    }

    setBlackout(flag) {
      if (this.blackedOut === flag) return;
      this.blackedOut = flag;
      if (this.wrapEl) this.wrapEl.classList.toggle('blackout', flag);
      if (flag) {
        try { this.video.pause(); } catch (e) { /* ignore */ }
      } else if (this.currentSongId !== null) {
        try { this.video.play(); } catch (e) { /* 自動再生ブロック等は無視 */ }
      }
      if (this.onBlackoutChanged) {
        try { this.onBlackoutChanged(flag); } catch (e) { /* ignore */ }
      }
    }
  }

  /* ==========================================================================
   * PART 8相当: メインの認識・再生ループ
   * (push/pushQuickがasyncになったことに伴うawaitの追加、
   * song.fileHandle -> song.filePath、forceRecheck()がhashLookupFnを
   * 使うようになった点以外はブラウザ版から無変更)
   * ========================================================================== */
  class RecognitionApp {
    constructor({ songsById, hashLookupFn, config, videoEl, onStatus, mic }) {
      this.songsById = songsById;
      this.config = config;
      this.onStatus = onStatus;
      this.mic = mic;
      this.recognizer = new StreamingRecognizer(hashLookupFn, config);
      this.player = new VideoPlayer(videoEl, config);
      this.timer = null;
      this.busy = false;
      this.lastMatchedWallclock = 0;
      this.noMatchGraceSeconds = 6;
      this.running = false;
      this.quickTimer = null;
      this.quickBusy = false;
      this.quickPollIntervalSeconds = config.quickPollIntervalSeconds || 1;
      this.silenceBlackoutSeconds = config.silenceBlackoutSeconds || 10;
      this.manualBlackout = false;
    }

    start() {
      this.running = true;
      this.timer = setInterval(() => this.tick(), this.config.pollIntervalSeconds * 1000);
      this.quickTimer = setInterval(() => this.quickTick(), this.quickPollIntervalSeconds * 1000);
    }

    stop() {
      this.running = false;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      if (this.quickTimer) clearInterval(this.quickTimer);
      this.quickTimer = null;
      this.player.stop();
      this.recognizer.reset();
      this.manualBlackout = false;
      if (this.player.blackedOut) this.player.setBlackout(false);
      this.lastMatchedWallclock = 0;
    }

    async tick() {
      if (this.busy) return;
      this.busy = true;
      try {
        const silenceSeconds = this.mic.getSilenceDurationSeconds();
        if (!this.manualBlackout) {
          const shouldBlackout = silenceSeconds >= this.silenceBlackoutSeconds;
          if (shouldBlackout !== this.player.blackedOut) {
            this.player.setBlackout(shouldBlackout);
          }
        }

        const buf = this.mic.getRecentAudio(this.config.queryWindowSeconds);
        if (!buf) {
          this.onStatus({ running: true, silenceSeconds, blackout: this.player.blackedOut });
          return;
        }
        const resampled = await resampleTo(buf.samples, buf.sampleRate, TARGET_SAMPLE_RATE);
        const hashes = fingerprintSamples(resampled);
        const state = await this.recognizer.push(hashes, buf.wallclockStart);

        const lockedMatch = state.lockedMatch;
        const candLines = state.candidates.map(([id, score]) => {
          const s = this.songsById.get(id);
          return `song_id=${id} (${s ? s.title : '?'})  score=${score}`;
        });

        if (lockedMatch) {
          this.lastMatchedWallclock = Date.now() / 1000;
          const song = this.songsById.get(lockedMatch.songId);
          const videoPos = lockedMatch.referencePositionAt(Date.now() / 1000);
          this.onStatus({
            running: true, locked: true, title: song ? song.title : null, score: lockedMatch.score,
            videoPos, candidates: candLines, error: null, silenceSeconds, blackout: this.player.blackedOut,
          });
          if (song && song.filePath) {
            if (this.player.currentSongId !== song.id) {
              await this.player.playSong(song.id, song.filePath, videoPos);
            } else {
              this.player.syncTo(videoPos);
            }
          }
        } else {
          this.onStatus({ running: true, locked: false, candidates: candLines, silenceSeconds, blackout: this.player.blackedOut });
          if (this.player.currentSongId !== null && (Date.now() / 1000 - this.lastMatchedWallclock) > this.noMatchGraceSeconds) {
            this.player.pause();
          }
        }
      } catch (err) {
        this.onStatus({ running: true, error: (err && err.message) ? err.message : String(err) });
      } finally {
        this.busy = false;
      }
    }

    async quickTick() {
      if (this.quickBusy) return;
      if (!this.recognizer.locked) return;
      this.quickBusy = true;
      try {
        const quickWindowSeconds = Math.min(this.config.quickWindowSeconds || 3, this.config.queryWindowSeconds);
        const buf = this.mic.getRecentAudio(quickWindowSeconds);
        if (!buf) return;
        const resampled = await resampleTo(buf.samples, buf.sampleRate, TARGET_SAMPLE_RATE);
        const quickHashes = fingerprintSamples(resampled);
        const quickMinConfidence = Math.max(
          4,
          Math.round(this.config.minConfidence * (quickWindowSeconds / this.config.queryWindowSeconds))
        );
        const fastSwitch = await this.recognizer.pushQuick(quickHashes, buf.wallclockStart, quickMinConfidence);
        if (!fastSwitch) return;

        this.lastMatchedWallclock = Date.now() / 1000;
        if (this.player.blackedOut && !this.manualBlackout) this.player.setBlackout(false);
        const song = this.songsById.get(fastSwitch.songId);
        const videoPos = fastSwitch.referencePositionAt(Date.now() / 1000);
        if (song && song.filePath) {
          if (this.player.currentSongId !== song.id) {
            await this.player.playSong(song.id, song.filePath, videoPos);
          } else {
            this.player.syncTo(videoPos);
          }
        }
        this.onStatus({
          running: true, locked: true, title: song ? song.title : null, score: fastSwitch.score,
          videoPos, error: null, blackout: this.player.blackedOut,
        });
      } catch (err) {
        console.error('クイックスキャン中にエラーが発生しました', err);
      } finally {
        this.quickBusy = false;
      }
    }

    async forceRecheck() {
      if (!this.running) return { ok: false, reason: 'not-running' };
      const buf = this.mic.getRecentAudio(this.config.queryWindowSeconds);
      if (!buf) return { ok: false, reason: 'no-audio' };
      const resampled = await resampleTo(buf.samples, buf.sampleRate, TARGET_SAMPLE_RATE);
      const hashes = fingerprintSamples(resampled);
      const hashIndex = await this.recognizer.hashLookupFn(hashes);
      const result = matchHashes(hashIndex, hashes, this.config.minConfidence);
      if (!result.matched) return { ok: false, reason: 'no-match' };

      const matchResult = this.recognizer._makeMatchResult(result, buf.wallclockStart);
      this.recognizer.locked = matchResult;
      this.recognizer.history = [matchResult];
      this.recognizer.quickHistory = [];
      this.lastMatchedWallclock = Date.now() / 1000;

      if (this.player.blackedOut && !this.manualBlackout) this.player.setBlackout(false);

      const song = this.songsById.get(matchResult.songId);
      const videoPos = matchResult.referencePositionAt(Date.now() / 1000);
      if (song && song.filePath) {
        await this.player.playSong(song.id, song.filePath, videoPos);
      }
      this.onStatus({
        running: true, locked: true, title: song ? song.title : null, score: matchResult.score,
        videoPos, error: null, blackout: this.player.blackedOut,
      });
      return { ok: true, songId: matchResult.songId, title: song ? song.title : null };
    }

    setManualBlackout(flag) {
      this.manualBlackout = flag;
      if (flag) {
        this.player.setBlackout(true);
      } else {
        const silenceSeconds = this.mic.getSilenceDurationSeconds();
        this.player.setBlackout(silenceSeconds >= this.silenceBlackoutSeconds);
      }
    }
  }

  /* ==========================================================================
   * PART 9相当: UI配線
   * ========================================================================== */
  const state = {
    roots: [],           // [{key, label, path}]
    songsById: new Map(),
    config: {
      micDeviceId: null,
      queryWindowSeconds: 8,
      pollIntervalSeconds: 2,
      minConfidence: 8,
      agreementRequired: 2,
      agreementToleranceSeconds: 1.5,
      quickWindowSeconds: 3,
      quickPollIntervalSeconds: 1,
      silenceRmsThreshold: 0.01,
      silenceBlackoutSeconds: 10,
      unmuteVideoAudio: false,
    },
    app: null,
    mic: null,
    buildStopFlag: false,
  };

  function checkAppSupport() {
    const badge = document.getElementById('browserSupportBadge');
    const missing = [];
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) missing.push('マイク(getUserMedia)');
    if (!window.anisong) missing.push('デスクトップ連携機能');
    if (missing.length) {
      badge.textContent = '⚠ 非対応の機能: ' + missing.join(' / ');
      badge.style.color = 'var(--danger)';
    } else {
      badge.textContent = '✓ デスクトップ版として動作しています';
      badge.style.color = 'var(--accent-2)';
    }
  }

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
  });

  function log(elId, message) {
    const el = document.getElementById(elId);
    el.textContent += message + '\n';
    el.scrollTop = el.scrollHeight;
  }

  // ---- ライブラリ: フォルダ管理 ----
  function renderRootsList() {
    const ul = document.getElementById('rootsList');
    ul.innerHTML = '';
    if (state.roots.length === 0) {
      ul.innerHTML = '<li style="color:var(--text-dim);">まだフォルダが追加されていません</li>';
      return;
    }
    for (const root of state.roots) {
      const li = document.createElement('li');
      const left = document.createElement('span');
      left.textContent = root.label + '  (' + root.path + ')';
      const right = document.createElement('span');
      const delBtn = document.createElement('button');
      delBtn.className = 'btn secondary';
      delBtn.textContent = '削除';
      delBtn.addEventListener('click', async () => {
        await window.anisong.removeRoot(root.key);
        state.roots = await window.anisong.listRoots();
        renderRootsList();
      });
      right.appendChild(delBtn);
      li.appendChild(left);
      li.appendChild(right);
      ul.appendChild(li);
    }
  }

  document.getElementById('addRootBtn').addEventListener('click', async () => {
    try {
      const root = await window.anisong.pickFolder();
      if (!root) return; // キャンセル
      state.roots = await window.anisong.listRoots();
      renderRootsList();
    } catch (e) {
      alert('フォルダの選択に失敗しました: ' + ((e && e.message) || e));
    }
  });

  document.getElementById('reloadRootsBtn').addEventListener('click', async () => {
    state.roots = await window.anisong.listRoots();
    renderRootsList();
  });

  // ---- ライブラリ構築 ----
  document.getElementById('buildBtn').addEventListener('click', async () => {
    if (state.roots.length === 0) { alert('先に「フォルダを追加」してください。'); return; }
    const buildBtn = document.getElementById('buildBtn');
    const stopBtn = document.getElementById('buildStopBtn');
    buildBtn.disabled = true;
    stopBtn.disabled = false;
    stopBtn.textContent = '中断';
    state.buildStopFlag = false;
    document.getElementById('buildLog').textContent = '';

    const maxDurRaw = document.getElementById('maxDurationInput').value;
    const maxDuration = maxDurRaw ? parseFloat(maxDurRaw) : null;

    const dedupeKeys = new Set(Array.from(state.songsById.values()).map((s) => s.dedupeKey));
    let okCount = 0, skipCount = 0, failCount = 0;

    try {
      for (const root of state.roots) {
        let files;
        try {
          files = await window.anisong.listFiles(root.path);
        } catch (e) {
          log('buildLog', `[警告] ${root.label} の走査に失敗しました: ${(e && e.message) || e}`);
          continue;
        }

        for (const { absPath, relativePath } of files) {
          if (state.buildStopFlag) { log('buildLog', '⏹ 中断しました（ここまでの内容を保存済みです）。'); break; }
          const dedupeKey = root.key + '::' + relativePath;
          if (dedupeKeys.has(dedupeKey)) { skipCount++; log('buildLog', `スキップ（登録済み）: ${relativePath}`); continue; }

          log('buildLog', `解析中: ${relativePath} ...`);
          try {
            if (state.buildStopFlag) { log('buildLog', '⏹ 中断しました（ここまでの内容を保存済みです）。'); break; }
            const arrayBuffer = await window.anisong.readFileBytes(absPath);
            if (state.buildStopFlag) { log('buildLog', '⏹ 中断しました（ここまでの内容を保存済みです）。'); break; }
            const resampled = await decodeAndResampleArrayBuffer(arrayBuffer, maxDuration);
            if (!resampled || resampled.length === 0) { log('buildLog', '  -> 音声データが空でした'); failCount++; continue; }
            const hashes = fingerprintSamples(resampled);
            if (!hashes.length) { log('buildLog', '  -> 指紋を生成できませんでした'); failCount++; continue; }

            const title = guessTitle(relativePath);
            const durationSeconds = resampled.length / TARGET_SAMPLE_RATE;
            const songRecord = { title, dedupeKey, relativePath, rootKey: root.key, rootLabel: root.label, filePath: absPath, durationSeconds };
            // SQLite側でIDが自動採番される(AUTOINCREMENT)。1曲ごとにこの1回の
            // 呼び出しだけで曲メタ情報とハッシュがまとめて永続化されるため、
            // ブラウザ版のような「逐次保存」の作り込みは不要になった。
            const songId = await window.anisong.addSong(songRecord, hashes);
            songRecord.id = songId;
            state.songsById.set(songId, songRecord);
            dedupeKeys.add(dedupeKey);
            okCount++;
            log('buildLog', `  -> 登録完了・保存済み (ハッシュ数=${hashes.length})`);
            updateLibSummary();
          } catch (err) {
            failCount++;
            log('buildLog', `  -> エラー: ${(err && err.message) || err}`);
          }
        }
        if (state.buildStopFlag) break;
      }

      log('buildLog', `完了: 新規登録=${okCount}, スキップ=${skipCount}, 失敗=${failCount}`);
    } catch (err) {
      log('buildLog', `[エラー] ライブラリ構築が予期せず停止しました: ${(err && err.message) || err}`);
    } finally {
      updateLibSummary();
      buildBtn.disabled = false;
      stopBtn.disabled = true;
      stopBtn.textContent = '中断';
    }
  });

  document.getElementById('buildStopBtn').addEventListener('click', () => {
    if (state.buildStopFlag) return;
    state.buildStopFlag = true;
    const stopBtn = document.getElementById('buildStopBtn');
    stopBtn.disabled = true;
    stopBtn.textContent = '中断中...';
    log('buildLog', '⏸ 中断をリクエストしました。処理中のファイルの解析が一段落し次第、停止します。');
  });

  function updateLibSummary() {
    document.getElementById('libSummary').textContent = `登録曲数: ${state.songsById.size}`;
  }

  // ---- ブラウザ版からのライブラリインポート ----
  document.getElementById('importLibraryBtn').addEventListener('click', async () => {
    try {
      const filePath = await window.anisong.pickExportFile();
      if (!filePath) return;
      const btn = document.getElementById('importLibraryBtn');
      btn.disabled = true;
      document.getElementById('importLog').textContent = '';
      log('importLog', `インポートを開始します: ${filePath}`);
      log('importLog', 'エクスポート元のフォルダ名ごとに、対応するフォルダの選択を求められます。');
      const removeListener = window.anisong.onImportProgress(({ songsDone, songCount }) => {
        document.getElementById('importLog').lastChild;
        log('importLog', `進捗: ${songsDone} / ${songCount || '?'} 曲`);
      });
      const result = await window.anisong.importLibrary(filePath);
      removeListener();
      log('importLog', `完了: インポート=${result.importedCount}, スキップ(重複等)=${result.skippedCount}, 対象曲数=${result.songCount}`);
      const songs = await window.anisong.listSongs();
      state.songsById = new Map(songs.map((s) => [s.id, s]));
      updateLibSummary();
      btn.disabled = false;
    } catch (e) {
      alert('インポート中にエラーが発生しました: ' + ((e && e.message) || e));
      document.getElementById('importLibraryBtn').disabled = false;
    }
  });

  // ---- 設定 ----
  function loadConfigIntoForm() {
    document.getElementById('cfgQueryWindow').value = state.config.queryWindowSeconds;
    document.getElementById('cfgPollInterval').value = state.config.pollIntervalSeconds;
    document.getElementById('cfgMinConfidence').value = state.config.minConfidence;
    document.getElementById('cfgAgreementRequired').value = state.config.agreementRequired;
    document.getElementById('cfgQuickWindow').value = state.config.quickWindowSeconds;
    document.getElementById('cfgQuickPollInterval').value = state.config.quickPollIntervalSeconds;
    document.getElementById('cfgSilenceThreshold').value = state.config.silenceRmsThreshold;
    document.getElementById('cfgSilenceSeconds').value = state.config.silenceBlackoutSeconds;
    document.getElementById('cfgUnmute').checked = state.config.unmuteVideoAudio;
  }

  async function refreshMicList() {
    try {
      const tmpStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      tmpStream.getTracks().forEach((t) => t.stop());
    } catch (e) { /* 許可が得られなくても一覧取得は試みる */ }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const select = document.getElementById('micSelect');
    select.innerHTML = '<option value="">(既定のマイク)</option>';
    devices.filter((d) => d.kind === 'audioinput').forEach((d) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `マイク (${d.deviceId.slice(0, 8)})`;
      select.appendChild(opt);
    });
    if (state.config.micDeviceId) select.value = state.config.micDeviceId;
  }

  document.getElementById('refreshMicBtn').addEventListener('click', refreshMicList);

  document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
    state.config.queryWindowSeconds = parseFloat(document.getElementById('cfgQueryWindow').value) || 8;
    state.config.pollIntervalSeconds = parseFloat(document.getElementById('cfgPollInterval').value) || 2;
    state.config.minConfidence = parseInt(document.getElementById('cfgMinConfidence').value, 10) || 8;
    state.config.agreementRequired = parseInt(document.getElementById('cfgAgreementRequired').value, 10) || 2;
    state.config.quickWindowSeconds = parseFloat(document.getElementById('cfgQuickWindow').value) || 3;
    state.config.quickPollIntervalSeconds = parseFloat(document.getElementById('cfgQuickPollInterval').value) || 1;
    state.config.silenceRmsThreshold = parseFloat(document.getElementById('cfgSilenceThreshold').value);
    if (!(state.config.silenceRmsThreshold >= 0)) state.config.silenceRmsThreshold = 0.01;
    state.config.silenceBlackoutSeconds = parseFloat(document.getElementById('cfgSilenceSeconds').value) || 10;
    state.config.unmuteVideoAudio = document.getElementById('cfgUnmute').checked;
    state.config.micDeviceId = document.getElementById('micSelect').value || null;
    await window.anisong.saveConfig(state.config);
    if (state.mic) {
      state.mic.silenceThresholdRms = state.config.silenceRmsThreshold;
    }
    if (state.app) {
      state.app.silenceBlackoutSeconds = state.config.silenceBlackoutSeconds;
      if (state.app.quickPollIntervalSeconds !== state.config.quickPollIntervalSeconds) {
        state.app.quickPollIntervalSeconds = state.config.quickPollIntervalSeconds;
        if (state.app.quickTimer) clearInterval(state.app.quickTimer);
        state.app.quickTimer = setInterval(() => state.app.quickTick(), state.app.quickPollIntervalSeconds * 1000);
      }
    }
    alert('設定を保存しました。');
  });

  document.getElementById('clearAllBtn').addEventListener('click', async () => {
    if (!confirm('保存されたライブラリ・フォルダ・設定をすべて削除します。よろしいですか？')) return;
    await window.anisong.clearAllData();
    location.reload();
  });

  // ---- 認識・再生 ----
  const videoEl = document.getElementById('previewVideo');
  videoEl.addEventListener('error', () => {
    document.getElementById('stError').textContent = '動画の再生に失敗しました（対応していないコーデックの可能性があります）';
  });

  function renderStatus(s) {
    if (s.running !== undefined) document.getElementById('stRunning').textContent = s.running ? '実行中' : '停止中';
    if (s.title !== undefined) document.getElementById('stTitle').textContent = s.title || '-';
    if (s.score !== undefined) document.getElementById('stScore').textContent = s.locked ? String(s.score) : '- (未確定)';
    if (s.videoPos !== undefined) document.getElementById('stPos').textContent = s.videoPos != null ? s.videoPos.toFixed(1) + ' 秒' : '-';
    if (s.error !== undefined) document.getElementById('stError').textContent = s.error || '-';
    if (s.candidates) document.getElementById('candidatesLog').textContent = s.candidates.join('\n');
    if (s.silenceSeconds !== undefined) {
      const el = document.getElementById('stSilence');
      if (s.silenceSeconds == null) {
        el.textContent = '-';
        el.className = 'value';
      } else if (s.blackout) {
        el.textContent = `⚫ 無音 ${s.silenceSeconds.toFixed(1)}秒（黒画面）`;
        el.className = 'value err';
      } else {
        el.textContent = s.silenceSeconds < 0.5 ? '音あり' : `無音 ${s.silenceSeconds.toFixed(1)}秒`;
        el.className = 'value';
      }
    }
  }

  document.getElementById('startBtn').addEventListener('click', async () => {
    if (state.songsById.size === 0) {
      alert('先に右側の「ライブラリ」欄でフォルダを追加し、ライブラリを構築してください。');
      return;
    }

    try {
      const mic = new MicCapture();
      mic.silenceThresholdRms = state.config.silenceRmsThreshold;
      await mic.start(state.config.micDeviceId || undefined);
      state.mic = mic;

      state.app = new RecognitionApp({
        songsById: state.songsById,
        hashLookupFn: buildTickHashIndex,
        config: state.config,
        videoEl,
        onStatus: renderStatus,
        mic,
      });
      state.app.start();
      state.app.player.onSourceChanged = refreshNdiPopupStream;
      state.app.player.onBlackoutChanged = setNdiPopupBlackout;
      document.getElementById('startBtn').disabled = true;
      document.getElementById('stopBtn').disabled = false;
      document.getElementById('manualRecheckBtn').disabled = false;
      document.getElementById('manualBlackoutBtn').disabled = false;
      renderStatus({ running: true, error: null });
    } catch (e) {
      if (state.mic) { state.mic.stop(); state.mic = null; }
      state.app = null;
      alert('開始できませんでした: ' + ((e && e.message) || e));
    }
  });

  document.getElementById('stopBtn').addEventListener('click', () => {
    if (state.app) { state.app.stop(); state.app = null; }
    if (state.mic) { state.mic.stop(); state.mic = null; }
    document.getElementById('startBtn').disabled = false;
    document.getElementById('stopBtn').disabled = true;
    document.getElementById('manualRecheckBtn').disabled = true;
    document.getElementById('manualBlackoutBtn').disabled = true;
    setManualBlackoutBtnLabel(false);
    renderStatus({ running: false, title: '-', score: '-', videoPos: null, error: null, locked: false, silenceSeconds: null });
    setNdiPopupBlackout(false);
  });

  document.getElementById('fullscreenBtn').addEventListener('click', () => {
    if (videoEl.requestFullscreen) videoEl.requestFullscreen();
    else if (videoEl.webkitRequestFullscreen) videoEl.webkitRequestFullscreen();
  });

  // ---- 手動操作: 現在の音を再読み込み / 手動で黒画面 ----
  document.getElementById('manualRecheckBtn').addEventListener('click', async () => {
    if (!state.app) return;
    const btn = document.getElementById('manualRecheckBtn');
    btn.disabled = true;
    try {
      const result = await state.app.forceRecheck();
      if (!result.ok) {
        const reasonText = {
          'not-running': '認識が開始されていません。',
          'no-audio': 'マイクの音声がまだ十分に集まっていません。少し待ってから再度お試しください。',
          'no-match': '今聞こえている音と一致する曲が見つかりませんでした。',
        }[result.reason] || '再読み込みに失敗しました。';
        alert(reasonText);
      }
    } catch (e) {
      alert('再読み込み中にエラーが発生しました: ' + ((e && e.message) || e));
    } finally {
      btn.disabled = false;
    }
  });

  function setManualBlackoutBtnLabel(flag) {
    const btn = document.getElementById('manualBlackoutBtn');
    if (flag) {
      btn.textContent = '⚫ 黒画面を解除（自動判定に戻す）';
      btn.classList.remove('secondary');
    } else {
      btn.textContent = '⚫ 手動で黒画面にする';
      btn.classList.add('secondary');
    }
  }

  document.getElementById('manualBlackoutBtn').addEventListener('click', () => {
    if (!state.app) return;
    const next = !state.app.manualBlackout;
    state.app.setManualBlackout(next);
    setManualBlackoutBtnLabel(next);
  });

  // ---- NDI出力用ポップアップウィンドウ(ブラウザ版から無変更) ----
  let ndiPopup = null;
  let ndiPopupVideo = null;
  let ndiPopupOverlay = null;

  function refreshNdiPopupStream() {
    if (!ndiPopup || ndiPopup.closed || !ndiPopupVideo) return;
    try {
      const captureFn = videoEl.captureStream || videoEl.mozCaptureStream;
      if (!captureFn) {
        ndiPopup.document.body.textContent = 'captureStream() に対応していません。';
        return;
      }
      const stream = captureFn.call(videoEl);
      ndiPopupVideo.srcObject = stream;
      ndiPopupVideo.play().catch(() => {});
    } catch (e) {
      console.error('NDI出力ウィンドウの更新に失敗しました', e);
    }
  }

  let ndiSeekRefreshTimer = null;
  videoEl.addEventListener('seeked', () => {
    if (!ndiPopup || ndiPopup.closed) return;
    if (ndiSeekRefreshTimer) clearTimeout(ndiSeekRefreshTimer);
    ndiSeekRefreshTimer = setTimeout(() => { refreshNdiPopupStream(); }, 300);
  });

  let ndiWatchdogTimer = null;
  let ndiWatchdogLastTime = null;

  function startNdiWatchdog() {
    stopNdiWatchdog();
    ndiWatchdogLastTime = null;
    ndiWatchdogTimer = setInterval(() => {
      if (!ndiPopup || ndiPopup.closed || !ndiPopupVideo) { stopNdiWatchdog(); return; }
      if (videoEl.paused || videoEl.readyState < 2) { ndiWatchdogLastTime = null; return; }
      if (ndiPopupVideo.paused) {
        ndiPopupVideo.play().catch(() => {});
        ndiWatchdogLastTime = null;
        return;
      }
      const cur = ndiPopupVideo.currentTime;
      if (ndiWatchdogLastTime !== null && Math.abs(cur - ndiWatchdogLastTime) < 0.05) {
        console.warn('NDI出力ウィンドウの映像が停止しているようです。自動的に再接続します。');
        refreshNdiPopupStream();
        ndiWatchdogLastTime = null;
      } else {
        ndiWatchdogLastTime = cur;
      }
    }, 3000);
  }

  function stopNdiWatchdog() {
    if (ndiWatchdogTimer) clearInterval(ndiWatchdogTimer);
    ndiWatchdogTimer = null;
  }

  function setNdiPopupBlackout(flag) {
    if (!ndiPopup || ndiPopup.closed || !ndiPopupOverlay) return;
    ndiPopupOverlay.style.display = flag ? 'block' : 'none';
  }

  document.getElementById('ndiWindowBtn').addEventListener('click', () => {
    if (ndiPopup && !ndiPopup.closed) {
      refreshNdiPopupStream();
      ndiPopup.focus();
      return;
    }
    const w = 1280, h = 720;
    ndiPopup = window.open('', 'ndiOutputWindow', `width=${w},height=${h},toolbar=no,menubar=no,location=no,status=no,resizable=yes`);
    if (!ndiPopup) {
      alert('ポップアップウィンドウを開けませんでした。');
      return;
    }
    ndiPopup.document.title = 'NDI出力ウィンドウ - Anime Seeker';
    ndiPopup.document.body.style.margin = '0';
    ndiPopup.document.body.style.background = '#000';
    ndiPopup.document.body.style.overflow = 'hidden';
    ndiPopup.document.body.style.position = 'relative';
    ndiPopupVideo = ndiPopup.document.createElement('video');
    ndiPopupVideo.autoplay = true;
    ndiPopupVideo.style.width = '100%';
    ndiPopupVideo.style.height = '100%';
    ndiPopupVideo.style.objectFit = 'contain';
    ndiPopupVideo.muted = videoEl.muted;
    ndiPopup.document.body.appendChild(ndiPopupVideo);

    ndiPopupOverlay = ndiPopup.document.createElement('div');
    ndiPopupOverlay.style.position = 'absolute';
    ndiPopupOverlay.style.top = '0';
    ndiPopupOverlay.style.left = '0';
    ndiPopupOverlay.style.right = '0';
    ndiPopupOverlay.style.bottom = '0';
    ndiPopupOverlay.style.background = '#000';
    ndiPopupOverlay.style.display = 'none';
    ndiPopup.document.body.appendChild(ndiPopupOverlay);

    refreshNdiPopupStream();
    setNdiPopupBlackout(state.app && state.app.player ? state.app.player.blackedOut : false);
    startNdiWatchdog();
  });

  // ---- 初期化 ----
  async function init() {
    checkAppSupport();

    state.roots = await window.anisong.listRoots();
    renderRootsList();

    const noticeCard = document.getElementById('startupNoticeCard');
    const notice = document.getElementById('startupNotice');

    // SQLiteはメタデータ(曲一覧)しか読み込まないため、ブラウザ版のような
    // 「数十秒かかることがある読み込み」は発生しない(数百〜数千曲でも一瞬)。
    const songs = await window.anisong.listSongs();
    state.songsById = new Map(songs.map((s) => [s.id, s]));
    updateLibSummary();

    if (state.songsById.size > 0) {
      noticeCard.style.display = 'block';
      notice.textContent =
        `保存されているライブラリを読み込みました（登録曲数: ${state.songsById.size}）。` +
        'フォルダの選択やライブラリの構築をやり直す必要はありません。このまま「▶ 開始」を押せます。' +
        '新しい動画を追加した時だけ右側の「ライブラリ」欄で構築/更新してください。';
    } else if (state.roots.length > 0) {
      noticeCard.style.display = 'block';
      notice.textContent =
        'フォルダは登録されていますが、まだライブラリが構築されていません。' +
        '右側の「ライブラリ構築」で「ライブラリを構築 / 更新」を一度実行してください（次回以降は不要です）。';
    } else {
      noticeCard.style.display = 'block';
      notice.textContent =
        'はじめてお使いの場合は、右側の「ライブラリインポート」でブラウザ版から' +
        'エクスポートしたファイルを取り込むか、「スキャン対象フォルダ」でフォルダを' +
        '追加してライブラリを構築してください。';
    }

    const savedConfig = await window.anisong.loadConfig();
    if (savedConfig) Object.assign(state.config, savedConfig);
    loadConfigIntoForm();
    refreshMicList().catch(() => {});
  }

  init().catch((e) => {
    console.error(e);
    alert('初期化中にエラーが発生しました: ' + ((e && e.message) || e));
  });
})();
