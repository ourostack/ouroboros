import { overrideTrustedUidForTests } from "../../a2a/trusted-files"

// Tests run as an ordinary user and write operator-owned state themselves, so that user counts as the trusted owner.
overrideTrustedUidForTests(process.getuid?.())
