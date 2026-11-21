// Source stand-in for a server that returns one tool without a name.
export function getToolSchemas() {
  return [{ description: "No name.", inputSchema: { type: "object", properties: {} } }];
}
