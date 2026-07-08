import SwiftUI

/// A PR's detail: header metadata, the branch flow, and its comment threads
/// loaded from Azure DevOps. A toolbar link opens the PR in Safari for actions
/// the read-only iPad app doesn't perform (approve, comment, run a review).
struct PRDetailView: View {
    let pr: PullRequest
    @AppStorage("lgtm.orgUrl") private var orgUrl = ""

    @State private var threads: [PRThread] = []
    @State private var isLoading = false
    @State private var loadError: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header
                branchCard
                threadsSection
            }
            .padding(20)
            .frame(maxWidth: 760, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(Tokens.appBg)
        .navigationTitle("!\(pr.id)")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if let url = URL(string: pr.webUrl) {
                    Link(destination: url) {
                        Image(systemName: "safari").foregroundStyle(Tokens.accent)
                    }
                }
            }
        }
        .task { await loadThreads() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text(pr.repo).font(.code(14, .medium)).foregroundStyle(Tokens.accent)
                if pr.isDraft {
                    Text("DRAFT").font(.ui(10, .bold)).foregroundStyle(Tokens.yellow)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Tokens.yellow.opacity(0.15), in: Capsule())
                }
            }
            Text(pr.title).font(.ui(22, .bold)).foregroundStyle(Tokens.text)
            HStack(spacing: 6) {
                Image(systemName: "person").font(.system(size: 11))
                Text(pr.createdBy)
                if let d = pr.createdDate {
                    Text("·")
                    Text(d, format: .dateTime.month().day().year())
                }
            }
            .font(.ui(13)).foregroundStyle(Tokens.textDim)
        }
    }

    private var branchCard: some View {
        HStack(spacing: 10) {
            Image(systemName: "arrow.triangle.branch").foregroundStyle(Tokens.textDim)
            Text(pr.sourceShort).font(.code(13)).foregroundStyle(Tokens.text)
            Image(systemName: "arrow.right").font(.system(size: 11)).foregroundStyle(Tokens.faint)
            Text(pr.targetShort).font(.code(13)).foregroundStyle(Tokens.text)
            Spacer()
        }
        .padding(14)
        .background(Tokens.surface, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Tokens.border, lineWidth: 1))
    }

    @ViewBuilder private var threadsSection: some View {
        HStack {
            Text("Comments").font(.ui(15, .semibold)).foregroundStyle(Tokens.text)
            if !threads.isEmpty {
                Text("\(threads.count)").font(.code(12)).foregroundStyle(Tokens.textDim)
            }
            Spacer()
            if isLoading { ProgressView().controlSize(.small).tint(Tokens.accent) }
        }

        if let loadError {
            Text(loadError).font(.ui(13)).foregroundStyle(Tokens.red)
        } else if threads.isEmpty && !isLoading {
            Text("No comments yet.").font(.ui(13)).foregroundStyle(Tokens.textDim)
        } else {
            ForEach(threads) { thread in
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(thread.comments) { c in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 6) {
                                Text(c.author).font(.ui(12, .semibold)).foregroundStyle(Tokens.text)
                                if let d = c.publishedDate {
                                    Text(d, format: .dateTime.month().day().hour().minute())
                                        .font(.ui(11)).foregroundStyle(Tokens.faint)
                                }
                            }
                            Text(c.content).font(.ui(13)).foregroundStyle(Tokens.textDim)
                                .textSelection(.enabled)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .background(Tokens.surface, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Tokens.border, lineWidth: 1))
            }
        }
    }

    private func loadThreads() async {
        guard let pat = Keychain.get(SecretKey.devopsPat) else { return }
        isLoading = true
        loadError = nil
        defer { isLoading = false }
        let client = DevOpsClient(pat: pat, orgUrl: orgUrl)
        do {
            threads = try await client.getPrThreads(project: pr.project, repoId: pr.repoId, prId: pr.id)
        } catch {
            loadError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}
