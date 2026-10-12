import { describe, expect, it } from "vitest"

import { redactCliArgs } from "../../../heart/daemon/cli-arg-redaction"

describe("redactCliArgs", () => {
  it("replaces the value after a value flag, in both spellings, and leaves the rest alone", () => {
    expect(redactCliArgs(["vault", "config", "set", "--agent", "slugger", "--key", "teams.clientSecret", "--value", "s3cret~value"]))
      .toEqual(["vault", "config", "set", "--agent", "slugger", "--key", "teams.clientSecret", "--value", "[redacted]"])
    expect(redactCliArgs(["connect", "--token=abc", "--password", "p", "--secret", "s", "--port=3978"]))
      .toEqual(["connect", "--token=[redacted]", "--password", "[redacted]", "--secret", "[redacted]", "--port=3978"])
    expect(redactCliArgs(["--value"])).toEqual(["--value"])
    expect(redactCliArgs([])).toEqual([])
  })
})
