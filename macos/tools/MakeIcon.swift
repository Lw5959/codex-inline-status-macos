import AppKit
import Foundation

// 使用可编辑的原生矢量绘制，图标不复制官方 ChatGPT 标识。
let destination = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let image = NSImage(size: NSSize(width: pixels, height: pixels))
        image.lockFocus()
        let transform = NSAffineTransform(); transform.scale(by: CGFloat(pixels) / 1024); transform.concat()
        let background = NSBezierPath(roundedRect: NSRect(x: 32, y: 32, width: 960, height: 960), xRadius: 220, yRadius: 220)
        NSGradient(starting: NSColor(calibratedRed: 0.13, green: 0.24, blue: 0.63, alpha: 1), ending: NSColor(calibratedRed: 0.1, green: 0.66, blue: 0.64, alpha: 1))!.draw(in: background, angle: 45)
        NSColor.white.withAlphaComponent(0.92).setStroke()
        let globe = NSBezierPath(ovalIn: NSRect(x: 180, y: 240, width: 580, height: 580)); globe.lineWidth = 30; globe.stroke()
        let meridian = NSBezierPath(ovalIn: NSRect(x: 350, y: 240, width: 240, height: 580)); meridian.lineWidth = 24; meridian.stroke()
        for y in [420.0, 620.0] {
            let line = NSBezierPath(); line.move(to: NSPoint(x: 215, y: y)); line.line(to: NSPoint(x: 725, y: y)); line.lineWidth = 24; line.stroke()
        }
        NSColor(calibratedRed: 0.08, green: 0.18, blue: 0.35, alpha: 1).setFill()
        NSBezierPath(ovalIn: NSRect(x: 526, y: 160, width: 340, height: 340)).fill()
        NSColor.white.setStroke()
        let clock = NSBezierPath(ovalIn: NSRect(x: 548, y: 182, width: 296, height: 296)); clock.lineWidth = 24; clock.stroke()
        let hands = NSBezierPath(); hands.move(to: NSPoint(x: 696, y: 420)); hands.line(to: NSPoint(x: 696, y: 330)); hands.line(to: NSPoint(x: 766, y: 290)); hands.lineWidth = 28; hands.lineCapStyle = .round; hands.stroke()
        image.unlockFocus()
        let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
        let filename = "icon_\(size)x\(size)" + (scale == 2 ? "@2x" : "") + ".png"
        try bitmap.representation(using: .png, properties: [:])!.write(to: destination.appendingPathComponent(filename))
    }
}
