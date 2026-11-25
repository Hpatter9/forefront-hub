import UIKit

/// The job's sketch: each scanned room drawn from above with every wall's length, its doors and windows, and its
/// sizes, two rooms to a row, on a white page (it goes in the estimate as the sketch page).
enum FloorPlan {
  static func image(_ scan: JobScan) -> UIImage {
    let cell: CGFloat = 900, pad: CGFloat = 70, header: CGFloat = 150
    let cols = scan.rooms.count > 1 ? 2 : 1
    let rows = max(1, Int(ceil(Double(scan.rooms.count) / Double(cols))))
    let size = CGSize(width: CGFloat(cols) * cell, height: header + CGFloat(rows) * cell)
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    return UIGraphicsImageRenderer(size: size, format: format).image { ctx in
      let g = ctx.cgContext
      UIColor.white.setFill(); g.fill(CGRect(origin: .zero, size: size))
      let title = "#\(scan.jobNumber) \(scan.jobName)"
      title.draw(at: CGPoint(x: 40, y: 30), withAttributes: [.font: UIFont.boldSystemFont(ofSize: 44), .foregroundColor: UIColor.black])
      let sub = [scan.address, "Measured with Keystone Scan (iPhone LiDAR), \(DateFormatter.localizedString(from: Date(), dateStyle: .medium, timeStyle: .none))"].filter { !$0.isEmpty }.joined(separator: " · ")
      sub.draw(at: CGPoint(x: 40, y: 90), withAttributes: [.font: UIFont.systemFont(ofSize: 26), .foregroundColor: UIColor.darkGray])
      for (i, room) in scan.rooms.enumerated() {
        let box = CGRect(x: CGFloat(i % cols) * cell, y: header + CGFloat(i / cols) * cell, width: cell, height: cell)
        draw(room, in: box.insetBy(dx: pad, dy: pad), g)
      }
    }
  }

  private static func draw(_ room: RoomScan, in box: CGRect, _ g: CGContext) {
    // Fit the room (walls and outline) in the box, leaving room for the labels.
    let pts = room.walls.flatMap { [$0.start, $0.end] } + room.outline
    guard let minX = pts.map({ $0[0] }).min(), let maxX = pts.map({ $0[0] }).max(), let minY = pts.map({ $0[1] }).min(), let maxY = pts.map({ $0[1] }).max() else { return }
    let area = box.insetBy(dx: 40, dy: 60).offsetBy(dx: 0, dy: 30)
    let k = min(area.width / CGFloat(max(1, maxX - minX)), area.height / CGFloat(max(1, maxY - minY)))
    let ox = area.midX - CGFloat(minX + maxX) / 2 * k, oy = area.midY - CGFloat(minY + maxY) / 2 * k
    func p(_ v: [Double]) -> CGPoint { CGPoint(x: ox + CGFloat(v[0]) * k, y: oy + CGFloat(v[1]) * k) }

    // The floor, lightly shaded.
    if room.outline.count >= 3 {
      g.beginPath(); g.move(to: p(room.outline[0])); for v in room.outline.dropFirst() { g.addLine(to: p(v)) }; g.closePath()
      UIColor(red: 0.91, green: 0.95, blue: 1, alpha: 1).setFill(); g.fillPath()
    }
    // Walls, each with its length.
    g.setLineCap(.round)
    for w in room.walls {
      let a = p(w.start), b = p(w.end)
      g.setStrokeColor(UIColor.black.cgColor); g.setLineWidth(9)
      g.move(to: a); g.addLine(to: b); g.strokePath()
      let mid = CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
      let label = Measure.feetInches(w.lengthFt) as NSString
      let attrs: [NSAttributedString.Key: Any] = [.font: UIFont.boldSystemFont(ofSize: 24), .foregroundColor: UIColor(red: 0.05, green: 0.25, blue: 0.55, alpha: 1), .backgroundColor: UIColor.white]
      let s = label.size(withAttributes: attrs)
      // Put the label just outside the wall, away from the room's middle.
      let c = CGPoint(x: area.midX, y: area.midY)
      var nx = -(b.y - a.y), ny = b.x - a.x
      let n = max(1, (nx * nx + ny * ny).squareRoot()); nx /= n; ny /= n
      if (mid.x + nx - c.x) * (mid.x + nx - c.x) + (mid.y + ny - c.y) * (mid.y + ny - c.y) < (mid.x - c.x) * (mid.x - c.x) + (mid.y - c.y) * (mid.y - c.y) { nx = -nx; ny = -ny }
      label.draw(at: CGPoint(x: mid.x + nx * 28 - s.width / 2, y: mid.y + ny * 28 - s.height / 2), withAttributes: attrs)
    }
    // Doors (orange), windows (blue) and openings (grey) drawn over the wall they're in.
    for (list, color) in [(room.doors, UIColor.orange), (room.windows, UIColor.systemBlue), (room.openings, UIColor.lightGray)] {
      for o in list {
        let half = o.widthFt / 2
        let a = p([o.center[0] - o.along[0] * half, o.center[1] - o.along[1] * half]), b = p([o.center[0] + o.along[0] * half, o.center[1] + o.along[1] * half])
        g.setStrokeColor(color.cgColor); g.setLineWidth(13); g.move(to: a); g.addLine(to: b); g.strokePath()
      }
    }
    // The room's name and sizes in the middle.
    let lines = [room.name, "\(Int(room.floorAreaSF.rounded())) SF floor · \(Int(room.perimeterLF.rounded())) LF", "Ceiling \(Measure.feetInches(room.ceilingHeightFt)) · walls \(Int(room.netWallAreaSF.rounded())) SF"]
    var y = box.minY
    for (i, t) in lines.enumerated() {
      let attrs: [NSAttributedString.Key: Any] = [.font: i == 0 ? UIFont.boldSystemFont(ofSize: 34) : UIFont.systemFont(ofSize: 24), .foregroundColor: UIColor.black]
      let s = (t as NSString).size(withAttributes: attrs)
      (t as NSString).draw(at: CGPoint(x: box.midX - s.width / 2, y: y), withAttributes: attrs)
      y += s.height + 4
    }
  }
}
