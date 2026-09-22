/* ============================================================================
 * preload.js — レンダラに公開するIPC窓口(contextBridge)
 * ----------------------------------------------------------------------------
 * ブラウザ版のPART2(IndexedDB)・PART4(File System Access API)が担っていた
 * 役割を、window.anisong.* という狭いAPI面に置き換えて公開する。
 * contextIsolation を有効にしたまま(nodeIntegration: false)、必要な機能
 * だけをレンダラへ渡す。
 * ========================================================================== */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('anisong', {
  // ---- フォルダ ----
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  listRoots: () => ipcRenderer.invoke('roots:list'),
  removeRoot: (key) => ipcRenderer.invoke('roots:remove', key),

  // ---- ライブラリ構築 ----
  listFiles: (rootPath) => ipcRenderer.invoke('library:listFiles', rootPath),
  addSong: (song, hashes) => ipcRenderer.invoke('library:addSong', { song, hashes }),
  listSongs: () => ipcRenderer.invoke('library:listSongs'),
  deleteSong: (songId) => ipcRenderer.invoke('library:deleteSong', songId),
  clearAllData: () => ipcRenderer.invoke('library:clearAll'),
  readFileBytes: (absPath) => ipcRenderer.invoke('file:readBytes', absPath),

  // ---- ハッシュ検索(認識のホットパス) ----
  lookupHashes: (hashValues) => ipcRenderer.invoke('hashes:lookup', hashValues),

  // ---- 設定 ----
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),

  // ---- 動画URL ----
  toVideoUrl: (absPath) => ipcRenderer.invoke('video:toUrl', absPath),

  // ---- ブラウザ版からのインポート ----
  pickExportFile: () => ipcRenderer.invoke('import:pickFile'),
  importLibrary: (ndjsonPath) => ipcRenderer.invoke('import:run', ndjsonPath),
  onImportProgress: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('import:progress', listener);
    return () => ipcRenderer.removeListener('import:progress', listener);
  },
});
