import RoomPlan
import SwiftUI

@main
struct KeystoneScanApp: App {
  @StateObject private var store = Store()
  var body: some Scene {
    WindowGroup {
      Group {
        if store.setup == nil { PairView() } else { JobsView() }
      }
      .environmentObject(store)
      .tint(Color(red: 0.05, green: 0.36, blue: 0.75))
    }
  }
}

/// What the app holds: the connection, and each job's scanned rooms (saved on the phone until they're sent, so a
/// lost signal or a closed app doesn't lose a scan).
@MainActor
final class Store: ObservableObject {
  @Published var setup: Setup? = SetupStore.load()
  @Published var scans: [Int: JobScan] = [:]

  private var folder: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("scans", isDirectory: true) }
  private func file(_ n: Int) -> URL { folder.appendingPathComponent("\(n).json") }

  var homebase: HomebaseClient? { setup.map(HomebaseClient.init) }

  func scan(for job: Job) -> JobScan {
    if let s = scans[job.jobNumber] { return s }
    if let d = try? Data(contentsOf: file(job.jobNumber)), let s = try? JSONDecoder().decode(JobScan.self, from: d) { scans[job.jobNumber] = s; return s }
    return JobScan(jobNumber: job.jobNumber, jobName: job.name, address: job.address, rooms: [])
  }

  func save(_ s: JobScan) {
    scans[s.jobNumber] = s
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let e = JSONEncoder(); e.outputFormatting = [.prettyPrinted, .sortedKeys]; e.dateEncodingStrategy = .iso8601
    try? e.encode(s).write(to: file(s.jobNumber), options: .atomic)
  }

  func forget() { SetupStore.forget(); setup = nil }
}

// MARK: - Connecting to Keystone on the laptop

struct PairView: View {
  @EnvironmentObject var store: Store
  @State private var address = UserDefaults.standard.string(forKey: "pairAddress") ?? ""
  @State private var code = ""
  @State private var busy = false
  @State private var problem: String?

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Text("On the laptop, double-click **Connect phone** in the Keystone folder. It shows an address and a 6-digit code. Type them here (the iPhone has to be on the same Wi-Fi).")
        }
        Section("From the laptop") {
          TextField("Address, like 192.168.1.20:4320", text: $address).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
          TextField("6-digit code", text: $code).keyboardType(.numberPad)
        }
        if let problem { Section { Text(problem).foregroundStyle(.red) } }
        Section {
          Button(busy ? "Connecting…" : "Connect") { Task { await connect() } }.disabled(busy || address.isEmpty || code.filter(\.isNumber).count != 6)
        }
      }
      .navigationTitle("Keystone Scan")
    }
  }

  private func connect() async {
    busy = true; problem = nil
    defer { busy = false }
    do {
      UserDefaults.standard.set(address, forKey: "pairAddress")
      store.setup = try await SetupStore.pair(address: address, code: code)
    } catch { problem = error.localizedDescription }
  }
}

// MARK: - Picking the job

struct JobsView: View {
  @EnvironmentObject var store: Store
  @State private var jobs: [Job] = []
  @State private var search = ""
  @State private var loading = false
  @State private var problem: String?

  var body: some View {
    NavigationStack {
      List {
        if !RoomCaptureSession.isSupported {
          Text("This iPhone has no LiDAR scanner, so it can't measure rooms. A Pro iPhone (12 Pro or newer) can.").foregroundStyle(.orange)
        }
        if let problem { Text(problem).foregroundStyle(.red) }
        ForEach(jobs) { job in
          NavigationLink(value: job) {
            VStack(alignment: .leading, spacing: 3) {
              Text(job.name).font(.headline)
              Text([job.address, job.stage].filter { !$0.isEmpty }.joined(separator: " · ")).font(.subheadline).foregroundStyle(.secondary)
              if let n = store.scans[job.jobNumber]?.rooms.count, n > 0 { Text("\(n) room\(n == 1 ? "" : "s") scanned").font(.caption).foregroundStyle(.blue) }
            }
          }
        }
        if jobs.isEmpty && !loading && problem == nil { Text(search.isEmpty ? "No open reconstruction jobs." : "No job matches.").foregroundStyle(.secondary) }
      }
      .overlay { if loading && jobs.isEmpty { ProgressView() } }
      .searchable(text: $search, prompt: "Name, address or job number")
      .onSubmit(of: .search) { Task { await load() } }
      .onChange(of: search) { _, v in if v.isEmpty { Task { await load() } } }
      .refreshable { await load() }
      .navigationTitle("Pick the job")
      .navigationDestination(for: Job.self) { JobScanView(job: $0) }
      .toolbar { Menu { Button("Disconnect this iPhone", role: .destructive) { store.forget() } } label: { Image(systemName: "gearshape") } }
      .task { if jobs.isEmpty { await load() } }
    }
  }

  private func load() async {
    guard let hb = store.homebase else { return }
    loading = true; problem = nil
    defer { loading = false }
    do { jobs = try await hb.jobs(search: search) } catch { problem = error.localizedDescription }
  }
}

// MARK: - Scanning a job's rooms

struct JobScanView: View {
  @EnvironmentObject var store: Store
  let job: Job
  @State private var scan: JobScan?
  @State private var capturing = false
  @State private var pending: CapturedRoom?
  @State private var roomName = ""
  @State private var naming = false
  @State private var sending = false
  @State private var status: String?
  @State private var showPlan = false

  private let suggestions = ["Kitchen", "Living Room", "Dining Room", "Family Room", "Bedroom", "Primary Bedroom", "Bathroom", "Primary Bathroom", "Hallway", "Laundry", "Closet", "Basement", "Office", "Entry", "Garage"]

  var body: some View {
    List {
      Section {
        Text(job.address.isEmpty ? job.stage : job.address).foregroundStyle(.secondary)
        Button { capturing = true } label: { Label("Scan a room", systemImage: "camera.metering.matrix").font(.headline) }
          .disabled(!RoomCaptureSession.isSupported)
      } footer: {
        Text("Stand in a doorway, point the camera at the walls and walk slowly around the room. Keep the floor and the tops of the walls in view.")
      }
      if let scan, !scan.rooms.isEmpty {
        Section("Rooms") {
          ForEach(scan.rooms) { r in
            VStack(alignment: .leading, spacing: 2) {
              Text(r.name).font(.headline)
              Text("\(Int(r.floorAreaSF.rounded())) SF floor · \(Int(r.perimeterLF.rounded())) LF · ceiling \(Measure.feetInches(r.ceilingHeightFt))").font(.subheadline)
              Text("\(r.walls.count) walls · \(r.doors.count) doors · \(r.windows.count) windows · walls \(Int(r.netWallAreaSF.rounded())) SF").font(.caption).foregroundStyle(.secondary)
            }
          }
          .onDelete { idx in var s = scan; s.rooms.remove(atOffsets: idx); store.save(s); self.scan = s }
        }
        Section {
          Button { showPlan = true } label: { Label("See the floor plan", systemImage: "square.split.2x2") }
          Button { Task { await send() } } label: { Label(sending ? "Sending…" : "Send to Homebase", systemImage: "paperplane.fill").font(.headline) }.disabled(sending)
        } footer: {
          Text("Sends the measurements and the floor plan to this job's Documents in Homebase. Keystone on the laptop puts them in the job for the estimate.")
        }
      }
      if let status { Section { Text(status) } }
    }
    .navigationTitle(job.name)
    .onAppear { scan = store.scan(for: job) }
    .fullScreenCover(isPresented: $capturing) {
      CaptureScreen { room in
        capturing = false
        if let room { pending = room; roomName = ""; naming = true }
      }
      .ignoresSafeArea()
    }
    .sheet(isPresented: $naming) { nameSheet }
    .sheet(isPresented: $showPlan) {
      if let scan { ScrollView([.horizontal, .vertical]) { Image(uiImage: FloorPlan.image(scan)).resizable().scaledToFit().frame(minWidth: 360) }.presentationDetents([.large]) }
    }
  }

  private var nameSheet: some View {
    NavigationStack {
      Form {
        TextField("Room name", text: $roomName)
        Section("Pick one") {
          ForEach(suggestions, id: \.self) { s in Button(s) { roomName = numbered(s) } }
        }
      }
      .navigationTitle("Which room was that?")
      .toolbar {
        ToolbarItem(placement: .confirmationAction) { Button("Save") { keep() }.disabled(roomName.trimmingCharacters(in: .whitespaces).isEmpty) }
        ToolbarItem(placement: .cancellationAction) { Button("Throw away", role: .destructive) { pending = nil; naming = false } }
      }
    }
    .interactiveDismissDisabled()
  }

  /// "Bedroom" again becomes "Bedroom 2".
  private func numbered(_ s: String) -> String {
    let taken = Set(scan?.rooms.map(\.name) ?? [])
    if !taken.contains(s) { return s }
    var i = 2
    while taken.contains("\(s) \(i)") { i += 1 }
    return "\(s) \(i)"
  }

  private func keep() {
    guard let room = pending else { return }
    var s = scan ?? store.scan(for: job)
    s.rooms.append(Measure.room(room, name: roomName.trimmingCharacters(in: .whitespaces)))
    store.save(s); scan = s
    pending = nil; naming = false
    status = nil
  }

  private func send() async {
    guard let scan, let hb = store.homebase else { return }
    sending = true; status = nil
    defer { sending = false }
    let stamp = { let f = DateFormatter(); f.dateFormat = "yyyyMMdd-HHmm"; return f.string(from: Date()) }()
    let base = "room-scan-\(job.jobNumber)-\(stamp)"
    do {
      let e = JSONEncoder(); e.outputFormatting = [.prettyPrinted, .sortedKeys]; e.dateEncodingStrategy = .iso8601
      try await hb.upload(job: job, fileName: "\(base).json", mime: "application/json", data: try e.encode(scan), title: "Room measurements (Keystone Scan)")
      guard let png = FloorPlan.image(scan).pngData() else { throw NSError(domain: "Scan", code: 1, userInfo: [NSLocalizedDescriptionKey: "Couldn't draw the floor plan."]) }
      try await hb.upload(job: job, fileName: "\(base).png", mime: "image/png", data: png, title: "Floor plan (Keystone Scan)")
      status = "✓ Sent \(scan.rooms.count) room\(scan.rooms.count == 1 ? "" : "s") to \(job.name) in Homebase."
    } catch {
      status = "Not sent: \(error.localizedDescription) The scans are kept on the phone; try again when you have signal."
    }
  }
}
