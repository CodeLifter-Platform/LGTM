# LGTM for iPad

A native SwiftUI **iPad** companion to the LGTM desktop app — a read-focused
viewer for your open Azure DevOps pull requests. It lists every active PR across
your organization (`Repo/PrId/Title`, newest first, with status dots) and lets
you drill into a PR's branches, author, and comment threads. Heavyweight actions
(running an AI review, posting comments) stay on the desktop app; from the iPad
you can jump to any PR in Safari with one tap.

iPad-only (`TARGETED_DEVICE_FAMILY = 2`), deployment target iOS 17.

## Layout

```
ios/
├── project.yml              # XcodeGen project definition (source of truth)
├── LGTM/
│   ├── LGTMApp.swift        # @main entry + dark/light scene
│   ├── Theme.swift          # design tokens (LGTM midnight-blue palette, dark + light)
│   ├── Models.swift         # PullRequest / PRThread / PRComment
│   ├── DevOpsClient.swift   # PAT-authenticated Azure DevOps REST client (port of devops-client.js)
│   ├── Keychain.swift       # encrypted PAT storage (mirrors the desktop pat-store)
│   ├── PRListView.swift     # main screen — top bar + live PR list
│   ├── PRDetailView.swift   # PR header, branch flow, comment threads
│   └── SettingsSheet.swift  # org URL + PAT, "Test & Save"
└── Tests/
    └── DevOpsClientTests.swift
```

The `.xcodeproj` and `LGTM/Info.plist` are **generated** from `project.yml` and
are git-ignored — never edit them by hand.

## Build & run

Requires [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`)
and Xcode.

```bash
cd ios
xcodegen generate                                   # regenerate LGTM.xcodeproj
open LGTM.xcodeproj                                  # then ⌘R onto an iPad simulator
```

Or from the command line:

```bash
xcodegen generate
xcodebuild -project LGTM.xcodeproj -scheme LGTM \
  -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M4)' build
xcodebuild -project LGTM.xcodeproj -scheme LGTM \
  -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M4)' test
```

## First launch

Tap the gear → enter your Azure DevOps organization URL
(`https://dev.azure.com/your-org`, optionally with a project to scope the list)
and a Personal Access Token with at least **Code (Read)** scope. "Test & Save"
verifies the credentials before storing the PAT in the iOS Keychain. The org URL
is parsed exactly like the desktop client (`dev.azure.com`, `*.visualstudio.com`,
and on-prem collections all supported).
