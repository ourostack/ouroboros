import * as path from "node:path"
import { overrideTrustRootForTests } from "../../a2a/operator-trust"
import { overrideTrustChainRootForTests, overrideTrustedUidForTests } from "../../a2a/trusted-files"

// Tests run as an ordinary user and write operator-owned state themselves, so that user counts as the trusted owner.
overrideTrustedUidForTests(process.getuid?.())
// Each test file lives under its own private temp root (isolated-tmpdir); the ancestors above it are the host's, not the test user's.
overrideTrustChainRootForTests(process.env.OURO_TEST_ISOLATED_ROOT)
// The operator trust directory defaults to /etc/ouro/trust/<agent>; tests never touch /etc.
if (process.env.OURO_TEST_ISOLATED_ROOT) overrideTrustRootForTests(path.join(process.env.OURO_TEST_ISOLATED_ROOT, "operator-trust"))
