// Draw the runner app's home-screen icon (the looktap mark, white on teal) into native/ios-device/LooktapRunner/Icon:
//   swift scripts/runner-icon.swift
// lib/runnerpatch.js copies these into the built runner app; the file names are the ones CFBundleIconFiles expects.
import AppKit

let out = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../native/ios-device/LooktapRunner/Icon").standardized
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

let teal = CGColor(red: 0x0a / 255, green: 0x7e / 255, blue: 0xa4 / 255, alpha: 1)
let white = CGColor(red: 1, green: 1, blue: 1, alpha: 1)

func icon(_ px: Int) -> Data {
  let ctx = CGContext(data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: 0,
                      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
  ctx.setFillColor(teal)
  ctx.fill(CGRect(x: 0, y: 0, width: px, height: px))
  // The favicon's 64-unit drawing (y down), scaled so the phone takes about 70% of the icon's height.
  let s = CGFloat(px) / 80
  ctx.translateBy(x: CGFloat(px) / 2, y: CGFloat(px) / 2)
  ctx.scaleBy(x: s, y: -s)
  ctx.translateBy(x: -32, y: -32)
  ctx.setStrokeColor(white)
  ctx.setFillColor(white)
  ctx.setLineWidth(4)
  ctx.addPath(CGPath(roundedRect: CGRect(x: 14, y: 4, width: 36, height: 56), cornerWidth: 8, cornerHeight: 8, transform: nil))
  ctx.strokePath()
  ctx.addPath(CGPath(roundedRect: CGRect(x: 26, y: 9, width: 12, height: 3), cornerWidth: 1.5, cornerHeight: 1.5, transform: nil))
  ctx.fillPath()
  ctx.fillEllipse(in: CGRect(x: 32 - 4.5, y: 35 - 4.5, width: 9, height: 9))
  ctx.setStrokeColor(white.copy(alpha: 0.6)!)
  ctx.setLineWidth(2.4)
  ctx.strokeEllipse(in: CGRect(x: 22, y: 25, width: 20, height: 20))
  return NSBitmapImageRep(cgImage: ctx.makeImage()!).representation(using: .png, properties: [:])!
}

for (name, px) in [("AppIcon60x60@2x", 120), ("AppIcon60x60@3x", 180), ("AppIcon76x76@2x~ipad", 152), ("AppIcon83.5x83.5@2x~ipad", 167)] {
  try icon(px).write(to: out.appendingPathComponent("\(name).png"))
}
print("wrote \(out.path)")
