import { BUTLER_AGENT_NAMES } from "../heart/butler-agent"
import {
  prepareSanctuaryPackageManagedBundle,
  requireSanctuaryPackageManagementDecision,
  resolveSanctuaryPackageManagementActivation,
} from "../heart/daemon/sanctuary-package-management"
import { emitNervesEvent } from "../nerves/runtime"
import type { OuroProduct } from "../heart/product/types"

/**
 * The Butler, registered with the harness through the product seam. The Unraid image names this module in
 * /opt/ouro/container-runtime.json, so core loads it at runtime and never imports it. Each of the Butler's jobs gets its
 * slot here as it moves behind the seam (M3).
 */
export const product: OuroProduct = {
  seamVersion: 1,
  id: "butler",
  agents: BUTLER_AGENT_NAMES,
  // J2: the packaged starter bundle is checked and migrated into the live bundle before anything starts.
  startup: (input) => {
    const decision = resolveSanctuaryPackageManagementActivation({ ...input, argv: [...input.argv] })
    return {
      preflight: () => { requireSanctuaryPackageManagementDecision(decision) },
      prepareManagedBundle: () => { prepareSanctuaryPackageManagedBundle(decision) },
    }
  },
}

emitNervesEvent({ component: "daemon", event: "daemon.butler_product_registered", message: "Butler product registered", meta: { agents: [...product.agents] } })
