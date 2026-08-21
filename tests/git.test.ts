import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { discover, inspectRepo, commitData, stagedData, installHooks, normalizeRemote } from '../packages/cli/src/git.js';

const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

describe('real Git integration', () => {
  it('discovers and extracts a real repository while preserving hooks', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-git-'));
    const repo = path.join(tmp, 'nested', 'repo');
    fs.mkdirSync(repo, { recursive: true });
    run(repo, 'init'); run(repo, 'config', 'user.name', 'Test User'); run(repo, 'config', 'user.email', 'test@example.test');
    run(repo, 'remote', 'add', 'origin', 'git@example.com:Team/Project.git');
    fs.writeFileSync(path.join(repo, 'one.txt'), 'one\n'); run(repo, 'add', 'one.txt');
    expect(stagedData(repo).changedFiles).toEqual(['one.txt']);
    run(repo, 'commit', '-m', 'First real commit');
    expect(discover(tmp)).toEqual([repo]);
    expect(inspectRepo(repo).normalizedRemote).toBe('example.com/team/project');
    expect(commitData(repo)).toMatchObject({ message: 'First real commit', filesChanged: 1 });
    const hook = path.join(repo, '.git', 'hooks', 'post-commit');
    fs.writeFileSync(hook, '#!/bin/sh\necho original\n', { mode: 0o755 });
    expect(installHooks(repo)).toContain('post-commit');
    expect(fs.readFileSync(hook, 'utf8')).toContain('TraceMini managed hook');
    expect(fs.readFileSync(hook + '.tracemini-original', 'utf8')).toContain('original');
    expect(normalizeRemote('https://example.com/team/project.git')).toBe(normalizeRemote('git@example.com:team/project.git'));
  });
});
