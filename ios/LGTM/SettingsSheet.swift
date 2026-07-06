import SwiftUI

/// Connection settings: the Azure DevOps organization URL and a Personal Access
/// Token. The org URL persists in `@AppStorage`; the PAT goes to the Keychain
/// (never to disk in plaintext) — mirroring the desktop app's keytar-backed
/// `pat-store`. "Test & Save" verifies the credentials before storing the PAT.
struct SettingsSheet: View {
    /// Called after a successful save so the parent reloads.
    var onSaved: () -> Void

    @Environment(\.dismiss) private var dismiss
    @AppStorage("lgtm.orgUrl") private var orgUrl = ""

    @State private var pat = ""
    @State private var hasStoredPat = Keychain.exists(SecretKey.devopsPat)
    @State private var isTesting = false
    @State private var status: Status?

    private enum Status: Equatable {
        case ok(String)
        case error(String)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://dev.azure.com/your-org", text: $orgUrl)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.code(14))
                } header: {
                    Text("Organization URL")
                } footer: {
                    Text("Optionally append a project to scope the PR list, e.g. …/your-org/MyProject.")
                }

                Section {
                    SecureField(hasStoredPat ? "•••••••• (stored)" : "Personal Access Token", text: $pat)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.code(14))
                    if hasStoredPat {
                        Button(role: .destructive) {
                            Keychain.delete(SecretKey.devopsPat)
                            hasStoredPat = false
                            pat = ""
                            status = nil
                        } label: { Text("Remove stored token") }
                    }
                } header: {
                    Text("Personal Access Token")
                } footer: {
                    Text("Needs at least Code (Read) scope. Stored encrypted in the iOS Keychain.")
                }

                if let status {
                    Section {
                        switch status {
                        case .ok(let name):
                            Label(name.isEmpty ? "Connected" : "Connected as \(name)",
                                  systemImage: "checkmark.circle.fill")
                                .foregroundStyle(Tokens.green)
                        case .error(let msg):
                            Label(msg, systemImage: "exclamationmark.triangle.fill")
                                .foregroundStyle(Tokens.red)
                        }
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isTesting {
                        ProgressView()
                    } else {
                        Button("Test & Save") { Task { await testAndSave() } }
                            .disabled(!canSave)
                    }
                }
            }
        }
    }

    private var canSave: Bool {
        !orgUrl.isEmpty && (!pat.isEmpty || hasStoredPat)
    }

    private func testAndSave() async {
        let token = pat.isEmpty ? (Keychain.get(SecretKey.devopsPat) ?? "") : pat
        guard !token.isEmpty else { return }
        isTesting = true
        status = nil
        defer { isTesting = false }

        let client = DevOpsClient(pat: token, orgUrl: orgUrl)
        do {
            let name = try await client.getMeName()
            if !pat.isEmpty {
                Keychain.set(pat, for: SecretKey.devopsPat)
                hasStoredPat = true
                pat = ""
            }
            status = .ok(name)
            onSaved()
        } catch {
            status = .error((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
        }
    }
}
