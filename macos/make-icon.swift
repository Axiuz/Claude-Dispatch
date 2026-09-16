// Convierte una imagen cuadrada en el icono de macOS: 1024 px, márgenes
// de la plantilla de Apple (824 px de cuerpo) y esquinas redondeadas.
// Uso: swift make-icon.swift <entrada> <salida.png>
import AppKit

let args = CommandLine.arguments
guard args.count == 3, let source = NSImage(contentsOfFile: args[1]) else {
  FileHandle.standardError.write("Uso: swift make-icon.swift <entrada> <salida.png>\n".data(using: .utf8)!)
  exit(1)
}

let canvas: CGFloat = 1024
let body: CGFloat = 824
let inset = (canvas - body) / 2
let rect = NSRect(x: inset, y: inset, width: body, height: body)

let bitmap = NSBitmapImageRep(
  bitmapDataPlanes: nil, pixelsWide: Int(canvas), pixelsHigh: Int(canvas),
  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSGraphicsContext.current?.imageInterpolation = .high
NSBezierPath(roundedRect: rect, xRadius: body * 0.225, yRadius: body * 0.225).addClip()
source.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1)
NSGraphicsContext.restoreGraphicsState()

try! bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
