//! A macro for the many "type" strings of the API (field, view, application,
//! formula types).
//!
//! The API is the contract and grows faster than the clients: an enum that fails
//! to deserialize on an unknown string would make a whole table unreadable
//! because of one new field type. Every generated enum therefore keeps unknown
//! values in an `Other(String)` variant and serializes them back unchanged.

/// Declares a string-backed enum with an `Other(String)` fallback.
///
/// Each variant lists its canonical wire name first, then optional aliases
/// accepted when reading (for example `auto_number`, an older spelling of
/// `autonumber`).
macro_rules! string_enum {
    (
        $(#[$meta:meta])*
        pub enum $name:ident {
            $(
                $(#[$vmeta:meta])*
                $variant:ident => $wire:literal $(| $alias:literal)*,
            )+
        }
    ) => {
        $(#[$meta])*
        #[derive(Clone, Debug, PartialEq, Eq, Hash)]
        pub enum $name {
            $(
                $(#[$vmeta])*
                $variant,
            )+
            /// A value this version does not know yet, kept verbatim.
            Other(String),
        }

        impl $name {
            /// The canonical wire name, as the API writes it.
            pub fn as_str(&self) -> &str {
                match self {
                    $(Self::$variant => $wire,)+
                    Self::Other(other) => other.as_str(),
                }
            }

            /// Every known variant, in declaration order.
            pub const KNOWN: &'static [$name] = &[$(Self::$variant,)+];
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                match value {
                    $($wire $(| $alias)* => Self::$variant,)+
                    other => Self::Other(other.to_owned()),
                }
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(self.as_str())
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let value = String::deserialize(deserializer)?;
                Ok(Self::from(value.as_str()))
            }
        }
    };
}

pub(crate) use string_enum;
