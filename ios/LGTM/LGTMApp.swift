import SwiftUI

@main
struct LGTMApp: App {
    @AppStorage("lgtm.isDark") private var isDark = true

    var body: some Scene {
        WindowGroup {
            PRListView()
                .preferredColorScheme(isDark ? .dark : .light)
        }
    }
}
