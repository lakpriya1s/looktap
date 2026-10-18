// The bench's eye on a real iPhone: the phone's screen as macOS sees it over USB (the capture device QuickTime uses),
// read with Vision's text recognition. Independent of every tool under test. stdin: "ocr" | "png <path>"; stdout: JSON lines.
import AVFoundation
import CoreMediaIO
import Vision
import CoreImage
import ImageIO
import UniformTypeIdentifiers

var prop = CMIOObjectPropertyAddress(mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices), mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal), mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
var allow: UInt32 = 1
CMIOObjectSetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &prop, 0, nil, UInt32(MemoryLayout<UInt32>.size), &allow)

func out(_ o: [String: Any]) {
  let d = try! JSONSerialization.data(withJSONObject: o)
  FileHandle.standardOutput.write(d + Data([10]))
}

final class Grab: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  let lock = NSLock()
  var frame: CVPixelBuffer?
  var at = 0.0
  func captureOutput(_ o: AVCaptureOutput, didOutput b: CMSampleBuffer, from c: AVCaptureConnection) {
    guard let px = CMSampleBufferGetImageBuffer(b) else { return }
    lock.lock(); frame = px; at = Date().timeIntervalSince1970; lock.unlock()
  }
  func latest() -> (CVPixelBuffer?, Double) { lock.lock(); defer { lock.unlock() }; return (frame, at) }
}

var device: AVCaptureDevice?
for _ in 0..<20 {
  let s = AVCaptureDevice.DiscoverySession(deviceTypes: [.external], mediaType: nil, position: .unspecified)
  device = s.devices.first { $0.modelID == "iOS Device" && (CommandLine.arguments.count < 2 || $0.localizedName == CommandLine.arguments[1]) }
  if device != nil { break }
  RunLoop.current.run(until: Date().addingTimeInterval(0.5))
}
guard let device else { out(["error": "no iPhone screen capture device (connect it with a cable and unlock it)"]); exit(1) }

let session = AVCaptureSession()
let grab = Grab()
do { session.addInput(try AVCaptureDeviceInput(device: device)) } catch { out(["error": "\(error)"]); exit(1) }
let video = AVCaptureVideoDataOutput()
video.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
video.alwaysDiscardsLateVideoFrames = true
video.setSampleBufferDelegate(grab, queue: DispatchQueue(label: "frames"))
session.addOutput(video)
session.startRunning()
for _ in 0..<100 where grab.latest().0 == nil { RunLoop.current.run(until: Date().addingTimeInterval(0.1)) }
guard let first = grab.latest().0 else { out(["error": "the capture device sent no frames"]); exit(1) }
out(["ready": true, "w": CVPixelBufferGetWidth(first), "h": CVPixelBufferGetHeight(first)])

DispatchQueue.global().async {
  while let line = readLine() {
    let (px, at) = grab.latest()
    guard let px else { out(["error": "no frame"]); continue }
    if line.hasPrefix("png ") {
      let ci = CIImage(cvPixelBuffer: px)
      let url = URL(fileURLWithPath: String(line.dropFirst(4)))
      try? CIContext().writePNGRepresentation(of: ci, to: url, format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
      out(["ok": true]); continue
    }
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = line == "fast" ? .fast : .accurate
    req.usesLanguageCorrection = false
    try? VNImageRequestHandler(cvPixelBuffer: px).perform([req])
    let items: [[String: Any]] = (req.results ?? []).compactMap { r in
      guard let s = r.topCandidates(1).first?.string else { return nil }
      let b = r.boundingBox // normalized, origin bottom-left
      return ["s": s, "x": b.minX, "y": 1 - b.maxY, "w": b.width, "h": b.height]
    }
    out(["at": at, "items": items])
  }
  exit(0)
}
RunLoop.main.run()
