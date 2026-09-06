import * as path from "node:path"
import { pathToFileURL } from "node:url"

import { beforeAll, describe, expect, it } from "vitest"

interface ParsedTemplate {
  root: { name: string; attributes: Record<string, string> }
  children: Array<{ name: string; attributes: Record<string, string>; form: "empty" | "text"; text: string }>
}

let parseDockerManTemplateXml: (input: unknown) => ParsedTemplate | null

beforeAll(async () => {
  const loaded = await import(pathToFileURL(path.resolve(__dirname, "../../../deploy/unraid/docker-man-template-xml.cjs")).href) as {
    default: { parseDockerManTemplateXml(input: unknown): ParsedTemplate | null }
  }
  parseDockerManTemplateXml = loaded.default.parseDockerManTemplateXml
})

describe("canonical DockerMan template parser", () => {
  const canonicalEmpty = "<?xml version=\"1.0\"?><Container version=\"2\"></Container>"

  it("returns exact direct-child structure without normalizing text", () => {
    expect(parseDockerManTemplateXml([
      "<?xml version=\"1.0\"?>",
      "<Container version=\"2\">",
      "  <Name> ouro-butler </Name>",
      "  <WebUI/>",
      "  <Config Target=\"/home/ouro\" Mode=\"rw\" Type=\"Path\">/mnt/user/appdata/ouro</Config>",
      "</Container>",
      "",
    ].join("\n"))).toEqual({
      root: { name: "Container", attributes: { version: "2" } },
      children: [
        { name: "Name", attributes: {}, form: "text", text: " ouro-butler " },
        { name: "WebUI", attributes: {}, form: "empty", text: "" },
        { name: "Config", attributes: { Target: "/home/ouro", Mode: "rw", Type: "Path" }, form: "text", text: "/mnt/user/appdata/ouro" },
      ],
    })
  })

  it("accepts canonical bytes and every allowed XML character range", () => {
    const text = `\t\n\r ${String.fromCodePoint(0x20, 0xD7FF, 0xE000, 0xFFFD, 0x10000, 0x10FFFF)}`

    expect(parseDockerManTemplateXml(Buffer.from(canonicalEmpty))).toEqual({ root: { name: "Container", attributes: { version: "2" } }, children: [] })
    expect(parseDockerManTemplateXml(`<?xml version="1.0"?><Container version="2"><Value>${text}</Value></Container>`)).not.toBeNull()
  })

  it("rejects unsupported inputs and malformed UTF-8 bytes", () => {
    expect(parseDockerManTemplateXml(null)).toBeNull()
    expect(parseDockerManTemplateXml(Uint8Array.of(0xFF))).toBeNull()
  })

  it.each([
    "<Container version=\"2\"></Container>",
    "\uFEFF<?xml version=\"1.0\"?><Container version=\"2\"></Container>",
    "<?xml version='1.0'?><Container version=\"2\"></Container>",
    "<?xml version=\"1.0\"?><Container></Container>",
    "<?xml version=\"1.0\"?><Container version=\"2\" extra=\"yes\"></Container>",
    "<?xml version=\"1.0\"?><Container  version=\"2\"></Container>",
    "<?xml version=\"1.0\"?><Container version=\"2\" ></Container>",
    "<?xml version=\"1.0\"?><Container version='2'></Container>",
    "<?xml version=\"1.0\"?><Container version=\"2\" version=\"2\"></Container>",
    "<?xml version=\"1.0\"?><Container version=\"2\"><Name attribute='value'>ouro-butler</Name></Container>",
    "<?xml version=\"1.0\"?><Container version=\"2\"><Name 1attribute=\"value\">ouro-butler</Name></Container>",
    "<?xml version=\"1.0\"?><Container version=\"2\"><Name attribute \"value\">ouro-butler</Name></Container>",
    "<?xml version=\"1.0\"?><Container version=\"2\"><Name attribute=\"value>ouro-butler</Name></Container>",
    "<?xml version=\"1.0\"?><Container version=\"2\"><Name attribute=\"é\">ouro-butler</Name></Container>",
    "<?xml version=\"1.0\"?><Container version=\"2\"><Name attribute=\"&\">ouro-butler</Name></Container>",
    "<?xml version=\"1.0\"?><Container version=\"2\"><Name attribute=\"one\" attribute=\"two\">ouro-butler</Name></Container>",
    "<?xml version=\"1.0\"?><Container version=\"2\"><Name>ouro<Name>nested</Name>-butler</Name></Container>",
    "<?xml version=\"1.0\"?><Container version=\"2\"><!-- comment --></Container>",
    "<?xml version=\"1.0\"?><Container version=\"2\"><![CDATA[text]]></Container>",
    "<?xml version=\"1.0\"?><!DOCTYPE Container><Container version=\"2\"></Container>",
    "<?xml version=\"1.0\"?><Container version=\"2\"><?pi data?></Container>",
    "<?xml version=\"1.0\"?><Container version=\"2\"><Name>ouro&amp;butler</Name></Container>",
    "<Container version=\"2\"></Container><?xml version=\"1.0\"?>",
    "<?xml bananas?><Container version=\"2\"></Container>",
    "<?XmL nope?><Container version=\"2\"></Container>",
    "<?xml version=\"1.0\"?><Container version=\"2\"><!-- \u0001 --></Container>",
    "<?xml version=\"1.0\"?><Container version=\"2\"><![CDATA[\u0001]]></Container>",
    "<?xml version=\"1.0\"?><Container version=\"2\"><?pi \u0001?></Container>",
    "<?xml version=\"1.0\"?><Container version=\"2\">text</Container>",
    "<?xml version=\"1.0\"?><Container version=\"2\"><Name>unterminated",
    "<?xml version=\"1.0\"?><Container version=\"2\"><Name>unterminated</Container>",
    "<?xml version=\"1.0\"?><Container version=\"2\"></Other>",
    "<?xml version=\"1.0\"?><Container version=\"2\"></Container><Other/>",
    "<?xml version=\"1.0\"?><Container version=\"2\"><Name>bad \u0000</Name></Container>",
    "<?xml version=\"1.0\"?><Container version=\"2\"><Name>bad \uD800</Name></Container>",
    "<?xml version=\"1.0\"?><Container version=\"2\"><Name>bad ]]></Name></Container>",
    "<?xml version=\"1.0\"?><Container version=\"2\"><Name />",
    "<?xml version=\"1.0\"?><Container version=\"2\">",
  ])("rejects input outside the canonical dialect: %s", (xml) => {
    expect(parseDockerManTemplateXml(xml)).toBeNull()
  })
})
