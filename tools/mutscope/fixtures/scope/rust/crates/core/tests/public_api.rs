use mutscope_core_fixture::coverage::covered;

#[test]
fn public_api() {
    assert!(covered());
}

