pub fn parse_ref(value: &str) -> Option<u32> {
    let mut text = value.trim();
    if let Some(first) = text.chars().next() {
        if first.eq_ignore_ascii_case(&'p') || first.eq_ignore_ascii_case(&'c') {
            text = text[first.len_utf8()..].trim_start();
        }
    }
    if let Some(rest) = text.strip_prefix('#') {
        text = rest.trim_start();
    }
    if text.is_empty() || !text.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

pub fn format_ref(number: u32) -> String {
    format!("p#{number}")
}

pub fn storage_ref(number: u32) -> String {
    format!("c#{number}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_public_storage_short_and_bare_forms() {
        for value in ["p#12", "c#12", "#12", "12", "P  #  12", "c12"] {
            assert_eq!(parse_ref(value), Some(12), "{value}");
        }
        assert_eq!(parse_ref("t#12"), None);
        assert_eq!(parse_ref("plan 12"), None);
    }

    #[test]
    fn display_and_storage_are_distinct() {
        assert_eq!(format_ref(7), "p#7");
        assert_eq!(storage_ref(7), "c#7");
    }
}
