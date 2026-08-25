// Audit every release tag against the commit it points at.
//
// The failure this exists to catch: a tag names one version and the
// package.json at that commit names another. The release workflow refuses to
// publish when they disagree -- correctly -- but the refusal happens in CI,
// minutes later, and reads as "the build broke" rather than "the tag is on the
// wrong commit". This says so in one line, locally, before you push anything.
//
//   npm run release:doctor
//
// Exit code is 1 if anything is wrong, so it can gate a release.

import { execFileSync } from 'node:child_process';

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitQuiet = (...args) => {
  try {
    return git(...args);
  } catch {
    return null;
  }
};

// Read a JSON file as it existed at a commit, without checking anything out.
function versionAt(ref, file) {
  const raw = gitQuiet('show', `${ref}:${file}`);
  if (raw === null) return null;
  try {
    return JSON.parse(raw).version ?? null;
  } catch {
    return null;
  }
}

function lockPackageVersionAt(ref) {
  const raw = gitQuiet('show', `${ref}:package-lock.json`);
  if (raw === null) return null;
  try {
    // npm records the version twice; `packages[""]` is the one `npm ci`
    // compares against package.json, and the one that drifts when a version is
    // edited by hand.
    return JSON.parse(raw).packages?.['']?.version ?? null;
  } catch {
    return null;
  }
}

const SEMVER_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

// The newest commit reachable from HEAD whose package.json carries `version`.
// Used to point the fix advice at a real commit rather than a placeholder.
function findCommitForVersion(version) {
  const log = gitQuiet('log', '--format=%H', '-n', '200', 'HEAD');
  if (!log) return null;
  for (const commit of log.split('\n')) {
    if (versionAt(commit, 'package.json') === version) return commit.slice(0, 7);
  }
  return null;
}

function compareTags(a, b) {
  const pa = SEMVER_TAG.exec(a).slice(1, 4).map(Number);
  const pb = SEMVER_TAG.exec(b).slice(1, 4).map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

const problems = [];
const notes = [];

const tags = git('tag', '--list', 'v*').split('\n').filter(t => SEMVER_TAG.test(t)).sort(compareTags);

if (tags.length === 0) {
  console.log('No vX.Y.Z tags found.');
  process.exit(0);
}

console.log('Release tags\n');

const rows = [];
for (const tag of tags) {
  const commit = git('rev-list', '-n', '1', tag);
  const short = commit.slice(0, 7);
  const subject = git('log', '-1', '--format=%s', commit);
  const pkg = versionAt(commit, 'package.json');
  const lock = lockPackageVersionAt(commit);
  const expected = tag.slice(1);
  // An annotated tag is its own object; a lightweight tag points straight at
  // the commit. Only annotated tags carry a message and a tagger date, which
  // is what `npm version` creates and what the release notes read from.
  const annotated = git('cat-file', '-t', tag) === 'tag';

  const flags = [];
  const cosmetic = [];
  if (pkg !== expected) {
    flags.push(`package.json says ${pkg ?? '(unreadable)'}`);
    // Find a commit that actually carries this version, so the advice can name
    // it instead of leaving a <placeholder> to guess at.
    const moveTo = findCommitForVersion(expected);
    problems.push({ tag, kind: 'version-mismatch', expected, actual: pkg, commit: short, moveTo });
  }
  if (lock !== null && lock !== pkg) {
    flags.push(`package-lock says ${lock}`);
    problems.push({ tag, kind: 'lockfile-drift', expected: pkg, actual: lock, commit: short });
  }
  if (!annotated) {
    cosmetic.push('lightweight tag');
    notes.push(`${tag} is a lightweight tag; \`npm version\` creates annotated ones. Harmless — it still publishes.`);
  }

  rows.push({
    tag, short, subject,
    broken: flags.length > 0,
    status: [...flags, ...cosmetic].join('; ') || 'ok'
  });
}

const width = Math.max(...rows.map(r => r.tag.length));
for (const r of rows) {
  const mark = r.broken ? '  !!  ' : '  ok  ';
  console.log(`${mark}${r.tag.padEnd(width)}  ${r.short}  ${r.subject}`);
  if (r.status !== 'ok') console.log(`${' '.repeat(width + 8)}  ^ ${r.status}`);
}

// A version that was bumped on main but never tagged publishes nothing: the
// release workflow only fires on tag pushes. This is the other half of the
// v2.2.1 failure -- the fix commit existed, but nothing triggered on it.
const headVersion = JSON.parse(gitQuiet('show', 'HEAD:package.json') ?? '{}').version;
if (headVersion) {
  const expectedTag = `v${headVersion}`;
  const tagCommit = gitQuiet('rev-list', '-n', '1', expectedTag);
  const headCommit = git('rev-parse', 'HEAD');

  console.log('');
  if (!tagCommit) {
    console.log(`  !!  HEAD is version ${headVersion} with no ${expectedTag} tag — nothing has been released for it.`);
    problems.push({ tag: expectedTag, kind: 'missing-tag', commit: headCommit.slice(0, 7) });
  } else if (tagCommit !== headCommit) {
    const behind = gitQuiet('rev-list', '--count', `${tagCommit}..${headCommit}`);
    console.log(`  !!  ${expectedTag} points at ${tagCommit.slice(0, 7)}, but HEAD (${headCommit.slice(0, 7)}) is ${behind} commit(s) further on.`);
    // If that tag is ALSO version-mismatched, it is one mistake, not two, and
    // the mismatch advice below already tells you to move it.
    const alreadyReported = problems.some(x => x.tag === expectedTag && x.kind === 'version-mismatch');
    if (!alreadyReported) {
      problems.push({ tag: expectedTag, kind: 'tag-behind-head', commit: tagCommit.slice(0, 7) });
    }
  } else {
    console.log(`  ok  HEAD is ${expectedTag} and the tag points here.`);
  }
}

for (const n of [...new Set(notes)]) console.log(`  note  ${n}`);

if (problems.length === 0) {
  console.log('\nEvery tag agrees with the package.json at its commit.');
  process.exit(0);
}

console.log('\nHow to fix\n');
for (const p of problems) {
  if (p.kind === 'version-mismatch' && p.moveTo) {
    console.log(`  ${p.tag} names ${p.expected} but its commit says ${p.actual}. The release workflow will`);
    console.log(`  refuse to publish it. ${p.moveTo} does carry ${p.expected} — move the tag there:`);
    console.log(`      git tag -d ${p.tag}`);
    console.log(`      git push origin :refs/tags/${p.tag}`);
    console.log(`      git tag -a ${p.tag} ${p.moveTo} -m "${p.tag}"`);
    console.log(`      git push origin ${p.tag}`);
  }
  if (p.kind === 'version-mismatch' && !p.moveTo) {
    console.log(`  ${p.tag} names ${p.expected}, but no commit in this history carries that version,`);
    console.log('  so there is nowhere to move it to. Either delete the tag:');
    console.log(`      git tag -d ${p.tag} && git push origin :refs/tags/${p.tag}`);
    console.log(`  or release ${p.expected} properly, which creates the tag for you:`);
    console.log('      npm version <patch|minor|major>');
  }
  if (p.kind === 'lockfile-drift') {
    console.log(`  ${p.tag} has package.json ${p.expected} but package-lock ${p.actual}; \`npm ci\` fails on that.`);
    console.log('  Run `npm install --package-lock-only` and commit the lockfile.');
  }
  if (p.kind === 'missing-tag') {
    console.log(`  Nothing was ever released for ${p.tag}. Either tag this commit, or bump again`);
    console.log('  with `npm version <patch|minor|major>`, which tags and pushes in one step.');
  }
  if (p.kind === 'tag-behind-head') {
    console.log(`  ${p.tag} is stranded behind HEAD. If it never published, move it forward:`);
    console.log(`      git tag -d ${p.tag} && git push origin :refs/tags/${p.tag}`);
    console.log(`      git tag -a ${p.tag} -m "${p.tag}" && git push origin ${p.tag}`);
    console.log('  If it DID publish, leave it and cut a new version instead.');
  }
  console.log('');
}

process.exit(1);
