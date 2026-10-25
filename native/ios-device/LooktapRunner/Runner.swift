// looktap's real-device runner: a UI test that never finishes. It listens on a TCP port on the device
// (reached from the Mac through usbmuxd) and answers the same JSON-lines requests as the simulator helper,
// using XCUITest to read the screen and to tap, swipe and type. Only installed on physical devices.
import Network
import XCTest

/** The last failure XCUITest recorded during a request (it records failures instead of throwing them). */
var lastIssue: String?

final class Runner: XCTestCase {
  // A failed query or gesture is the request's error, not the end of the test session.
  override func record(_ issue: XCTIssue) {
    lastIssue = issue.compactDescription.split(separator: "\n").first.map(String.init) ?? "XCUITest failure"
  }

  func testServe() throws {
    let env = ProcessInfo.processInfo.environment
    let port = UInt16(env["LOOKTAP_PORT"] ?? "") ?? 22087
    let server = Server(version: env["LOOKTAP_VERSION"] ?? "")
    try server.listen(port: port)
    while !server.stopped { _ = RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.5)) }
  }
}

// MARK: - transport

final class Server {
  let version: String
  var stopped = false
  private var listener: NWListener?
  private let ops: Ops

  init(version: String) {
    self.version = version
    ops = Ops()
  }

  func listen(port: UInt16) throws {
    let l = try NWListener(using: .tcp, on: NWEndpoint.Port(rawValue: port)!)
    l.newConnectionHandler = { [weak self] c in self?.accept(c) }
    l.start(queue: DispatchQueue(label: "looktap.listen"))
    listener = l
  }

  private func accept(_ c: NWConnection) {
    let q = DispatchQueue(label: "looktap.conn")
    c.start(queue: q)
    var buf = Data()
    func next() {
      c.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { data, _, done, err in
        if let data { buf.append(data) }
        while let nl = buf.firstIndex(of: 10) {
          let line = buf.subdata(in: buf.startIndex..<nl)
          buf.removeSubrange(buf.startIndex...nl)
          guard let req = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { continue }
          // XCUITest wants the main thread; the test method spins its run loop.
          var reply: (head: [String: Any], body: Data?) = ([:], nil)
          DispatchQueue.main.sync { reply = self.handle(req) }
          self.send(c, reply.head, reply.body)
        }
        if done || err != nil { c.cancel() } else { next() }
      }
    }
    next()
  }

  private func send(_ c: NWConnection, _ head: [String: Any], _ body: Data?) {
    var h = head
    if let body { h["bytes"] = body.count }
    var out = (try? JSONSerialization.data(withJSONObject: h)) ?? Data("{\"ok\":false}".utf8)
    out.append(10)
    if let body { out.append(body) }
    c.send(content: out, completion: .contentProcessed { _ in })
  }

  private func handle(_ r: [String: Any]) -> ([String: Any], Data?) {
    let op = r["op"] as? String ?? ""
    if op == "hello" { return (["ok": true, "version": version, "pid": getpid(), "input": "xcuitest"], nil) }
    if op == "stop" {
      stopped = true
      return (["ok": true], nil)
    }
    lastIssue = nil
    do {
      let out = try ops.run(op, r)
      if let issue = lastIssue { return (["ok": false, "error": issue], nil) }
      return out
    } catch {
      return (["ok": false, "error": "\(error)"], nil)
    }
  }
}

struct Failure: Error, CustomStringConvertible {
  let description: String
  init(_ s: String) { description = s }
}

// MARK: - operations

final class Ops {
  let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
  /** Apps that may be in front, most recently seen first. The CLI adds the installed ones (`apps`). */
  var known = ["com.apple.Spotlight", "com.apple.Preferences", "com.apple.mobilesafari", "com.apple.Maps", "com.apple.mobileslideshow", "com.apple.MobileSMS",
               "com.apple.mobilemail", "com.apple.camera", "com.apple.AppStore", "com.apple.mobilecal", "com.apple.mobilenotes",
               "com.apple.reminders", "com.apple.MobileAddressBook", "com.apple.mobilephone", "com.apple.weather", "com.apple.Music",
               "com.apple.Health", "com.apple.DocumentsApp", "com.apple.shortcuts", "com.apple.mobiletimer", "com.apple.calculator"]
  private var apps: [String: XCUIApplication] = [:]
  /** Set by `selectall`: the next `delete` clears the focused field. */
  private var selected = false

  init() {
    // XCUITest waits for the app to go idle before every query and gesture. A screen that never idles
    // (a spinner, a Bluetooth scan) then stalls each command: answer from what is there now instead.
    if let cls = NSClassFromString("XCUIApplicationProcess") {
      for name in ["waitForQuiescenceIncludingAnimationsIdle:isPreEvent:", "waitForQuiescenceIncludingAnimationsIdle:usingActivity:isPreEvent:"] {
        let sel = NSSelectorFromString(name)
        guard let m = class_getInstanceMethod(cls, sel) else { continue }
        let noop: @convention(block) (AnyObject) -> Void = { _ in }
        method_setImplementation(m, imp_implementationWithBlock(noop))
      }
    }
  }

  func app(_ id: String) -> XCUIApplication {
    if let a = apps[id] { return a }
    let a = XCUIApplication(bundleIdentifier: id)
    apps[id] = a
    return a
  }

  /** The app in front, or nil on the home screen. Checks the last one first: usually it hasn't changed. */
  func front() -> String? {
    for id in known where id != "com.apple.springboard" && app(id).state == .runningForeground {
      if known.first != id { known.removeAll { $0 == id }; known.insert(id, at: 0) }
      return id
    }
    return nil
  }

  func frontApp() -> XCUIApplication { front().map(app) ?? springboard }

  func run(_ op: String, _ r: [String: Any]) throws -> ([String: Any], Data?) {
    let num = { (k: String, d: Double) -> Double in (r[k] as? NSNumber)?.doubleValue ?? d }
    switch op {
    case "apps":
      for id in (r["ids"] as? [String] ?? []) where !known.contains(id) { known.append(id) }
      return (["ok": true, "count": known.count], nil)

    case "tree":
      let a = frontApp()
      let all = r["all"] as? Bool ?? false
      let root = try a.snapshot()
      let screen = root.frame
      var walked = Walk()
      walked.walk(root, parent: -1, all: all, screen: screen)
      // System alerts (permission prompts) belong to SpringBoard, drawn over the app.
      if a != springboard, springboard.alerts.count > 0, let sb = try? springboard.snapshot() {
        for alert in sb.children where hasAlert(alert) { walked.walk(alert, parent: -1, all: false, screen: screen) }
      }
      let nodes = all ? walked.nodes.map(\.row) : walked.uncovered(screen: screen)
      return (["ok": true, "nodes": nodes, "screen": screenInfo(screen)], nil)

    case "front":
      let id = front()
      return (["ok": true, "pid": 0, "id": id ?? "", "path": ""], nil)

    case "tap":
      let c = point(num("x", 0), num("y", 0))
      let hold = num("hold", 0)
      if hold > 100 { c.press(forDuration: hold / 1000) } else { c.tap() }
      return (["ok": true], nil)

    case "swipe":
      let a = point(num("x1", 0), num("y1", 0)), b = point(num("x2", 0), num("y2", 0))
      let dist = hypot(num("x2", 0) - num("x1", 0), num("y2", 0) - num("y1", 0))
      let secs = max(num("ms", 150), 50) / 1000
      // `hold`: stay still at the end before lifting, so a list stops where the finger did instead of coasting.
      a.press(forDuration: 0.05, thenDragTo: b, withVelocity: XCUIGestureVelocity(max(dist / secs, 200)), thenHoldForDuration: num("hold", 0) / 1000)
      return (["ok": true], nil)

    case "pinch":
      // XCUITest pinches around an element's centre: the app's, whatever point was asked for.
      let r0 = num("r0", 40), r1 = num("r1", 100)
      frontApp().pinch(withScale: CGFloat(r1 / r0), velocity: r1 > r0 ? 2 : -2)
      return (["ok": true], nil)

    case "text":
      selected = false
      frontApp().typeText(r["s"] as? String ?? "")
      return (["ok": true], nil)

    case "key":
      for k in r["keys"] as? [String] ?? [] { try key(k) }
      return (["ok": true], nil)

    case "keyboard":
      return (["ok": true, "shown": frontApp().keyboards.count > 0], nil)

    case "shot":
      let png = XCUIScreen.main.screenshot().pngRepresentation
      let scale = num("scale", 1)
      return (["ok": true], scale < 1 ? shrink(png, scale) : png)

    case "rotate":
      let want = Int(num("orientation", 0))
      if (1...4).contains(want), let o = UIDeviceOrientation(rawValue: want) {
        XCUIDevice.shared.orientation = o
        Thread.sleep(forTimeInterval: 0.6)
      }
      return (["ok": true, "screen": screenInfo(frontApp().frame)], nil)

    case "launch":
      let id = r["app"] as? String ?? ""
      app(id).launch()
      known.removeAll { $0 == id }
      known.insert(id, at: 0)
      return (["ok": true], nil)

    case "activate":
      // To the front as it was; started only if it isn't running (launch would restart it).
      let id = r["app"] as? String ?? ""
      app(id).activate()
      known.removeAll { $0 == id }
      known.insert(id, at: 0)
      return (["ok": true], nil)

    case "terminate":
      app(r["app"] as? String ?? "").terminate()
      return (["ok": true], nil)

    case "state":
      let s = app(r["app"] as? String ?? "").state
      return (["ok": true, "running": s != .notRunning && s != .unknown, "front": s == .runningForeground], nil)

    case "open":
      guard let url = URL(string: r["url"] as? String ?? "") else { throw Failure("not a URL") }
      XCUIDevice.shared.system.open(url)
      return (["ok": true], nil)

    case "home":
      XCUIDevice.shared.press(.home)
      // Some phones ignore the Home press (an iPhone 14 Pro on iOS 26.0 did, from one day to the next, with no
      // error): bring the home screen forward instead.
      let until = Date().addingTimeInterval(1)
      while front() != nil && Date() < until { Thread.sleep(forTimeInterval: 0.1) }
      if front() != nil { springboard.activate() }
      return (["ok": true], nil)

    case "appearance":
      if let m = r["mode"] as? String { XCUIDevice.shared.appearance = m == "dark" ? .dark : .light }
      return (["ok": true, "mode": XCUIDevice.shared.appearance == .dark ? "dark" : "light"], nil)

    default:
      throw Failure("unknown op: \(op)")
    }
  }

  // MARK: helpers

  private func hasAlert(_ s: XCUIElementSnapshot) -> Bool {
    s.elementType == .alert || s.children.contains { hasAlert($0) }
  }

  private func screenInfo(_ f: CGRect) -> [String: Any] {
    ["w": f.width.rounded(), "h": f.height.rounded(), "orientation": XCUIDevice.shared.orientation.rawValue]
  }

  /** A point on screen, in the same space as the tree's frames (the front app's). */
  private func point(_ x: Double, _ y: Double) -> XCUICoordinate {
    frontApp().coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y))
  }

  private func key(_ k: String) throws {
    let a = frontApp()
    switch k {
    case "selectall":
      selected = true
      return
    case "delete":
      if selected {
        selected = false
        let field = a.descendants(matching: .any).matching(NSPredicate(format: "hasKeyboardFocus == true")).firstMatch
        if field.exists, let v = field.value as? String, !v.isEmpty, v != field.placeholderValue {
          a.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: v.count))
        }
        return
      }
      a.typeText(XCUIKeyboardKey.delete.rawValue)
    case "return": a.typeText("\n")
    case "tab": a.typeText("\t")
    case "space": a.typeText(" ")
    case "escape": a.typeText(XCUIKeyboardKey.escape.rawValue)
    case "home": XCUIDevice.shared.press(.home)
    case "volumeup": XCUIDevice.shared.press(.volumeUp)
    case "volumedown": XCUIDevice.shared.press(.volumeDown)
    default: throw Failure("unknown key: \(k)")
    }
    selected = false
  }

  private func shrink(_ png: Data, _ scale: Double) -> Data {
    guard let img = UIImage(data: png) else { return png }
    let size = CGSize(width: img.size.width * img.scale * scale, height: img.size.height * img.scale * scale)
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    return UIGraphicsImageRenderer(size: size, format: format).pngData { _ in img.draw(in: CGRect(origin: .zero, size: size)) }
  }
}

/**
 The snapshot flattened in pre-order. XCUITest also reports views that are on screen but covered — the
 page under a search overlay, say — so `uncovered` hit-tests each element a listing would show and drops
 those whose centre belongs to some other branch of the tree.
 */
struct Walk {
  struct Node {
    var row: [String: Any]
    let ax: NSObject?
    let parent: Int
    let visible: CGRect
  }
  var nodes: [Node] = []
  private var all: [Node] = [] // every snapshot element, listed or not: parents for the hit test
  private var listed: [Int] = [] // index in `all` of each of `nodes`

  mutating func walk(_ s: XCUIElementSnapshot, parent: Int, all showAll: Bool, screen: CGRect) {
    let f = s.frame
    // The part not clipped away by scroll views and containers. Empty for some floating views that are in
    // plain sight (iOS 26's glass toolbars), so it only narrows the frame; the hit test decides what's covered.
    let clip = ((s as AnyObject).value(forKey: "visibleFrame") as? CGRect) ?? f
    let vf = clip.isEmpty ? f : clip
    // Some system windows report their frame in pixels, not points: nothing real is bigger than the screen.
    let oversized = f.width > screen.width * 1.5 && f.height > screen.height * 1.5
    let onScreen = f.width > 0 && f.height > 0 && f.intersects(screen) && !vf.isEmpty && !oversized
    var row: [String: Any] = ["l": s.label, "t": typeName(s.elementType),
                              "x": f.minX.rounded(), "y": f.minY.rounded(), "w": f.width.rounded(), "h": f.height.rounded()]
    if !s.identifier.isEmpty { row["id"] = s.identifier }
    if let v = s.value { let str = "\(v)"; if !str.isEmpty { row["v"] = str } }
    let node = Node(row: row, ax: (s as AnyObject).value(forKey: "accessibilityElement") as? NSObject, parent: parent, visible: vf.intersection(screen))
    let me = all.count
    all.append(node)
    if showAll || onScreen {
      listed.append(me)
      nodes.append(node)
    }
    for c in s.children { walk(c, parent: me, all: showAll, screen: screen) }
  }

  func uncovered(screen: CGRect) -> [[String: Any]] {
    guard let client = XCUIDevice.shared.value(forKey: "accessibilityInterface") as? NSObject else { return nodes.map(\.row) }
    let sel = NSSelectorFromString("hitTestElement:withPoint:error:")
    guard client.responds(to: sel) else { return nodes.map(\.row) }
    typealias HitFn = @convention(c) (NSObject, Selector, NSObject, CGPoint, UnsafeMutablePointer<NSError?>?) -> NSObject?
    let hit = unsafeBitCast(client.method(for: sel), to: HitFn.self)
    var index: [NSObject: Int] = [:]
    for (i, n) in all.enumerated() { if let ax = n.ax, index[ax] == nil { index[ax] = i } }
    let ancestors = { (i: Int) -> Set<Int> in
      var out = Set<Int>(), j = i
      while j >= 0 { out.insert(j); j = all[j].parent }
      return out
    }
    let bars = nodes.filter { ["Toolbar", "TabBar", "NavigationBar"].contains($0.row["t"] as? String ?? "") }.map(\.visible)
    var out: [[String: Any]] = []
    for (k, n) in nodes.enumerated() {
      let label = n.row["l"] as? String ?? ""
      let type = n.row["t"] as? String ?? ""
      // Only what a listing shows is worth a hit test; containers the size of the screen can't be covered.
      if (label.isEmpty && !type.contains("Button")) || n.visible.isEmpty || n.visible.equalTo(screen) {
        out.append(n.row)
        continue
      }
      let me = listed[k]
      var top = me
      while all[top].parent >= 0 { top = all[top].parent }
      // Bars float over the content (iOS 26 draws them as glass over the list), and hit tests can answer
      // with the row underneath: whatever sits in a bar is on top.
      if bars.contains(where: { $0.contains(n.visible) }) {
        out.append(n.row)
        continue
      }
      guard let root = all[top].ax, let h = hit(client, sel, root, CGPoint(x: n.visible.midX, y: n.visible.midY), nil), let at = index[h] else {
        out.append(n.row) // nothing known there (another process's view): keep it
        continue
      }
      // Visible when what is at its centre is the element itself, inside it, or one of its containers.
      if ancestors(at).contains(me) || ancestors(me).contains(at) { out.append(n.row) }
    }
    return out
  }
}

/** XCUITest's element types, named like the simulator helper's accessibility roles. */
func typeName(_ t: XCUIElement.ElementType) -> String {
  switch t {
  case .application: return "Application"
  case .window: return "Window"
  case .alert: return "Alert"
  case .sheet: return "Sheet"
  case .button: return "Button"
  case .radioButton: return "RadioButton"
  case .checkBox: return "CheckBox"
  case .popUpButton: return "PopUpButton"
  case .menuButton: return "MenuButton"
  case .toolbarButton: return "ToolbarButton"
  case .link: return "Link"
  case .cell: return "Cell"
  case .staticText: return "StaticText"
  case .textField: return "TextField"
  case .secureTextField: return "SecureTextField"
  case .searchField: return "SearchField"
  case .textView: return "TextArea"
  case .image: return "Image"
  case .icon: return "Button" // home-screen icons: Button, as on the simulator
  case .switch: return "Switch"
  case .toggle: return "Toggle"
  case .slider: return "Slider"
  case .stepper: return "Stepper"
  case .picker: return "Picker"
  case .pickerWheel: return "PickerWheel"
  case .pageIndicator: return "PageIndicator"
  case .progressIndicator: return "ProgressIndicator"
  case .activityIndicator: return "ActivityIndicator"
  case .segmentedControl: return "SegmentedControl"
  case .navigationBar: return "NavigationBar"
  case .tabBar: return "TabBar"
  case .tab: return "Tab"
  case .toolbar: return "Toolbar"
  case .statusBar: return "StatusBar"
  case .table: return "Table"
  case .collectionView: return "CollectionView"
  case .scrollView: return "ScrollView"
  case .webView: return "WebView"
  case .map: return "Map"
  case .keyboard: return "Keyboard"
  case .key: return "Button" // keyboard keys: Button, as on the simulator (lib/screen.js folds them)
  case .menu: return "Menu"
  case .menuItem: return "MenuItem"
  case .datePicker: return "DatePicker"
  case .other: return "Group"
  default: return "Other"
  }
}
