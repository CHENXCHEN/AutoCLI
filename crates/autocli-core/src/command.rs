use crate::{ArgDef, CliError, IPage, Strategy};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

pub type CommandArgs = HashMap<String, Value>;

pub type AdapterFunc = Arc<
    dyn Fn(
            Option<Arc<dyn IPage>>,
            CommandArgs,
        ) -> Pin<Box<dyn Future<Output = Result<Value, CliError>> + Send>>
        + Send
        + Sync,
>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum NavigateBefore {
    Bool(bool),
    Url(String),
}

impl Default for NavigateBefore {
    fn default() -> Self {
        Self::Bool(true)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserOptions {
    pub carrier: Option<String>,
    pub group_name: Option<String>,
    pub group_idle_timeout_seconds: Option<u64>,
}

#[derive(Clone)]
pub struct CliCommand {
    pub site: String,
    pub name: String,
    pub description: String,
    pub domain: Option<String>,
    pub strategy: Strategy,
    pub browser: bool,
    pub browser_options: Option<BrowserOptions>,
    pub args: Vec<ArgDef>,
    pub columns: Vec<String>,
    pub pipeline: Option<Vec<Value>>,
    pub func: Option<AdapterFunc>,
    pub timeout_seconds: Option<u64>,
    pub navigate_before: NavigateBefore,
}

impl CliCommand {
    pub fn full_name(&self) -> String {
        format!("{} {}", self.site, self.name)
    }

    pub fn needs_browser(&self) -> bool {
        // Cookie HTTP commands use the extension only as a scoped cookie source.
        // Opt in narrowly so existing cookie/evaluate commands keep their page.
        if !self.browser
            && self.strategy == Strategy::Cookie
            && self.pipeline.as_ref().is_some_and(|pipeline| {
                pipeline.len() == 1
                    && pipeline[0]
                        .as_object()
                        .is_some_and(|step| step.len() == 1 && step.contains_key("cookie_http"))
            })
        {
            return false;
        }
        if self.browser || self.strategy.requires_browser() {
            return true;
        }
        // Check if pipeline contains browser steps
        if let Some(ref pipeline) = self.pipeline {
            const BROWSER_STEPS: &[&str] = &[
                "navigate",
                "click",
                "type",
                "wait",
                "press",
                "evaluate",
                "snapshot",
                "screenshot",
                "intercept",
                "tap",
            ];
            for step in pipeline {
                if let Some(obj) = step.as_object() {
                    for key in obj.keys() {
                        if BROWSER_STEPS.contains(&key.as_str()) {
                            return true;
                        }
                    }
                }
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn command(strategy: Strategy, browser: bool, pipeline: Vec<Value>) -> CliCommand {
        CliCommand {
            site: "fixture".into(),
            name: "read".into(),
            description: String::new(),
            domain: Some("example.com".into()),
            strategy,
            browser,
            browser_options: None,
            args: vec![],
            columns: vec![],
            pipeline: Some(pipeline),
            func: None,
            timeout_seconds: None,
            navigate_before: NavigateBefore::default(),
        }
    }

    #[test]
    fn cookie_http_explicitly_avoids_a_browser_page() {
        assert!(!command(
            Strategy::Cookie,
            false,
            vec![json!({"cookie_http": {"evaluate": "[]"}})],
        )
        .needs_browser());
    }

    #[test]
    fn existing_cookie_and_browser_commands_still_need_a_page() {
        assert!(command(Strategy::Cookie, false, vec![json!({"evaluate": "[]"})]).needs_browser());
        assert!(command(Strategy::Cookie, false, vec![]).needs_browser());
        assert!(command(Strategy::Cookie, true, vec![json!({"cookie_http": {}})],).needs_browser());
        assert!(
            command(Strategy::Header, false, vec![json!({"cookie_http": {}})],).needs_browser()
        );
    }

    #[test]
    fn mixed_or_malformed_cookie_http_pipelines_cannot_skip_the_page() {
        for pipeline in [
            vec![json!({"cookie_http": {}}), json!({"evaluate": "[]"})],
            vec![json!({"cookie_http": {}, "evaluate": "[]"})],
            vec![json!("cookie_http")],
        ] {
            assert!(command(Strategy::Cookie, false, pipeline).needs_browser());
        }
        assert!(command(Strategy::Public, false, vec![json!({"evaluate": "[]"})]).needs_browser());
        assert!(!command(
            Strategy::Public,
            false,
            vec![json!({"fetch": "https://example.com"})]
        )
        .needs_browser());
    }
}

impl std::fmt::Debug for CliCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CliCommand")
            .field("site", &self.site)
            .field("name", &self.name)
            .field("strategy", &self.strategy)
            .field("browser", &self.browser)
            .field("has_func", &self.func.is_some())
            .field("has_pipeline", &self.pipeline.is_some())
            .finish()
    }
}
