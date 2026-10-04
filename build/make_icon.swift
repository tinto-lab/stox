// Renders the Stox app icon (build/icon.png, 1024x1024) -- a pixel-art Wall
// Street guy in profile, on the phone and typing at his laptop, over a rising stock line, on a
// green macOS-style rounded square.
// electron-builder picks up build/icon.png automatically when packaging.
//
// Regenerate with:  swift build/make_icon.swift   (run from the repo root)
import AppKit

let size: CGFloat = 1024
let body: CGFloat = 824
let radius: CGFloat = 185

// The scene as a 32x32 grid, one character per pixel; "." shows the
// background through. Side view: him in profile at his laptop, phone pinned to
// his shoulder, sleeves rolled up, black tie down his shirt front, a coffee on
// the desk and his office chair behind him.
let scene = [
  "................................",
  "................................",
  "............KKKKKK..............",
  "...........KHHhhHHKK............",
  "..........KHHhhhHHHHK...........",
  ".........KHHhhHHHHHHHK..........",
  ".........KHHHHHHHHHSSK..........",
  ".........KHHHHHHHSSSSK..........",
  ".........KHHHHHSSSHHSSK.........",
  ".........KHHHppPSSSESK..........",
  ".........KHHHPPPSSSSSSK.........",
  ".........KHHHSspPSSSSSSK........",
  "..........KHSSSSpPSSsKK.........",
  ".....K....KHsSSSSpPMK...........",
  "....KXK....KsSSSpPPPK....KK.....",
  "...KxXXK.KKKssSSSSKK....KCAK....",
  "...KxXXKKWWwWWWWwTTK....KCAK....",
  "...KxXXKWWWWWWWwWtTK....KCAK....",
  "...KxXXKWWWWWWWwWWtK...KCAK..V..",
  "...KxXXKWWWWWWWwWWTK...KCAK.V...",
  "...KxXXKWWWWWWWwWWGK...KCAK..V..",
  "...KxXXKWWWWWWWwWWTK...KCAK.V...",
  "...KxXXKWWWWwWWWKKKK..KCAK......",
  "...KxXXKWWWWwSSSSSSK..KCAK.DDDK.",
  "...KxXXKWWWWwSSSSSsKKKKCAKKrRRRK",
  "...KxXXKWWWWwssssAAAAAAAK.KrRRRK",
  "...KxXXKWWWWWWWWWaaaaaaaK.KrRRK.",
  "dddddddddddddddddddddddddddddddd",
  "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
  "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
  "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
  "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
]

func rgb(_ hex: UInt32) -> NSColor {
  NSColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255,
          green: CGFloat((hex >> 8) & 0xff) / 255,
          blue: CGFloat(hex & 0xff) / 255, alpha: 1)
}
let palette: [Character: NSColor] = [
  "K": rgb(0x0b0d12),  // outline
  "H": rgb(0x2a1d14), "h": rgb(0x5c4130),  // slicked-back hair + shine
  "S": rgb(0xf0c08a), "s": rgb(0xcf9563),  // skin + shade
  "E": rgb(0x1a1a1a),  // eye
  "M": rgb(0x8a3f33),  // smirk
  "W": rgb(0xf5f5f2), "w": rgb(0xc5cad6),  // white shirt + creases
  "T": rgb(0x15171c), "t": rgb(0x4a5060), "G": rgb(0xe0b048),  // black tie, sheen, gold clip
  "X": rgb(0x3a3f4c), "x": rgb(0x2a2e38),  // office chair
  "A": rgb(0xc9ced6), "a": rgb(0x9aa1ad), "C": rgb(0x9fe8c4),  // laptop + screen glow
  "P": rgb(0x1f2229), "p": rgb(0x4a4f5c),  // phone handset
  "R": rgb(0xd7263d), "r": rgb(0x9c1428), "V": rgb(0xdfe8ec),  // coffee mug + steam
  "D": rgb(0x6b4428), "d": rgb(0x8a5a36),  // desk + its lit top edge
]

let rep = NSBitmapImageRep(
  bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size),
  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

let inset = (size - body) / 2
let rect = NSRect(x: inset, y: inset, width: body, height: body)
let shape = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)

NSGraphicsContext.saveGraphicsState()
let shadow = NSShadow()
shadow.shadowColor = NSColor.black.withAlphaComponent(0.35)
shadow.shadowOffset = NSSize(width: 0, height: -10)
shadow.shadowBlurRadius = 24
shadow.set()
rgb(0x0f3d2e).setFill()
shape.fill()
NSGraphicsContext.restoreGraphicsState()

NSGradient(starting: rgb(0x1d6b4f), ending: rgb(0x0b2e22))!.draw(in: shape, angle: -90)

// Everything below is clipped to the icon body so the torso runs off its edge.
shape.addClip()
let grid = 32
let cell = body / CGFloat(grid)
func px(_ col: Int, _ row: Int, _ color: NSColor) {
  // Round cell edges to whole pixels so neighbouring cells never leave seams.
  let x0 = (inset + CGFloat(col) * cell).rounded(), x1 = (inset + CGFloat(col + 1) * cell).rounded()
  let yTop = size - inset - CGFloat(row) * cell, yBot = size - inset - CGFloat(row + 1) * cell
  color.setFill()
  NSRect(x: x0, y: yBot.rounded(), width: x1 - x0, height: yTop.rounded() - yBot.rounded()).fill()
}
// A rising stock line behind him, ending in an arrowhead top-right.
let trend = [(1, 12), (3, 8), (5, 10), (9, 4), (20, 4), (25, 8), (28, 5)]
let up = rgb(0x4fd18b)
for ((c0, r0), (c1, r1)) in zip(trend, trend.dropFirst()) {
  let steps = max(abs(c1 - c0), abs(r1 - r0))
  for t in 0...steps {
    let c = c0 + (c1 - c0) * t / steps, r = r0 + (r1 - r0) * t / steps
    px(c, r, up)
  }
}
for (c, r) in [(26, 5), (27, 5), (28, 6), (28, 7)] { px(c, r, up) }

for (row, line) in scene.enumerated() {
  precondition(line.count == grid, "row \(row) has width \(line.count)")
  for (col, ch) in line.enumerated() where ch != "." {
    guard let color = palette[ch] else { fatalError("unknown pixel \(ch)") }
    px(col, row, color)
  }
}

NSGraphicsContext.restoreGraphicsState()
let out = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "build/icon.png")
try! rep.representation(using: .png, properties: [:])!.write(to: out)
print("wrote \(out.path)")
