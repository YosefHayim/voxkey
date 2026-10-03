import AppKit
import Darwin
import Foundation
import QuartzCore

// One pill, one surface — no nested chrome / no window shadow box.
// Args: <worker-pid> <state-home>

let args = CommandLine.arguments
guard args.count >= 3, let workerPid = Int32(args[1]) else {
    fputs("usage: overlay_hud <worker-pid> <state-home>\n", stderr)
    exit(2)
}
let stateHome = args[2]
let statusPath = (stateHome as NSString).appendingPathComponent("status.json")
let lockPath = (stateHome as NSString).appendingPathComponent("overlay.lock")

// Exclusive lock so stacked / orphaned HUDs never paint a second pill.
let lockFd = open(lockPath, O_CREAT | O_RDWR, 0o600)
if lockFd < 0 {
    fputs("overlay_hud: cannot open overlay.lock\n", stderr)
    exit(1)
}
if flock(lockFd, LOCK_EX | LOCK_NB) != 0 {
    // Another live HUD already owns the display.
    exit(0)
}

class Panel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

var width: CGFloat = 168
let height: CGFloat = 40
let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 800, height: 600)
var originX = screen.origin.x + (screen.size.width - width) / 2
let originY = screen.origin.y + 72

let panel = Panel(
    contentRect: NSRect(x: originX, y: originY, width: width, height: height),
    styleMask: [.borderless, .nonactivatingPanel],
    backing: .buffered,
    defer: false
)
panel.level = .floating
panel.isOpaque = false
panel.backgroundColor = .clear
panel.hasShadow = false
panel.ignoresMouseEvents = true
panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

// Single pill surface (background + rounded clip + soft shadow).
let pill = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
pill.wantsLayer = true
func stylePillLayer(_ layer: CALayer, w: CGFloat) {
    layer.backgroundColor = NSColor(srgbRed: 0.09, green: 0.10, blue: 0.12, alpha: 0.94).cgColor
    layer.cornerRadius = height / 2
    layer.masksToBounds = false
    layer.shadowColor = NSColor.black.withAlphaComponent(0.45).cgColor
    layer.shadowOpacity = 0.55
    layer.shadowRadius = 12
    layer.shadowOffset = CGSize(width: 0, height: -3)
    layer.shadowPath = CGPath(
        roundedRect: CGRect(x: 0, y: 0, width: w, height: height),
        cornerWidth: height / 2,
        cornerHeight: height / 2,
        transform: nil
    )
}
if let layer = pill.layer {
    stylePillLayer(layer, w: width)
}
panel.contentView = pill

// Clip only the inner content (dot/label) to the rounded rect without a second bg.
let content = NSView(frame: pill.bounds)
content.wantsLayer = true
content.layer?.backgroundColor = NSColor.clear.cgColor
content.layer?.cornerRadius = height / 2
content.layer?.masksToBounds = true
content.autoresizingMask = [.width, .height]
pill.addSubview(content)

let dotSize: CGFloat = 9
let dot = NSView(frame: NSRect(x: 14, y: (height - dotSize) / 2, width: dotSize, height: dotSize))
dot.wantsLayer = true
dot.layer?.backgroundColor = NSColor(srgbRed: 0.92, green: 0.24, blue: 0.22, alpha: 1).cgColor
dot.layer?.cornerRadius = dotSize / 2
dot.isHidden = true
content.addSubview(dot)

let spinner = NSProgressIndicator(frame: NSRect(x: 12, y: (height - 16) / 2, width: 16, height: 16))
spinner.style = .spinning
spinner.controlSize = .small
spinner.isDisplayedWhenStopped = false
spinner.isHidden = true
if #available(macOS 11.0, *) {
    spinner.appearance = NSAppearance(named: .darkAqua)
}
content.addSubview(spinner)

let label = NSTextField(labelWithString: "")
label.frame = NSRect(x: 32, y: 0, width: width - 44, height: height)
label.alignment = .left
label.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
label.textColor = .white
label.lineBreakMode = .byTruncatingHead
label.maximumNumberOfLines = 1
label.drawsBackground = false
label.isBezeled = false
label.isBordered = false
label.focusRingType = .none
content.addSubview(label)

var visible = false
var lastStage = ""
var pulseRunning = false

func processAlive(_ pid: Int32) -> Bool {
    kill(pid, 0) == 0
}

struct Status {
    var stage: String
    var preview: String
    var detail: String
}

func readStatus() -> Status {
    guard
        let data = try? Data(contentsOf: URL(fileURLWithPath: statusPath)),
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
        return Status(stage: "inactive", preview: "", detail: "")
    }
    let stage = json["dictation"] as? String ?? "inactive"
    let preview = (json["preview"] as? String ?? "")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    let detail = (json["detail"] as? String ?? "")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    return Status(stage: stage, preview: preview, detail: detail)
}

func labelColor(for stage: String) -> NSColor {
    switch stage {
    case "listening":
        return NSColor(srgbRed: 0.98, green: 0.94, blue: 0.94, alpha: 1)
    case "starting":
        return NSColor(srgbRed: 1.0, green: 0.90, blue: 0.50, alpha: 1)
    case "finishing", "refining", "typing":
        return NSColor(srgbRed: 0.80, green: 0.88, blue: 1.0, alpha: 1)
    case "unavailable":
        return NSColor(srgbRed: 1.0, green: 0.55, blue: 0.55, alpha: 1)
    default:
        return .white
    }
}

func bodyText(for status: Status) -> String {
    switch status.stage {
    case "starting":
        return "Connecting"
    case "listening":
        if !status.preview.isEmpty {
            let p = status.preview
            return p.count > 40 ? "…" + String(p.suffix(38)) : p
        }
        return "Recording"
    case "finishing":
        return "Working"
    case "typing":
        return "Pasting…"
    case "refining":
        // Show short detail when present (e.g. model id); keep pill readable.
        if !status.detail.isEmpty {
            let d = status.detail
            return d.count > 42 ? String(d.prefix(40)) + "…" : d
        }
        return "Refining…"
    case "unavailable":
        return "Mic unavailable"
    default:
        return ""
    }
}

func startCalmPulse() {
    guard !pulseRunning, let layer = dot.layer else { return }
    pulseRunning = true
    layer.removeAnimation(forKey: "pulse")
    let anim = CABasicAnimation(keyPath: "opacity")
    anim.fromValue = 1.0
    anim.toValue = 0.38
    anim.duration = 1.2
    anim.autoreverses = true
    anim.repeatCount = .infinity
    anim.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    layer.add(anim, forKey: "pulse")
}

func stopCalmPulse() {
    pulseRunning = false
    dot.layer?.removeAnimation(forKey: "pulse")
    dot.layer?.opacity = 1
}

func resizePill(body: String, leading: CGFloat) {
    let attrs: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: 13, weight: .semibold)
    ]
    let textW = (body as NSString).size(withAttributes: attrs).width
    let newWidth = max(140, min(380, leading + textW + 18))
    guard abs(newWidth - width) > 3 else {
        label.frame = NSRect(x: leading, y: 0, width: width - leading - 12, height: height)
        return
    }
    width = newWidth
    originX = screen.origin.x + (screen.size.width - width) / 2
    panel.setFrame(NSRect(x: originX, y: originY, width: width, height: height), display: true)
    pill.frame = NSRect(x: 0, y: 0, width: width, height: height)
    content.frame = pill.bounds
    content.layer?.cornerRadius = height / 2
    if let layer = pill.layer {
        stylePillLayer(layer, w: width)
    }
    label.frame = NSRect(x: leading, y: 0, width: width - leading - 12, height: height)
}

func apply(stage: String, body: String) {
    switch stage {
    case "listening":
        spinner.stopAnimation(nil)
        spinner.isHidden = true
        dot.isHidden = false
        dot.layer?.backgroundColor = NSColor(srgbRed: 0.92, green: 0.24, blue: 0.22, alpha: 1).cgColor
        startCalmPulse()
        resizePill(body: body, leading: 32)
    case "starting":
        spinner.stopAnimation(nil)
        spinner.isHidden = true
        stopCalmPulse()
        dot.isHidden = false
        dot.layer?.backgroundColor = NSColor(srgbRed: 0.98, green: 0.75, blue: 0.18, alpha: 1).cgColor
        resizePill(body: body, leading: 32)
    case "finishing", "refining", "typing":
        stopCalmPulse()
        dot.isHidden = true
        spinner.isHidden = false
        spinner.startAnimation(nil)
        resizePill(body: body, leading: 34)
    case "unavailable":
        spinner.stopAnimation(nil)
        spinner.isHidden = true
        stopCalmPulse()
        dot.isHidden = false
        dot.layer?.backgroundColor = NSColor(srgbRed: 0.97, green: 0.44, blue: 0.44, alpha: 1).cgColor
        resizePill(body: body, leading: 32)
    default:
        spinner.stopAnimation(nil)
        spinner.isHidden = true
        stopCalmPulse()
        dot.isHidden = true
    }
}

Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { timer in
    if !processAlive(workerPid) {
        timer.invalidate()
        app.terminate(nil)
        return
    }
    let status = readStatus()
    // Hard hide for idle stages even if a stale detail string is present.
    let idleStages: Set<String> = ["inactive", "idle", "ready", ""]
    let body: String
    if idleStages.contains(status.stage) {
        body = ""
    } else {
        body = bodyText(for: status)
    }
    if body.isEmpty {
        if visible {
            stopCalmPulse()
            spinner.stopAnimation(nil)
            spinner.isHidden = true
            dot.isHidden = true
            label.stringValue = ""
            panel.orderOut(nil)
            visible = false
            lastStage = ""
        }
        return
    }

    if status.stage != lastStage {
        apply(stage: status.stage, body: body)
        lastStage = status.stage
    } else if status.stage == "listening" || status.stage == "refining" || status.stage == "typing" {
        resizePill(body: body, leading: status.stage == "listening" ? 32 : 34)
    }

    label.stringValue = body
    label.textColor = labelColor(for: status.stage)

    if !visible {
        apply(stage: status.stage, body: body)
        lastStage = status.stage
        panel.orderFrontRegardless()
        visible = true
    }
}

app.run()
