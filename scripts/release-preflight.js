// Checks that run before `npm version` bumps anything.
//
// The release workflow already refuses to publish a tag that disagrees with
// package.json. That check is correct but late: it fires in CI, minutes after
// the push, and the failure reads like a broken build rather than a tag on the
// wrong commit. Everything here is the same class of check, run locally, before
// a version number or a tag exists to get wrong.
//
// Run on its own any time:  npm run release:check

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const RELEASE_BRANCH = process.env.RELEASE_BRANCH || 'main';

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitQuiet = (...args) => {
  try {
    return git(...args);
  } catch {
    return null;
  }
};

const failures = [];
const warnings = [];
const fail = (what, ...how) => failures.push({ what, how });
const warn = (what, ...how) => warnings.push({ what, how });

// ---------------------------------------------------------------- 1. branch
const branch = gitQuiet('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== RELEASE_BRANCH) {
  fail(
    `You are on "${branch}", not "${RELEASE_BRANCH}".`,
    `Releases are cut from ${RELEASE_BRANCH} so the tag lands on the history everyone else has.`,
    `git switch ${RELEASE_BRANCH}`,
    'Set RELEASE_BRANCH=<name> if you really mean to release from elsewhere.'
  );
}

// ------------------------------------------------------------ 2. clean tree
// npm version refuses a dirty tree too, but its message does not say which
// files, and a stray edit here is how a version bump ends up carrying
// unrelated changes into a release.
const dirty = gitQuiet('status', '--porcelain');
if (dirty) {
  const files = dirty.split('\n').map(l => '  ' + l).join('\n');
  fail('The working tree has uncommitted changes.', 'Commit or stash them first:', files);
}

// -------------------------------------------------- 3. package/lock in sync
const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
let lock = null;
try {
  lock = JSON.parse(readFileSync('package-lock.json', 'utf-8'));
} catch {
  fail('package-lock.json is missing or unreadable.', '`npm ci` in the release workflow needs it.');
}

if (lock) {
  const lockVersion = lock.packages?.['']?.version ?? lock.version;
  if (lockVersion !== pkg.version) {
    fail(
      `package.json is ${pkg.version} but package-lock.json is ${lockVersion}.`,
      '`npm ci` fails outright when these disagree, so the release would die at the install step.',
      'This is what editing a version by hand does. Fix it, then let npm own the number from here on:',
      '  npm install --package-lock-only',
      '  git commit -am "sync lockfile version"'
    );
  }
}

// ------------------------------------------------- 4. in step with the remote
// A release cut from a stale main tags a commit that is not what main will look
// like, and the tag then sits behind origin forever.
const upstream = gitQuiet('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}');
if (!upstream) {
  warn(`"${branch}" has no upstream branch; skipping the up-to-date check.`);
} else {
  const fetched = gitQuiet('fetch', '--quiet', '--tags', 'origin') !== null;
  if (!fetched) {
    warn(
      'Could not reach origin, so this could not confirm you are up to date.',
      'If you are offline, the tag still pushes fine later — just make sure nobody else pushed first.'
    );
  }
  const behind = gitQuiet('rev-list', '--count', `HEAD..${upstream}`);
  const ahead = gitQuiet('rev-list', '--count', `${upstream}..HEAD`);
  if (behind && Number(behind) > 0) {
    fail(
      `${branch} is ${behind} commit(s) behind ${upstream}.`,
      'Releasing now would tag a commit that is not the tip of the branch.',
      '  git pull --rebase'
    );
  }
  if (ahead && Number(ahead) > 0) {
    warn(`${branch} is ${ahead} commit(s) ahead of ${upstream}; they will be pushed with the tag.`);
  }
}

// ------------------------------------- 5. the mess this whole script exists for
// If a tag already exists for the version currently in package.json and it does
// not point here, the previous release never completed. Bumping on top buries
// that instead of fixing it.
const currentTag = `v${pkg.version}`;
const currentTagCommit = gitQuiet('rev-list', '-n', '1', currentTag);
if (currentTagCommit) {
  const head = gitQuiet('rev-parse', 'HEAD');
  if (currentTagCommit !== head) {
    const taggedVersion = (() => {
      const raw = gitQuiet('show', `${currentTagCommit}:package.json`);
      try {
        return JSON.parse(raw).version;
      } catch {
        return null;
      }
    })();
    if (taggedVersion !== pkg.version) {
      fail(
        `${currentTag} exists but points at ${currentTagCommit.slice(0, 7)}, whose package.json says ${taggedVersion}.`,
        `That tag can never publish — the workflow will reject it every time. Nothing was released for ${pkg.version}.`,
        'Fix that first, then release again:',
        '  npm run release:doctor'
      );
    } else {
      warn(`${currentTag} points at ${currentTagCommit.slice(0, 7)}, not HEAD. Fine if it already published.`);
    }
  }
}

// ---------------------------------------------------------------- report
// Indent every line of every hint by four, including lines inside a hint that
// is itself multi-line (the list of dirty files, for one).
const bullet = (lines) =>
  lines
    .flatMap(l => String(l).split('\n'))
    .map(l => '    ' + l)
    .join('\n');

for (const w of warnings) {
  console.warn(`\nwarning: ${w.what}`);
  if (w.how.length) console.warn(bullet(w.how));
}

if (failures.length === 0) {
  console.log(`\nRelease preflight passed — ${branch} is clean and at ${pkg.version}.`);
  process.exit(0);
}

console.error(`\nRelease preflight failed (${failures.length} problem${failures.length === 1 ? '' : 's'}):\n`);
for (const f of failures) {
  console.error(`  * ${f.what}`);
  if (f.how.length) console.error(bullet(f.how));
  console.error('');
}
process.exit(1);
