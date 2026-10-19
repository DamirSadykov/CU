pub fn covered() -> bool {
    true
}

#[cfg(test)]
mod tests {
    #[test]
    fn covered_is_true() {
        assert!(super::covered());
    }
}

