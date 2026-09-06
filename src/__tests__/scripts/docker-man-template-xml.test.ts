import * as path from "node:path"
import { pathToFileURL } from "node:url"

import { beforeAll, describe, expect, it } from "vitest"

let isWellFormedDockerManTemplateXml: (xml: unknown) => boolean

beforeAll(async () => {
  const loaded = await import(pathToFileURL(path.resolve(__dirname, "../../../deploy/unraid/docker-man-template-xml.cjs")).href) as {
    default: { isWellFormedDockerManTemplateXml(xml: unknown): boolean }
  }
  isWellFormedDockerManTemplateXml = loaded.default.isWellFormedDockerManTemplateXml
})

describe("DockerMan template XML validator", () => {
  it.each([
    "<Container/>",
    "<Container><Child></Child></Container> \n",
    "\uFEFF<?xml version=\"1.0\"?>\n<Container ></Container><!-- done -->",
    "<ns:Container data-id='one' _flag=\"two\"><Child/>text &amp; &#65; &#x1F642;</ns:Container>",
    "<Ünicode·Name attr=\"\uE000\u{10000}\"><![CDATA[<literal>]]></Ünicode·Name>",
    "<Container>\t\n\r&#9;&#10;&#13;&#xD7FF;&#xE000;&#xFFFD;&#x10000;&apos;&gt;&lt;&quot;</Container>",
  ])("accepts well-formed XML: %s", (xml) => {
    expect(isWellFormedDockerManTemplateXml(xml)).toBe(true)
  })

  it.each([
    null,
    "",
    "text<Container/>",
    "<Container/>text",
    "<!-- comment only -->",
    "<Container>",
    "<Container></Other>",
    "<Container/></Other>",
    "<Container/><Other/>",
    "<1Container/>",
    "<Container/child>",
    "<Container attribute>",
    "<Container 1attribute=\"value\"/>",
    "<Container attribute value=\"other\"/>",
    "<Container attribute=value/>",
    "<Container attribute=\"value/>",
    "<Container attribute=\"<\"/>",
    "<Container attribute=\"&missing;\"/>",
    "<Container attribute=\"one\" attribute=\"two\"/>",
    "<Container attribute=\"one\"other=\"two\"/>",
    "<Container<Child/>",
    "<Container><!-- unfinished</Container>",
    "<Container><!-- bad--comment --></Container>",
    "<![CDATA[text]]><Container/>",
    "<Container><![CDATA[unfinished</Container>",
    "<?unfinished<Container/>",
    "<?1invalid?><Container/>",
    "<!DOCTYPE Container><Container/>",
    "<Container></>",
    "<Container></Container extra>",
    "<Container>bad & entity</Container>",
    "<Container>bad &missing;</Container>",
    "<Container>bad &#xZ;</Container>",
    "<Container>bad &#0;</Container>",
    "<Container>bad &#x110000;</Container>",
    "<Container>bad ]]> text</Container>",
    "<Container>bad \u0000 text</Container>",
    "<Container>bad \uD800 text</Container>",
    "<Container attribute=\"bad \u0000\"/>",
  ])("rejects non-well-formed XML: %s", (xml) => {
    expect(isWellFormedDockerManTemplateXml(xml)).toBe(false)
  })
})
