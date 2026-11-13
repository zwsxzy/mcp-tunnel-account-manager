// Local run helper for the parallel-instance console.
// Same as scripts/launch-manager.mjs but points the adapter at the existing
// tunnel-client binary that ships with D:\MCP, because this checkout has no
// bundle package-manifest.json to auto-resolve it. Reads PORT / DATA_DIR /
// TUNNEL_CLIENT_BIN from the environment. Does not modify any project code.
import { getLaunchOptions, run as _unused } from './launch-manager.mjs';

const TUNNEL_CLIENT_BIN = process.env.TUNNEL_CLIENT_BIN || 'D:\\MCP\\tunnel-client\\tunnel-client.exe';

async function main() {
  const base = getLaunchOptions(process.env);
  const options = {
    ...base,
    adapterOptions: {
      ...(base.adapterOptions || {}),
      paths: {
        ...((base.adapterOptions && base.adapterOptions.paths) || {}),
        tunnelClientBin: TUNNEL_CLIENT_BIN
      }
    }
  };
  const { startManager } = await import('../src/main.mjs');
  const manager = await startManager(options);
  console.log(`MCP Tunnel Account Manager listening on ${manager.url}`);
  console.log(`Local data directory: ${manager.dataDir}`);
  console.log(`tunnel-client binary: ${TUNNEL_CLIENT_BIN}`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 5000);
    deadline.unref();
    try {
      await manager.close();
      clearTimeout(deadline);
      process.exitCode = 0;
    } catch (error) {
      console.error('Shutdown failed:', error.message);
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((error) => {
  console.error('Console startup failed:', error.message);
  process.exitCode = 1;
});
