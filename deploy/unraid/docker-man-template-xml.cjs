"use strict"

const NAME_START = /^[:_\p{L}]$/u
const NAME_CHARACTER = /^[:_.\-\p{L}\p{N}\u00B7\u0300-\u036F\u203F-\u2040]$/u
const XML_WHITESPACE = /^[\t\n\r ]$/u
const PREDEFINED_ENTITIES = new Set(["amp", "apos", "gt", "lt", "quot"])

function readName(value, start) {
  if (!NAME_START.test(value[start] ?? "")) return null
  let index = start + 1
  while (NAME_CHARACTER.test(value[index] ?? "")) index += 1
  return { value: value.slice(start, index), index }
}

function isXmlCodePoint(codePoint) {
  return codePoint === 0x9 || codePoint === 0xA || codePoint === 0xD
    || (codePoint >= 0x20 && codePoint <= 0xD7FF)
    || (codePoint >= 0xE000 && codePoint <= 0xFFFD)
    || (codePoint >= 0x10000 && codePoint <= 0x10FFFF)
}

function entitiesAreWellFormed(value) {
  for (const character of value) {
    if (!isXmlCodePoint(character.codePointAt(0))) return false
  }
  if (value.includes("]]>")) return false
  let index = 0
  while ((index = value.indexOf("&", index)) !== -1) {
    const end = value.indexOf(";", index + 1)
    if (end === -1) return false
    const entity = value.slice(index + 1, end)
    if (!PREDEFINED_ENTITIES.has(entity)) {
      const numeric = entity.match(/^#(x[0-9A-Fa-f]+|[0-9]+)$/u)
      if (!numeric) return false
      const digits = numeric[1]
      const codePoint = Number.parseInt(digits.startsWith("x") ? digits.slice(1) : digits, digits.startsWith("x") ? 16 : 10)
      if (!isXmlCodePoint(codePoint)) return false
    }
    index = end + 1
  }
  return true
}

function findTagEnd(xml, start) {
  let quote = null
  for (let index = start; index < xml.length; index += 1) {
    const character = xml[index]
    if (quote) {
      if (character === quote) quote = null
    } else if (character === "\"" || character === "'") {
      quote = character
    } else if (character === ">") {
      return index
    } else if (character === "<") {
      return -1
    }
  }
  return -1
}

function skipWhitespace(value, start) {
  let index = start
  while (XML_WHITESPACE.test(value[index] ?? "")) index += 1
  return index
}

function parseOpenTag(body) {
  const name = readName(body, 0)
  if (!name) return null
  let index = name.index
  const attributes = new Set()
  while (index < body.length) {
    const beforeWhitespace = index
    index = skipWhitespace(body, index)
    if (index === body.length) return { name: name.value, selfClosing: false }
    if (body[index] === "/" && index === body.length - 1) return { name: name.value, selfClosing: true }
    if (index === beforeWhitespace) return null
    const attribute = readName(body, index)
    if (!attribute || attributes.has(attribute.value)) return null
    attributes.add(attribute.value)
    index = skipWhitespace(body, attribute.index)
    if (body[index] !== "=") return null
    index = skipWhitespace(body, index + 1)
    const quote = body[index]
    if (quote !== "\"" && quote !== "'") return null
    const end = body.indexOf(quote, index + 1)
    if (end === -1 || body.slice(index + 1, end).includes("<") || !entitiesAreWellFormed(body.slice(index + 1, end))) return null
    index = end + 1
  }
  return { name: name.value, selfClosing: false }
}

// DockerMan templates use one element tree, quoted unique attributes, comments/CDATA/PIs, predefined or numeric entities, and no document type declaration.
function isWellFormedDockerManTemplateXml(xml) {
  if (typeof xml !== "string" || xml.length === 0) return false
  const stack = []
  let cursor = xml.charCodeAt(0) === 0xFEFF ? 1 : 0
  let rootSeen = false
  let rootClosed = false
  while (cursor < xml.length) {
    const open = xml.indexOf("<", cursor)
    const textEnd = open === -1 ? xml.length : open
    const text = xml.slice(cursor, textEnd)
    if (!entitiesAreWellFormed(text) || (stack.length === 0 && text.trim() !== "")) return false
    if (open === -1) break
    if (xml.startsWith("<!--", open)) {
      const end = xml.indexOf("-->", open + 4)
      if (end === -1 || xml.slice(open + 4, end).includes("--")) return false
      cursor = end + 3
      continue
    }
    if (xml.startsWith("<![CDATA[", open)) {
      const end = xml.indexOf("]]>", open + 9)
      if (stack.length === 0 || end === -1) return false
      cursor = end + 3
      continue
    }
    if (xml.startsWith("<?", open)) {
      const end = xml.indexOf("?>", open + 2)
      if (end === -1 || !readName(xml.slice(open + 2, end), 0)) return false
      cursor = end + 2
      continue
    }
    if (xml.startsWith("<!", open)) return false
    const end = findTagEnd(xml, open + 1)
    if (end === -1) return false
    const body = xml.slice(open + 1, end)
    if (body.startsWith("/")) {
      const closing = readName(body, 1)
      if (!closing || skipWhitespace(body, closing.index) !== body.length || stack.pop() !== closing.value) return false
      if (stack.length === 0) rootClosed = true
    } else {
      const tag = parseOpenTag(body)
      if (!tag || (stack.length === 0 && (rootSeen || rootClosed))) return false
      if (stack.length === 0) rootSeen = true
      if (tag.selfClosing) {
        if (stack.length === 0) rootClosed = true
      } else {
        stack.push(tag.name)
      }
    }
    cursor = end + 1
  }
  return rootSeen && rootClosed && stack.length === 0
}

module.exports = { isWellFormedDockerManTemplateXml }
