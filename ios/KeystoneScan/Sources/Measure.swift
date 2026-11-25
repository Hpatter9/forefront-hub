import Foundation
import RoomPlan
import simd

/// One scanned room, as the estimate needs it: feet and square feet, the walls with their lengths, the doors, windows
/// and openings in them, and the floor outline (for the sketch). Worked out on the phone from Apple's RoomPlan result.
struct RoomScan: Codable, Identifiable {
  struct Wall: Codable { var lengthFt: Double; var heightFt: Double; var start: [Double]; var end: [Double] }
  struct Opening: Codable { var kind: String; var widthFt: Double; var heightFt: Double; var center: [Double]; var along: [Double] }
  struct Thing: Codable { var kind: String; var widthFt: Double; var depthFt: Double; var heightFt: Double }

  var id = UUID()
  var name: String
  var scannedAt: Date
  var ceilingHeightFt: Double
  var floorAreaSF: Double
  var perimeterLF: Double
  /// All the walls' area, then the same with the doors, windows and openings taken out.
  var wallAreaSF: Double
  var netWallAreaSF: Double
  var ceilingAreaSF: Double
  var walls: [Wall]
  var doors: [Opening]
  var windows: [Opening]
  var openings: [Opening]
  /// Fixtures RoomPlan recognised (tub, toilet, vanity/sink, cabinets, appliances...): a check on the scope.
  var objects: [Thing]
  /// The floor's outline, in feet, seen from above (x across, y down the page).
  var outline: [[Double]]
}

/// Everything scanned on one job, as it's saved on the phone and uploaded.
struct JobScan: Codable {
  var app = "Keystone Scan"
  var format = 1
  var jobNumber: Int
  var jobName: String
  var address: String
  var rooms: [RoomScan]
}

enum Measure {
  static let ft = 3.28084, sf = 10.7639

  private static func r1(_ v: Double) -> Double { (v * 10).rounded() / 10 }
  private static func r2(_ v: Double) -> Double { (v * 100).rounded() / 100 }

  /// Where a surface sits seen from above: its center and the direction it runs (RoomPlan's x axis), in metres.
  private static func plan(_ t: simd_float4x4) -> (center: SIMD2<Double>, dir: SIMD2<Double>) {
    let c = t.columns.3, x = t.columns.0
    let d = SIMD2(Double(x.x), Double(x.z))
    let len = max(1e-6, (d.x * d.x + d.y * d.y).squareRoot())
    return (SIMD2(Double(c.x), Double(c.z)), d / len)
  }

  private static func shoelace(_ p: [SIMD2<Double>]) -> Double {
    guard p.count >= 3 else { return 0 }
    var a = 0.0
    for i in 0..<p.count { let j = (i + 1) % p.count; a += p[i].x * p[j].y - p[j].x * p[i].y }
    return abs(a) / 2
  }

  private static func perimeter(_ p: [SIMD2<Double>]) -> Double {
    guard p.count >= 2 else { return 0 }
    return (0..<p.count).reduce(0) { s, i in let a = p[i], b = p[(i + 1) % p.count]; return s + ((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)).squareRoot() }
  }

  /// The floor outline from above, in metres: RoomPlan's floor polygon when it has one, else the walls' corners in
  /// order around the room's middle.
  private static func outline(_ room: CapturedRoom) -> [SIMD2<Double>] {
    if let floor = room.floors.first, floor.polygonCorners.count >= 3 {
      return floor.polygonCorners.map { c in
        let w = floor.transform * SIMD4<Float>(c.x, c.y, c.z, 1)
        return SIMD2(Double(w.x), Double(w.z))
      }
    }
    var pts: [SIMD2<Double>] = []
    for w in room.walls {
      let (c, d) = plan(w.transform), half = Double(w.dimensions.x) / 2
      pts.append(c - d * half); pts.append(c + d * half)
    }
    guard !pts.isEmpty else { return [] }
    let mid = pts.reduce(SIMD2<Double>(0, 0), +) / Double(pts.count)
    // Wall ends meet at corners: keep one point per corner, then go around.
    var corners: [SIMD2<Double>] = []
    for p in pts where !corners.contains(where: { simd_distance($0, p) < 0.25 }) { corners.append(p) }
    return corners.sorted { atan2($0.y - mid.y, $0.x - mid.x) < atan2($1.y - mid.y, $1.x - mid.x) }
  }

  private static func name(_ c: Any) -> String {
    // "door(isOpen: false)" -> "door"; "washerDryer" -> "washer dryer"
    let s = String(describing: c).components(separatedBy: "(").first ?? ""
    return s.replacingOccurrences(of: "([a-z])([A-Z])", with: "$1 $2", options: .regularExpression).lowercased()
  }

  static func room(_ room: CapturedRoom, name roomName: String) -> RoomScan {
    let outlineM = outline(room)
    let heights = room.walls.map { Double($0.dimensions.y) }
    let ceiling = heights.max() ?? 0
    let wallArea = room.walls.reduce(0.0) { $0 + Double($1.dimensions.x * $1.dimensions.y) }
    func openings(_ list: [CapturedRoom.Surface], _ kind: String) -> [RoomScan.Opening] {
      list.map { s in
        let (c, d) = plan(s.transform)
        return .init(kind: kind, widthFt: r1(Double(s.dimensions.x) * ft), heightFt: r1(Double(s.dimensions.y) * ft), center: [r2(c.x * ft), r2(c.y * ft)], along: [r2(d.x), r2(d.y)])
      }
    }
    let holes = (room.doors + room.windows + room.openings).reduce(0.0) { $0 + Double($1.dimensions.x * $1.dimensions.y) }
    let floorM2 = shoelace(outlineM)
    let perimM = room.walls.isEmpty ? perimeter(outlineM) : room.walls.reduce(0.0) { $0 + Double($1.dimensions.x) }
    return RoomScan(
      name: roomName,
      scannedAt: Date(),
      ceilingHeightFt: r1(ceiling * ft),
      floorAreaSF: r1(floorM2 * sf),
      perimeterLF: r1(perimM * ft),
      wallAreaSF: r1(wallArea * sf),
      netWallAreaSF: r1(max(0, wallArea - holes) * sf),
      ceilingAreaSF: r1(floorM2 * sf),
      walls: room.walls.map { w in
        let (c, d) = plan(w.transform), half = Double(w.dimensions.x) / 2
        let a = c - d * half, b = c + d * half
        return .init(lengthFt: r1(Double(w.dimensions.x) * ft), heightFt: r1(Double(w.dimensions.y) * ft), start: [r2(a.x * ft), r2(a.y * ft)], end: [r2(b.x * ft), r2(b.y * ft)])
      },
      doors: openings(room.doors, "door"),
      windows: openings(room.windows, "window"),
      openings: openings(room.openings, "opening"),
      objects: room.objects.map { .init(kind: name($0.category), widthFt: r1(Double($0.dimensions.x) * ft), depthFt: r1(Double($0.dimensions.z) * ft), heightFt: r1(Double($0.dimensions.y) * ft)) },
      outline: outlineM.map { [r2($0.x * ft), r2($0.y * ft)] }
    )
  }

  /// 12.5 -> 12' 6"
  static func feetInches(_ v: Double) -> String {
    let total = Int((v * 12).rounded())
    return "\(total / 12)' \(total % 12)\""
  }
}
