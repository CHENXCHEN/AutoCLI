use autocli_core::{BrowserOptions, CliError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BrowserCarrier {
    AutomationWindow,
    TabGroupBackground,
}

impl Default for BrowserCarrier {
    fn default() -> Self {
        Self::AutomationWindow
    }
}

impl BrowserCarrier {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::AutomationWindow => "automation-window",
            Self::TabGroupBackground => "tab-group-background",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserConfig {
    pub carrier: BrowserCarrier,
    pub group_name: Option<String>,
    pub group_idle_timeout_seconds: Option<u64>,
}

impl Default for BrowserConfig {
    fn default() -> Self {
        Self {
            carrier: BrowserCarrier::AutomationWindow,
            group_name: None,
            group_idle_timeout_seconds: None,
        }
    }
}

pub fn load_browser_config() -> Result<BrowserConfig, CliError> {
    let file_json = read_default_config_file()?;
    let env_pairs = browser_env_pairs();
    resolve_browser_config(file_json.as_deref(), &env_pairs)
}

pub fn load_browser_config_with_options(
    options: Option<&BrowserOptions>,
) -> Result<BrowserConfig, CliError> {
    let file_json = read_default_config_file()?;
    let env_pairs = browser_env_pairs();
    resolve_browser_config_with_options(file_json.as_deref(), &env_pairs, options)
}

pub fn resolve_browser_config<K, V>(
    file_json: Option<&str>,
    env: &[(K, V)],
) -> Result<BrowserConfig, CliError>
where
    K: AsRef<str>,
    V: AsRef<str>,
{
    resolve_browser_config_with_options(file_json, env, None)
}

pub fn resolve_browser_config_with_options<K, V>(
    file_json: Option<&str>,
    env: &[(K, V)],
    options: Option<&BrowserOptions>,
) -> Result<BrowserConfig, CliError>
where
    K: AsRef<str>,
    V: AsRef<str>,
{
    let mut cfg = match file_json {
        Some(raw) if !raw.trim().is_empty() => parse_file_config(raw)?,
        _ => BrowserConfig::default(),
    };

    for (key, value) in env {
        apply_env_override(&mut cfg, key.as_ref(), value.as_ref())?;
    }

    if let Some(options) = options {
        apply_command_options(&mut cfg, options)?;
    }

    validate_browser_config(cfg)
}

fn parse_file_config(raw: &str) -> Result<BrowserConfig, CliError> {
    let root: Value = serde_json::from_str(raw).map_err(|e| {
        CliError::config(format!(
            "Invalid ~/.autocli/config.json browser config JSON: {e}"
        ))
    })?;
    let Some(browser) = root.get("browser") else {
        return Ok(BrowserConfig::default());
    };
    let Some(browser) = browser.as_object() else {
        return Err(CliError::config("browser config must be an object"));
    };

    let carrier = match browser.get("carrier").and_then(Value::as_str) {
        Some(value) => parse_carrier(value)?,
        None => BrowserCarrier::AutomationWindow,
    };
    let group_name = browser
        .get("groupName")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let group_idle_timeout_seconds = match browser.get("groupIdleTimeoutSeconds") {
        Some(Value::Number(n)) => Some(n.as_u64().filter(|value| *value > 0).ok_or_else(|| {
            CliError::config("browser group idle timeout must be a positive integer")
        })?),
        Some(Value::String(s)) => Some(parse_timeout(s)?),
        Some(_) => {
            return Err(CliError::config(
                "browser.groupIdleTimeoutSeconds must be a positive integer timeout",
            ));
        }
        None => None,
    };

    Ok(BrowserConfig {
        carrier,
        group_name,
        group_idle_timeout_seconds,
    })
}

fn apply_env_override(cfg: &mut BrowserConfig, key: &str, value: &str) -> Result<(), CliError> {
    match key {
        "AUTOCLI_BROWSER_CARRIER" => cfg.carrier = parse_carrier(value)?,
        "AUTOCLI_BROWSER_GROUP_NAME" => cfg.group_name = Some(value.to_string()),
        "AUTOCLI_BROWSER_GROUP_IDLE_TIMEOUT" => {
            cfg.group_idle_timeout_seconds = Some(parse_timeout(value)?);
        }
        _ => {}
    }
    Ok(())
}

fn apply_command_options(
    cfg: &mut BrowserConfig,
    options: &BrowserOptions,
) -> Result<(), CliError> {
    if let Some(carrier) = &options.carrier {
        cfg.carrier = parse_carrier(carrier)?;
    }
    if let Some(group_name) = &options.group_name {
        cfg.group_name = Some(group_name.clone());
    }
    if let Some(timeout) = options.group_idle_timeout_seconds {
        cfg.group_idle_timeout_seconds = Some(timeout);
    }
    Ok(())
}

fn validate_browser_config(mut cfg: BrowserConfig) -> Result<BrowserConfig, CliError> {
    if let Some(name) = cfg.group_name.take() {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            cfg.group_name = None;
        } else if trimmed.contains('\n') || trimmed.contains('\r') {
            return Err(CliError::config(
                "browser group name cannot contain newlines",
            ));
        } else {
            cfg.group_name = Some(trimmed.to_string());
        }
    }

    if cfg.carrier == BrowserCarrier::TabGroupBackground && cfg.group_name.is_none() {
        cfg.group_name = Some("default".to_string());
    }

    if cfg.group_idle_timeout_seconds == Some(0) {
        return Err(CliError::config(
            "browser group idle timeout must be a positive integer",
        ));
    }

    Ok(cfg)
}

fn parse_carrier(value: &str) -> Result<BrowserCarrier, CliError> {
    match value.trim() {
        "" | "automation-window" => Ok(BrowserCarrier::AutomationWindow),
        "tab-group-background" => Ok(BrowserCarrier::TabGroupBackground),
        other => Err(CliError::config(format!(
            "Unknown browser carrier '{other}'. Expected automation-window or tab-group-background"
        ))),
    }
}

fn parse_timeout(value: &str) -> Result<u64, CliError> {
    let parsed = value
        .trim()
        .parse::<u64>()
        .map_err(|_| CliError::config("browser group idle timeout must be a positive integer"))?;
    if parsed == 0 {
        return Err(CliError::config(
            "browser group idle timeout must be a positive integer",
        ));
    }
    Ok(parsed)
}

fn read_default_config_file() -> Result<Option<String>, CliError> {
    let home = match std::env::var("HOME") {
        Ok(home) => home,
        Err(_) => return Ok(None),
    };
    let path = Path::new(&home).join(".autocli").join("config.json");
    match std::fs::read_to_string(path) {
        Ok(raw) => Ok(Some(raw)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(CliError::config(format!(
            "Failed to read ~/.autocli/config.json: {e}"
        ))),
    }
}

fn browser_env_pairs() -> Vec<(String, String)> {
    [
        "AUTOCLI_BROWSER_CARRIER",
        "AUTOCLI_BROWSER_GROUP_NAME",
        "AUTOCLI_BROWSER_GROUP_IDLE_TIMEOUT",
    ]
    .iter()
    .filter_map(|key| {
        std::env::var(key)
            .ok()
            .map(|value| ((*key).to_string(), value))
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolve(file_json: Option<&str>, env: &[(&str, &str)]) -> Result<BrowserConfig, CliError> {
        resolve_browser_config(file_json, env)
    }

    fn resolve_with_options(
        file_json: Option<&str>,
        env: &[(&str, &str)],
        options: Option<&BrowserOptions>,
    ) -> Result<BrowserConfig, CliError> {
        resolve_browser_config_with_options(file_json, env, options)
    }

    #[test]
    fn defaults_to_automation_window_when_config_is_absent() {
        let cfg = resolve(None, &[]).unwrap();
        assert_eq!(cfg.carrier, BrowserCarrier::AutomationWindow);
        assert_eq!(cfg.group_name, None);
        assert_eq!(cfg.group_idle_timeout_seconds, None);
    }

    #[test]
    fn reads_browser_group_config_from_existing_config_file() {
        let cfg = resolve(
            Some(
                r#"{
  "llm": { "provider": "openai" },
  "browser": {
    "carrier": "tab-group-background",
    "groupName": "work",
    "groupIdleTimeoutSeconds": 45
  }
}"#,
            ),
            &[],
        )
        .unwrap();

        assert_eq!(cfg.carrier, BrowserCarrier::TabGroupBackground);
        assert_eq!(cfg.group_name.as_deref(), Some("work"));
        assert_eq!(cfg.group_idle_timeout_seconds, Some(45));
    }

    #[test]
    fn env_overrides_file_config() {
        let cfg = resolve(
            Some(
                r#"{
  "browser": {
    "carrier": "automation-window",
    "groupName": "file",
    "groupIdleTimeoutSeconds": 10
  }
}"#,
            ),
            &[
                ("AUTOCLI_BROWSER_CARRIER", "tab-group-background"),
                ("AUTOCLI_BROWSER_GROUP_NAME", "env"),
                ("AUTOCLI_BROWSER_GROUP_IDLE_TIMEOUT", "20"),
            ],
        )
        .unwrap();

        assert_eq!(cfg.carrier, BrowserCarrier::TabGroupBackground);
        assert_eq!(cfg.group_name.as_deref(), Some("env"));
        assert_eq!(cfg.group_idle_timeout_seconds, Some(20));
    }

    #[test]
    fn command_options_override_env_and_file_config() {
        let options = BrowserOptions {
            carrier: Some("tab-group-background".to_string()),
            group_name: Some("adapter".to_string()),
            group_idle_timeout_seconds: Some(30),
        };
        let cfg = resolve_with_options(
            Some(
                r#"{
  "browser": {
    "carrier": "automation-window",
    "groupName": "file",
    "groupIdleTimeoutSeconds": 10
  }
}"#,
            ),
            &[
                ("AUTOCLI_BROWSER_CARRIER", "automation-window"),
                ("AUTOCLI_BROWSER_GROUP_NAME", "env"),
                ("AUTOCLI_BROWSER_GROUP_IDLE_TIMEOUT", "20"),
            ],
            Some(&options),
        )
        .unwrap();

        assert_eq!(cfg.carrier, BrowserCarrier::TabGroupBackground);
        assert_eq!(cfg.group_name.as_deref(), Some("adapter"));
        assert_eq!(cfg.group_idle_timeout_seconds, Some(30));
    }

    #[test]
    fn tab_group_mode_defaults_missing_command_group_name() {
        let options = BrowserOptions {
            carrier: Some("tab-group-background".to_string()),
            group_name: None,
            group_idle_timeout_seconds: None,
        };
        let cfg = resolve_with_options(None, &[], Some(&options)).unwrap();

        assert_eq!(cfg.carrier, BrowserCarrier::TabGroupBackground);
        assert_eq!(cfg.group_name.as_deref(), Some("default"));
    }

    #[test]
    fn tab_group_mode_defaults_empty_group_name() {
        let cfg = resolve(
            Some(r#"{ "browser": { "carrier": "tab-group-background", "groupName": " " } }"#),
            &[],
        )
        .unwrap();

        assert_eq!(cfg.carrier, BrowserCarrier::TabGroupBackground);
        assert_eq!(cfg.group_name.as_deref(), Some("default"));
    }

    #[test]
    fn tab_group_mode_defaults_missing_file_group_name() {
        let cfg = resolve(
            Some(r#"{ "browser": { "carrier": "tab-group-background" } }"#),
            &[],
        )
        .unwrap();

        assert_eq!(cfg.carrier, BrowserCarrier::TabGroupBackground);
        assert_eq!(cfg.group_name.as_deref(), Some("default"));
    }

    #[test]
    fn rejects_unknown_carrier_without_fallback() {
        let err = resolve(
            Some(r#"{ "browser": { "carrier": "hidden-window" } }"#),
            &[],
        )
        .unwrap_err();

        assert_eq!(err.code(), "CONFIG");
        assert!(err.to_string().contains("carrier"));
    }

    #[test]
    fn rejects_invalid_idle_timeout_without_fallback() {
        let err = resolve(
            None,
            &[
                ("AUTOCLI_BROWSER_CARRIER", "tab-group-background"),
                ("AUTOCLI_BROWSER_GROUP_NAME", "work"),
                ("AUTOCLI_BROWSER_GROUP_IDLE_TIMEOUT", "0"),
            ],
        )
        .unwrap_err();

        assert_eq!(err.code(), "CONFIG");
        assert!(err.to_string().contains("timeout"));
    }

    #[test]
    fn rejects_non_positive_numeric_idle_timeout_without_fallback() {
        let err = resolve(
            Some(
                r#"{ "browser": { "carrier": "tab-group-background", "groupName": "work", "groupIdleTimeoutSeconds": -1 } }"#,
            ),
            &[],
        )
        .unwrap_err();

        assert_eq!(err.code(), "CONFIG");
        assert!(err.to_string().contains("timeout"));
    }
}
