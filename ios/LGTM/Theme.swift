import SwiftUI

/// LGTM design tokens — the desktop renderer's midnight-blue palette as the Dark
/// variant and its companion Light variant, resolved automatically per trait
/// collection (native dark mode). Values mirror `src/renderer/styles.css`.
enum Tokens {
    private static func ui(_ hex: UInt32) -> UIColor {
        UIColor(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1)
    }

    /// A color that adapts to light/dark automatically.
    private static func dyn(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(UIColor { trait in trait.userInterfaceStyle == .dark ? ui(dark) : ui(light) })
    }

    private static func fixed(_ hex: UInt32) -> Color { Color(ui(hex)) }

    // Surfaces
    static let appBg = dyn(0xF4F5F9, 0x1A1A2E)
    static let surface = dyn(0xFFFFFF, 0x16213E)
    static let surfaceAlt = dyn(0xEEF0F6, 0x131B33)

    // Borders
    static let border = dyn(0xD6DBE8, 0x0F3460)
    static let borderFaint = dyn(0xE6E9F2, 0x14264C)

    // Text
    static let text = dyn(0x1A1A2E, 0xE0E0E0)
    static let textDim = dyn(0x6C7A89, 0x8892A4)
    static let faint = dyn(0x97A1AE, 0x636E80)

    // Accent
    static let accent = dyn(0x2A7CD6, 0x4CC9F0)
    static let onAccent = fixed(0xFFFFFF)

    // Semantic / status
    static let green = dyn(0x1F9D55, 0x2ECC71)
    static let yellow = dyn(0xC27803, 0xF39C12)
    static let red = dyn(0xC92A3A, 0xE74C3C)
}

extension Font {
    /// LGTM's UI face is the system sans (matches the desktop renderer's
    /// `-apple-system` stack).
    static func ui(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight)
    }

    /// Monospaced system face for PR ids, branch names, and other code-ish text.
    static func code(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}
