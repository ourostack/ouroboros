export function sanctuaryContainerInspectFixture() {
  return {
    Name: "/ouro-butler",
    Image: "sha256:" + "a".repeat(64),
    Path: "node",
    Args: ["/opt/ouro/dist/heart/daemon/daemon-entry.js", "--package-managed-agent", "sanctuary"],
    Config: {
      User: "10001:10001",
      Image: "ghcr.io/ourostack/ouroboros-butler:0.1.0-alpha.798",
      Entrypoint: ["node", "/opt/ouro/dist/heart/daemon/daemon-entry.js", "--package-managed-agent", "sanctuary"],
      Cmd: [],
      Env: ["PATH=/usr/local/bin:/usr/bin:/bin", "NODE_VERSION=22.18.0", "HOME=/home/ouro"],
      ExposedPorts: null,
      Labels: {
        "org.opencontainers.image.source": "https://github.com/ourostack/ouroboros",
        "net.unraid.docker.managed": "dockerman",
        "net.unraid.docker.icon": "https://raw.githubusercontent.com/ourostack/ouroboros/main/assets/ouroboros.png",
      },
    },
    HostConfig: {
      NetworkMode: "host",
      PidMode: "",
      IpcMode: "private",
      Privileged: false,
      ReadonlyRootfs: false,
      SecurityOpt: null,
      RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
      Binds: null,
      Mounts: [
        { Type: "bind", Source: "/mnt/user/appdata/ouro-butler/runtime/.ouro-cli", Target: "/home/ouro/.ouro-cli", ReadOnly: false },
        { Type: "bind", Source: "/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro", Target: "/home/ouro/AgentBundles/sanctuary.ouro", ReadOnly: false },
        { Type: "bind", Source: "/boot/config/custom/ouro-events/spool", Target: "/run/ouro-events", ReadOnly: true },
      ],
      PortBindings: {},
      Devices: [],
      CapAdd: null,
      CapDrop: null,
      PublishAllPorts: false,
    },
    Mounts: [
      { Type: "bind", Source: "/mnt/user/appdata/ouro-butler/runtime/.ouro-cli", Destination: "/home/ouro/.ouro-cli", RW: true, Propagation: "rprivate" },
      { Type: "bind", Source: "/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro", Destination: "/home/ouro/AgentBundles/sanctuary.ouro", RW: true, Propagation: "rprivate" },
      { Type: "bind", Source: "/boot/config/custom/ouro-events/spool", Destination: "/run/ouro-events", RW: false, Propagation: "rprivate" },
    ],
    NetworkSettings: { Ports: {} },
  }
}
