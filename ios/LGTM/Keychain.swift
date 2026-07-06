import Foundation
import Security

/// Minimal wrapper over the iOS Keychain for app secrets (the Azure DevOps PAT).
/// Values are stored in the system Keychain — encrypted and app-private — never
/// as a plaintext file on disk. Mirrors the desktop app's keytar-backed
/// `pat-store`.
enum Keychain {
    private static let service = "net.codelifter.lgtm"

    static func set(_ value: String, for account: String) {
        let data = Data(value.utf8)
        delete(account)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        SecItemAdd(query as CFDictionary, nil)
    }

    static func get(_ account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let value = String(data: data, encoding: .utf8)
        else { return nil }
        return value
    }

    static func delete(_ account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }

    static func exists(_ account: String) -> Bool { get(account) != nil }
}

/// Keychain account identifiers used by the app.
enum SecretKey {
    static let devopsPat = "devops.pat"
}
