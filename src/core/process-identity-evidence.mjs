/** Persisted verification evidence, excluding control capabilities and environment. */
export function processIdentityEvidence(source) {
  const evidence = {};
  if (typeof source?.processStartToken === 'string' && source.processStartToken.length <= 512) {
    evidence.processStartToken = source.processStartToken;
  }
  if (source?.creationTimeFileTime !== undefined && source.creationTimeFileTime !== null) {
    evidence.creationTimeFileTime = source.creationTimeFileTime;
  }
  const posix = source?.posix;
  if (posix && posix.version === 1 && typeof posix.scope === 'string' &&
      typeof posix.launchId === 'string' && Number.isSafeInteger(posix.supervisorPid) &&
      Number.isSafeInteger(posix.processGroupId)) {
    evidence.posix = { version: 1, scope: posix.scope, launchId: posix.launchId,
      supervisorPid: posix.supervisorPid, processGroupId: posix.processGroupId };
  }
  return evidence;
}
