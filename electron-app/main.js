/* ============================================================================
 * main.js — Electronメインプロセス
 * ----------------------------------------------------------------------------
 * フォルダ選択・ファイル走査・ファイル読み込み・SQLite永続化・設定/曲メタ
 * データCRUD・ライブラリインポートを担当する。レンダラはpreload.js経由の
 * IPCでこれらを呼び出す(ブラウザ版のFile System Access API / IndexedDBの
 * 置き換え)。
 * ========================================================================== */
'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

const db = require('./db.js');
const scan = require('./scan.js');
const { importLibraryFromNdjson } = require('./importExport.js');

const USER_DATA_DIR = app.getPath('userData');
const DB_PATH = path.join(USER_DATA_DIR, 'library.sqlite');

let mainWindow = null;
let hashDb = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  hashDb = db.openHashDb(DB_PATH);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (hashDb) db.closeHashDb(hashDb);
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// フォルダ選択・一覧
// ---------------------------------------------------------------------------
ipcMain.handle('folder:pick', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled || result.filePaths.length === 0) return null;
  const folderPath = result.filePaths[0];
  const label = path.basename(folderPath) || folderPath;
  const key = 'root_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const root = { key, label, path: folderPath };
  db.upsertRoot(hashDb, root);
  return root;
});

ipcMain.handle('roots:list', async () => db.listRoots(hashDb));

ipcMain.handle('roots:remove', async (_e, key) => {
  db.removeRoot(hashDb, key);
  return true;
});

// ---------------------------------------------------------------------------
// ライブラリ構築(走査・進捗通知)。実際のデコード・指紋生成はレンダラ側
// (Web Audio APIが使えるのはレンダラのみ)。メインは「ファイル一覧の列挙」と
// 「生バイト列の読み込み」だけを担当する。中断フラグ・1件ずつのtry/catch・
// 逐次保存といったブラウザ版PART9の制御フローは、そのままレンダラ側の
// JS変数(state.buildStopFlag)として残す(ボタンのクリックとチェックが
// 同じレンダラプロセス内で完結するため、IPCを挟む必要が無い)。
// ---------------------------------------------------------------------------
ipcMain.handle('library:listFiles', async (_e, rootPath) => {
  return scan.walkFiles(rootPath);
});

ipcMain.handle('library:addSong', async (_e, { song, hashes }) => {
  return db.addSongWithHashes(hashDb, song, hashes);
});

ipcMain.handle('library:listSongs', async () => db.listSongs(hashDb));

ipcMain.handle('library:deleteSong', async (_e, songId) => {
  db.deleteSong(hashDb, songId);
  return true;
});

ipcMain.handle('library:clearAll', async () => {
  db.clearAll(hashDb);
  return true;
});

ipcMain.handle('file:readBytes', async (_e, absPath) => {
  const buf = await fs.readFile(absPath);
  // ArrayBufferとしてレンダラへ渡す(構造化複製でコピーされる)。
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

// ---------------------------------------------------------------------------
// ハッシュ検索(認識の1ティックごとのホットパス)
// ---------------------------------------------------------------------------
ipcMain.handle('hashes:lookup', async (_e, hashValues) => {
  return db.lookupHashes(hashDb, hashValues);
});

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------
ipcMain.handle('config:load', async () => db.loadConfig(hashDb));
ipcMain.handle('config:save', async (_e, config) => {
  db.saveConfig(hashDb, config);
  return true;
});

// ---------------------------------------------------------------------------
// 動画URL解決
// ---------------------------------------------------------------------------
ipcMain.handle('video:toUrl', async (_e, absPath) => {
  return pathToFileURL(absPath).href;
});

// ---------------------------------------------------------------------------
// ブラウザ版からのライブラリインポート(NDJSON)
// ---------------------------------------------------------------------------
ipcMain.handle('import:pickFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'NDJSON', extensions: ['ndjson', 'jsonl', 'txt'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// rootLabel(エクスポート元のフォルダ表示名)ごとに、インポート先の実フォルダを
// 1回だけ選んでもらい、それ以降は相対パスを結合して絶対パスを解決する。
ipcMain.handle('import:run', async (_e, ndjsonPath) => {
  const rootPathCache = new Map(); // rootKey -> 絶対パス(未選択ならnull)

  const resolveFilePath = (songObj) => {
    let rootAbs = rootPathCache.get(songObj.rootKey);
    if (rootAbs === undefined) {
      // 同期的にフォルダ選択ダイアログを出す(インポート中に1回だけ、
      // rootKeyごとに聞く)。
      const result = dialog.showOpenDialogSync(mainWindow, {
        title: `「${songObj.rootLabel}」に対応するフォルダを選択してください`,
        properties: ['openDirectory'],
      });
      rootAbs = (result && result[0]) || null;
      rootPathCache.set(songObj.rootKey, rootAbs);
    }
    if (!rootAbs) return null;
    const relParts = String(songObj.relativePath).split('/');
    return path.join(rootAbs, ...relParts);
  };

  const onProgress = (songsDone, songCount) => {
    if (mainWindow) mainWindow.webContents.send('import:progress', { songsDone, songCount });
  };

  return importLibraryFromNdjson(hashDb, ndjsonPath, resolveFilePath, onProgress);
});
