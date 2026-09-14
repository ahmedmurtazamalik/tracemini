import {afterEach, describe, expect, it, vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {contextPrompt} from '../packages/cli/src/agent.js';
import * as gitModule from '../packages/cli/src/git.js';

let temporary = '';
afterEach(() => { vi.restoreAllMocks(); if (temporary) fs.rmSync(temporary, {recursive: true, force: true}); });

describe('evidence-rich reports', () => {
  it('preserves ordinary contribution evidence while redacting credential assignments', () => {
    const message = 'Fix password reset and token validation: both tests passed.';
    const source = [
      '+const passed = true;',
      '+const compass = "north";',
      '+const tokenization = "complete";',
      '+const summary = "Improve password reset";',
      '+const authToken = "ASSIGNED_AUTH_VALUE";',
      '+DB_PASSWORD=ASSIGNED_DATABASE_VALUE',
      '+pass: ASSIGNED_PASS_VALUE',
      String.raw`+const configJson = "{\"apiKey\":\"EMBEDDED_API_VALUE\"}";`,
    ].join('\n');
    vi.spyOn(gitModule, 'git').mockReturnValue(source);
    const prompt = contextPrompt({
      job: {start_date: '2026-09-14', end_date: '2026-09-14', include_diff: true},
      events: [{repository_name: 'password-reset', normalized_remote: 'example/project', type: 'commit',
        data: {commitSha: 'fixture', message, passed: true, compass: 'north', tokenization: 'complete',
          authToken: 'NESTED_AUTH_VALUE', DB_PASSWORD: 'NESTED_DATABASE_VALUE'}}],
    }, [{path: '/test/project', normalizedRemote: 'example/project'}] as any);

    expect(prompt).toContain(message);
    for (const line of source.split('\n').slice(0, 4)) expect(prompt).toContain(line);
    expect(prompt).toContain('"passed": true');
    expect(prompt).toContain('"compass": "north"');
    expect(prompt).toContain('"tokenization": "complete"');
    for (const secret of ['ASSIGNED_AUTH_VALUE', 'ASSIGNED_DATABASE_VALUE', 'ASSIGNED_PASS_VALUE', 'EMBEDDED_API_VALUE', 'NESTED_AUTH_VALUE', 'NESTED_DATABASE_VALUE']) expect(prompt).not.toContain(secret);
  });

  it('reserves the same contributor allowance for one or ten commits, across repositories and input orders', () => {
    const patches = new Map<string, string>();
    vi.spyOn(gitModule, 'git').mockImplementation((_cwd, args) => patches.get(args.at(-1)!)!);
    const event = (user: string, repository: string, sha: string, patch: string) => {
      patches.set(sha, patch);
      return {user_id: user, user_name: user, repository_name: repository, normalized_remote: `example/${repository}`,
        occurred_at: '2026-08-24T10:00:00Z', type: 'commit', data: {commitSha: sha, message: 'Implement contribution'}};
    };
    const completeWork = '+implemented behavior\n'.repeat(6000);
    const clones = ['product', 'library'].map(name => ({path: `/test/${name}`, normalizedRemote: `example/${name}`})) as any;
    for (const commitCount of [1, 10]) {
      const events = Array.from({length: commitCount}, (_, index) => event('Alex', 'product', `work-${index}`,
        completeWork.slice(index * completeWork.length / commitCount, (index + 1) * completeWork.length / commitCount)));
      events.push(event('Alex', 'library', 'library-work', completeWork));
      events.push(event('Blair', 'product', 'substantial-work', completeWork));
      // A contributor without a local clone must retain metadata without consuming excerpt space.
      events.push(event('Casey', 'unavailable', 'remote-work', ''));
      for (const ordered of [events, [...events].reverse()]) {
        const prompt = contextPrompt({job: {report_scope: 'workspace', include_diff: true}, events: ordered}, clones);
        const lengths = new Map<string, number>();
        for (const section of prompt.split('\n## Evidence: ').slice(1)) {
          const contributor = section.match(/Contributor: (\w+)/)![1];
          const length = [...section.matchAll(/Git evidence:\n```diff\n([\s\S]*?)\n```/g)]
            .reduce((sum, match) => sum + match[1].length, 0);
          lengths.set(contributor, (lengths.get(contributor) || 0) + length);
        }
        expect(Object.fromEntries(lengths)).toEqual({Alex: 40_000, Blair: 40_000, Casey: 0});
        expect(prompt).toContain('Git excerpt truncated');
        expect(prompt).toContain('Git evidence unavailable: no matching local clone');
        expect(prompt).toContain('Contributor: Casey');
      }
    }
  });

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
      'const endpoint = "postgres://db-user:***@example.test/app";',
      'const passwd = "context-passwd-value";',
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
      'const pwd = "added-pwd-value";',
      'export const featureFlag = true;',
      '',
    ].join('\n'));
    execFileSync('git', ['add', '.'], {cwd: temporary});
    execFileSync('git', ['commit', '-qm', 'feat: update configuration behavior'], {cwd: temporary});
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: temporary, encoding: 'utf8'}).trim();
    const event = {repository_name: 'sample', normalized_remote: 'example/sample', occurred_at: '2026-08-24T10:00:00Z', type: 'commit', data: {commitSha: sha, message: 'feat: update configuration behavior', password: 'event-password-value', token: 'generic-token-value', authToken: 'auth-token-value', nested: {token: 'nested-token-value'}, endpoint: 'postgres://event-user:event-password@example.test/app'}};

    const prompt = contextPrompt({job: {start_date: '2026-08-24', end_date: '2026-08-24', timezone: 'UTC', include_diff: true}, events: [event]}, [{path: temporary, normalizedRemote: 'example/sample'}] as any);
    for (const secret of ['context-password-value', 'db-password', 'context-passwd-value', 'added-pwd-value', 'bearer-secret-value', 'quoted-api-secret-value', 'event-password-value', 'event-password', 'generic-token-value', 'auth-token-value', 'nested-token-value']) expect(prompt).not.toContain(secret);
    expect(prompt).toContain('[REDACTED SENSITIVE VALUE]');
  });

  it('applies redaction at the final prompt boundary for every interpolated field', () => {
    const prompt = contextPrompt({
      job: {
        start_date: '2026-08-24',
        end_date: '2026-08-24',
        timezone: 'UTC',
        include_diff: false,
        custom_prompt: 'password:\nCUSTOM_PROMPT_SECRET\namqp://user:AMQP_SECRET@example.test/vhost\nssh://user:SSH_SECRET@example.test/repo',
      },
      events: [{
        repository_name: 'accessKeyId=REPOSITORY_NAME_SECRET',
        normalized_remote: 'example/safe',
        occurred_at: '2026-08-24T10:00:00Z',
        type: 'consumerKey=EVENT_TYPE_SECRET',
        data: {message: 'safe contribution metadata', authToken: 'AUTH_TOKEN_SECRET', nested: {safe: 'SAFE_NESTED', accessKey: 'ACCESS_KEY_SECRET'}, safe: 'SAFE_SIBLING'},
      }],
    }, [{path: '/tmp/password=LOCAL_PATH_SECRET', normalizedRemote: 'example/safe'}] as any);

    for (const secret of ['CUSTOM_PROMPT_SECRET', 'AMQP_SECRET', 'SSH_SECRET', 'REPOSITORY_NAME_SECRET', 'LOCAL_PATH_SECRET', 'EVENT_TYPE_SECRET', 'AUTH_TOKEN_SECRET', 'ACCESS_KEY_SECRET']) expect(prompt).not.toContain(secret);
    for (const safe of ['safe contribution metadata', 'SAFE_NESTED', 'SAFE_SIBLING']) expect(prompt).toContain(safe);
  });
});
