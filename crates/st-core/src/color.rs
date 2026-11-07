//! The named color palette of select options, ratings and decorations.
//!
//! Colors travel as names (`blue`, `dark-orange`…). The hex values are those of
//! the web app (`$colors` in `frontend/modules/core/assets/scss/colors.scss`) so
//! that a chip looks the same in both clients.

/// An sRGB color.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Rgb {
    pub const fn hex(value: u32) -> Self {
        Self {
            r: (value >> 16) as u8,
            g: (value >> 8) as u8,
            b: value as u8,
        }
    }

    /// Whether white text reads better than dark text on this background
    /// (relative luminance below the WCAG midpoint).
    pub fn is_dark(self) -> bool {
        let channel = |value: u8| {
            let value = f32::from(value) / 255.0;
            if value <= 0.039_28 {
                value / 12.92
            } else {
                ((value + 0.055) / 1.055).powf(2.4)
            }
        };
        let luminance =
            0.2126 * channel(self.r) + 0.7152 * channel(self.g) + 0.0722 * channel(self.b);
        luminance < 0.179
    }
}

/// Neutral background used for chips without a color (links, collaborators).
pub const NEUTRAL_CHIP: Rgb = Rgb::hex(0xededed);

/// Resolves a palette name. Unknown names return `None`; the caller picks a
/// neutral color then.
pub fn palette(name: &str) -> Option<Rgb> {
    let hex = match name {
        "light-blue" => 0xf0f4fc,
        "light-green" => 0xecfcf1,
        "light-cyan" => 0xcff5fa,
        "light-orange" => 0xfffbf0,
        "light-yellow" => 0xfffbf0,
        "light-red" => 0xfff2f0,
        "light-brown" => 0xf5e6dc,
        "light-purple" => 0xf9f1fd,
        "light-pink" => 0xf7e1f2,
        "light-gray" => 0xf5f5f5,

        "blue" => 0xdae4fd,
        "green" => 0xd0f6dc,
        "cyan" => 0xa0ebf5,
        "orange" => 0xfff4da,
        "yellow" => 0xffe9b4,
        "red" => 0xffdeda,
        "brown" => 0xf5ceb0,
        "purple" => 0xdfb9f7,
        "pink" => 0xf7b2e7,
        "gray" => 0xd7d8d9,

        "dark-blue" => 0xacc8f8,
        "dark-green" => 0xa0eeba,
        "dark-cyan" => 0x70e0ef,
        "dark-orange" => 0xffe9b4,
        "dark-yellow" => 0xffdd8f,
        "dark-red" => 0xffbdb4,
        "dark-brown" => 0xf5c098,
        "dark-purple" => 0xcf96f2,
        "dark-pink" => 0xf285d9,
        "dark-gray" => 0xcdcecd,

        "darker-blue" => 0x689ef1,
        "darker-green" => 0x41dd75,
        "darker-cyan" => 0x41d6ea,
        "darker-orange" => 0xffd269,
        "darker-yellow" => 0xffd269,
        "darker-red" => 0xff7b69,
        "darker-brown" => 0xf5a96e,
        "darker-purple" => 0xbf73ee,
        "darker-pink" => 0xff6dde,
        "darker-gray" => 0xb5b5b7,

        "deep-dark-green" => 0x10bf4a,
        "deep-dark-orange" => 0xffc744,
        _ => return None,
    };
    Some(Rgb::hex(hex))
}

/// The color of the filled symbols of a rating field. Ratings use the strong
/// variant of their palette color so that a filled star stands out from an
/// empty one.
pub fn rating_color(name: &str) -> Rgb {
    let strong = match name {
        "dark-orange" | "orange" | "darker-orange" => 0xffc744,
        "dark-red" | "red" | "darker-red" => 0xff5a44,
        "dark-green" | "green" | "darker-green" => 0x10bf4a,
        "dark-blue" | "blue" | "darker-blue" => 0x5190ef,
        "dark-purple" | "purple" | "darker-purple" => 0xaf50ea,
        "dark-pink" | "pink" | "darker-pink" => 0xe26ab0,
        _ => return palette(name).unwrap_or(Rgb::hex(0xffc744)),
    };
    Rgb::hex(strong)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_option_colors_of_the_test_data() {
        for name in [
            "blue",
            "green",
            "orange",
            "red",
            "dark-blue",
            "light-gray",
            "purple",
            "dark-orange",
        ] {
            assert!(palette(name).is_some(), "{name}");
        }
        assert_eq!(
            palette("blue"),
            Some(Rgb {
                r: 0xda,
                g: 0xe4,
                b: 0xfd
            })
        );
        assert_eq!(palette("chartreuse"), None);
    }

    #[test]
    fn tells_dark_backgrounds() {
        assert!(!palette("blue").unwrap().is_dark());
        assert!(Rgb::hex(0x202128).is_dark());
    }
}
