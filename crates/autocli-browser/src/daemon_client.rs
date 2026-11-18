use autocli_core::CliError;
use serde_json::Value;
use std::time::Duration;
use tracing::{debug, warn};

use crate::types::{DaemonCommand, DaemonResult};

/// HTTP client that communicates with the Daemon server.
pub struct DaemonClient {
    base_url: String,
    client: reqwest::Client,
}

/// Retry delays for exponential backoff.
const RETRY_DELAYS_MS: [u64; 4] = [200, 500, 1000, 2000];

/// Preserve structured extension failures returned with HTTP 422.
///
/// The daemon uses 422 for command failures, even though the JSON body still
/// follows the normal `DaemonResult` envelope. Callers rely on this error text
/// to recognize strict-background stale-tab failures and retry with a fresh tab.
fn daemon_failure_from_unprocessable_entity(body: &str) -> Option<CliError> {
    let daemon_result = serde_json::from_str::<DaemonResult>(body).ok()?;
    if daemon_result.ok {
        return None;
    }

    let err_msg = daemon_result
        .error
        .unwrap_or_else(|| "Unknown daemon error".into());
    Some(CliError::command_execution(format!(
        "Daemon command failed: {err_msg}"
    )))
}

fn uncertain_on_response_failure(cmd: &DaemonCommand) -> bool {
    cmd.action == "exec"
        || cmd.action == "close-window"
        || (cmd.action == "tabs" && cmd.op.as_deref() == Some("close"))
}

impl DaemonClient {
    /// Create a new client pointing at the given port on localhost.
    pub fn new(port: u16) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("failed to build reqwest client");
        Self {
            base_url: format!("http://127.0.0.1:{port}"),
            client,
        }
    }

    /// Send a command to the daemon and return the result data.
    ///
    /// Retries up to 4 times with exponential backoff on transient failures.
    pub async fn send_command(&self, cmd: DaemonCommand) -> Result<Value, CliError> {
        let url = format!("{}/command", self.base_url);
        let mut last_err: Option<String> = None;

        for (attempt, &delay_ms) in RETRY_DELAYS_MS.iter().enumerate() {
            debug!(attempt = attempt + 1, action = %cmd.action, "sending daemon command");

            let result = self
                .client
                .post(&url)
                .header("X-AutoCLI", "1")
                .json(&cmd)
                .send()
                .await;

            match result {
                Ok(resp) => {
                    let status = resp.status();

                    if status.is_success() {
                        let daemon_result: DaemonResult = resp.json().await.map_err(|e| {
                            let message = format!("Failed to parse daemon response: {e}");
                            if uncertain_on_response_failure(&cmd) {
                                CliError::browser_outcome_unknown(format!(
                                    "Command outcome UNKNOWN: {message}"
                                ))
                            } else {
                                CliError::browser_connect(message)
                            }
                        })?;
                        if daemon_result.ok {
                            return Ok(daemon_result.data.unwrap_or(Value::Null));
                        } else {
                            let err_msg = daemon_result
                                .error
                                .unwrap_or_else(|| "Unknown daemon error".into());
                            return Err(CliError::command_execution(format!(
                                "Daemon command failed: {err_msg}"
                            )));
                        }
                    }

                    // 4xx errors are client/business errors — don't retry
                    if status.is_client_error() {
                        let body = resp.text().await.unwrap_or_default();
                        if status.as_u16() == 422 {
                            if let Some(error) = daemon_failure_from_unprocessable_entity(&body) {
                                return Err(error);
                            }
                        }
                        return Err(CliError::command_execution(format!(
                            "Command error (HTTP {status}): {body}"
                        )));
                    }

                    // 5xx / other errors — retryable
                    let body = resp.text().await.unwrap_or_default();
                    if uncertain_on_response_failure(&cmd) {
                        let message = format!(
                            "Command outcome UNKNOWN for action {} after HTTP {status}: {body}",
                            cmd.action
                        );
                        return Err(
                            if cmd.action == "exec"
                                && status == reqwest::StatusCode::GATEWAY_TIMEOUT
                            {
                                CliError::browser_execution_timeout(message)
                            } else {
                                CliError::browser_outcome_unknown(message)
                            },
                        );
                    }
                    last_err = Some(format!("HTTP {status}: {body}"));
                }
                Err(e) => {
                    if uncertain_on_response_failure(&cmd) && !e.is_connect() {
                        let message =
                            format!("Command outcome UNKNOWN for action {}: {e}", cmd.action);
                        return Err(if cmd.action == "exec" && e.is_timeout() {
                            CliError::browser_execution_timeout(message)
                        } else {
                            CliError::browser_outcome_unknown(message)
                        });
                    }
                    // Network error — retryable
                    last_err = Some(format!("Request error: {e}"));
                }
            }

            if attempt < RETRY_DELAYS_MS.len() - 1 {
                warn!(
                    attempt = attempt + 1,
                    error = last_err.as_deref().unwrap_or("unknown"),
                    "retrying daemon command"
                );
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            }
        }

        Err(CliError::browser_connect(format!(
            "Failed to send command after {} attempts: {}",
            RETRY_DELAYS_MS.len(),
            last_err.unwrap_or_else(|| "unknown error".into())
        )))
    }

    /// Check if something is listening on the daemon port.
    /// Tries our health endpoint first, then falls back to checking with X-AutoCLI header
    /// (needed for the original opencli daemon which requires it on all requests).
    pub async fn is_running(&self) -> bool {
        let url = format!("{}/health", self.base_url);
        // Try without header first (our daemon doesn't require it)
        if let Ok(resp) = self.client.get(&url).send().await {
            if resp.status().is_success() {
                return true;
            }
            // Got a response (even 403) means something is listening
            if resp.status().as_u16() == 403 {
                return true;
            }
        }
        false
    }

    /// Check if the Chrome extension is connected to the daemon.
    /// Compatible with both autocli (`extension` field) and original opencli (`extensionConnected` field).
    pub async fn is_extension_connected(&self) -> bool {
        let url = format!("{}/status", self.base_url);
        // Original OpenCLI requires X-AutoCLI header on all requests
        match self.client.get(&url).header("X-AutoCLI", "1").send().await {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(json) = resp.json::<Value>().await {
                    // Our format: {"extension": bool}
                    // Original format: {"extensionConnected": bool}
                    json.get("extension")
                        .or_else(|| json.get("extensionConnected"))
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                } else {
                    false
                }
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unknown_execution_and_close_are_not_replayed() {
        use axum::{http::StatusCode, routing::post, Router};
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };

        let requests = Arc::new(AtomicUsize::new(0));
        let received = requests.clone();
        let app = Router::new().route(
            "/command",
            post(move || {
                let received = received.clone();
                async move {
                    received.fetch_add(1, Ordering::SeqCst);
                    StatusCode::INTERNAL_SERVER_ERROR
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = DaemonClient::new(port);
        for command in [
            DaemonCommand::new("exec"),
            DaemonCommand::new("tabs").with_op("close"),
            DaemonCommand::new("close-window"),
        ] {
            assert!(matches!(
                client.send_command(command).await,
                Err(CliError::BrowserOutcomeUnknown { .. })
            ));
        }
        assert_eq!(requests.load(Ordering::SeqCst), 3);
        server.abort();
    }

    #[tokio::test]
    async fn execution_422_remains_a_command_error() {
        use axum::{http::StatusCode, routing::post, Router};

        let app = Router::new().route(
            "/command",
            post(|| async {
                (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    r#"{"id":"test","ok":false,"error":"script failed"}"#,
                )
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let error = DaemonClient::new(port)
            .send_command(DaemonCommand::new("exec"))
            .await
            .unwrap_err();
        assert!(matches!(error, CliError::CommandExecution { .. }));
        assert!(error.to_string().contains("script failed"));
        server.abort();
    }

    #[tokio::test]
    async fn daemon_504_is_execution_timeout_only_for_exec() {
        use axum::{http::StatusCode, routing::post, Router};
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };

        let count = Arc::new(AtomicUsize::new(0));
        let received = count.clone();
        let app = Router::new().route(
            "/command",
            post(move || {
                let received = received.clone();
                async move {
                    received.fetch_add(1, Ordering::SeqCst);
                    (
                        StatusCode::GATEWAY_TIMEOUT,
                        r#"{"error":"Command timed out"}"#,
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = DaemonClient::new(port);
        assert!(matches!(
            client.send_command(DaemonCommand::new("exec")).await,
            Err(CliError::BrowserExecutionTimeout { .. })
        ));
        assert!(matches!(
            client
                .send_command(DaemonCommand::new("tabs").with_op("close"))
                .await,
            Err(CliError::BrowserOutcomeUnknown { .. })
        ));
        assert_eq!(count.load(Ordering::SeqCst), 2);
        server.abort();
    }

    #[test]
    fn script_timeout_message_is_a_returned_command_error() {
        let error = daemon_failure_from_unprocessable_entity(
            r#"{"id":"test","ok":false,"error":"Error: Timeout waiting for selector: #missing"}"#,
        )
        .unwrap();
        assert!(matches!(error, CliError::CommandExecution { .. }));
    }

    #[test]
    fn test_daemon_client_construction() {
        let client = DaemonClient::new(19925);
        assert_eq!(client.base_url, "http://127.0.0.1:19925");
    }

    #[tokio::test]
    async fn test_is_running_when_no_server() {
        // Pick a port that's almost certainly not in use
        let client = DaemonClient::new(19999);
        assert!(!client.is_running().await);
    }

    #[tokio::test]
    async fn test_is_extension_connected_when_no_server() {
        let client = DaemonClient::new(19999);
        assert!(!client.is_extension_connected().await);
    }

    #[test]
    fn parses_structured_422_daemon_failure() {
        let error = daemon_failure_from_unprocessable_entity(
            r#"{"id":"request-1","ok":false,"error":"strict-background-stale-tab: tab 42 is no longer available"}"#,
        )
        .expect("structured daemon failure should parse");

        assert_eq!(
            error.to_string(),
            "[command] Daemon command failed: strict-background-stale-tab: tab 42 is no longer available"
        );
    }

    #[test]
    fn leaves_non_failure_or_non_daemon_422_bodies_for_generic_handling() {
        assert!(daemon_failure_from_unprocessable_entity("forbidden").is_none());
        assert!(daemon_failure_from_unprocessable_entity(
            r#"{"id":"request-1","ok":true,"data":{}}"#
        )
        .is_none());
    }
}
