import {describe, expect, it} from 'vitest';
import {contextPrompt} from '../packages/cli/src/agent.js';

describe('engineering report prompt', () => {
  it('synthesizes engineering contributions and applies regeneration guidance', () => {
    const prompt = contextPrompt({
      job: {
        start_date: '2026-08-01',
        end_date: '2026-08-25',
        custom_prompt: 'Use an executive summary followed by project outcomes.',
      },
      events: [{
        normalized_remote: 'github.com/team/product',
        repository_name: 'Product',
        occurred_at: '2026-08-20T10:00:00.000Z',
        type: 'commit',
        data: {commitSha: 'missing-locally', message: 'Add workspace reporting'},
      }],
    }, []);

    expect(prompt).toContain('engineering contributions');
    expect(prompt).toContain('Do not structure the report as a commit-by-commit chronology');
    expect(prompt).toContain('technical decisions');
    expect(prompt).toContain('Use an executive summary followed by project outcomes.');
    expect(prompt).toContain('Use only the supplied Git evidence');
  });
});
