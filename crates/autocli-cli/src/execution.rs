use autocli_browser::BrowserBridge;
use autocli_core::{CliCommand, CliError, IPage};
use autocli_pipeline::{execute_pipeline, steps::register_all_steps, StepRegistry};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

/// Get daemon port from env or default
fn daemon_port() -> u16 {
    std::env::var("AUTOCLI_DAEMON_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(19925)
}

/// Get command timeout from env or command config or default (60s)
fn command_timeout(cmd: &CliCommand) -> u64 {
    std::env::var("AUTOCLI_BROWSER_COMMAND_TIMEOUT")
        .ok()
        .and_then(|s| s.parse().ok())
        .or(cmd.timeout_seconds)
        .unwrap_or(60)
}

pub async fn execute_command(
    cmd: &CliCommand,
    kwargs: HashMap<String, Value>,
) -> Result<Value, CliError> {
    tracing::info!(site = %cmd.site, name = %cmd.name, "Executing command");

    let timeout_secs = command_timeout(cmd);

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        execute_command_inner(cmd, kwargs),
    )
    .await;

    match result {
        Ok(inner) => inner,
        Err(_) => Err(command_timeout_error(cmd, timeout_secs)),
    }
}

fn command_timeout_error(cmd: &CliCommand, timeout_secs: u64) -> CliError {
    // The outer deadline may be shorter than the runner's own deadline. Once
    // the child is cancelled we cannot know whether a permitted POST was sent.
    let may_submit = cmd.pipeline.as_ref().is_some_and(|steps| {
        steps.iter().any(|step| {
            step.get("cookie_http")
                .and_then(|policy| policy.get("allowed_requests"))
                .and_then(Value::as_array)
                .is_some_and(|rules| {
                    rules.iter().any(|rule| {
                        rule.get("method")
                            .and_then(Value::as_str)
                            .is_some_and(|method| !matches!(method, "GET" | "HEAD"))
                    })
                })
        })
    });
    let uncertainty = if may_submit {
        "; submission outcome UNKNOWN; inspect target state before retrying"
    } else {
        ""
    };
    CliError::timeout(format!(
        "Command '{}' timed out after {}s{}",
        cmd.full_name(),
        timeout_secs,
        uncertainty
    ))
}

async fn execute_command_inner(
    cmd: &CliCommand,
    kwargs: HashMap<String, Value>,
) -> Result<Value, CliError> {
    // Build step registry
    let mut registry = StepRegistry::new();
    register_all_steps(&mut registry);

    if cmd.needs_browser() {
        // Browser session
        let mut bridge =
            BrowserBridge::new(daemon_port()).with_browser_options(cmd.browser_options.clone());
        let page = bridge.connect().await?;

        // Pre-navigate to domain if set, but ONLY if the pipeline doesn't
        // start with its own navigate step (to avoid double navigation).
        let pipeline_starts_with_navigate = cmd
            .pipeline
            .as_ref()
            .and_then(|steps| steps.first())
            .and_then(|step| step.as_object())
            .map_or(false, |obj| obj.contains_key("navigate"));

        if !pipeline_starts_with_navigate {
            if let Some(domain) = &cmd.domain {
                let url = format!("https://{}", domain);
                tracing::debug!(url = %url, "Pre-navigating to domain");
                page.goto(&url, None).await?;
            }
        }

        // Execute
        let result = if let Some(ref steps) = cmd.pipeline {
            execute_pipeline(Some(page.clone()), steps, &kwargs, &registry).await
        } else if cmd.func.is_some() {
            run_command(cmd, Some(page.clone()), &kwargs, &registry).await
        } else {
            Err(CliError::command_execution(format!(
                "Command '{}' has no pipeline or func",
                cmd.full_name()
            )))
        };

        // Close the automation tab/window after command completes
        let _ = page.close().await;

        result
    } else {
        run_command(cmd, None, &kwargs, &registry).await
    }
}

async fn run_command(
    cmd: &CliCommand,
    page: Option<Arc<dyn IPage>>,
    kwargs: &HashMap<String, Value>,
    registry: &StepRegistry,
) -> Result<Value, CliError> {
    if let Some(pipeline) = &cmd.pipeline {
        execute_pipeline(page, pipeline, kwargs, registry).await
    } else if let Some(func) = &cmd.func {
        func(page, kwargs.clone()).await
    } else {
        Err(CliError::command_execution(format!(
            "Command '{}' has no pipeline or func",
            cmd.full_name()
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_http_outer_deadline_preserves_submission_uncertainty() {
        for (method, unknown) in [("GET", false), ("POST", true)] {
            let cmd = CliCommand {
                site: "fixture".into(),
                name: "request".into(),
                description: String::new(),
                domain: None,
                strategy: autocli_core::Strategy::Cookie,
                browser: false,
                browser_options: None,
                args: vec![],
                columns: vec![],
                pipeline: Some(vec![serde_json::json!({"cookie_http": {
                    "allowed_requests": [{"method": method, "path": "^/api/items$"}]
                }})]),
                func: None,
                timeout_seconds: Some(1),
                navigate_before: Default::default(),
            };
            let message = command_timeout_error(&cmd, 1).to_string();
            assert_eq!(message.contains("UNKNOWN"), unknown);
            assert_eq!(message.contains("inspect target state"), unknown);
        }
    }
}
