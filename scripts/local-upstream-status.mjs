#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = new Set(process.argv.slice(2));
const shouldFetch = args.has('--fetch');
const outputJson = args.has('--json');

function git(params, options = {}) {
  return execFileSync('git', params, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', options.ignoreStderr ? 'ignore' : 'pipe'],
    maxBuffer: 20 * 1024 * 1024,
  }).trim();
}

function gitLines(params, options = {}) {
  const out = execFileSync('git', params, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', options.ignoreStderr ? 'ignore' : 'pipe'],
    maxBuffer: 20 * 1024 * 1024,
  });
  return out ? out.split('\n').filter(Boolean) : [];
}

function short(ref) {
  return git(['rev-parse', '--short=12', ref]);
}

function parseStatusLine(line) {
  if (!line) return null;
  const code = line.slice(0, 2);
  const rawPath = line.slice(3);
  const path = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() : rawPath;
  return { code, path };
}

function isGenerated(path) {
  return path === 'plugin/bun.lock'
    || path === 'plugin/package.json'
    || path === 'plugin/ui/viewer-bundle.js'
    || path === 'plugin/ui/viewer.html'
    || path.startsWith('plugin/ui/assets/')
    || path.startsWith('plugin/scripts/')
    || path.startsWith('dist/')
    || path.startsWith('openclaw/dist/');
}

function versionAt(ref) {
  try {
    return JSON.parse(git(['show', `${ref}:package.json`])).version ?? null;
  } catch {
    return null;
  }
}

if (shouldFetch) {
  git(['fetch', '--all', '--prune'], { ignoreStderr: false });
}

const branch = git(['branch', '--show-current']);
const head = short('HEAD');
const upstream = 'origin/main';
const upstreamHead = short(upstream);
const [aheadRaw, behindRaw] = git(['rev-list', '--left-right', '--count', `HEAD...${upstream}`]).split(/\s+/);
const ahead = Number(aheadRaw);
const behind = Number(behindRaw);
const statusEntries = gitLines(['status', '--porcelain=v1']).map(parseStatusLine).filter(Boolean);
const dirtyFiles = [...new Set(statusEntries.map(entry => entry.path))].sort();
const upstreamFiles = gitLines(['diff', '--name-only', `HEAD..${upstream}`]).sort();
const dirtySet = new Set(dirtyFiles);
const upstreamSet = new Set(upstreamFiles);
const overlapFiles = dirtyFiles.filter(path => upstreamSet.has(path));
const generatedDirtyFiles = dirtyFiles.filter(isGenerated);
const generatedOverlapFiles = overlapFiles.filter(isGenerated);
const localSourceDirtyFiles = dirtyFiles.filter(path => !isGenerated(path));
const upstreamCommits = gitLines([
  'log',
  '--date=short',
  '--pretty=format:%h %ad %s',
  `HEAD..${upstream}`,
]);
const shortstat = git(['diff', '--shortstat', `HEAD..${upstream}`], { ignoreStderr: true });

const report = {
  branch,
  head,
  upstream,
  upstreamHead,
  version: {
    head: versionAt('HEAD'),
    upstream: versionAt(upstream),
    worktree: (() => {
      try {
        return JSON.parse(readFileSync('package.json', 'utf8')).version ?? null;
      } catch {
        return null;
      }
    })(),
  },
  ahead,
  behind,
  shortstat,
  dirtyFiles,
  upstreamFiles,
  overlapFiles,
  generatedDirtyFiles,
  generatedOverlapFiles,
  localSourceDirtyFiles,
  upstreamCommits,
};

if (outputJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

console.log('claude-mem local upstream status');
console.log('');
console.log(`branch:        ${branch || '(detached)'}`);
console.log(`HEAD:          ${head} (${report.version.head ?? 'unknown'})`);
console.log(`${upstream}:   ${upstreamHead} (${report.version.upstream ?? 'unknown'})`);
console.log(`ahead/behind:  ${ahead}/${behind}`);
console.log(`upstream diff: ${shortstat || 'no changes'}`);
console.log('');
console.log(`dirty files:              ${dirtyFiles.length}`);
console.log(`local source dirty files: ${localSourceDirtyFiles.length}`);
console.log(`generated dirty files:    ${generatedDirtyFiles.length}`);
console.log(`overlap with upstream:    ${overlapFiles.length}`);
console.log(`generated overlap:        ${generatedOverlapFiles.length}`);

if (upstreamCommits.length > 0) {
  console.log('');
  console.log('upstream commits not yet integrated:');
  for (const line of upstreamCommits) console.log(`  ${line}`);
}

if (overlapFiles.length > 0) {
  console.log('');
  console.log('files that are both locally changed and changed upstream:');
  for (const file of overlapFiles) {
    const marker = isGenerated(file) ? 'generated' : 'source';
    console.log(`  [${marker}] ${file}`);
  }
}

if (localSourceDirtyFiles.length > 0) {
  console.log('');
  console.log('local source/docs/config files to protect:');
  for (const file of localSourceDirtyFiles) console.log(`  ${file}`);
}

if (generatedDirtyFiles.length > 0) {
  console.log('');
  console.log('generated files: resolve from source first, then run npm run build:');
  for (const file of generatedDirtyFiles) console.log(`  ${file}`);
}
