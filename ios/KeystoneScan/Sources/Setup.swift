import CommonCrypto
import CryptoKit
import Foundation
import Security

/// What the app needs from Keystone on the laptop: the Homebase address and key, and who Hunter is. It arrives once,
/// over the home or office Wi-Fi, locked with the 6-digit code the laptop shows (the same "Connect phone" handover
/// the Android app uses: AES-256-GCM under a key stretched from the code with PBKDF2-SHA256).
struct Setup: Codable {
  struct Homebase: Codable { var url: String; var token: String }
  struct Me: Codable { var name: String; var email: String }
  var homebase: Homebase
  var me: Me
}

enum SetupError: LocalizedError {
  case address, unreachable, notOffering, wrongCode, bad
  var errorDescription: String? {
    switch self {
    case .address: return "That doesn't look like the address the laptop shows (like 192.168.1.20:4320)."
    case .unreachable: return "Couldn't reach the laptop. Make sure the iPhone is on the same Wi-Fi and the Connect phone window is still open."
    case .notOffering: return "Keystone on the laptop isn't offering a connection right now. Double-click Connect phone again."
    case .wrongCode: return "That code didn't match. Check the 6 digits on the laptop."
    case .bad: return "What the laptop sent couldn't be read. Double-click Connect phone again."
    }
  }
}

enum SetupStore {
  private static let account = "keystone-setup"

  /// The setup, kept in the iPhone's Keychain (never in a plain file).
  static func load() -> Setup? {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: account, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
    return try? JSONDecoder().decode(Setup.self, from: data)
  }

  static func save(_ data: Data) {
    forget()
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: account, kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    SecItemAdd(q as CFDictionary, nil)
  }

  static func forget() {
    SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: account] as CFDictionary)
  }

  /// Fetches the locked setup from the laptop and opens it with the code.
  static func pair(address: String, code: String) async throws -> Setup {
    let host = address.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "http://", with: "").replacingOccurrences(of: "https://", with: "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    guard host.range(of: "^[0-9A-Za-z.\\-]+(:\\d+)?$", options: .regularExpression) != nil, let url = URL(string: "http://\(host)/pair") else { throw SetupError.address }
    let data: Data, response: URLResponse
    do { (data, response) = try await URLSession.shared.data(from: url) } catch { throw SetupError.unreachable }
    guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw SetupError.notOffering }
    guard let box = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let salt = Data(base64Encoded: box["salt"] as? String ?? ""), let iv = Data(base64Encoded: box["iv"] as? String ?? ""),
          let sealed = Data(base64Encoded: box["data"] as? String ?? ""), let rounds = box["rounds"] as? Int, sealed.count > 16 else { throw SetupError.bad }
    let digits = code.filter(\.isNumber)
    let key = try pbkdf2(password: digits, salt: salt, rounds: rounds)
    let plain: Data
    do {
      let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: sealed.prefix(sealed.count - 16), tag: sealed.suffix(16))
      plain = try AES.GCM.open(box, using: SymmetricKey(data: key))
    } catch { throw SetupError.wrongCode }
    guard let setup = try? JSONDecoder().decode(Setup.self, from: plain), !setup.homebase.token.isEmpty else { throw SetupError.bad }
    // Only what this app needs is kept (the laptop's setup also carries contacts and other keys).
    save(try JSONEncoder().encode(setup))
    return setup
  }

  private static func pbkdf2(password: String, salt: Data, rounds: Int) throws -> Data {
    var key = Data(count: 32)
    let pw = Array(password.utf8)
    let status = key.withUnsafeMutableBytes { k in
      salt.withUnsafeBytes { s in
        CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), pw.map { Int8(bitPattern: $0) }, pw.count,
                             s.bindMemory(to: UInt8.self).baseAddress, salt.count,
                             CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), UInt32(rounds),
                             k.bindMemory(to: UInt8.self).baseAddress, 32)
      }
    }
    guard status == kCCSuccess else { throw SetupError.bad }
    return key
  }
}
