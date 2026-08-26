export function canApplyWorkspaceResult(expectedWorkspaceId: number, currentWorkspaceId: number, mounted: boolean) {
  return mounted && expectedWorkspaceId === currentWorkspaceId;
}
