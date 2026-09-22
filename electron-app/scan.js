/* ============================================================================
 * scan.js — フォルダ走査(ブラウザ版PART4のFile System Access APIの置き換え)
 * ----------------------------------------------------------------------------
 * ブラウザ版の walkFiles()(FileSystemDirectoryHandleを再帰的に辿る)を、
 * Node.jsの fs.promises.readdir({recursive:true}) を使った実装に置き換える。
 * ========================================================================== */
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

// ブラウザ版と同じ拡張子セット(PART4のMEDIA_EXT_RE相当)。
const MEDIA_EXT_RE = /\.(mp4|webm|mkv|m4v)$/i;

// root配下を再帰的に走査し、対応拡張子のファイルを列挙する。
// 戻り値: [{ absPath, relativePath }, ...] (relativePathはrootからの相対パス、
// スラッシュ区切りに正規化する。ブラウザ版のdedupeKey生成と互換にするため)
async function walkFiles(rootPath) {
  const results = [];
  let entries;
  try {
    entries = await fs.readdir(rootPath, { withFileTypes: true, recursive: true });
  } catch (e) {
    throw new Error(`フォルダの走査に失敗しました: ${rootPath} (${e.message})`);
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!MEDIA_EXT_RE.test(entry.name)) continue;
    // Node 20+ の fs.readdir recursive:true では entry.parentPath (無ければ
    // entry.path、さらに古い場合はfallback)が実際の親ディレクトリの絶対パスを
    // 返す。
    const parentAbs = entry.parentPath || entry.path || rootPath;
    const absPath = path.join(parentAbs, entry.name);
    const relativePath = path.relative(rootPath, absPath).split(path.sep).join('/');
    results.push({ absPath, relativePath });
  }
  // ブラウザ版のwalkFiles()と同じく、ある程度安定した順序で返す
  results.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  return results;
}

// ブラウザ版PART4のguessTitle()と全く同じロジック(拡張子除去・アンダースコア
// とスラッシュをスペースに置換)。相対パス全体(サブフォルダ名も含む)から
// タイトルを推測する挙動も含めて完全に一致させる。
function guessTitle(relativePath) {
  return relativePath.replace(/\.[^./]+$/, '').replace(/[_/]/g, ' ').trim();
}

module.exports = { walkFiles, guessTitle, MEDIA_EXT_RE };
