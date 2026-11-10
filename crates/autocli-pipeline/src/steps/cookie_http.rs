use std::collections::HashMap;
use std::ffi::OsStr;
use std::process::Stdio;
use std::sync::Arc;

use async_trait::async_trait;
use autocli_core::{CliError, IPage};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;

use crate::step_registry::{StepHandler, StepRegistry};
use crate::template::{render_template_str, TemplateContext};

const RUNNER_SOURCE: &str = include_str!("cookie_http_runner.mjs");

/// Execute adapter JavaScript locally, obtaining cookies through the extension
/// without creating a browser page. Cookie and HTTP policy live in the runner.
pub struct CookieHttpStep;

#[async_trait]
impl StepHandler for CookieHttpStep {
    fn name(&self) -> &'static str {
        "cookie_http"
    }

    async fn execute(
        &self,
        _page: Option<Arc<dyn IPage>>,
        params: &Value,
        data: &Value,
        args: &HashMap<String, Value>,
    ) -> Result<Value, CliError> {
        let input = runner_input(params, data, args)?;
        run_node(OsStr::new("node"), RUNNER_SOURCE, &input).await
    }
}

fn runner_input(
    params: &Value,
    data: &Value,
    args: &HashMap<String, Value>,
) -> Result<Value, CliError> {
    let mut rendered_params = params
        .as_object()
        .cloned()
        .ok_or_else(|| CliError::pipeline("cookie_http requires an object"))?;
    let source = rendered_params
        .get("evaluate")
        .and_then(Value::as_str)
        .ok_or_else(|| CliError::pipeline("cookie_http requires an evaluate string"))?;
    let ctx = TemplateContext {
        args: args.clone(),
        data: data.clone(),
        item: Value::Null,
        index: 0,
    };
    let rendered_source = render_template_str(source, &ctx)?;
    if !rendered_source.is_string() {
        return Err(CliError::pipeline(
            "cookie_http evaluate must render to a JavaScript string",
        ));
    }
    rendered_params.insert("evaluate".into(), rendered_source);
    let daemon_port = std::env::var("AUTOCLI_DAEMON_PORT")
        .ok()
        .and_then(|port| port.parse::<u16>().ok())
        .unwrap_or(19925);
    Ok(json!({
        "params": rendered_params,
        "args": args,
        "data": data,
        "daemon_port": daemon_port,
    }))
}

async fn run_node(node: &OsStr, runner_source: &str, input: &Value) -> Result<Value, CliError> {
    let mut child = tokio::process::Command::new(node)
        .args(["--input-type=module", "-e", runner_source])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // The CLI's command deadline drops this future. Do not leave requests
        // running in a child after the caller reports a timeout.
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                CliError::pipeline("cookie_http requires Node.js 22 or newer on PATH")
            } else {
                CliError::pipeline("cookie_http could not start the Node.js runtime")
            }
        })?;

    let bytes = serde_json::to_vec(input)
        .map_err(|_| CliError::pipeline("cookie_http could not encode runtime input"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| CliError::pipeline("cookie_http runtime input is unavailable"))?;
    stdin
        .write_all(&bytes)
        .await
        .map_err(|_| CliError::pipeline("cookie_http could not send runtime input"))?;
    stdin
        .shutdown()
        .await
        .map_err(|_| CliError::pipeline("cookie_http could not finish runtime input"))?;
    drop(stdin);

    let output = child
        .wait_with_output()
        .await
        .map_err(|_| CliError::pipeline("cookie_http could not collect runtime output"))?;
    // Never copy raw runtime stdout/stderr into an error: they can contain
    // cookies, SQL, request bodies or other production data.
    let envelope: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| CliError::pipeline("cookie_http runtime returned an invalid response"))?;
    match envelope.get("ok").and_then(Value::as_bool) {
        Some(true) if output.status.success() => {
            Ok(envelope.get("data").cloned().unwrap_or(Value::Null))
        }
        Some(false) => Err(runtime_failure(&envelope)),
        _ => Err(CliError::pipeline("cookie_http runtime failed")),
    }
}

fn runtime_failure(envelope: &Value) -> CliError {
    // Only the transport can attach this classification, before any business
    // write was submitted. Unknown outcomes keep their non-retryable error.
    if envelope.get("request_sent").and_then(Value::as_bool) == Some(false)
        && envelope.get("submission_state").and_then(Value::as_str) != Some("UNKNOWN")
    {
        let reason = envelope.get("connection_reason").and_then(Value::as_str);
        let message = match reason {
            Some("DAEMON_UNREACHABLE") => Some("Cannot reach the AutoCLI daemon"),
            Some("EXTENSION_NOT_CONNECTED") => Some("Chrome extension not connected"),
            _ => None,
        };
        if let Some(message) = message {
            let mut error =
                CliError::browser_connect(format!("[CONNECTION:{}] {message}", reason.unwrap()));
            if let CliError::BrowserConnect { suggestions, .. } = &mut error {
                suggestions.push("Run the readiness gate from the installed AutoCLI skill in the same execution environment; the script handles connection waiting.".into());
                suggestions.push("After readiness succeeds, retry only a read-only or dry-run command whose target request was not sent. Never automatically replay writes or UNKNOWN outcomes.".into());
            }
            return error;
        }
    }
    CliError::pipeline(
        envelope
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("cookie_http runtime failed"),
    )
}

pub fn register_cookie_http_steps(registry: &mut StepRegistry) {
    registry.register(Arc::new(CookieHttpStep));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn input_renders_only_the_adapter_source_and_preserves_args_and_data() {
        let args = HashMap::from([("name".into(), json!("quote\"\nvalue"))]);
        let params = json!({
            "origin": "https://example.com",
            "allowed_requests": [{"method": "GET", "path": "^/api/${{ literal }}$"}],
            "evaluate": "({ templated: ${{ args.name | json }}, raw: args.name, previous: data })",
        });
        let input = runner_input(&params, &json!({"count": 2}), &args).unwrap();
        assert_eq!(input["args"]["name"], args["name"]);
        assert_eq!(input["data"], json!({"count": 2}));
        assert_eq!(
            input["params"]["allowed_requests"],
            params["allowed_requests"]
        );
        assert_eq!(
            input["params"]["evaluate"],
            json!("({ templated: \"quote\\\"\\nvalue\", raw: args.name, previous: data })")
        );
    }

    #[tokio::test]
    async fn local_runtime_receives_stdin_to_eof_without_a_page() {
        let input = runner_input(
            &json!({"evaluate": "({ value: ${{ args.value }}, prior: data.count })"}),
            &json!({"count": 2}),
            &HashMap::from([("value".into(), json!(3))]),
        )
        .unwrap();
        let source = r#"
            let text = '';
            for await (const chunk of process.stdin) text += chunk;
            const {params, args, data} = JSON.parse(text);
            const result = eval(params.evaluate);
            process.stdout.write(JSON.stringify({ok: true, data: result}));
        "#;
        let result = run_node(OsStr::new("node"), source, &input).await.unwrap();
        assert_eq!(result, json!({"value": 3, "prior": 2}));
    }

    #[tokio::test]
    async fn missing_runtime_has_an_actionable_error_without_payload() {
        let error = run_node(
            OsStr::new("/nonexistent/autocli-cookie-http-node"),
            "",
            &json!({"secret": "private-payload"}),
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(error.contains("Node.js 22"));
        assert!(!error.contains("private-payload"));
    }

    #[tokio::test]
    async fn invalid_runtime_output_does_not_expose_stdout_or_stderr() {
        let error = run_node(
            OsStr::new("node"),
            "process.stdout.write('private-cookie'); process.stderr.write('private-payload'); process.exitCode = 1;",
            &json!({}),
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(error.contains("invalid response"));
        assert!(!error.contains("private-cookie"));
        assert!(!error.contains("private-payload"));
    }

    #[tokio::test]
    async fn structured_runtime_errors_remain_actionable() {
        let error = run_node(
            OsStr::new("node"),
            r#"process.stdout.write(JSON.stringify({ok: false, error: 'Chrome extension is not connected'})); process.exitCode = 1;"#,
            &json!({}),
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(error.contains("Chrome extension is not connected"));
    }

    #[test]
    fn connection_failures_use_the_existing_browser_error_and_renderer_contract() {
        for (reason, message) in [
            ("DAEMON_UNREACHABLE", "Cannot reach the AutoCLI daemon"),
            ("EXTENSION_NOT_CONNECTED", "Chrome extension not connected"),
        ] {
            let error = runtime_failure(&json!({
                "error": "private runtime detail", "connection_reason": reason, "request_sent": false
            }));
            assert_eq!(error.code(), "BROWSER_CONNECT");
            assert_eq!(
                error.to_string(),
                format!("[browser] [CONNECTION:{reason}] {message}")
            );
            assert!(error
                .suggestions()
                .iter()
                .any(|hint| hint.contains("readiness gate")));
            assert!(error
                .suggestions()
                .iter()
                .any(|hint| hint.contains("UNKNOWN")));
            assert!(!error.to_string().contains("private runtime detail"));
        }
    }

    #[test]
    fn unknown_and_unclassified_failures_do_not_offer_connection_recovery() {
        for envelope in [
            json!({"error": "outcome UNKNOWN", "connection_reason": "EXTENSION_NOT_CONNECTED", "request_sent": false, "submission_state": "UNKNOWN"}),
            json!({"error": "permission denied", "connection_reason": "PERMISSION_DENIED", "request_sent": false}),
            json!({"error": "adapter error", "connection_reason": "EXTENSION_NOT_CONNECTED"}),
        ] {
            let error = runtime_failure(&envelope);
            assert_eq!(error.code(), "PIPELINE");
            assert!(error.suggestions().is_empty());
        }
    }

    #[tokio::test]
    async fn command_deadline_cancels_and_kills_the_runtime() {
        let path = std::env::temp_dir().join(format!(
            "autocli-cookie-http-cancel-{}-{}.txt",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let source = format!(
            "import {{ writeFileSync }} from 'node:fs'; setTimeout(() => writeFileSync({}, 'runtime survived'), 800);",
            serde_json::to_string(&path).unwrap(),
        );
        let result = tokio::time::timeout(
            Duration::from_millis(300),
            run_node(OsStr::new("node"), &source, &json!({})),
        )
        .await;
        assert!(result.is_err());
        tokio::time::sleep(Duration::from_millis(700)).await;
        assert!(
            !path.exists(),
            "timed out runtime must not survive to perform work"
        );
    }
}
