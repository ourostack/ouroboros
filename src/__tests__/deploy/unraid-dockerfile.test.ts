import { describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

const DOCKERFILE = readFileSync("deploy/unraid/Dockerfile", "utf8")
const KNOWN_HOSTS = readFileSync("deploy/unraid/github_known_hosts", "utf8")

// GitHub's published SSH host key fingerprints (https://api.github.com/meta, ssh_key_fingerprints), read 2026-11-06.
const GITHUB_FINGERPRINTS: Record<string, string> = {
  "ssh-ed25519": "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU",
  "ecdsa-sha2-nistp256": "SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM",
  "ssh-rsa": "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s",
}

function fingerprint(base64Key: string): string {
  return `SHA256:${createHash("sha256").update(Buffer.from(base64Key, "base64")).digest("base64").replace(/=+$/u, "")}`
}

describe("the Butler image carries git and ssh for bundle sync", () => {
  it("installs git and openssh-client with apt, without recommends, in the root layer", () => {
    const install = DOCKERFILE.split("\n").find((line) => line.includes("apt-get install"))
    expect(install).toMatch(/apt-get install -y --no-install-recommends .*\bgit\b/u)
    expect(install).toMatch(/apt-get install -y --no-install-recommends .*\bopenssh-client\b/u)
    expect(DOCKERFILE.indexOf("apt-get install")).toBeLessThan(DOCKERFILE.indexOf("USER 10001:10001"))
    expect(DOCKERFILE).toContain("rm -rf /var/lib/apt/lists/*")
  })

  it("installs GitHub's pinned host keys as the system known_hosts, before dropping root", () => {
    expect(DOCKERFILE).toContain("COPY deploy/unraid/github_known_hosts /etc/ssh/ssh_known_hosts\n")
    expect(DOCKERFILE.indexOf("/etc/ssh/ssh_known_hosts")).toBeLessThan(DOCKERFILE.indexOf("USER 10001:10001"))
  })

  it("pins exactly GitHub's ed25519, ecdsa and rsa keys", () => {
    const lines = KNOWN_HOSTS.trimEnd().split("\n")
    expect(KNOWN_HOSTS.endsWith("\n")).toBe(true)
    expect(lines.map((line) => line.split(" ")[1])).toEqual(["ssh-ed25519", "ecdsa-sha2-nistp256", "ssh-rsa"])
    for (const line of lines) {
      const [host, type, key, ...rest] = line.split(" ")
      expect(host).toBe("github.com")
      expect(rest).toEqual([])
      expect(fingerprint(key!)).toBe(GITHUB_FINGERPRINTS[type!])
    }
  })
})
