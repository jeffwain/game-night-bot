// Tests for the release guards themselves.
//
// release-preflight.js and release-doctor.js exist to stop a bad release, so a
// silent regression in them is worse than not having them: you would trust a
// green preflight that no longer checks anything. Each case below builds a
// throwaway git repo in a specific broken shape and asserts the guard fires,
// with the message that tells you what to do.
//
// Node rather than shell so it runs on Windows too.
//
// Run with: npm test

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = mkdtempSync(path.join(tmpdir(), 'release-guards-'));

let pass = 0;
const failures = [];

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Run a guard script and capture exit code + BOTH streams.
//
// Warnings go to stderr even on a successful run, so capturing only stdout on
// exit 0 silently drops half of what these scripts say -- which is exactly the
// half the unreachable-origin case is about.
function run(cwd, script) {
  const opts = { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] };
  try {
    const proc = spawnSync(process.execPath, [path.join(SCRIPTS, script)], opts);
    if (proc.error) throw proc.error;
    return { code: proc.status ?? 0, out: `${proc.stdout ?? ''}${proc.stderr ?? ''}` };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

const indent = (s) => String(s).split('\n').map(l => '      ' + l).join('\n');

function expect(name, cwd, script, wantCode, needle) {
  const { code, out } = run(cwd, script);
  if (code !== wantCode) {
    failures.push(`${name}\n    expected exit ${wantCode}, got ${code}\n${indent(out)}`);
    return;
  }
  if (needle && !out.includes(needle)) {
    failures.push(`${name}\n    output missing: ${needle}\n${indent(out)}`);
    return;
  }
  console.log('  PASS  ' + name);
  pass++;
}

function writeVersions(dir, pkgVersion, lockVersion = pkgVersion) {
  writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: 'x', version: pkgVersion }, null, 2) + '\n');
  writeFileSync(path.join(dir, 'package-lock.json'),
    JSON.stringify({ name: 'x', version: lockVersion, packages: { '': { version: lockVersion } } }, null, 2) + '\n');
}

function newRepo(name) {
  const dir = path.join(ROOT, name);
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'ignore' });
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Release Guard Test');
  // Never let a developer's global config change the outcome.
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgsign', 'false');
  return dir;
}

const commit = (dir, message) => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', message); };

try {
  // ---------------------------------------------------------- 1. healthy
  {
    const d = newRepo('healthy');
    writeVersions(d, '1.0.0');
    commit(d, 'v1.0.0');
    git(d, 'tag', '-a', 'v1.0.0', '-m', 'v1.0.0');
    expect('a healthy repo passes preflight', d, 'release-preflight.js', 0, 'Release preflight passed');
    expect('a healthy repo passes the doctor', d, 'release-doctor.js', 0, 'Every tag agrees');
  }

  // ----------------------------------------------------- 2. wrong branch
  {
    const d = newRepo('branch');
    writeVersions(d, '1.0.0');
    commit(d, 'init');
    git(d, 'switch', '-q', '-c', 'feature');
    expect('releasing off the release branch is refused', d, 'release-preflight.js', 1, 'not "main"');
  }

  // ------------------------------------------------------- 3. dirty tree
  {
    const d = newRepo('dirty');
    writeVersions(d, '1.0.0');
    commit(d, 'init');
    writeFileSync(path.join(d, 'scratch.txt'), 'wip\n');
    expect('a dirty working tree is refused', d, 'release-preflight.js', 1, 'uncommitted changes');
  }

  // ---------------------------------------------------- 4. lockfile drift
  // Editing a version by hand touches package.json and forgets the lockfile;
  // `npm ci` then fails in CI at the install step, before any of our checks.
  {
    const d = newRepo('lockdrift');
    writeVersions(d, '1.1.0', '1.0.0');
    commit(d, 'hand-edited the version');
    expect('lockfile drift is refused', d, 'release-preflight.js', 1, 'package-lock.json is 1.0.0');
    expect('lockfile drift names the fix', d, 'release-preflight.js', 1, 'npm install --package-lock-only');
  }

  // ----------------------------------------- 5. a tag naming the wrong commit
  // This is the shape that stranded v2.2.1.
  {
    const d = newRepo('stranded');
    writeVersions(d, '1.0.0');
    commit(d, 'v1.0.0');
    git(d, 'tag', '-a', 'v1.0.0', '-m', 'v1.0.0');
    writeVersions(d, '1.1.0');
    commit(d, 'the feature');
    git(d, 'tag', '-a', 'v1.1.0', '-m', 'v1.1.0');
    writeVersions(d, '1.2.0');
    commit(d, 'more work');
    git(d, 'tag', '-a', 'v1.3.0', '-m', 'v1.3.0');   // names 1.3.0; commit says 1.2.0
    expect('the doctor catches a mismatched tag', d, 'release-doctor.js', 1, 'package.json says 1.2.0');
    expect('the doctor will not invent a commit to move to', d, 'release-doctor.js', 1,
      'no commit in this history carries that version');
  }

  // A tag for the CURRENT version, sitting on a commit that predates the bump.
  {
    const d = newRepo('desync');
    writeVersions(d, '1.0.0');
    commit(d, 'old');
    git(d, 'tag', '-a', 'v1.1.0', '-m', 'v1.1.0');   // tagged before bumping
    writeVersions(d, '1.1.0');
    commit(d, 'bump to 1.1.0');
    expect('preflight refuses to bump over a dead tag', d, 'release-preflight.js', 1, 'can never publish');
    expect('preflight sends you to the doctor', d, 'release-preflight.js', 1, 'release:doctor');
    // and the doctor names the commit that would fix it
    const head = git(d, 'rev-parse', '--short', 'HEAD');
    expect('the doctor names the commit to move the tag to', d, 'release-doctor.js', 1,
      `git tag -a v1.1.0 ${head}`);
  }

  // ---------------------------------------------------- 6. behind the remote
  {
    const d = newRepo('behind');
    writeVersions(d, '1.0.0');
    commit(d, 'init');
    const bare = path.join(ROOT, 'behind-origin.git');
    // -b main matters: a bare repo otherwise defaults HEAD to master, the
    // clone below lands on the wrong branch, and the push never moves main.
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
    git(d, 'remote', 'add', 'origin', bare);
    git(d, 'push', '-q', '-u', 'origin', 'main');

    const clone = path.join(ROOT, 'behind-clone');
    execFileSync('git', ['clone', '-q', bare, clone], { stdio: 'ignore' });
    git(clone, 'config', 'user.email', 'other@example.com');
    git(clone, 'config', 'user.name', 'Someone Else');
    writeFileSync(path.join(clone, 'later.txt'), 'theirs\n');
    commit(clone, 'someone else pushed first');
    git(clone, 'push', '-q');

    expect('releasing from behind origin is refused', d, 'release-preflight.js', 1, 'behind');
  }

  // -------------------------------------------- 6b. origin unreachable
  // Being unable to fetch must WARN, never block: releasing offline is legal,
  // and the tag pushes fine later. The warning has to say what git actually
  // said, though -- a bare "could not reach origin" on a machine with working
  // network sent someone looking in the wrong place once.
  {
    const d = newRepo('unreachable');
    writeVersions(d, '1.0.0');
    commit(d, 'v1.0.0');
    git(d, 'tag', '-a', 'v1.0.0', '-m', 'v1.0.0');
    // A remote that cannot possibly resolve, wired up as a real upstream.
    const bare = path.join(ROOT, 'gone-origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
    git(d, 'remote', 'add', 'origin', bare);
    git(d, 'push', '-q', '-u', 'origin', 'main');
    rmSync(bare, { recursive: true, force: true });   // origin disappears

    const { code, out } = run(d, 'release-preflight.js');
    if (code !== 0) {
      failures.push(`an unreachable origin must not block a release\n    exited ${code}\n${indent(out)}`);
    } else if (!out.includes('Could not fetch from origin')) {
      failures.push(`an unreachable origin must warn\n${indent(out)}`);
    } else if (!out.includes('git said:')) {
      failures.push(`the warning must quote git's own error\n${indent(out)}`);
    } else {
      console.log('  PASS  an unreachable origin warns with git\'s reason and does not block');
      pass++;
    }
  }

  // ------------------------------------------------- 7. version never tagged
  {
    const d = newRepo('untagged');
    writeVersions(d, '2.0.0');
    commit(d, 'v2.0.0');
    git(d, 'tag', '-a', 'v2.0.0', '-m', 'v2.0.0');
    writeVersions(d, '2.1.0');
    commit(d, 'bumped but never tagged');
    expect('the doctor spots a version with no tag', d, 'release-doctor.js', 1, 'no v2.1.0 tag');
  }

  // --------------------------------------------------- 8. lightweight tag
  // Cosmetic only: it publishes fine, so it must not fail the audit.
  {
    const d = newRepo('lightweight');
    writeVersions(d, '1.0.0');
    commit(d, 'v1.0.0');
    git(d, 'tag', 'v1.0.0');
    expect('a lightweight tag is a note, not a failure', d, 'release-doctor.js', 0, 'lightweight tag');
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} release-guard case(s) failed:\n`);
    for (const f of failures) console.error('  ' + f + '\n');
    process.exit(1);
  }

  console.log(`\n✅ ALL RELEASE GUARD TESTS PASSED (${pass} checks) ✅`);
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}
