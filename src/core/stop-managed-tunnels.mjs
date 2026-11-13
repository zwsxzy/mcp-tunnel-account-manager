import crypto from 'node:crypto';
import { assertInstanceTarget } from './concurrent-instances.mjs';

/** Stop only adapters with verifiable ownership; never enumerate or kill by name. */
export async function stopManagedTunnels({
  services = [], instances = [], adapters = {}, adapterProvider,
  instanceAdapterProvider, repo, onProgress = () => {}
} = {}) {
  const killedPids = new Set();
  const remainingPids = new Set();
  const errors = [];
  const operationId = `stop-managed-${crypto.randomUUID()}`;
  const targets = [];
  for (const serviceId of services) targets.push({ serviceId });
  for (const entry of instances) targets.push(entry);
  const resolved = [];

  for (const [index, target] of targets.entries()) {
    let before = null;
    try {
      let adapter;
      if (target.instanceId) {
        assertInstanceTarget(target);
        if (typeof instanceAdapterProvider !== 'function') throw new Error('INSTANCE_ADAPTER_UNAVAILABLE');
        adapter = await instanceAdapterProvider({ id: operationId }, target.serviceId, target.profileId);
        if (adapter?.instanceId !== target.instanceId) throw new Error('INSTANCE_IDENTITY_MISMATCH');
      } else {
        adapter = adapters?.[target.serviceId];
        if (!adapter && typeof adapterProvider === 'function') {
          const definition = typeof repo?.getDefinition === 'function'
            ? await repo.getDefinition(target.serviceId)
            : await repo?.registry?.getDefinition?.(target.serviceId);
          const op = { id: `${operationId}-${target.serviceId}` };
          if (definition) op.registrySnapshot = { services: [definition] };
          try { adapter = await adapterProvider(op, target.serviceId); }
          finally { adapterProvider.release?.(op.id); }
        }
      }
      const controller = adapter?.processController;
      if (!controller || typeof controller.inspect !== 'function' || typeof adapter.stopConnection !== 'function') {
        throw new Error('PROCESS_ADAPTER_UNAVAILABLE');
      }
      const inspect = () => controller.inspect(target.instanceId || target.serviceId, { allowExternalScan: false });
      before = await inspect();
      if (before?.running !== true && before?.absenceVerified !== true) throw new Error('PROCESS_ABSENCE_UNCONFIRMED');
      const receipt = await adapter.stopConnection({
        operationId, serviceId: target.serviceId,
        ...(target.instanceId ? { instanceId: target.instanceId } : {})
      });
      if (receipt?.stopped !== true || !['verified-owned-process-exit', 'verified-already-stopped'].includes(receipt?.proof?.kind)) {
        throw new Error('STOP_RECEIPT_UNCONFIRMED');
      }
      resolved.push({ target, inspect });
      if (before.running === true && Number.isSafeInteger(before.pid)) killedPids.add(before.pid);
    } catch (error) {
      if (before?.running && Number.isSafeInteger(before.pid)) remainingPids.add(before.pid);
      errors.push({ scope: 'managed-process', target: target.instanceId || target.serviceId,
        message: String(error?.code || error?.message || 'STOP_UNCONFIRMED') });
    }
    onProgress(30 + Math.round(45 * (index + 1) / Math.max(1, targets.length)), `已核验 ${index + 1}/${targets.length} 个托管目标`);
  }

  // Recheck every target after all stop attempts, including an already-absent
  // target that may have been restarted while another target was being stopped.
  for (const { target, inspect } of resolved) {
    try {
      const after = await inspect();
      if (after?.running === true || after?.absenceVerified !== true) {
        if (Number.isSafeInteger(after?.pid)) remainingPids.add(after.pid);
        throw new Error('PROCESS_ABSENCE_UNCONFIRMED');
      }
    } catch (error) {
      errors.push({ scope: 'managed-process-recheck', target: target.instanceId || target.serviceId,
        message: String(error?.code || error?.message || 'STOP_UNCONFIRMED') });
    }
  }
  return { killedPids: [...killedPids], remainingPids: [...remainingPids], errors,
    absenceUnconfirmed: errors.length ? '部分托管隧道的退出尚未确认' : null };
}
