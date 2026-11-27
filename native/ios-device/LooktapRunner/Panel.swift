// What the runner shows on the phone. The runner is an app ("looktap runner") that is mostly in the background while
// looktap drives other apps; whoever opens it sees what it is, whether looktap is connected, what it did last, when
// its build stops working, and a switch to stop looktap acting on the phone.
//
// It is drawn from the test's own process (the runner app's), in a window of its own on the app's scene. Nothing here
// is part of what looktap reads: it never reads the runner app's screen.
import UIKit

/** The ops that change something on the phone. While control is off these are refused; reading the screen is not. */
let ACTION_OPS: Set<String> = ["tap", "swipe", "pinch", "text", "key", "launch", "activate", "terminate", "open", "home", "rotate", "appearance"]

/** One action, as the panel lists it. */
struct Done {
  let at: Date
  let what: String
  let ok: Bool
}

/** looktap's accent: the site's #22d3ee on dark, a deeper teal on light so it reads on white. */
let accent = UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0x22 / 255, green: 0xd3 / 255, blue: 0xee / 255, alpha: 1) : UIColor(red: 0x0e / 255, green: 0x74 / 255, blue: 0x90 / 255, alpha: 1) }

/** The build's provisioning profile: when it stops working, and the team that signed it. */
func profile() -> (expires: Date?, team: String?) {
  guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"), let data = try? Data(contentsOf: url),
        let start = data.range(of: Data("<?xml".utf8)), let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex),
        let plist = try? PropertyListSerialization.propertyList(from: data.subdata(in: start.lowerBound..<end.upperBound), format: nil) as? [String: Any]
  else { return (nil, nil) }
  return (plist["ExpirationDate"] as? Date, plist["TeamName"] as? String)
}

/** An op and its request → a line for the list. Typed text is never shown (it can be a password), nor a URL's path. */
func describe(_ op: String, _ r: [String: Any]) -> String {
  let n = { (k: String) -> Int in Int((r[k] as? NSNumber)?.doubleValue ?? 0) }
  switch op {
  case "tap": return n("hold") > 100 ? "Long press at \(n("x")), \(n("y"))" : "Tap at \(n("x")), \(n("y"))"
  case "swipe": return "Swipe \(n("x1")), \(n("y1")) → \(n("x2")), \(n("y2"))"
  case "pinch": return "Pinch"
  case "text":
    let count = (r["s"] as? String ?? "").count
    return "Typed \(count) character\(count == 1 ? "" : "s")"
  case "key": return "Key " + (r["keys"] as? [String] ?? []).joined(separator: ", ")
  case "launch": return "Launched \(r["app"] as? String ?? "an app")"
  case "activate": return "Switched to \(r["app"] as? String ?? "an app")"
  case "terminate": return "Closed \(r["app"] as? String ?? "an app")"
  case "open":
    let url = URL(string: r["url"] as? String ?? "")
    return "Opened \(url?.scheme ?? "a link")\(url?.host.map { "://" + $0 } ?? ":")"
  case "home": return "Home"
  case "rotate": return "Rotated"
  case "appearance": return r["mode"] is String ? "Appearance: \(r["mode"] as! String)" : "Read appearance"
  default: return op
  }
}

final class Panel {
  static let shared = Panel()

  let started = Date()
  let signed = profile()
  var version = ""
  /** Who connected last (sent with hello): the Mac's name, and USB or Wi-Fi. */
  var mac: String?
  var via: String?
  var peers = 0
  var lastContact: Date?
  var reads = 0
  var actions = 0
  var recent: [Done] = []
  var onStop: (() -> Void)?

  /**
   Show touches: apps that looktap launches get LOOKTAP_TOUCHES=1, which an app built with LooktapTouches.m reads to
   draw its pointer. The phone's own switch for `looktap touches on|off`: either one sets it.
   */
  var touches: Bool {
    get { UserDefaults.standard.bool(forKey: "looktap.touches") }
    set { UserDefaults.standard.set(newValue, forKey: "looktap.touches"); refresh() }
  }

  /** Control on (the default) or off. Kept across runs, so a phone someone paused stays paused. */
  var allowed: Bool {
    get { UserDefaults.standard.object(forKey: "looktap.allowed") as? Bool ?? true }
    set { UserDefaults.standard.set(newValue, forKey: "looktap.allowed"); refresh() }
  }

  private var window: UIWindow?
  private var rows: [String: UILabel] = [:]
  private var list = UIStackView()
  private var toggle = UISwitch()
  private var touchesToggle = UISwitch()
  private var dot = UIView()
  private var timer: Timer?

  /** Days left before the build stops working, nil when the profile can't be read. */
  var daysLeft: Int? {
    signed.expires.map { Int(floor($0.timeIntervalSinceNow / 86400)) }
  }

  // MARK: what the server tells it (all on the main thread)

  // Speed first: XCUITest runs on this same main thread. The panel only notes what happened here (a few counters);
  // it redraws later, after the reply has gone, and only while someone is looking at it.
  func connected() { peers += 1; lastContact = Date(); refreshSoon() }
  func disconnected() { peers = max(0, peers - 1); lastContact = Date(); refreshSoon() }

  func did(_ op: String, _ r: [String: Any], ok: Bool) {
    lastContact = Date()
    guard ACTION_OPS.contains(op) else { reads += 1; return refreshSoon() }
    actions += 1
    recent.insert(Done(at: Date(), what: describe(op, r), ok: ok), at: 0)
    if recent.count > 20 { recent.removeLast(recent.count - 20) }
    refreshSoon()
  }

  // MARK: the window

  func show() {
    guard window == nil else { return }
    let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
    let w = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: UIScreen.main.bounds)
    w.windowLevel = .normal + 1
    w.rootViewController = build()
    w.isHidden = false
    window = w
    timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.refresh() }
    refresh()
  }

  private func build() -> UIViewController {
    let vc = UIViewController()
    vc.view.backgroundColor = .systemGroupedBackground
    let scroll = UIScrollView()
    scroll.translatesAutoresizingMaskIntoConstraints = false
    scroll.alwaysBounceVertical = true
    vc.view.addSubview(scroll)
    let stack = UIStackView()
    stack.axis = .vertical
    stack.spacing = 14
    stack.translatesAutoresizingMaskIntoConstraints = false
    scroll.addSubview(stack)
    let guide = scroll.contentLayoutGuide, frame = scroll.frameLayoutGuide
    NSLayoutConstraint.activate([
      scroll.topAnchor.constraint(equalTo: vc.view.safeAreaLayoutGuide.topAnchor),
      scroll.bottomAnchor.constraint(equalTo: vc.view.bottomAnchor),
      scroll.leadingAnchor.constraint(equalTo: vc.view.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: vc.view.trailingAnchor),
      stack.topAnchor.constraint(equalTo: guide.topAnchor, constant: 20),
      stack.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -32),
      stack.leadingAnchor.constraint(equalTo: frame.leadingAnchor, constant: 16),
      stack.trailingAnchor.constraint(equalTo: frame.trailingAnchor, constant: -16),
    ])

    // Title, and what this app is.
    let title = UILabel()
    title.text = "looktap runner"
    title.font = .systemFont(ofSize: 30, weight: .bold)
    let intro = text("Lets looktap on your Mac read this iPhone's screen and drive it, for you or an AI agent. It runs while a looktap command or looktap live uses it.", style: .subheadline, color: .secondaryLabel)
    stack.addArrangedSubview(title)
    stack.addArrangedSubview(intro)
    stack.setCustomSpacing(20, after: intro)

    // Connection.
    dot.translatesAutoresizingMaskIntoConstraints = false
    dot.layer.cornerRadius = 5
    NSLayoutConstraint.activate([dot.widthAnchor.constraint(equalToConstant: 10), dot.heightAnchor.constraint(equalToConstant: 10)])
    stack.addArrangedSubview(card("Connection", [row("status", "Status", lead: dot), row("last", "Last command"), row("count", "This session"), row("since", "Running since")]))

    // Control.
    toggle.onTintColor = accent
    toggle.addAction(UIAction { [weak self] a in self?.allowed = (a.sender as? UISwitch)?.isOn ?? true }, for: .valueChanged)
    let control = row("control", "Allow control", trail: toggle)
    let note = text("Off: looktap can still see the screen, but can't tap, type, swipe or open apps until you turn it back on.", style: .footnote, color: .secondaryLabel)
    let stop = UIButton(type: .system)
    stop.setTitle("Stop the runner", for: .normal)
    stop.setTitleColor(.systemRed, for: .normal)
    stop.contentHorizontalAlignment = .leading
    stop.addAction(UIAction { [weak self, weak vc] _ in self?.confirmStop(from: vc) }, for: .touchUpInside)
    // Shown, but faded and off: the same screen as on Android, where it works in every app. iOS lets no app draw over
    // another, so here only `looktap touches on` reaches an app built with LooktapTouches.m.
    touchesToggle.isEnabled = false
    let touchesRow = row("touches", "Show touches", trail: touchesToggle)
    touchesRow.alpha = 0.45
    let touchesNote = text("Not available on iPhone: iOS lets no app draw over another. On a computer, looktap shot --mark draws the touch on a screenshot, and an app built with LooktapTouches.m can show it.", style: .footnote, color: .secondaryLabel)
    stack.addArrangedSubview(card("Control", [control, note, touchesRow, touchesNote, stop]))

    // Build.
    stack.addArrangedSubview(card("This build", [row("expires", "Works until"), row("team", "Signed by"), row("version", "Version")]))

    // Recent actions.
    list.axis = .vertical
    list.spacing = 8
    stack.addArrangedSubview(card("Recent actions", [list]))

    // Help.
    stack.addArrangedSubview(card("If looktap can't reach this iPhone", [
      text("• Keep it unlocked while looktap works.\n• Connect it with a cable, or keep it on the same Wi-Fi as the Mac.\n• First run: trust the developer in Settings › General › VPN & Device Management.\n• Run looktap doctor on the Mac: it says what is wrong.", style: .footnote, color: .secondaryLabel),
    ]))
    return vc
  }

  private func text(_ s: String, style: UIFont.TextStyle, color: UIColor = .label) -> UILabel {
    let l = UILabel()
    l.text = s
    l.font = .preferredFont(forTextStyle: style)
    l.textColor = color
    l.numberOfLines = 0
    l.adjustsFontForContentSizeCategory = true
    return l
  }

  private func row(_ key: String, _ name: String, lead: UIView? = nil, trail: UIView? = nil) -> UIView {
    let h = UIStackView()
    h.alignment = .center
    h.spacing = 8
    if let lead { h.addArrangedSubview(lead) }
    let n = text(name, style: .body)
    n.setContentHuggingPriority(.required, for: .horizontal)
    h.addArrangedSubview(n)
    if let trail {
      h.addArrangedSubview(UIView())
      h.addArrangedSubview(trail)
    } else {
      let v = text("", style: .body, color: .secondaryLabel)
      v.textAlignment = .right
      h.addArrangedSubview(v)
      rows[key] = v
    }
    return h
  }

  private func card(_ title: String, _ items: [UIView]) -> UIView {
    let outer = UIStackView()
    outer.axis = .vertical
    outer.spacing = 6
    let head = text(title.uppercased(), style: .caption1, color: .secondaryLabel)
    outer.addArrangedSubview(head)
    let box = UIStackView(arrangedSubviews: items)
    box.axis = .vertical
    box.spacing = 10
    box.isLayoutMarginsRelativeArrangement = true
    box.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16)
    box.backgroundColor = .secondarySystemGroupedBackground
    box.layer.cornerRadius = 12
    outer.addArrangedSubview(box)
    return outer
  }

  private func confirmStop(from vc: UIViewController?) {
    let a = UIAlertController(title: "Stop the runner?", message: "looktap can't use this iPhone until its next command starts the runner again.", preferredStyle: .alert)
    a.addAction(UIAlertAction(title: "Cancel", style: .cancel))
    a.addAction(UIAlertAction(title: "Stop", style: .destructive) { [weak self] _ in self?.onStop?() })
    vc?.present(a, animated: true)
  }

  // MARK: keeping it current

  private var soon = false
  /** Reads come several a second while looktap live watches: redraw at most twice a second for those. */
  private func refreshSoon() {
    guard !soon else { return }
    soon = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.soon = false; self?.refresh() }
  }

  func refresh() {
    // Nobody can see it while another app is in front: nothing to draw.
    guard window != nil, UIApplication.shared.applicationState == .active else { return }
    let ago = { (d: Date) -> String in
      let s = Int(-d.timeIntervalSinceNow)
      return s < 5 ? "just now" : s < 60 ? "\(s) s ago" : s < 3600 ? "\(s / 60) min ago" : "\(s / 3600) h ago"
    }
    let clock = DateFormatter()
    clock.timeStyle = .short
    clock.dateStyle = Calendar.current.isDateInToday(started) ? .none : .short

    let where_ = [mac, via].compactMap { $0 }.joined(separator: " · ")
    rows["status"]?.text = !allowed ? "Paused" : peers > 0 ? (where_.isEmpty ? "Connected" : where_) : "Waiting for looktap"
    dot.backgroundColor = !allowed ? .systemOrange : peers > 0 ? accent : .systemGray3
    rows["last"]?.text = recent.first.map { "\($0.what) · \(ago($0.at))" } ?? (lastContact.map { "read the screen · \(ago($0))" } ?? "none yet")
    rows["count"]?.text = "\(actions) action\(actions == 1 ? "" : "s"), \(reads) read\(reads == 1 ? "" : "s")"
    rows["since"]?.text = clock.string(from: started)
    toggle.isOn = allowed
    touchesToggle.isOn = false

    if let expires = signed.expires, let days = daysLeft {
      let date = DateFormatter()
      date.dateStyle = .medium
      rows["expires"]?.text = days < 0 ? "Expired \(date.string(from: expires))" : "\(date.string(from: expires)) · \(days == 0 ? "today" : days == 1 ? "1 day" : "\(days) days")"
      rows["expires"]?.textColor = days <= 2 ? .systemOrange : .secondaryLabel
    } else {
      rows["expires"]?.text = "unknown"
    }
    rows["team"]?.text = signed.team ?? "unknown"
    rows["version"]?.text = version.isEmpty ? "—" : version

    // The list only when it changed (rebuilding it each second would reset VoiceOver's place in it); the times always.
    let lines = recent.prefix(12).map { "\($0.at.timeIntervalSince1970)\($0.what)" }
    if lines != shown {
      shown = lines
      whens = []
      list.arrangedSubviews.forEach { $0.removeFromSuperview() }
      if recent.isEmpty { list.addArrangedSubview(text("Nothing yet. Taps, typing and app launches show here as looktap does them.", style: .footnote, color: .secondaryLabel)) }
      for d in recent.prefix(12) {
        let h = UIStackView()
        h.spacing = 8
        let what = text(d.what, style: .subheadline, color: d.ok ? .label : .systemRed)
        let when = text(ago(d.at), style: .footnote, color: .secondaryLabel)
        when.setContentHuggingPriority(.required, for: .horizontal)
        when.setContentCompressionResistancePriority(.required, for: .horizontal)
        what.accessibilityLabel = "\(d.what)\(d.ok ? "" : ", failed")"
        h.addArrangedSubview(what)
        h.addArrangedSubview(when)
        list.addArrangedSubview(h)
        whens.append(when)
      }
    }
    for (l, d) in zip(whens, recent) { l.text = ago(d.at) }
  }

  private var shown: [String] = []
  private var whens: [UILabel] = []
}
