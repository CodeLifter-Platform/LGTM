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

    func testRoutingSegmentsAfterTheProjectAreDropped() {
        let r = DevOpsClient.parseOrgUrl("https://dev.azure.com/myorg/MyProject/_git/repo/pullrequest/12")
        XCTAssertEqual(r.orgUrl, "https://dev.azure.com/myorg")
        XCTAssertEqual(r.project, "MyProject")
    }

    // Regression (mirrors tests/core/parse-org-url.test.js on the desktop):
    // the port was dropped and the `tfs` virtual directory was taken for the
    // collection, making "DefaultCollection" the project filter.
    func testOnPremKeepsPortAndTfsVirtualDirectoryAndTakesThirdSegmentAsProject() {
        let r = DevOpsClient.parseOrgUrl("http://tfs.corp:8080/tfs/DefaultCollection/Proj")
        XCTAssertEqual(r.orgUrl, "http://tfs.corp:8080/tfs/DefaultCollection")
        XCTAssertEqual(r.project, "Proj")

        let noProject = DevOpsClient.parseOrgUrl("http://tfs.corp:8080/tfs/DefaultCollection")
        XCTAssertEqual(noProject.orgUrl, "http://tfs.corp:8080/tfs/DefaultCollection")
        XCTAssertNil(noProject.project)
    }

    func testOnPremWithoutTfsVirtualDirectoryTreatsFirstSegmentAsCollection() {
        let r = DevOpsClient.parseOrgUrl("https://ado.corp.example/DefaultCollection/Proj")
        XCTAssertEqual(r.orgUrl, "https://ado.corp.example/DefaultCollection")
        XCTAssertEqual(r.project, "Proj")
    }

    func testGarbageComesBackAsTypedWithNoProject() {
        let r = DevOpsClient.parseOrgUrl("not a url")
        XCTAssertEqual(r.orgUrl, "not a url")
        XCTAssertNil(r.project)
    }

    func testShortBranchStripsRefsHeads() {
        XCTAssertEqual(PullRequest.shortBranch("refs/heads/feature/foo"), "feature/foo")
    }
}
