import { DurableObject } from 'cloudflare:workers';
export { default, LocalAccount, LocalDevice, LocalGatekeeper, LocalVerifier, GatekeeperVendor } from '../src/localhost';

export class TestHarness extends DurableObject {
  async resource(deviceId: string, kind: 'folders' | 'execution' | 'network', grant: string) {
    return this.ctx.facets.get('resource', () => ({ class: this.ctx.exports.LocalGatekeeper({ props: { deviceId, kind, grant } }) }));
  }
  async account(deviceId: string) { return this.ctx.exports.LocalAccount({ props: { deviceId } }); }
  async rejectObserver(deviceId: string): Promise<string> {
    try {
      const resource = await this.resource(deviceId, 'folders', 'docs');
      await resource.addObserver('observer', this.ctx.exports.LocalVerifier({}));
      return '';
    } catch (error) { return error instanceof Error ? error.message : 'error'; }
  }
}
