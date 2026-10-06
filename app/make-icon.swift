// Draws the app icon (a row of switcher buttons with program and preview lit)
// and writes a 1024px PNG: swift app/make-icon.swift <out.png>
import AppKit

let size: CGFloat = 1024
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()

// Rounded-square background, inset like a standard macOS icon.
let inset: CGFloat = 100
let body = NSRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
let bg = NSBezierPath(roundedRect: body, xRadius: 185, yRadius: 185)
NSGradient(starting: NSColor(calibratedWhite: 0.23, alpha: 1), ending: NSColor(calibratedWhite: 0.09, alpha: 1))!.draw(in: bg, angle: -90)

// Two rows of buttons: program bus (one red) and preview bus (one green).
let cols = 4
let gap: CGFloat = 26
let btn = (body.width - 120 - gap * CGFloat(cols - 1)) / CGFloat(cols)
func row(y: CGFloat, lit: Int, color: NSColor) {
    for i in 0..<cols {
        let r = NSRect(x: body.minX + 60 + CGFloat(i) * (btn + gap), y: y, width: btn, height: btn * 0.78)
        let p = NSBezierPath(roundedRect: r, xRadius: 26, yRadius: 26)
        (i == lit ? color : NSColor(calibratedWhite: 0.78, alpha: 1)).setFill()
        p.fill()
    }
}
row(y: body.minY + 400, lit: 1, color: NSColor(calibratedRed: 0.93, green: 0.2, blue: 0.18, alpha: 1))
row(y: body.minY + 190, lit: 2, color: NSColor(calibratedRed: 0.2, green: 0.78, blue: 0.33, alpha: 1))

// A T-bar slot along the top.
let slot = NSRect(x: body.minX + 60, y: body.maxY - 150, width: body.width - 120, height: 34)
NSColor(calibratedWhite: 0.05, alpha: 1).setFill()
NSBezierPath(roundedRect: slot, xRadius: 17, yRadius: 17).fill()
NSColor(calibratedRed: 1.0, green: 0.62, blue: 0.1, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: slot.midX - 70, y: slot.minY - 28, width: 140, height: 90), xRadius: 22, yRadius: 22).fill()

image.unlockFocus()
let tiff = image.tiffRepresentation!
let png = NSBitmapImageRep(data: tiff)!.representation(using: .png, properties: [:])!
try! png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
