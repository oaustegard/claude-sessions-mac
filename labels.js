// Project and branch for a session's working folder, read straight from the
// .git files so no git process is spawned. A linked worktree reports the name
// of its main repository, so `shop` sessions in different worktrees all read
// as "shop · <branch>".
'use strict';
const fs = require('fs/promises');
const path = require('path');

const MAX_DEPTH = 40;

async function readText(p) {
  try { return (await fs.readFile(p, 'utf8')).trim(); } catch { return null; }
}

async function stat(p) {
  try { return await fs.stat(p); } catch { return null; }
}

/** The branch name, or a short sha when HEAD is detached. */
async function branchOf(gitDir) {
  const head = await readText(path.join(gitDir, 'HEAD'));
  if (!head) return undefined;
  const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  if (m) return m[1];
  return /^[0-9a-f]{7,}$/i.test(head) ? head.slice(0, 7) : undefined;
}

/** Resolves {project, branch} for cwd; project falls back to the folder name. */
async function labelsFor(cwd) {
  const fallback = { project: path.basename(path.resolve(cwd)) || cwd, branch: undefined };
  let dir = path.resolve(cwd);
  for (let i = 0; i < MAX_DEPTH; i++) {
    const dotGit = path.join(dir, '.git');
    const st = await stat(dotGit);
    if (st && st.isDirectory()) {
      return { project: path.basename(dir), branch: await branchOf(dotGit) };
    }
    if (st && st.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec((await readText(dotGit)) || '');
      if (!m) return fallback;
      const gitDir = path.resolve(dir, m[1].trim());
      const common = await readText(path.join(gitDir, 'commondir'));
      // A worktree's commondir points at the main .git folder; a submodule has none.
      const project = common ? path.basename(path.dirname(path.resolve(gitDir, common))) : path.basename(dir);
      return { project, branch: await branchOf(gitDir) };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fallback;
}

module.exports = { labelsFor };
