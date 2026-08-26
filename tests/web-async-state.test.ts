import {describe, expect, it} from 'vitest';
import {canApplyWorkspaceResult} from '../apps/web/async-state.js';

describe('workspace-scoped async results', () => {
  it('rejects results after unmount or workspace changes', () => {
    expect(canApplyWorkspaceResult(7, 7, true)).toBe(true);
    expect(canApplyWorkspaceResult(7, 8, true)).toBe(false);
    expect(canApplyWorkspaceResult(7, 7, false)).toBe(false);
  });
});
