import os from 'node:os';
import path from 'node:path';

const MANAGER_NAME = 'McpTunnelAccountManager';

function join(root, ...parts) {
  // Keep Windows fixtures meaningful when inspected on a POSIX test host.
  const paths = /^[A-Za-z]:[\\/]|^\\\\/.test(root) ? path.win32 : path.posix;
  return paths.join(root, ...parts);
}

function absoluteSetting(value) {
  return typeof value === 'string' && value.trim() &&
    (path.posix.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) ? value : null;
}

/** Resolve defaults only; callers may still override individual adapter paths. */
export function resolvePlatformPaths({ platform = process.platform, env = process.env, home } = {}) {
  const userProfile = env.USERPROFILE || home || env.HOME || os.homedir();
  if (!absoluteSetting(userProfile)) throw new Error('USER_PROFILE_UNAVAILABLE');

  const windows = platform === 'win32';
  const appData = env.APPDATA || (windows
    ? join(userProfile, 'AppData', 'Roaming')
    : absoluteSetting(env.XDG_CONFIG_HOME) || join(userProfile, '.config'));
  const localAppData = env.LOCALAPPDATA || (windows
    ? join(userProfile, 'AppData', 'Local')
    : platform === 'darwin'
      ? join(userProfile, 'Library', 'Application Support')
      : absoluteSetting(env.XDG_DATA_HOME) || join(userProfile, '.local', 'share'));
  const dataDir = join(localAppData, MANAGER_NAME);
  const tunnelHome = join(userProfile, '.openai-tunnel');
  const antigravityHome = join(userProfile, '.antigravity-mcp');
  const tunnelConfigDir = join(appData, 'tunnel-client');
  return {
    platform,
    userProfile,
    appData,
    configRoot: appData,
    localAppData,
    tunnelConfigDir,
    dataDir,
    instanceDataDir: join(dataDir, 'runtime', 'instances'),
    tunnelHome,
    tunnelClientBin: join(tunnelHome, windows ? 'tunnel-client.exe' : 'tunnel-client'),
    antigravityHome,
    antigravityPython: join(antigravityHome, 'venv', windows ? 'Scripts' : 'bin', windows ? 'python.exe' : 'python'),
    antigravityAppDir: join(antigravityHome, 'app'),
    antigravityStateDir: env.ANTIGRAVITY_STATE_DIR || (windows
      ? join(localAppData, 'antigravity-mcp')
      : platform === 'darwin'
        ? join(userProfile, 'Library', 'Application Support', 'antigravity-mcp')
        : join(absoluteSetting(env.XDG_STATE_HOME) || join(userProfile, '.local', 'state'), 'antigravity-mcp')),
    overleafRuntimeDir: join(userProfile, '.overleaf-mcp', 'runtime'),
    overleafConfigDir: join(absoluteSetting(env.XDG_CONFIG_HOME) || (windows ? appData : join(userProfile, '.config')), 'overleaf-mcp'),
    overleafConfigPath: join(tunnelConfigDir, 'overleaf.yaml'),
    antigravityConfigPath: join(tunnelConfigDir, 'antigravity-local.yaml')
  };
}
