import {describe, expect, it} from 'vitest';
import {codexExecArgs} from '../packages/cli/src/runner.js';

describe('report runner command compatibility', () => {
  it('uses supported non-interactive Codex flags and remains read-only', () => {
    const args = codexExecArgs('/work/repository');
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'gpt-6-astra']);
    expect(args).toContain('read-only');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('/work/repository');
    expect(args).not.toContain('--ask-for-approval');
  });
});
