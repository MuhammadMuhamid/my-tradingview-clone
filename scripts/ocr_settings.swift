import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count > 1 else { exit(2) }
for path in CommandLine.arguments.dropFirst() {
    guard let image = NSImage(contentsOfFile: path),
          let data = image.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: data),
          let cg = bitmap.cgImage else { fputs("cannot read \(path)\n", stderr); continue }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    do { try VNImageRequestHandler(cgImage: cg).perform([request]) }
    catch { fputs("vision error \(error)\n", stderr); continue }
    print("=== \(path) ===")
    let rows = (request.results ?? []).sorted {
        if abs($0.boundingBox.midY - $1.boundingBox.midY) > 0.01 {
            return $0.boundingBox.midY > $1.boundingBox.midY
        }
        return $0.boundingBox.minX < $1.boundingBox.minX
    }
    for row in rows {
        if let text = row.topCandidates(1).first?.string { print(text) }
    }
}
