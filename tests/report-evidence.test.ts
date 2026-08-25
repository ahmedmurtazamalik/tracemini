import {afterEach, describe, expect, it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {contextPrompt} from '../packages/cli/src/agent.js';

let temporary = '';
afterEach(() => { if (temporary) fs.rmSync(temporary, {recursive: true, force: true}); });

describe('evidence-rich reports', () => {
  it('grounds contribution-focused reports and only includes source patches after explicit consent', () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-report-evidence-'));
    execFileSync('git', ['init', '-q'], {cwd: temporary});
    execFileSync('git', ['config', 'user.email', 'report@example.test'], {cwd: temporary});
    execFileSync('git', ['config', 'user.name', 'Report Test'], {cwd: temporary});
    fs.writeFileSync(path.join(temporary, 'feature.ts'), 'export const featureFlag = true;\n');
    execFileSync('git', ['add', '.'], {cwd: temporary});
    execFileSync('git', ['commit', '-qm', 'feat: add precise report evidence'], {cwd: temporary});
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: temporary, encoding: 'utf8'}).trim();
    const event = {repository_name: 'sample', normalized_remote: 'example/sample', occurred_at: '2026-08-24T10:00:00Z', type: 'commit', data: {commitSha: sha, message: 'feat: add precise report evidence', changedFiles: ['feature.ts'], filesChanged: 1, insertions: 1, deletions: 0}};
    const clones: any = [{path: temporary, normalizedRemote: 'example/sample'}];

    const summaryOnly = contextPrompt({job: {start_date: '2026-08-24', end_date: '2026-08-24', timezone: 'Asia/Karachi', include_diff: false}, events: [event]}, clones);
    expect(summaryOnly).toContain(sha.slice(0, 12));
    expect(summaryOnly).toContain('feat: add precise report evidence');
    expect(summaryOnly).not.toContain('+export const featureFlag = true;');

    const detailed = contextPrompt({job: {start_date: '2026-08-24', end_date: '2026-08-24', timezone: 'UTC', include_diff: true}, events: [event]}, clones);
    expect(detailed).toContain('+export const featureFlag = true;');
    expect(detailed).toContain('Synthesize related work into meaningful contributions');
    expect(detailed).toContain('Do not structure the report as a commit-by-commit chronology');
  });

  it('redacts sensitive values from added and unchanged diff lines before generation', () => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tracemini-report-redaction-'));
    execFileSync('git', ['init', '-q'], {cwd: temporary});
    execFileSync('git', ['config', 'user.email', 'report@example.test'], {cwd: temporary});
    execFileSync('git', ['config', 'user.name', 'Report Test'], {cwd: temporary});
    fs.writeFileSync(path.join(temporary, 'config.ts'), [
      'const password = "context-password-value";',
      'const endpoint = "postgres://db-user:db-password@example.test/app";',
      'export const featureFlag = false;',
      '',
    ].join('\n'));
    execFileSync('git', ['add', '.'], {cwd: temporary});
    execFileSync('git', ['commit', '-qm', 'test: establish nearby sensitive context'], {cwd: temporary});
    fs.writeFileSync(path.join(temporary, 'config.ts'), [
      'const password = "context-password-value";',
      'const endpoint = "postgres://db-user:db-password@example.test/app";',
      'const headers = {"Authorization": "Bearer bearer-secret-value"};',
      'const config = {"apiKey": "quoted-api-secret-value"};',
      'export const featureFlag = true;',
      '',
    ].join('\n'));
    execFileSync('git', ['add', '.'], {cwd: temporary});
    execFileSync('git', ['commit', '-qm', 'feat: update configuration behavior'], {cwd: temporary});
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: temporary, encoding: 'utf8'}).trim();
    const event = {repository_name: 'sample', normalized_remote: 'example/sample', occurred_at: '2026-08-24T10:00:00Z', type: 'commit', data: {commitSha: sha, message: 'feat: update configuration behavior', password: 'event-password-value', endpoint: 'postgres://event-user:event-password@example.test/app'}};

    const prompt = contextPrompt({job: {start_date: '2026-08-24', end_date: '2026-08-24', timezone: 'UTC', include_diff: true}, events: [event]}, [{path: temporary, normalizedRemote: 'example/sample'}] as any);
    for (const secret of ['context-password-value', 'db-password', 'bearer-secret-value', 'quoted-api-secret-value', 'event-password-value', 'event-password']) expect(prompt).not.toContain(secret);
    expect(prompt).toContain('[REDACTED SENSITIVE VALUE]');
  });
});
