#!/usr/bin/env node
/**
 * Lockstep version bumper for control17.
 *
 * Usage:
 *   pnpm bump 0.0.1
 *
 * Rewrites every package.json (root, packages/<pkg>, apps/<pkg>) to the
 * given version, commits with "release: <version>", and creates an
 * annotated tag `v<version>`. Does NOT push — the operator runs
 * `git push --follow-tags` after inspecting the commit.
 *
 * Requires a clean working tree. Refuses to run if the tag already exists.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function die(msg) {
  process.stderr.write(`bump: ${msg}\n`);
  process.exit(1);
}

function run(cmd) {
  return execSync(cmd, { cwd: repoRoot, stdio: 'pipe' }).toString().trim();
}

function runInherit(cmd) {
  execSync(cmd, { cwd: repoRoot, stdio: 'inherit' });
}

const version = process.argv[2];
if (!version) die('usage: pnpm bump <version>  (e.g. 0.0.1 or 1.2.3-rc.1)');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  die(`invalid semver: ${version}`);
}
const tag = `v${version}`;

// --- Preflight: clean working tree ---
try {
  const status = run('git status --porcelain');
  if (status.length > 0) {
    process.stderr.write(`bump: working tree is not clean. Commit or stash first:\n${status}\n`);
    process.exit(1);
  }
} catch (err) {
  die(`failed to check git status: ${err.message}`);
}

// --- Preflight: tag doesn't already exist ---
try {
  run(`git rev-parse ${tag}`);
  die(`tag ${tag} already exists`);
} catch {
  // good — tag not found
}

// --- Discover all package.json files to bump ---
const targets = [join(repoRoot, 'package.json')];
for (const parent of ['packages', 'apps']) {
  const base = join(repoRoot, parent);
  if (!existsSync(base)) continue;
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgPath = join(base, entry.name, 'package.json');
    if (existsSync(pkgPath)) targets.push(pkgPath);
  }
}

// --- Rewrite each in place ---
const changes = [];
for (const path of targets) {
  const content = await readFile(path, 'utf8');
  const pkg = JSON.parse(content);
  const from = pkg.version;
  if (from === version) {
    process.stdout.write(`  ${pkg.name.padEnd(24)} already at ${version}, skipping\n`);
    continue;
  }
  pkg.version = version;
  const next = `${JSON.stringify(pkg, null, 2)}\n`;
  await writeFile(path, next);
  changes.push({ name: pkg.name, path, from, to: version });
}

if (changes.length === 0) die(`nothing to bump — every package is already at ${version}`);

process.stdout.write(`\nBumped ${changes.length} package(s) to ${version}:\n`);
for (const c of changes) {
  process.stdout.write(`  ${c.name.padEnd(24)} ${c.from} -> ${c.to}\n`);
}

// --- Stage only the files we touched ---
for (const c of changes) {
  run(`git add ${JSON.stringify(c.path)}`);
}

// --- Commit + tag ---
runInherit(`git commit -m ${JSON.stringify(`release: ${version}`)}`);
run(`git tag -a ${tag} -m ${JSON.stringify(`release ${version}`)}`);

process.stdout.write(`\nCreated commit + tag ${tag}.\n`);
process.stdout.write('Push with:\n');
process.stdout.write('  git push --follow-tags\n');
