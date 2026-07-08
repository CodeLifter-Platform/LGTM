import Foundation

/// An active pull request, flattened across project + repo — mirrors the shape
/// produced by the desktop app's `DevOpsClient.getAllOpenPRs`.
struct PullRequest: Identifiable, Hashable {
    let id: Int
    let title: String
    let repo: String
    let project: String
    let repoId: String
    let sourceBranch: String
    let targetBranch: String
    let createdBy: String
    let createdDate: Date?
    let webUrl: String
    let isDraft: Bool

    /// `Repo/PrId/Title` — the desktop list-row label.
    var label: String { "\(repo)/\(id)/\(title)" }

    /// Branch names with the `refs/heads/` prefix stripped.
    var sourceShort: String { Self.shortBranch(sourceBranch) }
    var targetShort: String { Self.shortBranch(targetBranch) }

    static func shortBranch(_ ref: String) -> String {
        ref.replacingOccurrences(of: "refs/heads/", with: "")
    }
}

/// A single comment thread on a PR.
struct PRThread: Identifiable, Hashable {
    let id: Int
    let status: String?
    let comments: [PRComment]
}

struct PRComment: Identifiable, Hashable {
    let id: Int
    let author: String
    let content: String
    let publishedDate: Date?
}
