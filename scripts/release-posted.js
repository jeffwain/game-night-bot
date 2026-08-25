// Printed after `npm version` has pushed the commit and its tag.
//
// The push is the last thing that happens locally; everything after it is a
// workflow you cannot see from the terminal. This says what was pushed and
// where to watch it, so "did that work?" has an answer that is not "wait and
// see if the container updates".

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const git = (...args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
};

const { version } = JSON.parse(readFileSync('package.json', 'utf-8'));
const tag = `v${version}`;

// Turn any of the remote URL shapes into a browsable https base.
const remote = git('remote', 'get-url', 'origin') || '';
const slug = remote
  .replace(/^git@([^:]+):/, 'https://$1/')
  .replace(/\.git$/, '')
  .replace(/\/$/, '');

console.log(`\nPushed ${tag} (${git('rev-parse', '--short', 'HEAD') ?? 'HEAD'}).`);
if (slug.startsWith('http')) {
  console.log(`\n  Watch the release build:  ${slug}/actions`);
  console.log(`  The release will appear:  ${slug}/releases/tag/${tag}`);
}
console.log(`\nWhen it goes green, ghcr.io tags ${version}, ${version.split('.').slice(0, 2).join('.')} and ${version.split('.')[0]} all move,`);
console.log('so anything following the floating tag picks it up on the next pull.');
console.log('\nIf it goes red, `npm run release:doctor` will say why.');
