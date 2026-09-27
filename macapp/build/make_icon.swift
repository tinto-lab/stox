// Renders the Stox app icon (build/icon.png, 1024x1024) -- the lowercase
// wordmark "stox" in SF Pro on a dark macOS-style rounded square.
// electron-builder picks up build/icon.png automatically when packaging.
//
// Regenerate with:  swift build/make_icon.swift   (run from macapp/)
import AppKit

let size: CGFloat = 1024
// Apple's macOS icon grid: an 824pt body centered on the 1024 canvas.
let body: CGFloat = 824
let radius: CGFloat = 185

let rep = NSBitmapImageRep(
  bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size),
  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

let inset = (size - body) / 2
let rect = NSRect(x: inset, y: inset, width: body, height: body)
let shape = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)

// Soft drop shadow, as macOS icons have.
NSGraphicsContext.saveGraphicsState()
let shadow = NSShadow()
shadow.shadowColor = NSColor.black.withAlphaComponent(0.35)
shadow.shadowOffset = NSSize(width: 0, height: -10)
shadow.shadowBlurRadius = 24
shadow.set()
NSColor(srgbRed: 0.08, green: 0.09, blue: 0.11, alpha: 1).setFill()
shape.fill()
NSGraphicsContext.restoreGraphicsState()

// Subtle top-to-bottom sheen.
NSGradient(
  starting: NSColor(srgbRed: 0.17, green: 0.18, blue: 0.21, alpha: 1),
  ending: NSColor(srgbRed: 0.07, green: 0.08, blue: 0.10, alpha: 1))!
  .draw(in: shape, angle: -90)

let font = NSFont.systemFont(ofSize: 300, weight: .bold)
let text = NSAttributedString(
  string: "stox",
  attributes: [
    .font: font,
    .foregroundColor: NSColor.white,
    .kern: -8,
  ])
let bounds = text.boundingRect(with: .zero, options: [.usesLineFragmentOrigin])
// Center on the x-height so the lowercase letters sit optically centered.
let x = (size - bounds.width) / 2
let y = size / 2 - font.xHeight / 2 + font.descender
text.draw(at: NSPoint(x: x, y: y))

NSGraphicsContext.restoreGraphicsState()

let out = URL(fileURLWithPath: CommandLine.arguments.count > 1
  ? CommandLine.arguments[1] : "build/icon.png")
try! rep.representation(using: .png, properties: [:])!.write(to: out)
print("wrote \(out.path)")
