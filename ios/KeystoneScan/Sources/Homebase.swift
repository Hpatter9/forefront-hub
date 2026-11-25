import Foundation

/// The little of Homebase this app uses: the open reconstruction jobs, and adding files to a job's Documents.
struct Job: Identifiable, Hashable {
  let id: String
  let jobNumber: Int
  let name: String
  let address: String
  let stage: String
}

struct HomebaseClient {
  let setup: Setup

  private func request(_ path: String, method: String = "GET") -> URLRequest {
    var r = URLRequest(url: URL(string: setup.homebase.url.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/api/v1" + path)!)
    r.httpMethod = method
    r.setValue("application/json", forHTTPHeaderField: "Accept")
    r.setValue("Bearer \(setup.homebase.token)", forHTTPHeaderField: "Authorization")
    if !setup.me.email.isEmpty { r.setValue(setup.me.email, forHTTPHeaderField: "X-Acting-User-Email") }
    r.timeoutInterval = 60
    return r
  }

  private func check(_ data: Data, _ response: URLResponse) throws -> [String: Any] {
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    if status == 401 || status == 403 { throw NSError(domain: "Homebase", code: status, userInfo: [NSLocalizedDescriptionKey: "Homebase didn't accept this iPhone's sign-in. Connect it again from the laptop (Connect phone)."]) }
    if !(200..<300).contains(status) {
      let e = json["error"] as? [String: Any]
      throw NSError(domain: "Homebase", code: status, userInfo: [NSLocalizedDescriptionKey: "Homebase: \(status) \(e?["message"] as? String ?? e?["code"] as? String ?? "")"])
    }
    return json
  }

  private static func addressText(_ a: Any?) -> String {
    if let s = a as? String { return s }
    guard let a = a as? [String: Any] else { return "" }
    let street = [a["street"], a["unit"]].compactMap { $0 as? String }.filter { !$0.isEmpty }.joined(separator: " ")
    let tail = [a["state"], a["zip"]].compactMap { $0 as? String }.filter { !$0.isEmpty }.joined(separator: " ")
    return [street, a["city"] as? String ?? "", tail].filter { !$0.isEmpty }.joined(separator: ", ")
  }

  /// Open reconstruction jobs, or a search across all jobs (closed ones too, when nothing open matches).
  func jobs(search: String = "") async throws -> [Job] {
    let q = search.trimmingCharacters(in: .whitespaces)
    func get(_ active: String) async throws -> [Job] {
      var c = URLComponents()
      c.queryItems = (q.isEmpty ? [URLQueryItem(name: "department", value: "reconstruction")] : [URLQueryItem(name: "q", value: q)]) + [URLQueryItem(name: "active", value: active), URLQueryItem(name: "limit", value: q.isEmpty ? "200" : "30")]
      let (data, response) = try await URLSession.shared.data(for: request("/projects?" + (c.percentEncodedQuery ?? "")))
      let rows = try check(data, response)["projects"] as? [[String: Any]] ?? []
      return rows.compactMap { p in
        guard let id = p["id"] as? String, let n = Int("\(p["jobNumber"] ?? "")") else { return nil }
        return Job(id: id, jobNumber: n, name: (p["name"] as? String) ?? (p["customer"] as? String) ?? "", address: Self.addressText(p["address"]), stage: p["stage"] as? String ?? "")
      }
    }
    var found = try await get("1")
    if found.isEmpty && !q.isEmpty { found = try await get("0") }
    return found.sorted { $0.jobNumber > $1.jobNumber }
  }

  /// Puts one file in the job's Documents tab (kind "scope": these are the job's measurements).
  func upload(job: Job, fileName: String, mime: String, data: Data, title: String) async throws {
    var r = request("/projects/\(job.id)/documents", method: "POST")
    let boundary = "keystone-\(UUID().uuidString)"
    r.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    r.setValue("scan:\(fileName)", forHTTPHeaderField: "Idempotency-Key")
    var body = Data()
    func field(_ name: String, _ value: String) {
      body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".data(using: .utf8)!)
    }
    field("kind", "scope")
    field("title", title)
    body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(fileName)\"\r\nContent-Type: \(mime)\r\n\r\n".data(using: .utf8)!)
    body.append(data)
    body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
    let (d, response) = try await URLSession.shared.upload(for: r, from: body)
    _ = try check(d, response)
  }
}
