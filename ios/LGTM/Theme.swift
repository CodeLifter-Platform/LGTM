import SwiftUI

/// LGTM design tokens — the SwiftUI port of the CodeLifter Design System as the
/// desktop renderer consumes it (`src/renderer/tokens.css`, itself a verbatim port
/// of `Platform-Design/tokens/*.css`). Dark is the canonical ink ramp; light is the
/// design system's light-cool scope, resolved automatically per trait collection.
///
/// Keep this file in step with `tokens.css`: the same value in both, in the same
/// change (Platform-Standards/design/design-system.md, rule 6).
/// Last synced: 2026-10-06.
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

    // Surfaces (--cl-bg, --cl-surface, --cl-surface-hover)
    static let appBg = dyn(0xF6F7FB, 0x0A0A0F)
    static let surface = dyn(0xFFFFFF, 0x12121A)
    static let surfaceAlt = dyn(0xF0F0F8, 0x1A1A28)

    // Borders (--cl-border; the subtle divider reuses the hover surface)
    static let border = dyn(0xE3E3EE, 0x1E1E2E)
    static let borderFaint = dyn(0xF0F0F8, 0x1A1A28)

    // Text (--cl-text, --cl-text-muted)
    static let text = dyn(0x14141C, 0xE8E8ED)
    static let textDim = dyn(0x5A5A72, 0x8888A0)
    /// Tertiary text has no light-cool step in the system; it maps to muted.
    static let faint = dyn(0x5A5A72, 0x8888A0)

    // Brand (--cl-primary / --cl-primary-text / --cl-on-primary; --cl-accent)
    static let accent = dyn(0x6D28D9, 0x7C3AED)
    static let accentText = dyn(0x6D28D9, 0xA78BFA)
    static let onAccent = fixed(0xFFFFFF)
    static let secondary = dyn(0x0891B2, 0x00D4FF)
    static let secondaryText = dyn(0x0E7490, 0x00D4FF)

    // Status (--cl-success / --cl-warning / --cl-danger and their -text steps)
    static let green = dyn(0x059669, 0x34D399)
    static let greenText = dyn(0x046C4E, 0x34D399)
    static let yellow = dyn(0xC2820C, 0xF5B544)
    static let yellowText = dyn(0x8A5A06, 0xF5B544)
    static let red = dyn(0xDC2F36, 0xF2555A)
    static let redText = dyn(0xB3202A, 0xF2555A)
}

extension Font {
    /// Interface type: Inter, bundled with the app (ios/LGTM/Fonts), never
    /// relied on from the system. Weight picks the matching static face.
    static func ui(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .custom(interFace(for: weight), size: size)
    }

    /// Code and metadata: JetBrains Mono, bundled the same way.
    static func code(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .custom(monoFace(for: weight), size: size)
    }

    private static func interFace(for weight: Font.Weight) -> String {
        switch weight {
        case .bold, .heavy, .black: return "Inter-Bold"
        case .semibold: return "Inter-SemiBold"
        case .medium: return "Inter-Medium"
        default: return "Inter-Regular"
        }
    }

    private static func monoFace(for weight: Font.Weight) -> String {
        switch weight {
        case .bold, .heavy, .black: return "JetBrainsMono-Bold"
        case .semibold: return "JetBrainsMono-SemiBold"
        case .medium: return "JetBrainsMono-Medium"
        default: return "JetBrainsMono-Regular"
        }
    }
}
