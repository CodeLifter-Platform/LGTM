import Foundation

/// Azure DevOps REST client, PAT-authenticated. A read-focused Swift port of the
/// desktop `devops-client.js`: it lists active PRs across the org and fetches a
/// PR's comment threads. Posting reviews / running agents stays on the desktop —
/// the iPad app is a companion viewer.
struct DevOpsClient {
    let orgUrl: String
    let projectFilter: String?
    private let pat: String

    init(pat: String, orgUrl rawUrl: String) {
        let parsed = DevOpsClient.parseOrgUrl(rawUrl)
        self.orgUrl = parsed.orgUrl
        self.projectFilter = parsed.project
        self.pat = pat
    }

    struct ClientError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    // MARK: URL parsing (mirrors src/main/core/org-url.js — change both together)

    /// Split a user-typed URL into the org base URL and an optional project.
    /// A non-default port is kept (`hostname` alone would drop it and send an
    /// on-prem server's traffic to the wrong port). Anything from the first
    /// `_`-prefixed segment on (`_git`, `_apis`) is routing and is dropped.
    /// On-prem: a leading `tfs` segment is the classic TFS virtual directory,
    /// so `tfs/<Collection>` is the base and the next segment the project;
    /// otherwise the first segment is the collection.
    static func parseOrgUrl(_ raw: String) -> (orgUrl: String, project: String?) {
        let trimmed = raw
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        guard let u = URL(string: trimmed), let host = u.host else {
            return (trimmed, nil)
        }
        let scheme = u.scheme ?? "https"
        let hostPort = u.port.map { "\(host):\($0)" } ?? host
        let base = "\(scheme)://\(hostPort)"
        let parts = u.pathComponents.filter { $0 != "/" && !$0.isEmpty }
        let segs: [String]
        if let routeIdx = parts.firstIndex(where: { $0.hasPrefix("_") }) {
            segs = Array(parts[..<routeIdx])
        } else {
            segs = parts
        }

        if host == "dev.azure.com" {
            let org = segs.first ?? ""
            let project = segs.count > 1 ? segs[1] : nil
            return ("\(base)/\(org)", project)
        }
        if host.hasSuffix(".visualstudio.com") {
            return (base, segs.first)
        }
        // On-prem / unknown host.
        let baseLen = (segs.first?.lowercased() == "tfs" && segs.count >= 2) ? 2 : 1
        let basePath = segs.prefix(baseLen).map { "/\($0)" }.joined()
        let project = segs.count > baseLen ? segs[baseLen] : nil
        return ("\(base)\(basePath)", project)
    }

    var orgHost: String { URL(string: orgUrl)?.host ?? "" }

    // MARK: Request plumbing

    private func authHeader() -> String {
        let token = Data(":\(pat)".utf8).base64EncodedString()
        return "Basic \(token)"
    }

    private func get(_ path: String, query: [String: String] = [:]) async throws -> Data {
        var comps = URLComponents(string: orgUrl + path)
        var items = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        items.append(URLQueryItem(name: "api-version", value: "7.1"))
        comps?.queryItems = items
        guard let url = comps?.url else { throw ClientError(message: "Bad URL: \(path)") }

        var req = URLRequest(url: url)
        req.setValue(authHeader(), forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.timeoutInterval = 30

        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw ClientError(message: "No HTTP response from Azure DevOps.")
        }
        if http.statusCode == 401 || http.statusCode == 203 {
            throw ClientError(message: "Authentication failed — check your PAT and its scopes (needs Code: Read).")
        }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw ClientError(message: "Azure DevOps error \(http.statusCode): \(body.prefix(200))")
        }
        return data
    }

    private func decodeValueArray(_ data: Data) -> [[String: Any]] {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let value = root["value"] as? [[String: Any]]
        else { return [] }
        return value
    }

    // MARK: Public API

    /// Verifies the org + PAT by fetching the authenticated profile name.
    func getMeName() async throws -> String {
        let data = try await get("/_apis/connectionData")
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let user = root["authenticatedUser"] as? [String: Any]
        else { return "" }
        return (user["providerDisplayName"] as? String) ?? (user["customDisplayName"] as? String) ?? ""
    }

    func getProjects() async throws -> [String] {
        let data = try await get("/_apis/projects", query: ["$top": "500"])
        return decodeValueArray(data).compactMap { $0["name"] as? String }
    }

    /// All active PRs across the org (or the configured project), newest first.
    func getAllOpenPRs() async throws -> [PullRequest] {
        var projects = try await getProjects()
        if let filter = projectFilter {
            projects = projects.filter { $0.lowercased() == filter.lowercased() }
        }

        var all: [PullRequest] = []
        for project in projects {
            let reposData: Data
            do {
                reposData = try await get("/\(enc(project))/_apis/git/repositories")
            } catch { continue }
            let repos = decodeValueArray(reposData)

            for repo in repos {
                guard let repoId = repo["id"] as? String,
                      let repoName = repo["name"] as? String else { continue }
                do {
                    let prData = try await get(
                        "/\(enc(project))/_apis/git/repositories/\(repoId)/pullrequests",
                        query: ["searchCriteria.status": "active", "$top": "200"])
                    for pr in decodeValueArray(prData) {
                        guard let prId = pr["pullRequestId"] as? Int else { continue }
                        let title = (pr["title"] as? String) ?? "(untitled)"
                        let source = (pr["sourceRefName"] as? String) ?? ""
                        let target = (pr["targetRefName"] as? String) ?? ""
                        let author = ((pr["createdBy"] as? [String: Any])?["displayName"] as? String) ?? ""
                        let created = parseDate(pr["creationDate"] as? String)
                        let isDraft = (pr["isDraft"] as? Bool) ?? false
                        let webUrl = "\(orgUrl)/\(enc(project))/_git/\(enc(repoName))/pullrequest/\(prId)"
                        all.append(PullRequest(
                            id: prId, title: title, repo: repoName, project: project,
                            repoId: repoId, sourceBranch: source, targetBranch: target,
                            createdBy: author, createdDate: created, webUrl: webUrl, isDraft: isDraft))
                    }
                } catch { continue }
            }
        }
        all.sort { ($0.createdDate ?? .distantPast) > ($1.createdDate ?? .distantPast) }
        return all
    }

    /// Comment threads on a PR, oldest first, system/empty threads removed.
    func getPrThreads(project: String, repoId: String, prId: Int) async throws -> [PRThread] {
        let data = try await get("/\(enc(project))/_apis/git/repositories/\(repoId)/pullRequests/\(prId)/threads")
        var threads: [PRThread] = []
        for t in decodeValueArray(data) {
            guard let tid = t["id"] as? Int else { continue }
            let rawComments = (t["comments"] as? [[String: Any]]) ?? []
            let comments: [PRComment] = rawComments.compactMap { c in
                guard let cid = c["id"] as? Int,
                      let content = c["content"] as? String,
                      !content.isEmpty else { return nil }
                let author = ((c["author"] as? [String: Any])?["displayName"] as? String) ?? ""
                return PRComment(id: cid, author: author, content: content,
                                 publishedDate: parseDate(c["publishedDate"] as? String))
            }
            guard !comments.isEmpty else { continue }
            threads.append(PRThread(id: tid, status: t["status"] as? String, comments: comments))
        }
        return threads
    }

    // MARK: Helpers

    private func enc(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? s
    }

    private func parseDate(_ s: String?) -> Date? {
        guard let s else { return nil }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = iso.date(from: s) { return d }
        iso.formatOptions = [.withInternetDateTime]
        return iso.date(from: s)
    }
}
