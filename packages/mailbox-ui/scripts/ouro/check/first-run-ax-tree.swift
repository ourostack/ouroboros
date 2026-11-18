// First-run gate: the eyes and hands a gate needs on a Mac, through the system's accessibility API and its own events.
// Generic: no app names. A gate builds it with swiftc and talks to it a line at a time on stdin; each answer is one JSON line.
//   trust                          whether this process may read other apps' windows and post events
//   tree <pid>                     every element of the process's windows, flattened: role, subrole, words, enabled, frame,
//                                  and the web content's DOM id and classes (WebKit's AXDOMIdentifier, AXDOMClassList)
//   shown <pid>                    the process's windows a person can see: on screen, normal layer, not transparent
//   close-window <pid>             presses the close button of the process's first window, as a click on it does
//   extras <pid>                   the process's menu bar items (NSStatusItem), with their words
//   extra-menu <pid> <n>           opens menu bar item n and reads its menu's items (title, enabled); the menu stays open
//   extra-press <title>            presses the item titled <title> in the open menu bar menu
//   press <pid> <label>            the accessibility press of the first enabled control whose words are exactly <label>
//                                  (or start with it, when it ends in *), inside the topmost dialog when one is up
//   key <name>                     escape, return, tab, a letter or a digit, with modifiers: cmd-w, cmd-1, cmd-a
//   click <x> <y>                  a left click at a screen point
//   pixels <png> <x> <y> <w> <h>   how much of that rectangle (points, from the screen's top left) of a full-screen
//                                  screenshot is one shade (uniform, 0 to 1) and its mean grey
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO

setvbuf(stdout, nil, _IOLBF, 0)
let source = CGEventSource(stateID: .hidSystemState)

func say(_ obj: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: obj)
  print(String(data: data, encoding: .utf8)!)
}

func attr(_ e: AXUIElement, _ name: String) -> AnyObject? {
  var v: CFTypeRef?
  return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
}

let wanted: [String] = [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, kAXEnabledAttribute,
                        kAXFocusedAttribute, kAXPositionAttribute, kAXSizeAttribute, "AXDOMIdentifier", "AXDOMClassList", kAXChildrenAttribute]

/// One round trip per element: the attributes a gate reads, in `wanted`'s order (nil where the element has none).
func many(_ e: AXUIElement) -> [AnyObject?] {
  var out: CFArray?
  guard AXUIElementCopyMultipleAttributeValues(e, wanted as CFArray, [], &out) == .success, let arr = out as? [AnyObject], arr.count == wanted.count else {
    return wanted.map { attr(e, $0) }
  }
  return arr.map { v -> AnyObject? in
    // A missing attribute comes back as an AXValue of type .axError.
    if CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .axError { return nil }
    return v
  }
}

func point(_ v: AnyObject?) -> CGPoint? {
  guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
  var p = CGPoint.zero
  return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
}

func size(_ v: AnyObject?) -> CGSize? {
  guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
  var s = CGSize.zero
  return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
}

func text(_ v: AnyObject?) -> String? {
  guard let s = v as? String, !s.isEmpty else { return nil }
  return String(s.prefix(160))
}

func children(_ e: AXUIElement) -> [AXUIElement] {
  (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

/// Depth-first and bounded, so a deep page can't hold the gate: each element once, with its parent's index.
func flatten(_ root: AXUIElement, budget: inout Int) -> [[String: Any]] {
  var nodes: [[String: Any]] = []
  var left = budget
  func visit(_ e: AXUIElement, parent: Int, depth: Int) {
    guard depth < 48, left > 0 else { return }
    left -= 1
    let v = many(e)
    var n: [String: Any] = ["i": nodes.count, "p": parent, "d": depth, "role": (v[0] as? String) ?? ""]
    if let s = v[1] as? String { n["subrole"] = s }
    let words = [text(v[2]), text(v[3]), text(v[4])].compactMap { $0 }
    if !words.isEmpty { n["words"] = words.joined(separator: " | ") }
    n["enabled"] = (v[5] as? Bool) ?? true
    if (v[6] as? Bool) == true { n["focused"] = true }
    if let p = point(v[7]), let z = size(v[8]) {
      n["x"] = Int(p.x)
      n["y"] = Int(p.y)
      n["w"] = Int(z.width)
      n["h"] = Int(z.height)
    }
    if let id = text(v[9]) { n["domId"] = id }
    if let cls = v[10] as? [String], !cls.isEmpty { n["domClass"] = cls }
    let me = nodes.count
    nodes.append(n)
    for c in (v[11] as? [AXUIElement]) ?? [] { visit(c, parent: me, depth: depth + 1) }
  }
  visit(root, parent: -1, depth: 0)
  budget = left
  return nodes
}

func key(_ code: CGKeyCode, _ flags: CGEventFlags = []) {
  for down in [true, false] {
    guard let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { continue }
    e.flags = flags
    e.post(tap: .cghidEventTap)
    usleep(12_000)
  }
}

let dialogSubroles: Set<String> = ["AXApplicationDialog", "AXApplicationAlertDialog", "AXDialog", "AXSystemDialog"]
let pressable: Set<String> = ["AXButton", "AXLink", "AXMenuItem", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXTab"]

func words(_ e: AXUIElement) -> [String] {
  [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute].compactMap { attr(e, $0) as? String }.filter { !$0.isEmpty }
}

/// The last dialog drawn (the topmost), else the windows themselves.
func scopes(_ app: AXUIElement) -> [AXUIElement] {
  var dialog: AXUIElement?
  var budget = 8000
  func walk(_ e: AXUIElement, _ depth: Int) {
    guard depth < 48, budget > 0 else { return }
    budget -= 1
    let role = (attr(e, kAXRoleAttribute) as? String) ?? ""
    if role == "AXSheet" || dialogSubroles.contains((attr(e, kAXSubroleAttribute) as? String) ?? "") { dialog = e }
    for c in children(e) { walk(c, depth + 1) }
  }
  for w in children(app) { walk(w, 0) }
  return dialog.map { [$0] } ?? children(app)
}

/// The main display's width in points, so a screenshot's pixels map to the accessibility tree's points.
let screenWidth = Double(CGDisplayBounds(CGMainDisplayID()).width)
var openMenu: AXUIElement?

while let line = readLine() {
  let parts = line.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: false).map(String.init)
  switch parts.first ?? "" {
  case "trust":
    say(["ok": true, "accessibility": AXIsProcessTrusted(), "postEvent": CGPreflightPostEventAccess(), "screen": CGPreflightScreenCaptureAccess()])
  case "tree" where parts.count >= 2:
    let app = AXUIElementCreateApplication(pid_t(Int(parts[1]) ?? -1))
    var budget = 9000
    var windows: [[String: Any]] = []
    for w in children(app) where (attr(w, kAXRoleAttribute) as? String) == "AXWindow" {
      let p = point(attr(w, kAXPositionAttribute)) ?? .zero
      let z = size(attr(w, kAXSizeAttribute)) ?? .zero
      let nodes = flatten(w, budget: &budget)
      windows.append(["title": (attr(w, kAXTitleAttribute) as? String) ?? "", "x": Int(p.x), "y": Int(p.y), "w": Int(z.width), "h": Int(z.height), "nodes": nodes])
    }
    say(["ok": true, "windows": windows, "budgetLeft": budget])
  case "shown" where parts.count >= 2:
    // A window an app keeps after it's closed can stay on the list, transparent: only one drawn counts as shown.
    let pid = Int(parts[1]) ?? -1
    let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    let mine = list.filter { ($0[kCGWindowOwnerPID as String] as? Int) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 && (($0[kCGWindowAlpha as String] as? Double) ?? 1) > 0.01 }
    let rows: [[String: Any]] = mine.compactMap { w in
      guard let b = (w[kCGWindowBounds as String] as? NSDictionary).flatMap({ CGRect(dictionaryRepresentation: $0) }), b.width > 200, b.height > 150 else { return nil }
      return ["name": w[kCGWindowName as String] ?? "", "w": Int(b.width), "h": Int(b.height)]
    }
    say(["ok": true, "windows": rows])
  case "close-window" where parts.count >= 2:
    let app = AXUIElementCreateApplication(pid_t(Int(parts[1]) ?? -1))
    let window = children(app).first { (attr($0, kAXRoleAttribute) as? String) == "AXWindow" }
    let button = window.flatMap { attr($0, kAXCloseButtonAttribute) }.map { $0 as! AXUIElement }
    say(["ok": button.map { AXUIElementPerformAction($0, kAXPressAction as CFString) == .success } ?? false])
  case "extras" where parts.count >= 2:
    let app = AXUIElementCreateApplication(pid_t(Int(parts[1]) ?? -1))
    let bar = attr(app, "AXExtrasMenuBar").map { $0 as! AXUIElement }
    let items = bar.map(children) ?? []
    say(["ok": bar != nil, "items": items.map { words($0).joined(separator: " | ") }])
  case "extra-menu" where parts.count >= 3:
    let app = AXUIElementCreateApplication(pid_t(Int(parts[1]) ?? -1))
    let items = attr(app, "AXExtrasMenuBar").map { children($0 as! AXUIElement) } ?? []
    let n = Int(parts[2]) ?? 0
    guard n < items.count else {
      say(["ok": false, "why": "no menu bar item \(n) (\(items.count) items)"])
      continue
    }
    // A press that opens a menu answers only when the menu closes: bound the wait and look for the menu instead.
    AXUIElementSetMessagingTimeout(items[n], 0.5)
    _ = AXUIElementPerformAction(items[n], kAXPressAction as CFString)
    var menu: AXUIElement?
    for _ in 0..<20 where menu == nil {
      usleep(100_000)
      menu = children(items[n]).first { (attr($0, kAXRoleAttribute) as? String) == "AXMenu" }
    }
    openMenu = menu
    let rows = (menu.map(children) ?? []).filter { (attr($0, kAXRoleAttribute) as? String) == "AXMenuItem" }.map { e -> [String: Any] in
      ["title": (attr(e, kAXTitleAttribute) as? String) ?? "", "enabled": (attr(e, kAXEnabledAttribute) as? Bool) ?? false]
    }
    say(["ok": menu != nil, "items": rows])
  case "extra-press" where parts.count >= 2:
    let title = String(line.dropFirst("extra-press ".count))
    let hit = (openMenu.map(children) ?? []).first { (attr($0, kAXTitleAttribute) as? String) == title }
    if let hit { AXUIElementSetMessagingTimeout(hit, 2) }
    let ok = hit.map { AXUIElementPerformAction($0, kAXPressAction as CFString) == .success } ?? false
    openMenu = nil
    say(["ok": ok])
  case "press" where parts.count >= 3:
    let app = AXUIElementCreateApplication(pid_t(Int(parts[1]) ?? -1))
    var pressed = false
    var budget = 8000
    let prefix = parts[2].hasSuffix("*")
    let want = prefix ? String(parts[2].dropLast()) : parts[2]
    func walk(_ e: AXUIElement, _ depth: Int) {
      guard !pressed, depth < 48, budget > 0 else { return }
      budget -= 1
      let role = (attr(e, kAXRoleAttribute) as? String) ?? ""
      if pressable.contains(role), (attr(e, kAXEnabledAttribute) as? Bool) ?? true, words(e).contains(where: { prefix ? $0.hasPrefix(want) : $0 == want }) {
        pressed = AXUIElementPerformAction(e, kAXPressAction as CFString) == .success
        return
      }
      for c in children(e) { walk(c, depth + 1) }
    }
    for s in scopes(app) { walk(s, 0) }
    say(["ok": pressed])
  case "key" where parts.count >= 2:
    let codes: [String: CGKeyCode] = ["escape": 53, "return": 36, "tab": 48, "space": 49, "comma": 43,
      "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
      "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
      "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25, "0": 29]
    let pieces = parts[1].split(separator: "-").map(String.init)
    var flags: CGEventFlags = []
    if pieces.contains("cmd") { flags.insert(.maskCommand) }
    if pieces.contains("shift") { flags.insert(.maskShift) }
    if pieces.contains("alt") { flags.insert(.maskAlternate) }
    if pieces.contains("ctrl") { flags.insert(.maskControl) }
    if let code = codes[pieces.last ?? ""] {
      key(code, flags)
      say(["ok": true])
    } else {
      say(["ok": false, "why": "unknown key \(parts[1])"])
    }
  case "click" where parts.count >= 3:
    let p = CGPoint(x: Double(parts[1]) ?? 0, y: Double(parts[2]) ?? 0)
    for t in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
      CGEvent(mouseEventSource: source, mouseType: t, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
      usleep(40_000)
    }
    say(["ok": true])
  case "pixels":
    // Every pixel of the rectangle (points from the screen's top left; 0 0 0 0 is the whole picture, for a picture of just
    // the rectangle), inset 24 points so a card's rounded corners, edge and shadow aren't read: the share within two grey
    // levels of the most common one. A line of text in a large pane is a few tenths of a percent; nothing drawn is all of it.
    let a = line.split(separator: " ").map(String.init)
    guard a.count == 6, let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: a[1]) as CFURL, nil), let img = CGImageSourceCreateImageAtIndex(src, 0, nil),
          let x = Double(a[2]), let y = Double(a[3]), let w = Double(a[4]), let h = Double(a[5]) else {
      say(["ok": false, "why": "usage: pixels <png> <x> <y> <w> <h>"])
      continue
    }
    let whole = w <= 0 || h <= 0
    // A whole screenshot's pixels per point; a picture of just the rectangle has the display's, read from its mode.
    let mode = CGDisplayCopyDisplayMode(CGMainDisplayID())
    let display = mode.map { Double($0.pixelWidth) / max(1, Double($0.width)) } ?? 1
    let scale = whole ? display : Double(img.width) / max(1, screenWidth)
    let inset = 24 * scale
    let rect = whole ? CGRect(x: inset, y: inset, width: Double(img.width) - 2 * inset, height: Double(img.height) - 2 * inset)
                     : CGRect(x: x * scale + inset, y: y * scale + inset, width: w * scale - 2 * inset, height: h * scale - 2 * inset)
    guard rect.width > 4, rect.height > 4, let crop = img.cropping(to: rect.integral) else {
      say(["ok": false, "why": "nothing to read in that rectangle"])
      continue
    }
    let gw = crop.width, gh = crop.height
    var gray = [UInt8](repeating: 0, count: gw * gh)
    let drawn: Bool = gray.withUnsafeMutableBytes { buf in
      guard let ctx = CGContext(data: buf.baseAddress, width: gw, height: gh, bitsPerComponent: 8, bytesPerRow: gw, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
      ctx.draw(crop, in: CGRect(x: 0, y: 0, width: gw, height: gh))
      return true
    }
    guard drawn else {
      say(["ok": false, "why": "no drawing context"])
      continue
    }
    var hist = [Int](repeating: 0, count: 256)
    var sum = 0
    for p in gray {
      hist[Int(p)] += 1
      sum += Int(p)
    }
    let top = hist.indices.max(by: { hist[$0] < hist[$1] }) ?? 0
    let near = (max(0, top - 2)...min(255, top + 2)).reduce(0) { $0 + hist[$1] }
    say(["ok": true, "uniform": Double(near) / Double(gray.count), "mean": Double(sum) / Double(gray.count)])
  default:
    say(["ok": false, "why": "unknown command"])
  }
}
