use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::Command;

use super::codex::{CodexCredits, CodexLimitWindow, CodexRateLimits};

fn executable() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        let target = if cfg!(target_arch = "aarch64") {
            ("arm64", "aarch64-pc-windows-msvc")
        } else {
            ("x64", "x86_64-pc-windows-msvc")
        };
        for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
            let native = dir.join("codex.exe");
            if native.is_file() {
                return Ok(native);
            }
            if !dir.join("codex.cmd").is_file() {
                continue;
            }
            let package = dir.join("node_modules").join("@openai").join("codex");
            for vendor in [
                package
                    .join("node_modules")
                    .join("@openai")
                    .join(format!("codex-win32-{}", target.0))
                    .join("vendor"),
                dir.join("node_modules")
                    .join("@openai")
                    .join(format!("codex-win32-{}", target.0))
                    .join("vendor"),
                package.join("vendor"),
            ] {
                let native = vendor.join(target.1).join("bin").join("codex.exe");
                if native.is_file() {
                    return Ok(native);
                }
            }
        }
        Err("Codex CLI не найден. Установите Codex CLI и войдите в аккаунт.".into())
    }
    #[cfg(not(windows))]
    {
        Ok(PathBuf::from("codex"))
    }
}

async fn response(reader: &mut (impl AsyncBufRead + Unpin), id: i64) -> Result<Value, String> {
    let mut line = String::new();
    loop {
        line.clear();
        if reader
            .read_line(&mut line)
            .await
            .map_err(|e| e.to_string())?
            == 0
        {
            return Err("Codex завершился до ответа. Проверьте вход в Codex CLI.".into());
        }
        let value: Value =
            serde_json::from_str(&line).map_err(|e| format!("Некорректный ответ Codex: {e}"))?;
        if value.get("id").and_then(Value::as_i64) != Some(id) {
            continue;
        }
        if let Some(error) = value.get("error") {
            return Err(format!(
                "Codex: {}",
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("ошибка запроса лимитов")
            ));
        }
        return value
            .get("result")
            .cloned()
            .ok_or_else(|| "Codex не вернул результат запроса.".into());
    }
}

async fn exchange(
    reader: &mut (impl AsyncBufRead + Unpin),
    writer: &mut (impl AsyncWrite + Unpin),
) -> Result<Option<CodexRateLimits>, String> {
    let request = async {
        let initialize = json!({"id": 1, "method": "initialize", "params": {
            "clientInfo": {"name": "cu", "title": "CU", "version": env!("CARGO_PKG_VERSION")}
        }});
        writer
            .write_all(format!("{initialize}\n").as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        writer.flush().await.map_err(|e| e.to_string())?;
        response(reader, 1).await?;
        writer.write_all(b"{\"method\":\"initialized\"}\n{\"id\":2,\"method\":\"account/rateLimits/read\"}\n")
        .await.map_err(|e| e.to_string())?;
        writer.flush().await.map_err(|e| e.to_string())?;
        parse_limits(&response(reader, 2).await?)
    };
    tokio::time::timeout(Duration::from_secs(20), request)
        .await
        .map_err(|_| "Codex не ответил на запрос лимитов за 20 секунд.".to_string())?
}

fn parse_limits(result: &Value) -> Result<Option<CodexRateLimits>, String> {
    let limits = result
        .get("rateLimitsByLimitId")
        .and_then(|v| v.get("codex"))
        .or_else(|| result.get("rateLimits"))
        .filter(|v| !v.is_null())
        .ok_or_else(|| {
            "Codex не вернул лимиты аккаунта. Проверьте вход через ChatGPT в Codex CLI.".to_string()
        })?;
    let window = |name| -> Result<Option<CodexLimitWindow>, String> {
        let Some(value) = limits.get(name).filter(|v| !v.is_null()) else {
            return Ok(None);
        };
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Window {
            used_percent: f64,
            window_duration_mins: i64,
            resets_at: i64,
        }
        let value: Window = serde_json::from_value(value.clone())
            .map_err(|e| format!("Некорректное окно лимитов Codex: {e}"))?;
        Ok(Some(CodexLimitWindow {
            used_percent: value.used_percent,
            window_minutes: value.window_duration_mins,
            resets_at: value.resets_at,
        }))
    };
    let primary = window("primary")?;
    let secondary = window("secondary")?;
    if primary.is_none() && secondary.is_none() {
        return Ok(None);
    }
    let credits = limits
        .get("credits")
        .filter(|v| !v.is_null())
        .map(|value| CodexCredits {
            has_credits: value
                .get("hasCredits")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            unlimited: value
                .get("unlimited")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            balance: match value.get("balance") {
                Some(Value::String(balance)) => balance.clone(),
                Some(Value::Number(balance)) => balance.to_string(),
                _ => String::new(),
            },
        });
    Ok(Some(CodexRateLimits {
        observed_at: chrono::Utc::now().to_rfc3339(),
        limit_id: limits
            .get("limitId")
            .and_then(Value::as_str)
            .unwrap_or("codex")
            .into(),
        plan_type: limits
            .get("planType")
            .and_then(Value::as_str)
            .map(str::to_string),
        primary,
        secondary,
        credits,
        rate_limit_reached_type: limits
            .get("rateLimitReachedType")
            .and_then(Value::as_str)
            .map(str::to_string),
    }))
}

pub async fn read_limits() -> Result<Option<CodexRateLimits>, String> {
    let mut command = Command::new(executable()?);
    command
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if let Some(home) = super::codex::codex_dir() {
        command.env("CODEX_HOME", home);
    }
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command
        .spawn()
        .map_err(|e| format!("Не удалось запустить Codex: {e}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or("Codex: недоступен канал запроса")?;
    let mut stdout = BufReader::new(
        child
            .stdout
            .take()
            .ok_or("Codex: недоступен канал ответа")?,
    );
    let result = exchange(&mut stdout, &mut stdin).await;
    drop(stdin);
    drop(stdout);
    if tokio::time::timeout(Duration::from_secs(2), child.wait())
        .await
        .is_err()
    {
        let _ = child.kill().await;
    }
    log::debug!("Codex account limits: success={}", result.is_ok());
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> Value {
        json!({"limitId":"codex", "planType":"fixture-plan", "primary": {
            "usedPercent":25, "windowDurationMins":10080, "resetsAt":1234567890
        }, "secondary":null, "credits":{"hasCredits":false,"unlimited":false,"balance":"0"}})
    }

    #[test]
    fn parses_weekly_account_window_and_credits() {
        let limits = parse_limits(&json!({"rateLimits":snapshot()}))
            .unwrap()
            .unwrap();
        assert_eq!(limits.primary.unwrap().window_minutes, 10080);
        assert_eq!(limits.plan_type.as_deref(), Some("fixture-plan"));
        assert_eq!(limits.credits.unwrap().balance, "0");
        assert!(limits.secondary.is_none());
        assert!(chrono::DateTime::parse_from_rfc3339(&limits.observed_at).is_ok());
    }

    #[test]
    fn prefers_codex_bucket_to_other_model_limits() {
        let mut other = snapshot();
        other["limitId"] = json!("other");
        other["primary"]["usedPercent"] = json!(99);
        let limits =
            parse_limits(&json!({"rateLimits":other,"rateLimitsByLimitId":{"codex":snapshot()}}))
                .unwrap()
                .unwrap();
        assert_eq!(limits.limit_id, "codex");
        assert_eq!(limits.primary.unwrap().used_percent, 25.0);
    }

    #[test]
    fn accepts_two_windows_with_an_absent_credit_balance() {
        let mut value = snapshot();
        value["primary"]["windowDurationMins"] = json!(300);
        value["secondary"] = snapshot()["primary"].clone();
        value["credits"]["balance"] = Value::Null;
        let limits = parse_limits(&json!({"rateLimits":value})).unwrap().unwrap();
        assert_eq!(limits.primary.unwrap().window_minutes, 300);
        assert_eq!(limits.secondary.unwrap().window_minutes, 10080);
        assert_eq!(limits.credits.unwrap().balance, "");
    }

    #[test]
    fn distinguishes_absent_windows_from_missing_or_malformed_response() {
        assert_eq!(
            parse_limits(&json!({"rateLimits":{"primary":null,"secondary":null}})).unwrap(),
            None
        );
        assert!(parse_limits(&json!({})).is_err());
        assert!(parse_limits(&json!({"rateLimits":{"primary":{"usedPercent":11}}})).is_err());
    }

    #[tokio::test]
    async fn requests_account_limits_without_starting_a_thread_or_turn() {
        let replies = format!(
            "{}\n{}\n{}\n",
            json!({"id":1,"result":{}}),
            json!({"method":"account/updated","params":{}}),
            json!({"id":2,"result":{"rateLimits":snapshot()}})
        );
        let mut reader = BufReader::new(replies.as_bytes());
        let mut requests = Vec::new();
        let limits = exchange(&mut reader, &mut requests).await.unwrap().unwrap();
        assert_eq!(limits.primary.unwrap().used_percent, 25.0);
        let methods: Vec<String> = String::from_utf8(requests)
            .unwrap()
            .lines()
            .map(|line| {
                serde_json::from_str::<Value>(line).unwrap()["method"]
                    .as_str()
                    .unwrap()
                    .into()
            })
            .collect();
        assert_eq!(
            methods,
            ["initialize", "initialized", "account/rateLimits/read"]
        );
    }

    #[tokio::test]
    async fn propagates_sign_in_error_without_a_session_fallback() {
        let replies = format!(
            "{}\n{}\n",
            json!({"id":1,"result":{}}),
            json!({"id":2,"error":{"code":-32000,"message":"Not signed in"}})
        );
        let mut reader = BufReader::new(replies.as_bytes());
        let error = exchange(&mut reader, &mut Vec::new()).await.unwrap_err();
        assert!(error.contains("Not signed in"));
    }

    #[tokio::test]
    async fn detects_exit_before_response() {
        let mut reader = BufReader::new(&b""[..]);
        assert!(exchange(&mut reader, &mut Vec::new())
            .await
            .unwrap_err()
            .contains("завершился"));
    }

    #[tokio::test]
    async fn times_out_when_server_does_not_respond() {
        let (_server, client) = tokio::io::duplex(1024);
        let mut reader = BufReader::new(client);
        let error = exchange(&mut reader, &mut Vec::new()).await.unwrap_err();
        assert!(error.contains("20 секунд"));
    }

    #[tokio::test]
    #[ignore]
    async fn live_account_limits_without_a_conversation() {
        let limits = read_limits().await.unwrap().unwrap();
        assert!(limits.primary.is_some() || limits.secondary.is_some());
    }
}
