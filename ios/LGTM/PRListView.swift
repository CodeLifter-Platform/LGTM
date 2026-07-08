import SwiftUI

/// The single-screen workspace: a top bar over the list of active pull requests
/// pulled from Azure DevOps, with a settings sheet for the org URL + PAT and a
/// dark/light toggle. Tapping a PR pushes its detail. Mirrors the desktop app's
/// live PR list (`Repo/PrId/PRName`, newest first, status dots).
struct PRListView: View {
    @AppStorage("lgtm.isDark") private var isDark = true
    @AppStorage("lgtm.orgUrl") private var orgUrl = ""

    @State private var prs: [PullRequest] = []
    @State private var isLoading = false
    @State private var loadError: String?
    @State private var showSettings = false
    /// Bumped after a settings change so `isConfigured` re-evaluates (Keychain
    /// isn't observable).
    @State private var configToken = 0

    private var isConfigured: Bool {
        _ = configToken
        return !orgUrl.isEmpty && Keychain.exists(SecretKey.devopsPat)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                topBar
                Divider().background(Tokens.border)
                content
            }
            .background(Tokens.appBg)
            .toolbar(.hidden, for: .navigationBar)
        }
        .tint(Tokens.accent)
        .sheet(isPresented: $showSettings) {
            SettingsSheet {
                configToken += 1
                Task { await reload() }
            }
        }
        .task { await reload() }
    }

    // MARK: Top bar

    private var topBar: some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 6)
                .fill(Tokens.accent)
                .frame(width: 26, height: 26)
                .overlay(Image(systemName: "checkmark").font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Tokens.onAccent))
            VStack(alignment: .leading, spacing: 1) {
                Text("LGTM").font(.ui(17, .bold)).foregroundStyle(Tokens.accent)
                    .tracking(1.5)
                Text(orgSubtitle).font(.ui(11)).foregroundStyle(Tokens.textDim)
                    .lineLimit(1)
            }

            Spacer()

            if isLoading { ProgressView().controlSize(.small).tint(Tokens.accent) }

            iconButton(systemName: "arrow.clockwise") { Task { await reload() } }
                .disabled(isLoading || !isConfigured)
            iconButton(systemName: isDark ? "moon.fill" : "sun.max") { isDark.toggle() }
            iconButton(systemName: "gearshape") { showSettings = true }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Tokens.surface)
    }

    private var orgSubtitle: String {
        guard !orgUrl.isEmpty else { return "Azure DevOps PR reviewer" }
        return DevOpsClient.parseOrgUrl(orgUrl).orgUrl
    }

    private func iconButton(systemName: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 15))
                .foregroundStyle(Tokens.textDim)
                .frame(width: 36, height: 36)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Tokens.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // MARK: Content

    @ViewBuilder private var content: some View {
        if !isConfigured {
            emptyState(
                icon: "key.horizontal",
                title: "Not connected",
                message: "Add your Azure DevOps organization URL and a Personal Access Token to see your open pull requests.",
                cta: "Open settings") { showSettings = true }
        } else if let loadError {
            emptyState(
                icon: "exclamationmark.triangle",
                title: "Couldn’t load PRs",
                message: loadError,
                cta: "Retry") { Task { await reload() } }
        } else if prs.isEmpty && !isLoading {
            emptyState(
                icon: "tray",
                title: "No open pull requests",
                message: "There are no active PRs in this organization right now.",
                cta: "Refresh") { Task { await reload() } }
        } else {
            List {
                ForEach(prs) { pr in
                    ZStack {
                        NavigationLink(value: pr) { EmptyView() }.opacity(0)
                        PRRow(pr: pr)
                    }
                    .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Tokens.appBg)
            .refreshable { await reload() }
            .navigationDestination(for: PullRequest.self) { PRDetailView(pr: $0) }
        }
    }

    private func emptyState(icon: String, title: String, message: String,
                            cta: String, action: @escaping () -> Void) -> some View {
        VStack(spacing: 14) {
            Image(systemName: icon).font(.system(size: 40)).foregroundStyle(Tokens.faint)
            Text(title).font(.ui(18, .semibold)).foregroundStyle(Tokens.text)
            Text(message).font(.ui(14)).foregroundStyle(Tokens.textDim)
                .multilineTextAlignment(.center).frame(maxWidth: 420)
            Button(action: action) {
                Text(cta).font(.ui(14, .semibold)).foregroundStyle(Tokens.onAccent)
                    .padding(.horizontal, 18).padding(.vertical, 9)
                    .background(Tokens.accent, in: RoundedRectangle(cornerRadius: 8))
            }
            .buttonStyle(.plain)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(40)
        .background(Tokens.appBg)
    }

    // MARK: Loading

    private func reload() async {
        guard isConfigured, let pat = Keychain.get(SecretKey.devopsPat) else { return }
        isLoading = true
        loadError = nil
        defer { isLoading = false }
        let client = DevOpsClient(pat: pat, orgUrl: orgUrl)
        do {
            prs = try await client.getAllOpenPRs()
        } catch {
            loadError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}

/// One PR card — `Repo/PrId/Title`, branches, author, and a status dot.
private struct PRRow: View {
    let pr: PullRequest

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Circle().fill(statusColor).frame(width: 9, height: 9).padding(.top, 5)

            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text(pr.repo).font(.code(13, .medium)).foregroundStyle(Tokens.accent)
                    Text("·").foregroundStyle(Tokens.faint)
                    Text("!\(pr.id)").font(.code(13)).foregroundStyle(Tokens.textDim)
                    if pr.isDraft {
                        Text("DRAFT").font(.ui(9, .bold)).foregroundStyle(Tokens.yellow)
                            .padding(.horizontal, 5).padding(.vertical, 2)
                            .background(Tokens.yellow.opacity(0.15), in: Capsule())
                    }
                }
                Text(pr.title).font(.ui(15, .semibold)).foregroundStyle(Tokens.text)
                    .lineLimit(2)
                HStack(spacing: 6) {
                    Image(systemName: "arrow.triangle.branch").font(.system(size: 10))
                    Text("\(pr.sourceShort) → \(pr.targetShort)").font(.code(11)).lineLimit(1)
                    Spacer(minLength: 8)
                    Text(pr.createdBy).font(.ui(11))
                }
                .foregroundStyle(Tokens.textDim)
            }
            Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Tokens.faint).padding(.top, 3)
        }
        .padding(14)
        .background(Tokens.surface, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Tokens.border, lineWidth: 1))
    }

    private var statusColor: Color { pr.isDraft ? Tokens.yellow : Tokens.green }
}
