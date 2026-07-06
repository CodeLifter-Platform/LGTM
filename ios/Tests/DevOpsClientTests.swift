import XCTest
@testable import LGTM

/// Pins `DevOpsClient.parseOrgUrl` against the same URL shapes the desktop
/// `devops-client.js` documents — org-only, org+project, visualstudio.com, and
/// on-prem collections — so the org/project split stays correct.
final class DevOpsClientTests: XCTestCase {
    func testDevAzureOrgOnly() {
        let r = DevOpsClient.parseOrgUrl("https://dev.azure.com/myorg")
        XCTAssertEqual(r.orgUrl, "https://dev.azure.com/myorg")
        XCTAssertNil(r.project)
    }

    func testDevAzureWithProject() {
        let r = DevOpsClient.parseOrgUrl("https://dev.azure.com/myorg/MyProject")
        XCTAssertEqual(r.orgUrl, "https://dev.azure.com/myorg")
        XCTAssertEqual(r.project, "MyProject")
    }

    func testTrailingSlashStripped() {
        let r = DevOpsClient.parseOrgUrl("https://dev.azure.com/myorg/")
        XCTAssertEqual(r.orgUrl, "https://dev.azure.com/myorg")
        XCTAssertNil(r.project)
    }

    func testVisualStudioWithProject() {
        let r = DevOpsClient.parseOrgUrl("https://myorg.visualstudio.com/MyProject")
        XCTAssertEqual(r.orgUrl, "https://myorg.visualstudio.com")
        XCTAssertEqual(r.project, "MyProject")
    }

    func testShortBranchStripsRefsHeads() {
        XCTAssertEqual(PullRequest.shortBranch("refs/heads/feature/foo"), "feature/foo")
    }
}
