// test/helpers/links.js — plant a directory link in a fixture on every platform.
//
// Windows without Developer Mode / SeCreateSymbolicLinkPrivilege refuses a plain `fs.symlinkSync`
// (EPERM). A directory junction is the unprivileged equivalent and `lstat().isSymbolicLink()` still
// reports true, so every "the loader must refuse a link" check keeps its meaning. File links cannot
// be junctions; use `tryFileLink` and skip when the OS refuses them.
import fs from 'node:fs';
import path from 'node:path';

const win = process.platform === 'win32';

/**
 * Directory (or file) link for a fixture. `type` is 'dir' (default) or 'file'.
 * @param {string} target existing path
 * @param {string} dest link to create
 * @param {'dir'|'file'} [type]
 */
export function link(target, dest, type = 'dir') {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (type === 'file') {
    fs.symlinkSync(target, dest);
    return;
  }
  fs.symlinkSync(target, dest, win ? 'junction' : 'dir');
}

/**
 * File link; returns false when the OS refuses (caller should skip that assertion).
 * @param {string} target
 * @param {string} dest
 */
export function tryFileLink(target, dest) {
  try {
    link(target, dest, 'file');
    return true;
  } catch {
    return false;
  }
}

/** Remove a directory/file link without following it (Windows junctions need unlink/rmdir, not rmSync). */
export function unlink(dest) {
  try { fs.unlinkSync(dest); } catch { fs.rmdirSync(dest); }
}
