use std::sync::OnceLock;

use log::warn;
use serde::Deserialize;
use tauri::AppHandle;

use super::windows;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    Settings(Option<String>),
    Tasks(Option<u32>),
    Analytics,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RouteTable {
    scheme: String,
    settings_tabs: Vec<String>,
    routes: Vec<RouteEntry>,
}

#[derive(Deserialize)]
struct RouteEntry {
    path: String,
    window: String,
}

fn table() -> &'static RouteTable {
    static TABLE: OnceLock<RouteTable> = OnceLock::new();
    TABLE.get_or_init(|| {
        serde_json::from_str(include_str!("../../../src/contracts/app-routes.json"))
            .expect("app-routes.json is valid")
    })
}

enum Param {
    Tab(String),
    Number(u32),
}

fn match_path(pattern: &str, segments: &[&str], table: &RouteTable) -> Option<Option<Param>> {
    let parts: Vec<&str> = pattern.split('/').collect();
    if parts.len() != segments.len() {
        return None;
    }
    let mut param = None;
    for (part, segment) in parts.iter().zip(segments) {
        match *part {
            "<tab>" => {
                if !table.settings_tabs.iter().any(|tab| tab == segment) {
                    return None;
                }
                param = Some(Param::Tab(segment.to_string()));
            }
            "<number>" => {
                if segment.is_empty() || !segment.bytes().all(|b| b.is_ascii_digit()) {
                    return None;
                }
                param = Some(Param::Number(segment.parse().ok()?));
            }
            literal if literal == *segment => {}
            _ => return None,
        }
    }
    Some(param)
}

pub fn parse(url: &str) -> Option<Route> {
    let table = table();
    let (scheme, rest) = url.trim().split_once("://")?;
    if !scheme.eq_ignore_ascii_case(&table.scheme) {
        return None;
    }
    let path = rest.split(['?', '#']).next().unwrap_or("").trim_end_matches('/');
    if path.is_empty() {
        return None;
    }
    let segments: Vec<&str> = path.split('/').collect();
    table.routes.iter().find_map(|entry| {
        let param = match_path(&entry.path, &segments, table)?;
        match (entry.window.as_str(), param) {
            ("settings", None) => Some(Route::Settings(None)),
            ("settings", Some(Param::Tab(tab))) => Some(Route::Settings(Some(tab))),
            ("todos", None) => Some(Route::Tasks(None)),
            ("todos", Some(Param::Number(number))) => Some(Route::Tasks(Some(number))),
            ("analytics", None) => Some(Route::Analytics),
            _ => None,
        }
    })
}

pub fn is_deep_link_launch(args: &[String]) -> bool {
    let prefix = format!("{}://", table().scheme);
    args.iter().any(|arg| {
        arg.get(..prefix.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(&prefix))
    })
}

pub fn handle_url(app: &AppHandle, url: &str) {
    match parse(url) {
        Some(route) => dispatch(app, route),
        None => warn!("deep link: unknown route {url}"),
    }
}

pub fn dispatch(app: &AppHandle, route: Route) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match route {
            Route::Settings(tab) => windows::open_settings(&app, tab),
            Route::Tasks(task) => windows::open_todos(&app, task),
            Route::Analytics => windows::open_analytics(&app),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn deep_link_parses_settings() {
        assert_eq!(parse("cu://settings"), Some(Route::Settings(None)));
    }

    #[test]
    fn deep_link_parses_settings_tab() {
        assert_eq!(
            parse("cu://settings/limits"),
            Some(Route::Settings(Some("limits".into())))
        );
    }

    #[test]
    fn deep_link_parses_every_settings_tab() {
        for tab in &table().settings_tabs {
            assert_eq!(
                parse(&format!("cu://settings/{tab}")),
                Some(Route::Settings(Some(tab.clone())))
            );
        }
    }

    #[test]
    fn deep_link_parses_tasks() {
        assert_eq!(parse("cu://tasks"), Some(Route::Tasks(None)));
    }

    #[test]
    fn deep_link_parses_task_number() {
        assert_eq!(parse("cu://tasks/42"), Some(Route::Tasks(Some(42))));
    }

    #[test]
    fn deep_link_parses_analytics() {
        assert_eq!(parse("cu://analytics"), Some(Route::Analytics));
    }

    #[test]
    fn deep_link_accepts_trailing_slash() {
        assert_eq!(parse("cu://settings/"), Some(Route::Settings(None)));
        assert_eq!(
            parse("cu://settings/budget/"),
            Some(Route::Settings(Some("budget".into())))
        );
        assert_eq!(parse("cu://tasks/7/"), Some(Route::Tasks(Some(7))));
        assert_eq!(parse("cu://analytics/"), Some(Route::Analytics));
    }

    #[test]
    fn deep_link_rejects_unknown_tab() {
        assert_eq!(parse("cu://settings/nope"), None);
    }

    #[test]
    fn deep_link_rejects_non_numeric_task() {
        assert_eq!(parse("cu://tasks/abc"), None);
        assert_eq!(parse("cu://tasks/+5"), None);
        assert_eq!(parse("cu://tasks/-1"), None);
        assert_eq!(parse("cu://tasks/99999999999"), None);
    }

    #[test]
    fn deep_link_rejects_unknown_route() {
        assert_eq!(parse("cu://"), None);
        assert_eq!(parse("cu://kit"), None);
        assert_eq!(parse("cu://analytics/extra"), None);
        assert_eq!(parse("cu://settings/limits/extra"), None);
    }

    #[test]
    fn deep_link_rejects_wrong_scheme() {
        assert_eq!(parse("https://settings"), None);
        assert_eq!(parse("cux://settings"), None);
        assert_eq!(parse("settings"), None);
    }

    #[test]
    fn deep_link_launch_detected() {
        assert!(is_deep_link_launch(&args(&["cu.exe", "cu://tasks/3"])));
        assert!(is_deep_link_launch(&args(&["cu.exe", "CU://settings"])));
    }

    #[test]
    fn deep_link_launch_not_detected() {
        assert!(!is_deep_link_launch(&args(&["cu.exe"])));
        assert!(!is_deep_link_launch(&args(&["cu.exe", "--minimized"])));
        assert!(!is_deep_link_launch(&args(&["cu.exe", "https://example.com"])));
        assert!(!is_deep_link_launch(&[]));
    }
}
