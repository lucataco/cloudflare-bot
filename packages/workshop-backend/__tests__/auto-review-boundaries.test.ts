import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { requiresManualReview } from '@gadgets/workshop-shared/auto-review';
import type { OverseerDurableObject } from '../src/overseer';
import { putAction } from './fixtures';

declare module 'cloudflare:workers' {
  interface ProvidedEnv { TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject> }
}
const enabler = { type: 'user' as const, id: 'owner', name: 'Owner' };

describe('administrator auto-review floor', () => {
  it('matches exact vendor/tag scopes and explicit wildcards', () => {
    expect(requiresManualReview([{ vendorId: 'github', tag: 'write' }], 'github', 'write')).toBe(true);
    expect(requiresManualReview([{ vendorId: 'github', tag: 'write' }], 'slack', 'write')).toBe(false);
    expect(requiresManualReview([{ vendorId: 'github', tag: 'write' }], undefined, 'write')).toBe(true);
    expect(requiresManualReview([{ vendorId: null, tag: 'write' }], undefined, 'write')).toBe(true);
    expect(requiresManualReview([{ vendorId: null, tag: null }], undefined, undefined)).toBe(true);
    expect(requiresManualReview([], 'github', 'write')).toBe(false);
  });

  it('stops an already-enabled drain at a locked action while preserving explicit human approval', async () => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async (instance: OverseerDurableObject) => {
      const impl = instance['impl'];
      const admin = impl.ctx.exports.AdminSettings.getByName('');
      await admin.setAutoReviewBoundaries([{ vendorId: null, tag: 'edit' }]);
      try {
        putAction(impl.storage, 1); putAction(impl.storage, 2);
        impl.storage.autoApproveTags.put({ gatekeeperId: 1, actionKind: { tag: 'edit', label: 'Edits' }, enabledBy: enabler });
        const applyAction = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
        Object.assign(impl, { getGatekeeperFacet: () => ({ applyAction }) });
        await impl.drainAutoApprovals(1);
        expect(applyAction).not.toHaveBeenCalled();
        expect(impl.storage.actions.get(1)?.state).toBe('pending');
        const action = impl.storage.actions.get(1);
        if (!action || action.type !== 'action') throw new Error('Missing test action');
        await impl.applyPendingAction(action, enabler, false);
        expect(applyAction).toHaveBeenCalledOnce();
        await admin.setAutoReviewBoundaries([]);
        await impl.drainAutoApprovals(1);
        expect(impl.storage.actions.get(2)?.state).toBe('approved');
      } finally { await admin.setAutoReviewBoundaries([]); }
    });
  });

  it('rechecks a removed user grant after the admin-policy read', async () => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async (instance: OverseerDurableObject) => {
      const impl = instance['impl'];
      putAction(impl.storage, 1);
      impl.storage.autoApproveTags.put({ gatekeeperId: 1, actionKind: { tag: 'edit', label: 'Edits' }, enabledBy: enabler });
      const policy = Promise.withResolvers<boolean>();
      const applyAction = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
      Object.assign(impl, { canAutoApprove: () => policy.promise, getGatekeeperFacet: () => ({ applyAction }) });
      const draining = impl.drainAutoApprovals(1);
      impl.storage.autoApproveTags.delete('1:edit');
      policy.resolve(true);
      await draining;
      expect(applyAction).not.toHaveBeenCalled();
      expect(impl.storage.actions.get(1)?.state).toBe('pending');
    });
  });

  it.each(['eligibility', 'tag'])('rechecks changed action %s after the policy read', async change => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()), async (instance: OverseerDurableObject) => {
      const impl = instance['impl'];
      putAction(impl.storage, 1);
      impl.storage.autoApproveTags.put({ gatekeeperId: 1, actionKind: { tag: 'edit', label: 'Edits' }, enabledBy: enabler });
      const policy = Promise.withResolvers<boolean>();
      const applyAction = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
      Object.assign(impl, { canAutoApprove: () => policy.promise, getGatekeeperFacet: () => ({ applyAction }) });
      const draining = impl.drainAutoApprovals(1);
      const action = impl.storage.actions.get(1);
      if (!action || action.type !== 'action') throw new Error('Missing action');
      action.description = change === 'eligibility' ? { ...action.description, autoApprovable: false }
        : { ...action.description, actionKind: { tag: 'other', label: 'Other action' } };
      impl.storage.actions.put(action);
      policy.resolve(true);
      await draining;
      expect(applyAction).not.toHaveBeenCalled();
      expect(impl.storage.actions.get(1)?.state).toBe('pending');
    });
  });
});
