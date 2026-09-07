"use strict"

const { TextDecoder } = require("node:util")

const DECLARATION = "<?xml version=\"1.0\"?>"
const ROOT_OPEN = "<Container version=\"2\">"
const ROOT_CLOSE = "</Container>"
const NAME_START = /^[A-Za-z_]$/u
const NAME_CHARACTER = /^[A-Za-z0-9_.:-]$/u
const XML_WHITESPACE = /^[\t\n\r ]$/u
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true })

function decodeUtf8(value) {
  if (typeof value === "string") return value
  if (!(value instanceof Uint8Array)) throw new TypeError("DockerMan template bytes are invalid")
  return UTF8_DECODER.decode(value)
}

function skipWhitespace(value, start) {
  let index = start
  while (XML_WHITESPACE.test(value[index] ?? "")) index += 1
  return index
}

function readName(value, start) {
  if (!NAME_START.test(value[start] ?? "")) return null
  let index = start + 1
  while (NAME_CHARACTER.test(value[index] ?? "")) index += 1
  return { name: value.slice(start, index), index }
}

function readOpenTag(xml, start) {
  if (xml[start] !== "<") return null
  const parsedName = readName(xml, start + 1)
  if (!parsedName) return null
  const attributes = new Map()
  let index = parsedName.index
  while (index < xml.length) {
    if (xml[index] === ">") return { name: parsedName.name, attributes: Object.fromEntries(attributes), form: "text", index: index + 1 }
    if (xml.startsWith("/>", index)) return { name: parsedName.name, attributes: Object.fromEntries(attributes), form: "empty", index: index + 2 }
    const whitespaceEnd = skipWhitespace(xml, index)
    if (whitespaceEnd === index) return null
    index = whitespaceEnd
    if (xml[index] === ">" || xml.startsWith("/>", index)) continue
    const attribute = readName(xml, index)
    if (!attribute || attributes.has(attribute.name)) return null
    index = skipWhitespace(xml, attribute.index)
    if (xml[index] !== "=") return null
    index = skipWhitespace(xml, index + 1)
    if (xml[index] !== "\"") return null
    const end = xml.indexOf("\"", index + 1)
    if (end === -1) return null
    const value = xml.slice(index + 1, end)
    if (!/^[\x20-\x7E]*$/u.test(value) || value.includes("<") || value.includes("&")) return null
    attributes.set(attribute.name, value)
    index = end + 1
  }
  return null
}

function hasValidXmlCharacters(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (!(codePoint === 0x9 || codePoint === 0xA || codePoint === 0xD
      || (codePoint >= 0x20 && codePoint <= 0xD7FF)
      || (codePoint >= 0xE000 && codePoint <= 0xFFFD)
      || (codePoint >= 0x10000 && codePoint <= 0x10FFFF))) return false
  }
  return true
}

// Canonical DockerMan dialect: exact declaration and Container root, flat leaf children, double-quoted ASCII attributes, and literal text without entities or auxiliary XML constructs.
function parseDockerManTemplateXml(input) {
  let xml
  try { xml = decodeUtf8(input) } catch { return null }
  if (!hasValidXmlCharacters(xml) || !xml.startsWith(DECLARATION)) return null
  let index = skipWhitespace(xml, DECLARATION.length)
  if (!xml.startsWith(ROOT_OPEN, index)) return null
  index += ROOT_OPEN.length
  const children = []
  while (index < xml.length) {
    index = skipWhitespace(xml, index)
    if (xml.startsWith(ROOT_CLOSE, index)) {
      index = skipWhitespace(xml, index + ROOT_CLOSE.length)
      return index === xml.length ? { root: { name: "Container", attributes: { version: "2" } }, children } : null
    }
    const child = readOpenTag(xml, index)
    if (!child) return null
    index = child.index
    if (child.form === "empty") {
      children.push({ name: child.name, attributes: child.attributes, form: child.form, text: "" })
      continue
    }
    const close = `</${child.name}>`
    const end = xml.indexOf("<", index)
    if (end === -1 || !xml.startsWith(close, end)) return null
    const text = xml.slice(index, end)
    if (text.includes("&") || text.includes("]]>")) return null
    children.push({ name: child.name, attributes: child.attributes, form: child.form, text })
    index = end + close.length
  }
  return null
}

module.exports = { decodeUtf8, parseDockerManTemplateXml }
