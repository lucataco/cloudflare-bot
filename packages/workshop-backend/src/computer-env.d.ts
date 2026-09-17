import type { ComputerRuntimeApi } from '@gadgets/workshop-shared/computer';

declare global {
  namespace Cloudflare {
    interface Env {
      /** Optional private, separately deployed Sandbox service; absence keeps shell/files unavailable. */
      COMPUTER_RUNTIME?: Service<ComputerRuntimeApi>;
    }
  }
}
