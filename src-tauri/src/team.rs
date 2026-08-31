//! Minimal Cloudflare Access / Managed OAuth integration for the team edition.
//!
//! Deployment-specific values live in `resources/team-config.json`. No upstream
//! subscription URL is ever accepted from the UI or persisted in profiles.yaml.

use crate::{
    config::{Config, PrfExtra, PrfItem, PrfOption, decrypt_data, encrypt_data, profiles},
    core::{CoreManager, handle},
    process::AsyncHandler,
    utils::{
        dirs,
        network::{NetworkManager, ProxyType},
    },
};
use anyhow::{Context as _, Result, bail};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use clash_verge_logging::{Type, logging};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_yaml_ng::Mapping;
use sha2::{Digest as _, Sha256};
use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::Write as _,
    path::{Path, PathBuf},
    process::Stdio,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt as _, AsyncWriteExt as _},
    net::TcpListener,
    process::Command,
};

pub const MANAGED_PROFILE_UID: &str = "RTEAMMANAGED";
const SESSION_FILE: &str = "team-session.enc";
const DEVICE_ID_FILE: &str = "team-device-id";
const TAILSCALE_KEY_PATH: &str = "/v1/desktop/tailscale/key";
const TAILSCALE_RECONCILE_PATH: &str = "/v1/desktop/tailscale/reconcile";
const TAILSCALE_VALIDATE_PATH: &str = "/v1/desktop/tailscale/validate";
const TAILSCALE_LOGOUT_PATH: &str = "/v1/desktop/tailscale/logout";
const TAILSCALE_KEY_EXPIRY_SECONDS: u64 = 7 * 24 * 60 * 60;
/// Tailscale CLI calls normally complete in a few hundred milliseconds. A
/// stopped or wedged daemon can otherwise leave the UI waiting indefinitely.
const TAILSCALE_CLI_TIMEOUT: Duration = Duration::from_secs(5);
const TAILSCALE_UP_TIMEOUT: Duration = Duration::from_secs(45);
const TAILSCALE_RECONCILE_TIMEOUT: Duration = Duration::from_secs(5);
const TAILSCALE_VALIDATE_TIMEOUT: Duration = Duration::from_secs(3);
/// Refresh the server-side device record often enough for a remote role/tag
/// change to become visible, while keeping ordinary status reads local.
const TAILSCALE_RECONCILE_INTERVAL_SECONDS: u64 = 15;
const TAILSCALE_RELEASES_URL: &str = "https://api.github.com/repos/tailscale/tailscale/releases/latest";
const TAILSCALE_RELEASES_PAGE_URL: &str = "https://github.com/tailscale/tailscale/releases/latest";
const CLOUDFLARE_RELEASES_URL: &str = "https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/download/index.md";
// Team requests run through an Access-protected Worker, so a cold isolate or
// a transient edge connection should not leave the desktop command hanging
// indefinitely. Keep the retry window short enough for the UI while allowing
// the Worker a moment to become ready.
const TEAM_HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const TEAM_HTTP_TIMEOUT: Duration = Duration::from_secs(20);
const TEAM_HTTP_RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(250), Duration::from_secs(1)];
static TEAM_HTTP_CLIENT: once_cell::sync::Lazy<reqwest::Client> = once_cell::sync::Lazy::new(|| {
    reqwest::Client::builder()
        .connect_timeout(TEAM_HTTP_CONNECT_TIMEOUT)
        .timeout(TEAM_HTTP_TIMEOUT)
        .pool_idle_timeout(Duration::from_secs(30))
        .user_agent("clash-verge-team")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
});
// Managed OAuth may rotate refresh tokens. Serialize the refresh path and
// reload the session after waiting so concurrent account/status calls cannot
// redeem the same token or overwrite a newer token on disk.
static SESSION_REFRESH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
// Keep session writes serialized and replace the encrypted blob atomically.
// Background account/profile updates otherwise can overlap on Windows, where
// a reader may observe a partially truncated file during `fs::write`.
static SESSION_WRITE_LOCK: Mutex<()> = Mutex::new(());
static BACKGROUND_STARTED: AtomicBool = AtomicBool::new(false);
/// Country code observed immediately before WARP is connected. This is the
/// route supplied by Clash TUN in the documented verification flow.
static CLASH_TUN_LOCATION: once_cell::sync::Lazy<Mutex<Option<String>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));
/// Country observed through a direct request before WARP is connected. This
/// is kept separately from the Clash TUN baseline so the UI can accept either
/// a matching proxy node or a matching local network as a valid route.
static LOCAL_NETWORK_LOCATION: once_cell::sync::Lazy<Mutex<Option<String>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));
/// Last explicit `tailscale netcheck` result requested by the UI. The probe
/// takes several seconds, so it runs on demand only and is cached here; the
/// periodic status path re-serves this value instead of probing again.
static NETCHECK_CACHE: once_cell::sync::Lazy<Mutex<Option<(u64, TailscaleNetcheck)>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));
static TAILSCALE_UPDATE_CACHE: once_cell::sync::Lazy<Mutex<Option<ClientUpdateStatus>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));
/// Avoid duplicate Worker reconciles when a foreground refresh overlaps with
/// the background status path.
static TAILSCALE_RECONCILE_IN_FLIGHT: AtomicBool = AtomicBool::new(false);
static CLOUDFLARE_UPDATE_CACHE: once_cell::sync::Lazy<Mutex<Option<ClientUpdateStatus>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

#[derive(Debug, Clone, Deserialize)]
pub struct TeamConfig {
    #[serde(default)]
    pub enabled: bool,
    pub api_base_url: String,
    #[serde(default)]
    pub oauth_client_id: String,
    #[serde(default = "default_scopes")]
    pub oauth_scopes: Vec<String>,
    #[serde(default)]
    pub oauth_resource: String,
    #[serde(default = "default_account_path")]
    pub account_path: String,
    #[serde(default = "default_profile_path")]
    pub profile_path: String,
    #[serde(default = "default_profile_name")]
    pub managed_profile_name: String,
    #[serde(default = "default_true")]
    pub auto_activate: bool,
    #[serde(default = "default_sync_interval")]
    pub sync_interval_minutes: u64,
}

const fn default_scopes() -> Vec<String> {
    Vec::new()
}
fn default_account_path() -> String {
    "/v1/desktop/account".into()
}
fn default_profile_path() -> String {
    "/v1/desktop/profile".into()
}
fn default_profile_name() -> String {
    "Team Managed Profile".into()
}
const fn default_sync_interval() -> u64 {
    360
}
const fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct TeamSession {
    access_token: String,
    refresh_token: Option<String>,
    token_type: String,
    expires_at: u64,
    client_id: String,
    token_endpoint: String,
    resource: String,
    etag: Option<String>,
    account: Option<TeamAccount>,
    last_sync_at: Option<u64>,
    #[serde(default)]
    tailscale: Option<TailscaleInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamQuota {
    pub upload: u64,
    pub download: u64,
    pub total: u64,
    pub expire: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamAccount {
    pub user_id: Option<String>,
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub team: Option<String>,
    #[serde(default)]
    pub enabled: bool,
    pub quota: Option<TeamQuota>,
    pub devices_online: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamStatus {
    pub configured: bool,
    pub authenticated: bool,
    pub account: Option<TeamAccount>,
    pub last_sync_at: Option<u64>,
    pub managed_profile_installed: bool,
    pub managed_profile_active: bool,
    pub tailscale: TailscaleStatus,
    pub cloudflare_one: CloudflareOneStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleInfo {
    pub node_id: Option<String>,
    pub key_issued_at: Option<u64>,
    pub key_expires_at: Option<u64>,
    pub role: Option<String>,
    pub tag: Option<String>,
    #[serde(default)]
    pub last_reconciled_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClientUpdateStatus {
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub checked_at: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleProfile {
    pub id: String,
    pub name: String,
    pub account_name: Option<String>,
    pub active: bool,
    pub tailnet: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleStatus {
    pub installed: bool,
    /// Whether the local Tailscale service/daemon is available to the CLI.
    /// This is intentionally separate from `installed`: the executable can
    /// exist while tailscaled/the Windows service is stopped.
    pub running: bool,
    pub version: Option<String>,
    pub logged_in: bool,
    pub device_name: Option<String>,
    pub ipv4: Option<String>,
    pub online: bool,
    pub node_id: Option<String>,
    pub addresses: Vec<String>,
    pub key_issued_at: Option<u64>,
    pub key_expires_at: Option<u64>,
    pub role: Option<String>,
    pub tag: Option<String>,
    pub profiles: Vec<TailscaleProfile>,
    pub update: ClientUpdateStatus,
    pub netcheck: Option<TailscaleNetcheck>,
    pub netcheck_at: Option<u64>,
}

/// Selected, presentation-friendly values returned by `tailscale netcheck`.
///
/// Tailscale has emitted both booleans and descriptive strings for the IPv4,
/// IPv6 and port-mapping fields across CLI versions, so those values remain
/// JSON scalars instead of being forced into a lossy Rust type.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleNetcheck {
    pub udp: Option<bool>,
    pub ipv4: Option<serde_json::Value>,
    pub ipv6: Option<serde_json::Value>,
    pub mapping_varies_by_dest_ip: Option<bool>,
    pub port_mapping: Option<serde_json::Value>,
    pub hair_pinning: Option<serde_json::Value>,
    pub captive_portal: Option<bool>,
    pub nearest_derp: Option<String>,
    pub derp_latency: HashMap<String, f64>,
    pub global_v6: Option<serde_json::Value>,
    pub available: bool,
    pub error: Option<String>,
}

/// Locally observed state of the Cloudflare One Client (WARP).
///
/// The desktop client does not expose a stable cross-platform API. The
/// `warp-cli` output is therefore treated as best-effort input: absence of the
/// executable is represented by `installed = false`, while a failed trace
/// request is retained in `error` without making the team status command fail.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CloudflareOneStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub running: bool,
    pub connected: bool,
    pub mode: Option<String>,
    pub account_type: Option<String>,
    pub exit_ip: Option<String>,
    pub exit_country: Option<String>,
    pub exit_region: Option<String>,
    pub exit_city: Option<String>,
    pub exit_colo: Option<String>,
    pub warp_enabled: Option<bool>,
    pub clash_tun_location: Option<String>,
    pub location_match: Option<bool>,
    pub local_network_location: Option<String>,
    pub local_location_match: Option<bool>,
    pub last_checked_at: u64,
    pub error: Option<String>,
    pub update: ClientUpdateStatus,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TailscaleKeyResponse {
    #[serde(alias = "auth_key", alias = "authKey")]
    key: String,
    #[serde(default, alias = "issued_at", alias = "issuedAt")]
    issued_at: Option<u64>,
    #[serde(default, alias = "expires_at", alias = "expiresAt")]
    expires_at: Option<u64>,
    role: Option<String>,
    tag: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TailscaleReconcileResponse {
    role: Option<String>,
    tag: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TailscaleValidateResponse {
    valid: bool,
}

#[derive(Debug, Deserialize)]
struct TailscaleStatusJson {
    #[serde(rename = "BackendState")]
    backend_state: Option<String>,
    #[serde(rename = "Self")]
    self_node: Option<TailscaleNode>,
}

fn deserialize_node_id<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct NodeIdVisitor;

    impl<'de> serde::de::Visitor<'de> for NodeIdVisitor {
        type Value = Option<String>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("a string, integer, or null")
        }

        fn visit_str<E>(self, v: &str) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            let trimmed = v.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(trimmed.to_string()))
            }
        }

        fn visit_string<E>(self, v: String) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            self.visit_str(&v)
        }

        fn visit_i64<E>(self, v: i64) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(Some(v.to_string()))
        }

        fn visit_u64<E>(self, v: u64) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(Some(v.to_string()))
        }

        fn visit_none<E>(self) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(None)
        }

        fn visit_unit<E>(self) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(None)
        }

        fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
        where
            D: serde::Deserializer<'de>,
        {
            deserializer.deserialize_any(Self)
        }
    }

    deserializer.deserialize_option(NodeIdVisitor)
}

#[derive(Debug, Deserialize)]
struct TailscaleNode {
    #[serde(rename = "ID", default, deserialize_with = "deserialize_node_id")]
    id: Option<String>,
    #[serde(rename = "HostName")]
    hostname: Option<String>,
    #[serde(rename = "DNSName")]
    dns_name: Option<String>,
    #[serde(rename = "TailscaleIPs", default)]
    ips: Vec<String>,
    #[serde(rename = "Online")]
    online: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct OAuthMetadata {
    authorization_endpoint: String,
    token_endpoint: String,
    registration_endpoint: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ClientRegistration {
    client_id: String,
}

#[derive(Debug, Deserialize)]
struct OAuthTokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default = "default_token_type")]
    token_type: String,
    #[serde(default = "default_expires_in")]
    expires_in: u64,
}

fn default_token_type() -> String {
    "Bearer".into()
}
const fn default_expires_in() -> u64 {
    900
}

// Stable per-install device id (not secret): survives logout, and feeds the
// worker's online-device counter via the x-team-device header.
fn device_id() -> Result<String> {
    let path = dirs::app_home_dir()?.join(DEVICE_ID_FILE);
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.into());
        }
    }
    let id = random_urlsafe(24)?;
    std::fs::write(&path, &id)?;
    Ok(id)
}

pub fn is_managed_profile_uid(uid: &str) -> bool {
    uid == MANAGED_PROFILE_UID
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn config_path() -> Result<PathBuf> {
    Ok(dirs::app_resources_dir()?.join("team-config.json"))
}

pub fn load_config() -> Result<TeamConfig> {
    let path = config_path()?;
    let text = std::fs::read_to_string(&path).with_context(|| format!("team config not found: {}", path.display()))?;
    let config: TeamConfig = serde_json::from_str(&text).context("invalid team-config.json")?;
    if config.enabled && config.api_base_url.trim().is_empty() {
        bail!("team-config.json: api_base_url is required when enabled")
    }
    Ok(config)
}

fn session_path() -> Result<PathBuf> {
    Ok(dirs::app_home_dir()?.join(SESSION_FILE))
}

fn load_session() -> Result<Option<TeamSession>> {
    let path = session_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let encrypted = std::fs::read_to_string(path)?;
    let plain = decrypt_data(&encrypted).map_err(|error| anyhow::anyhow!(error.to_string()))?;
    Ok(Some(serde_json::from_str(&plain)?))
}

fn clear_session() -> Result<()> {
    let path = session_path()?;
    let _write_guard = SESSION_WRITE_LOCK.lock();
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

fn save_session(session: &TeamSession) -> Result<()> {
    let path = session_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let encrypted =
        encrypt_data(&serde_json::to_string(session)?).map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let _write_guard = SESSION_WRITE_LOCK.lock();
    let temporary = path.with_extension(format!("tmp-{}", random_urlsafe(8)?));
    std::fs::write(&temporary, encrypted)?;
    if let Err(error) = crate::utils::server::replace_file_atomic(&temporary, &path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error).with_context(|| format!("failed to replace team session: {}", path.display()));
    }
    Ok(())
}

const fn tailscale_program() -> &'static str {
    if cfg!(windows) { "tailscale.exe" } else { "tailscale" }
}

fn tailscale_command() -> Command {
    let mut command = Command::new(tailscale_program());
    command.kill_on_drop(true);
    // CREATE_NO_WINDOW: spawning the console-subsystem tailscale CLI from the
    // GUI app would otherwise flash a console window on every status poll.
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}

async fn tailscale_output(args: &[&str]) -> Result<std::process::Output> {
    tokio::time::timeout(
        TAILSCALE_CLI_TIMEOUT,
        tailscale_command().args(args).stdin(Stdio::null()).output(),
    )
    .await
    .with_context(|| format!("{} command timed out", tailscale_program()))?
    .with_context(|| format!("{} is not installed or is unavailable", tailscale_program()))
}

fn tailscale_service_command() -> Command {
    #[cfg(windows)]
    {
        let mut command = Command::new("sc.exe");
        command.args(["start", "Tailscale"]);
        command.creation_flags(0x08000000);
        command
    }
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        command.args(["-a", "Tailscale"]);
        command
    }
    #[cfg(target_os = "linux")]
    {
        let mut command = Command::new("systemctl");
        command.args(["start", "tailscaled"]);
        command
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        Command::new(tailscale_program())
    }
}

async fn start_tailscale_service() -> Result<()> {
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    bail!("starting the Tailscale service is not supported on this platform");

    let output = tailscale_service_command()
        .stdin(Stdio::null())
        .output()
        .await
        .context("failed to start the Tailscale service")?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr);
    let detail = detail.trim();
    if detail.is_empty() {
        bail!("failed to start the Tailscale service (exit status {})", output.status);
    }
    let detail: String = detail.chars().take(300).collect();
    bail!("failed to start the Tailscale service: {detail}");
}

fn cloudflare_service_command(service_name: &str) -> Command {
    #[cfg(windows)]
    {
        let mut command = Command::new("sc.exe");
        command.args(["start", service_name]);
        command.creation_flags(0x08000000);
        command
    }
    #[cfg(target_os = "macos")]
    {
        let _ = service_name;
        let mut command = Command::new("open");
        command.args(["-a", "Cloudflare WARP"]);
        command
    }
    #[cfg(target_os = "linux")]
    {
        let mut command = Command::new("systemctl");
        command.args(["start", service_name]);
        command
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = service_name;
        Command::new("warp-cli")
    }
}

async fn start_cloudflare_service() -> Result<()> {
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    bail!("starting the Cloudflare One Client service is not supported on this platform");

    #[cfg(windows)]
    let service_names = ["CloudflareWARP", "Cloudflare WARP", "warp-svc"];
    #[cfg(target_os = "macos")]
    let service_names = ["Cloudflare WARP"];
    #[cfg(target_os = "linux")]
    let service_names = ["warp-svc"];
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    let service_names = ["warp-svc"];

    let mut last_detail = None;
    for service_name in service_names {
        let output = cloudflare_service_command(service_name)
            .stdin(Stdio::null())
            .output()
            .await
            .with_context(|| "failed to start the Cloudflare One Client service")?;
        if output.status.success() {
            return Ok(());
        }
        let detail = String::from_utf8_lossy(&output.stderr);
        let detail = detail.trim();
        if !detail.is_empty() {
            last_detail = Some(detail.chars().take(300).collect::<String>());
        }
    }

    if let Some(detail) = last_detail {
        bail!("failed to start the Cloudflare One Client service: {detail}");
    }
    bail!("failed to start the Cloudflare One Client service")
}

fn normalized_netcheck_key(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .map(|character| character.to_ascii_lowercase())
        .collect()
}

fn netcheck_json_field(root: &serde_json::Value, names: &[&str]) -> Option<serde_json::Value> {
    let names: Vec<String> = names.iter().map(|name| normalized_netcheck_key(name)).collect();
    let report = root.as_object().and_then(|object| {
        object
            .iter()
            .find(|(key, _)| normalized_netcheck_key(key) == "report")
            .map(|(_, value)| value)
    });
    for container in [Some(root), report].into_iter().flatten() {
        let Some(object) = container.as_object() else {
            continue;
        };
        if let Some((_, value)) = object
            .iter()
            .find(|(key, _)| names.contains(&normalized_netcheck_key(key)))
        {
            return (!value.is_null()).then(|| value.clone());
        }
    }
    None
}

fn json_bool(value: Option<serde_json::Value>) -> Option<bool> {
    match value? {
        serde_json::Value::Bool(value) => Some(value),
        serde_json::Value::String(value) => match value.trim().to_ascii_lowercase().as_str() {
            "true" | "yes" | "up" => Some(true),
            "false" | "no" | "down" => Some(false),
            _ => None,
        },
        serde_json::Value::Number(value) => value.as_i64().map(|value| value != 0),
        _ => None,
    }
}

fn scalar_from_netcheck_text(value: &str) -> serde_json::Value {
    let value = value.trim().trim_end_matches(',').trim();
    match value.to_ascii_lowercase().as_str() {
        "true" | "yes" | "up" => serde_json::Value::Bool(true),
        "false" | "no" | "down" => serde_json::Value::Bool(false),
        _ => serde_json::Value::String(value.to_owned()),
    }
}

fn latency_millis(value: &str) -> Option<f64> {
    let value = value.trim().trim_end_matches(',').trim();
    let number = value
        .strip_suffix("ms")
        .map(str::trim)
        .or_else(|| value.strip_suffix("MS").map(str::trim))
        .and_then(|value| value.parse::<f64>().ok())
        .or_else(|| {
            value
                .strip_suffix('s')
                .map(str::trim)
                .and_then(|value| value.parse::<f64>().ok())
                .map(|value| value * 1000.0)
        })
        .or_else(|| value.parse::<f64>().ok())?;
    Some(
        if value.ends_with("ms") || value.ends_with("MS") || value.ends_with('s') {
            number
        } else if number.abs() < 1.0 {
            number * 1000.0
        } else {
            number
        },
    )
}

fn latency_number_millis(value: f64) -> f64 {
    if value.abs() >= 1_000_000.0 {
        value / 1_000_000.0
    } else if value.abs() < 1.0 {
        value * 1000.0
    } else {
        value
    }
}

fn parse_json_netcheck(root: &serde_json::Value) -> TailscaleNetcheck {
    let mut result = TailscaleNetcheck {
        available: true,
        ..TailscaleNetcheck::default()
    };
    result.udp = json_bool(netcheck_json_field(root, &["UDP"]));
    result.ipv4 = netcheck_json_field(root, &["IPv4"]);
    result.ipv6 = netcheck_json_field(root, &["IPv6"]);
    result.mapping_varies_by_dest_ip = json_bool(netcheck_json_field(root, &["MappingVariesByDestIP"]));
    result.port_mapping = netcheck_json_field(root, &["PortMapping"]);
    result.hair_pinning = netcheck_json_field(root, &["HairPinning"]);
    result.captive_portal = json_bool(netcheck_json_field(root, &["CaptivePortal"]));
    result.global_v6 = netcheck_json_field(root, &["GlobalV6"]);
    result.nearest_derp = netcheck_json_field(root, &["NearestDERP"]).and_then(|value| match value {
        serde_json::Value::String(value) => Some(value),
        _ => None,
    });
    if let Some(serde_json::Value::Object(latencies)) = netcheck_json_field(root, &["DERPLatency"]) {
        for (region, latency) in latencies {
            let latency = match latency {
                serde_json::Value::Number(value) => value.as_f64().map(latency_number_millis),
                serde_json::Value::String(value) => latency_millis(&value),
                _ => None,
            };
            if let Some(latency) = latency {
                result.derp_latency.insert(region, latency);
            }
        }
    }
    result
}

fn parse_text_netcheck(text: &str) -> TailscaleNetcheck {
    let mut result = TailscaleNetcheck {
        available: true,
        ..TailscaleNetcheck::default()
    };
    let mut in_latency = false;
    for line in text.lines() {
        let mut line = line.trim();
        let had_bullet = line.starts_with('*') || line.starts_with('-');
        line = line.trim_start_matches(&['*', '-'][..]).trim();
        if line.is_empty() {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = normalized_netcheck_key(key);
        let value = value.trim();
        if key == "derplatency" || key == "derplatencies" {
            in_latency = true;
            continue;
        }
        if in_latency
            && had_bullet
            && !matches!(
                key.as_str(),
                "udp"
                    | "ipv4"
                    | "ipv6"
                    | "mappingvariesbydestip"
                    | "portmapping"
                    | "hairpinning"
                    | "captiveportal"
                    | "nearestderp"
                    | "globalv6"
            )
        {
            if let Some(latency) = latency_millis(value.split('(').next().unwrap_or(value)) {
                result.derp_latency.insert(key, latency);
            }
            continue;
        }
        match key.as_str() {
            "udp" => result.udp = json_bool(Some(scalar_from_netcheck_text(value))),
            "ipv4" => result.ipv4 = Some(scalar_from_netcheck_text(value)),
            "ipv6" => result.ipv6 = Some(scalar_from_netcheck_text(value)),
            "mappingvariesbydestip" => {
                result.mapping_varies_by_dest_ip = json_bool(Some(scalar_from_netcheck_text(value)))
            }
            "portmapping" => result.port_mapping = Some(scalar_from_netcheck_text(value)),
            "hairpinning" => result.hair_pinning = Some(scalar_from_netcheck_text(value)),
            "captiveportal" => result.captive_portal = json_bool(Some(scalar_from_netcheck_text(value))),
            "nearestderp" => result.nearest_derp = Some(value.to_owned()),
            "globalv6" => result.global_v6 = Some(scalar_from_netcheck_text(value)),
            _ => {}
        }
    }
    result
}

async fn tailscale_netcheck_snapshot() -> TailscaleNetcheck {
    let mut last_error = None;
    for args in [["netcheck", "--format=json"].as_slice(), ["netcheck"].as_slice()] {
        let output = match tailscale_output(args).await {
            Ok(output) => output,
            Err(error) => {
                last_error = Some(error.to_string());
                continue;
            }
        };
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            last_error = Some(if detail.is_empty() {
                format!("tailscale netcheck failed (exit status {})", output.status)
            } else {
                detail.chars().take(300).collect()
            });
            continue;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(text.trim()) {
            return parse_json_netcheck(&value);
        }
        if let (Some(start), Some(end)) = (text.find('{'), text.rfind('}'))
            && start < end
            && let Ok(value) = serde_json::from_str::<serde_json::Value>(&text[start..=end])
        {
            return parse_json_netcheck(&value);
        }
        return parse_text_netcheck(&text);
    }
    TailscaleNetcheck {
        error: last_error,
        ..TailscaleNetcheck::default()
    }
}

async fn tailscale_status_snapshot_with_profiles(include_profiles: bool) -> TailscaleStatus {
    // These probes are independent. Running them together keeps a slow local
    // daemon (or process startup on Windows) from multiplying status latency.
    let profiles = async {
        if include_profiles {
            Some(tailscale_profiles().await)
        } else {
            None
        }
    };
    let (version, status, ip, profiles) = tokio::join!(
        tailscale_output(&["version"]),
        tailscale_output(&["status", "--json"]),
        tailscale_output(&["ip", "-4"]),
        profiles,
    );
    let Ok(version) = version else {
        return TailscaleStatus::default();
    };
    let version_text = if version.stdout.is_empty() {
        String::from_utf8_lossy(&version.stderr)
    } else {
        String::from_utf8_lossy(&version.stdout)
    };
    let version = version_text
        .lines()
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let mut result = TailscaleStatus {
        installed: true,
        version,
        ..TailscaleStatus::default()
    };

    if let Ok(status) = status
        && status.status.success()
    {
        result.running = true;
        match serde_json::from_slice::<TailscaleStatusJson>(&status.stdout) {
            Ok(value) => {
                result.running = value.backend_state.as_deref().is_none_or(|state| state != "Stopped");
                result.logged_in = value.backend_state.as_deref() == Some("Running") && value.self_node.is_some();
                if let Some(node) = value.self_node {
                    result.node_id = node.id;
                    result.device_name = node.hostname.or(node.dns_name);
                    result.addresses = node.ips;
                    result.ipv4 = result
                        .addresses
                        .iter()
                        .find(|ip| ip.parse::<std::net::Ipv4Addr>().is_ok())
                        .cloned();
                    result.online = node.online.unwrap_or(result.logged_in);
                }
            }
            Err(error) => {
                logging!(debug, Type::Config, "failed to parse tailscale status JSON: {error}");
            }
        }
    }
    if let Ok(ip) = ip
        && ip.status.success()
        && result.ipv4.is_none()
    {
        result.running = true;
        result.ipv4 = String::from_utf8_lossy(&ip.stdout)
            .lines()
            .next()
            .map(str::trim)
            .filter(|value| value.parse::<std::net::Ipv4Addr>().is_ok())
            .map(str::to_owned);
        if let Some(ipv4) = result.ipv4.as_ref()
            && !result.addresses.iter().any(|address| address == ipv4)
        {
            result.addresses.insert(0, ipv4.clone());
        }
    }
    if let Some(profiles) = profiles {
        result.profiles = profiles;
    }
    result.update = TAILSCALE_UPDATE_CACHE.lock().clone().unwrap_or_default();
    result
}

async fn tailscale_status_snapshot() -> TailscaleStatus {
    tailscale_status_snapshot_with_profiles(true).await
}

/// Probe only daemon state and identity. Account-profile enumeration is useful
/// for the settings page but needlessly expensive while waiting for `tailscale
/// up` to publish its node identity.
async fn tailscale_status_snapshot_fast() -> TailscaleStatus {
    tailscale_status_snapshot_with_profiles(false).await
}

async fn tailscale_profiles() -> Vec<TailscaleProfile> {
    if let Ok(output) = tailscale_output(&["switch", "--list", "--json"]).await
        && output.status.success()
        && let Ok(values) = serde_json::from_slice::<Vec<serde_json::Value>>(&output.stdout)
    {
        let profiles = values
            .into_iter()
            .filter_map(|value| {
                let id = value.get("id")?.as_str()?.to_string();
                let account_name = value
                    .get("account")
                    .and_then(serde_json::Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned);
                let nickname = value
                    .get("nickname")
                    .and_then(serde_json::Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned);
                Some(TailscaleProfile {
                    id,
                    name: account_name.clone().or(nickname).unwrap_or_else(|| "未命名账号".into()),
                    account_name,
                    active: value
                        .get("selected")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false),
                    tailnet: value
                        .get("tailnet")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned),
                })
            })
            .collect::<Vec<_>>();
        if !profiles.is_empty() {
            return profiles;
        }
    }

    let Ok(output) = tailscale_output(&["switch", "--list"]).await else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut profiles = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("ID") || line.starts_with("---") {
            continue;
        }
        let is_active = line.ends_with('*') || line.contains(" *");
        let cleaned = line.trim_end_matches('*').trim();
        let parts: Vec<&str> = cleaned.split_whitespace().collect();
        if let Some(first) = parts.first() {
            // `tailscale switch --list` prints ID, Tailnet, and Account. The
            // second column is the tailnet, not the login identity users need
            // to choose from.
            let tailnet = parts.get(1).map(|value| (*value).to_string());
            let account_name = parts.get(2..).map(|values| values.join(" "));
            let account_name = account_name.filter(|value| !value.is_empty());
            profiles.push(TailscaleProfile {
                id: (*first).to_string(),
                name: account_name.clone().unwrap_or_else(|| (*first).to_string()),
                account_name,
                active: is_active,
                tailnet,
            });
        }
    }
    profiles
}

fn warp_cli_candidates() -> Vec<PathBuf> {
    let mut candidates = vec![PathBuf::from(if cfg!(windows) { "warp-cli.exe" } else { "warp-cli" })];

    #[cfg(windows)]
    {
        for variable in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Some(root) = std::env::var_os(variable) {
                candidates.push(
                    PathBuf::from(root)
                        .join("Cloudflare")
                        .join("Cloudflare WARP")
                        .join("warp-cli.exe"),
                );
            }
        }
    }

    #[cfg(target_os = "macos")]
    candidates.push(PathBuf::from(
        "/Applications/Cloudflare WARP.app/Contents/Resources/warp-cli",
    ));

    #[cfg(target_os = "linux")]
    {
        candidates.push(PathBuf::from("/usr/bin/warp-cli"));
        candidates.push(PathBuf::from("/usr/local/bin/warp-cli"));
    }

    candidates.sort_unstable();
    candidates.dedup();
    candidates
}

async fn warp_cli_output(program: &Path, args: &[&str]) -> Result<std::process::Output> {
    let mut command = Command::new(program);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
        .args(args)
        .stdin(Stdio::null())
        .output()
        .await
        .with_context(|| format!("{} is unavailable", program.display()))
}

async fn find_warp_cli() -> Result<(PathBuf, Option<String>)> {
    let mut last_error = None;
    let mut found_program = None;
    let mut found_version = None;
    for candidate in warp_cli_candidates() {
        for version_args in [["--version"].as_slice(), ["version"].as_slice()] {
            match warp_cli_output(&candidate, version_args).await {
                Ok(output) if output.status.success() => {
                    return Ok((candidate, parse_warp_version(&warp_cli_text(&output))));
                }
                Ok(output) => {
                    // A stopped WARP daemon can make the version probe exit
                    // non-zero even though the CLI is installed. Keep the
                    // executable so the status path can report `running =
                    // false` and offer the service start action.
                    found_program.get_or_insert_with(|| candidate.clone());
                    found_version = found_version.or_else(|| parse_warp_version(&warp_cli_text(&output)));
                    last_error = Some(warp_cli_text(&output));
                }
                Err(error) => last_error = Some(error.to_string()),
            }
        }
    }
    if let Some(program) = found_program {
        return Ok((program, found_version));
    }
    let detail = last_error
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!(": {}", value.trim()))
        .unwrap_or_default();
    bail!("Cloudflare One Client warp-cli is not installed or unavailable{detail}")
}

fn warp_cli_text(output: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !stdout.trim().is_empty() {
        stdout.into_owned()
    } else {
        String::from_utf8_lossy(&output.stderr).into_owned()
    }
}

fn first_value_after_label(text: &str, label: &str) -> Option<String> {
    let label = label.to_ascii_lowercase();
    text.lines().find_map(|line| {
        let (key, value) = line.split_once(':').or_else(|| line.split_once('='))?;
        if key.trim().to_ascii_lowercase() != label {
            return None;
        }
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

fn parse_warp_connected(text: &str) -> bool {
    let mut connected = false;
    for line in text.lines() {
        let line = line.trim().to_ascii_lowercase();
        if !line.contains("connected") && !line.contains("disconnected") {
            continue;
        }
        if line.contains("disconnected") || line.contains("not connected") {
            connected = false;
        } else if line.contains("connected") {
            connected = true;
        }
    }
    connected
}

fn parse_warp_version(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| line.chars().any(|character| character.is_ascii_digit()))
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
}

fn version_parts(value: &str) -> Vec<u64> {
    value
        .split(|character: char| !character.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse::<u64>().ok())
        .collect()
}

fn version_is_newer(current: Option<&str>, latest: Option<&str>) -> bool {
    let (Some(current), Some(latest)) = (current, latest) else {
        return false;
    };
    let current = version_parts(current);
    let latest = version_parts(latest);
    if current.is_empty() || latest.is_empty() {
        return false;
    }
    let length = current.len().max(latest.len());
    (0..length).any(|index| {
        let current_part = current.get(index).copied().unwrap_or_default();
        let latest_part = latest.get(index).copied().unwrap_or_default();
        latest_part > current_part
            && (0..index).all(|previous| {
                current.get(previous).copied().unwrap_or_default() == latest.get(previous).copied().unwrap_or_default()
            })
    })
}

#[cfg(target_os = "windows")]
const fn cloudflare_platform_name() -> &'static str {
    "Windows"
}

#[cfg(target_os = "macos")]
const fn cloudflare_platform_name() -> &'static str {
    "macOS"
}

#[cfg(target_os = "linux")]
const fn cloudflare_platform_name() -> &'static str {
    "Linux"
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn cloudflare_platform_name() -> &'static str {
    ""
}

fn extract_cloudflare_latest_version(markdown: &str) -> Option<String> {
    let platform = cloudflare_platform_name();
    if platform.is_empty() {
        return None;
    }
    let heading = format!("## {platform}");
    // The page puts a `## Footnotes` subsection between the platform table
    // and its release entries. Keep the whole remainder instead of stopping
    // at the first heading; the platform-specific version marker is unique
    // and the first match is the latest release.
    let section = markdown.split_once(&heading)?.1;
    let marker = format!("**Version:** {platform} ");
    let value = section.split_once(&marker)?.1;
    let value = value.split("**").next()?.trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// Fetch public release metadata through the same local Clash proxy that is
/// used for subscriptions, then try the system proxy and a direct request.
/// Team builds are commonly used on networks where GitHub and Cloudflare are
/// not reachable without a proxy.
async fn fetch_update_text(url: &str) -> Result<String> {
    let network = NetworkManager::new();
    let mut errors = Vec::new();
    for proxy_type in [ProxyType::Localhost, ProxyType::System, ProxyType::None] {
        match network
            .get_with_interrupt(
                url,
                proxy_type,
                Some(8),
                Some("clash-verge-rev update checker".into()),
                false,
            )
            .await
        {
            Ok(response) if response.status().is_success() => {
                return response
                    .text_with_charset()
                    .map(str::to_owned)
                    .context("failed to read update response body");
            }
            Ok(response) => errors.push(format!("HTTP {}", response.status())),
            Err(error) => errors.push(error.to_string()),
        }
    }
    bail!("update request failed: {}", errors.join("; "))
}

fn extract_tailscale_page_version(page: &str) -> Option<String> {
    let lower = page.to_ascii_lowercase();
    let marker = "release v";
    let start = lower.find(marker).map(|index| index + marker.len())?;
    let value: String = page[start..]
        .chars()
        .take_while(|character| character.is_ascii_digit() || *character == '.')
        .collect();
    (!value.is_empty()).then_some(value)
}

async fn tailscale_latest_version() -> Result<String> {
    let api_result = fetch_update_text(TAILSCALE_RELEASES_URL).await.and_then(|text| {
        serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|payload| {
                payload
                    .get("tag_name")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .map(|value| value.trim_start_matches('v').to_owned())
            .filter(|value| !value.is_empty())
            .context("Tailscale release response did not contain a version")
    });
    match api_result {
        Ok(version) => Ok(version),
        Err(api_error) => fetch_update_text(TAILSCALE_RELEASES_PAGE_URL)
            .await
            .and_then(|page| {
                extract_tailscale_page_version(&page).context("Tailscale release page did not contain a version")
            })
            .with_context(|| format!("Tailscale release lookup failed: {api_error}")),
    }
}

async fn check_tailscale_update_snapshot(current: Option<&str>) -> ClientUpdateStatus {
    let checked_at = now();
    let result = tailscale_latest_version().await.map_err(|error| error.to_string());
    match result {
        Ok(latest_version) => ClientUpdateStatus {
            update_available: version_is_newer(current, Some(&latest_version)),
            latest_version: Some(latest_version),
            checked_at: Some(checked_at),
            error: None,
        },
        Err(error) => ClientUpdateStatus {
            checked_at: Some(checked_at),
            error: Some(error),
            ..ClientUpdateStatus::default()
        },
    }
}

async fn check_cloudflare_update_snapshot(current: Option<&str>) -> ClientUpdateStatus {
    let checked_at = now();
    let result = fetch_update_text(CLOUDFLARE_RELEASES_URL)
        .await
        .and_then(|text| {
            extract_cloudflare_latest_version(&text)
                .context("Cloudflare One Client release page did not contain a version")
        })
        .map_err(|error| error.to_string());
    match result {
        Ok(latest_version) => ClientUpdateStatus {
            update_available: version_is_newer(current, Some(&latest_version)),
            latest_version: Some(latest_version),
            checked_at: Some(checked_at),
            error: None,
        },
        Err(error) => ClientUpdateStatus {
            checked_at: Some(checked_at),
            error: Some(error),
            ..ClientUpdateStatus::default()
        },
    }
}

fn parse_cloudflare_trace(text: &str) -> CloudflareTrace {
    let mut trace = CloudflareTrace::default();
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        match key.trim() {
            "ip" => trace.ip = Some(value.to_string()),
            "loc" => trace.country = Some(value.to_string()),
            "colo" => trace.colo = Some(value.to_string()),
            "warp" => {
                trace.warp_enabled = match value.to_ascii_lowercase().as_str() {
                    "on" | "plus" | "true" | "1" => Some(true),
                    "off" | "false" | "0" => Some(false),
                    _ => None,
                };
            }
            _ => {}
        }
    }
    trace
}

#[derive(Debug, Default, Clone)]
struct CloudflareTrace {
    ip: Option<String>,
    country: Option<String>,
    colo: Option<String>,
    warp_enabled: Option<bool>,
}

async fn cloudflare_trace_with_proxy(proxy_type: ProxyType) -> Result<CloudflareTrace> {
    let response = NetworkManager::new()
        .get_with_interrupt(
            "https://www.cloudflare.com/cdn-cgi/trace",
            proxy_type,
            Some(5),
            Some("clash-verge-rev".into()),
            false,
        )
        .await
        .context("Cloudflare trace request failed")?;
    if !response.status().is_success() {
        bail!("Cloudflare trace returned an error: {}", response.status());
    }
    Ok(parse_cloudflare_trace(
        response
            .text_with_charset()
            .context("failed to read Cloudflare trace response")?,
    ))
}

async fn cloudflare_trace() -> Result<CloudflareTrace> {
    cloudflare_trace_with_proxy(ProxyType::None).await
}

async fn cloudflare_one_status_snapshot() -> CloudflareOneStatus {
    let checked_at = now();
    let mut result = CloudflareOneStatus {
        last_checked_at: checked_at,
        update: CLOUDFLARE_UPDATE_CACHE.lock().clone().unwrap_or_default(),
        ..CloudflareOneStatus::default()
    };
    let Ok((program, version)) = find_warp_cli().await else {
        return result;
    };
    result.installed = true;
    result.version = version;

    let status = match warp_cli_output(&program, &["status"]).await {
        Ok(output) => {
            let text = warp_cli_text(&output);
            let lower = text.to_ascii_lowercase();
            result.running = output.status.success()
                && !lower.contains("daemon is not running")
                && !lower.contains("service is not running")
                && !lower.contains("failed to connect to daemon")
                && !lower.contains("unable to connect to daemon")
                && !lower.contains("could not connect to daemon");
            if !output.status.success() && !text.trim().is_empty() {
                result.error = Some(text.trim().to_string());
            }
            text
        }
        Err(error) => {
            result.error = Some(error.to_string());
            String::new()
        }
    };
    result.connected = parse_warp_connected(&status);
    result.mode = first_value_after_label(&status, "mode");

    if result.running
        && result.mode.is_none()
        && let Ok(output) = warp_cli_output(&program, &["settings"]).await
        && output.status.success()
    {
        result.mode = first_value_after_label(&warp_cli_text(&output), "mode");
    }
    if result.running
        && let Ok(output) = warp_cli_output(&program, &["registration", "show"]).await
        && output.status.success()
    {
        result.account_type = first_value_after_label(&warp_cli_text(&output), "account type");
    }

    if !result.running || !result.connected {
        return result;
    }
    match cloudflare_trace().await {
        Ok(trace) => {
            result.exit_ip = trace.ip;
            result.exit_country = trace.country;
            result.exit_colo = trace.colo;
            result.warp_enabled = trace.warp_enabled;
            result.clash_tun_location = CLASH_TUN_LOCATION.lock().clone();
            result.location_match = result
                .clash_tun_location
                .as_ref()
                .zip(result.exit_country.as_ref())
                .map(|(clash, exit)| clash.eq_ignore_ascii_case(exit));
            result.local_network_location = LOCAL_NETWORK_LOCATION.lock().clone();
            result.local_location_match = result
                .local_network_location
                .as_ref()
                .zip(result.exit_country.as_ref())
                .map(|(local, exit)| local.eq_ignore_ascii_case(exit));
        }
        Err(error) => result.error = Some(error.to_string()),
    }
    result
}

fn create_tailscale_key_file(key: &str) -> Result<PathBuf> {
    let path = std::env::temp_dir().join(format!("clash-verge-tailscale-key-{}", random_urlsafe(18)?));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(&path)?;
    if let Err(error) = file.write_all(key.as_bytes()).and_then(|()| file.sync_all()) {
        let _ = std::fs::remove_file(&path);
        return Err(error.into());
    }
    Ok(path)
}

async fn tailscale_up(key: &str) -> Result<()> {
    let path = create_tailscale_key_file(key)?;
    let path_arg = format!("--auth-key=file:{}", path.to_string_lossy());
    let result = tokio::time::timeout(
        TAILSCALE_UP_TIMEOUT,
        tailscale_command()
            .arg("up")
            .arg("--reset")
            .arg(path_arg)
            .arg("--accept-routes")
            .arg("--accept-dns=true")
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| {
        anyhow::anyhow!(
            "tailscale up timed out after {} seconds",
            TAILSCALE_UP_TIMEOUT.as_secs()
        )
    })
    .and_then(|result| result.map_err(|error| anyhow::anyhow!("failed to start tailscale up: {error}")));
    let _ = std::fs::remove_file(path);
    let output = result?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail: String = stderr.trim().chars().take(300).collect();
        if detail.is_empty() {
            bail!("tailscale up failed (exit status {})", output.status);
        }
        bail!("tailscale up failed (exit status {}): {detail}", output.status);
    }
    Ok(())
}

/// error_for_status() discards the response body, but the Worker puts the
/// diagnostic (e.g. the upstream Tailscale API message) in it - keep it.
async fn checked_response(response: reqwest::Response) -> Result<reqwest::Response> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let detail: String = body.trim().chars().take(500).collect();
    if detail.is_empty() {
        bail!("team Worker request failed: {status}");
    }
    bail!("team Worker request failed: {status}: {detail}")
}

fn retryable_worker_status(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::REQUEST_TIMEOUT
        || status == reqwest::StatusCode::TOO_EARLY
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
}

fn retryable_worker_error(error: &reqwest::Error) -> bool {
    error.is_connect() || error.is_timeout() || error.is_request()
}

/// Send a team Worker request with a bounded retry budget for transient edge
/// failures. The request builder is recreated for each attempt so callers can
/// safely include bodies and headers without reusing a consumed request.
async fn send_team_request_with_policy<F>(
    mut build: F,
    retry: bool,
    retry_responses: bool,
    operation: &str,
) -> Result<reqwest::Response>
where
    F: FnMut() -> reqwest::RequestBuilder,
{
    let attempts = if retry { TEAM_HTTP_RETRY_DELAYS.len() + 1 } else { 1 };
    let mut attempt = 0;
    loop {
        match build().send().await {
            Ok(response) => {
                if retry
                    && retry_responses
                    && retryable_worker_status(response.status())
                    && let Some(delay) = TEAM_HTTP_RETRY_DELAYS.get(attempt).copied()
                {
                    // Drop the intermediate response body before waiting for
                    // the next attempt; this also returns the connection to
                    // reqwest's pool promptly.
                    let status = response.status();
                    drop(response);
                    attempt += 1;
                    tokio::time::sleep(delay).await;
                    logging!(
                        debug,
                        Type::Config,
                        "team Worker request returned {status}; retrying ({}/{})",
                        attempt,
                        attempts
                    );
                    continue;
                }
                return Ok(response);
            }
            Err(error) => {
                if retry
                    && retryable_worker_error(&error)
                    && let Some(delay) = TEAM_HTTP_RETRY_DELAYS.get(attempt).copied()
                {
                    attempt += 1;
                    tokio::time::sleep(delay).await;
                    logging!(
                        debug,
                        Type::Config,
                        "team Worker request failed transiently; retrying ({}/{})",
                        attempt,
                        attempts
                    );
                    continue;
                }
                return Err(error).with_context(|| operation.to_owned());
            }
        }
    }
}

async fn send_team_request<F>(build: F, retry: bool, operation: &str) -> Result<reqwest::Response>
where
    F: FnMut() -> reqwest::RequestBuilder,
{
    send_team_request_with_policy(build, retry, retry, operation).await
}

async fn send_team_request_transport_retry<F>(build: F, operation: &str) -> Result<reqwest::Response>
where
    F: FnMut() -> reqwest::RequestBuilder,
{
    // A failed `send()` means no response reached the caller, so retry only
    // connection/timeouts here. Never replay a response status for OAuth POSTs
    // because the provider may have already rotated the refresh token.
    send_team_request_with_policy(build, true, false, operation).await
}

async fn team_post(path: &str, body: serde_json::Value) -> Result<reqwest::Response> {
    let config = load_config()?;
    let session = usable_session().await?;
    let url = endpoint(&config.api_base_url, path)?;
    let team_device_id = device_id()?;
    // Key issuance is deliberately single-attempt: retrying a POST after a
    // transport failure could mint two one-time Tailscale keys. Reconcile,
    // validate and logout are idempotent and can safely use the retry budget.
    let retry = !path.ends_with("/key");
    let response = send_team_request(
        || {
            TEAM_HTTP_CLIENT
                .post(url.clone())
                .bearer_auth(&session.access_token)
                .header("x-team-device", &team_device_id)
                .json(&body)
        },
        retry,
        "team Worker request failed",
    )
    .await?;
    checked_response(response).await
}

async fn tailscale_reconcile(device_id: &str, snapshot: &TailscaleStatus) -> Result<TailscaleReconcileResponse> {
    let node_id = snapshot
        .node_id
        .as_deref()
        .context("Tailscale status did not include Self.ID")?;
    let hostname = snapshot
        .device_name
        .as_deref()
        .context("Tailscale status did not include a hostname")?;
    team_post(
        TAILSCALE_RECONCILE_PATH,
        serde_json::json!({
            "deviceId": device_id,
            "nodeId": node_id,
            "hostname": hostname,
            "addresses": &snapshot.addresses,
        }),
    )
    .await?
    .json::<TailscaleReconcileResponse>()
    .await
    .context("invalid Tailscale reconcile response")
}

async fn tailscale_validate(device_id: &str, node_id: &str) -> Result<bool> {
    let response = team_post(
        TAILSCALE_VALIDATE_PATH,
        serde_json::json!({ "deviceId": device_id, "nodeId": node_id }),
    )
    .await?;
    Ok(response
        .json::<TailscaleValidateResponse>()
        .await
        .context("invalid Tailscale validation response")?
        .valid)
}

async fn save_tailscale_reconcile(response: TailscaleReconcileResponse, node_id: Option<String>) -> Result<()> {
    let mut session = usable_session().await?;
    let previous = session.tailscale.clone().unwrap_or_default();
    session.tailscale = Some(TailscaleInfo {
        node_id: node_id.or(previous.node_id),
        key_issued_at: previous.key_issued_at,
        key_expires_at: previous.key_expires_at,
        role: response.role.or(previous.role),
        tag: response.tag.or(previous.tag),
        last_reconciled_at: Some(now()),
    });
    save_session(&session)
}

fn invalidate_tailscale_reconcile() {
    let Ok(Some(mut session)) = load_session() else {
        return;
    };
    let Some(info) = session.tailscale.as_mut() else {
        return;
    };
    info.last_reconciled_at = None;
    if let Err(error) = save_session(&session) {
        logging!(
            debug,
            Type::Config,
            "failed to invalidate Tailscale reconcile cache: {error:#}"
        );
    }
}

/// Reconcile the local node with the Worker when the cached role/tag is stale.
/// The result is optional so callers can distinguish "not due yet" from an
/// attempted request that failed (the latter still gets a lightweight
/// validation fallback in `status`).
async fn maybe_reconcile_tailscale(snapshot: &TailscaleStatus, session: &Option<TeamSession>) -> Option<bool> {
    let node_id = snapshot.node_id.as_deref()?;
    snapshot.device_name.as_deref()?;
    let authenticated = session.as_ref().is_some_and(|value| !value.access_token.is_empty());
    if !authenticated {
        return None;
    }

    let cached = session.as_ref().and_then(|value| value.tailscale.as_ref());
    let node_changed = cached
        .and_then(|value| value.node_id.as_deref())
        .is_none_or(|value| value != node_id);
    let reconcile_due = cached
        .and_then(|value| value.last_reconciled_at)
        .is_none_or(|checked_at| now().saturating_sub(checked_at) >= TAILSCALE_RECONCILE_INTERVAL_SECONDS);
    if !node_changed && !reconcile_due {
        return None;
    }
    if TAILSCALE_RECONCILE_IN_FLIGHT
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed)
        .is_err()
    {
        return None;
    }

    let result = tokio::time::timeout(TAILSCALE_RECONCILE_TIMEOUT, async {
        let device_id = device_id()?;
        let response = tailscale_reconcile(&device_id, snapshot).await?;
        save_tailscale_reconcile(response, Some(node_id.to_owned())).await
    })
    .await
    .map_err(|_| anyhow::anyhow!("Tailscale reconcile timed out"))
    .and_then(|result| result);
    TAILSCALE_RECONCILE_IN_FLIGHT.store(false, Ordering::Release);
    match result {
        Ok(()) => Some(true),
        Err(error) => {
            logging!(debug, Type::Config, "automatic Tailscale reconcile failed: {error:#}");
            Some(false)
        }
    }
}

fn endpoint(base: &str, path: &str) -> Result<reqwest::Url> {
    let mut url = reqwest::Url::parse(base)?;
    url.set_path(path);
    url.set_query(None);
    Ok(url)
}

async fn metadata(config: &TeamConfig) -> Result<OAuthMetadata> {
    // Managed OAuth serves the discovery document on the Access-protected
    // application domain itself; no override is needed.
    let url = endpoint(&config.api_base_url, "/.well-known/oauth-authorization-server")?;
    let response = send_team_request(
        || TEAM_HTTP_CLIENT.get(url.clone()),
        true,
        "OAuth discovery request failed",
    )
    .await?;
    checked_response(response)
        .await?
        .json()
        .await
        .context("invalid OAuth discovery metadata")
}

async fn register_client(metadata: &OAuthMetadata, redirect_uri: &str, resource: &str) -> Result<String> {
    let registration_endpoint = metadata
        .registration_endpoint
        .as_ref()
        .context("oauth_client_id is empty and discovery has no registration_endpoint")?;
    let body = serde_json::json!({
        "client_name": "Clash Verge Team Desktop",
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        "resource": resource
    });
    let response = send_team_request(
        || TEAM_HTTP_CLIENT.post(registration_endpoint).json(&body),
        false,
        "OAuth client registration request failed",
    )
    .await?;
    let response = checked_response(response).await?;
    Ok(response.json::<ClientRegistration>().await?.client_id)
}

fn random_urlsafe(byte_count: usize) -> Result<String> {
    let mut bytes = vec![0_u8; byte_count];
    getrandom::fill(&mut bytes)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

async fn receive_authorization_code(listener: TcpListener, expected_state: &str) -> Result<String> {
    let (mut stream, _) = tokio::time::timeout(Duration::from_secs(300), listener.accept())
        .await
        .context("OAuth login timed out")??;
    let mut buffer = vec![0_u8; 16 * 1024];
    let size = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut buffer)).await??;
    let request = std::str::from_utf8(&buffer[..size])?;
    let target = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .context("invalid OAuth callback request")?;
    let url = reqwest::Url::parse(&format!("http://127.0.0.1{target}"))?;
    let params: HashMap<_, _> = url.query_pairs().into_owned().collect();
    let valid = params.get("state").is_some_and(|state| state == expected_state);
    let code = params.get("code").cloned();
    let success = valid && code.is_some();
    let message = if success {
        "Authentication completed. You can close this window and return to the app."
    } else {
        "Authentication failed. Return to the app and try again."
    };
    let body = format!("<!doctype html><meta charset=utf-8><title>Team login</title><h2>{message}</h2>");
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    if !valid {
        bail!("OAuth state mismatch")
    }
    code.context("OAuth callback did not contain a code")
}

pub async fn login() -> Result<TeamStatus> {
    let config = load_config()?;
    if !config.enabled {
        bail!("team integration is disabled in team-config.json")
    }
    let metadata = metadata(&config).await?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let redirect_uri = format!("http://127.0.0.1:{}/oauth/callback", listener.local_addr()?.port());
    let resource = if config.oauth_resource.trim().is_empty() {
        config.api_base_url.trim_end_matches('/').to_owned()
    } else {
        config.oauth_resource.trim_end_matches('/').to_owned()
    };
    let client_id = if config.oauth_client_id.trim().is_empty() {
        register_client(&metadata, &redirect_uri, &resource).await?
    } else {
        config.oauth_client_id.clone()
    };

    // Cloudflare Access currently rejects a challenge beginning with '-' or '_'
    // in some authorization URLs. Regenerate until the S256 challenge starts
    // with an alphanumeric character.
    let (verifier, challenge) = loop {
        let candidate = random_urlsafe(48)?;
        let candidate_challenge = pkce_challenge(&candidate);
        if candidate_challenge
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        {
            break (candidate, candidate_challenge);
        }
    };
    let state = random_urlsafe(24)?;
    let mut authorization_url = reqwest::Url::parse(&metadata.authorization_endpoint)?;
    {
        let mut query = authorization_url.query_pairs_mut();
        query
            .append_pair("response_type", "code")
            .append_pair("client_id", &client_id)
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("state", &state)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256");
        if !config.oauth_scopes.is_empty() {
            query.append_pair("scope", &config.oauth_scopes.join(" "));
        }
        query.append_pair("resource", &resource);
    }
    open::that(authorization_url.as_str())?;
    let code = receive_authorization_code(listener, &state).await?;
    let mut token_form = vec![
        ("grant_type", "authorization_code"),
        ("client_id", client_id.as_str()),
        ("code", code.as_str()),
        ("redirect_uri", redirect_uri.as_str()),
        ("code_verifier", verifier.as_str()),
    ];
    token_form.push(("resource", resource.as_str()));
    let token_endpoint = metadata.token_endpoint.clone();
    let token = send_team_request(
        || TEAM_HTTP_CLIENT.post(&token_endpoint).form(&token_form),
        false,
        "OAuth token request failed",
    )
    .await?;
    let token = checked_response(token).await?.json::<OAuthTokenResponse>().await?;
    save_session(&TeamSession {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        token_type: token.token_type,
        expires_at: now().saturating_add(token.expires_in),
        client_id,
        token_endpoint: metadata.token_endpoint,
        resource,
        ..TeamSession::default()
    })?;
    // Login ends here: the account page can refresh immediately. The frontend
    // kicks off the profile sync in the background and reports its failures
    // separately, so a sync error never surfaces as a login error.
    refresh_account().await
}

async fn usable_session() -> Result<TeamSession> {
    let session = load_session()?.context("not authenticated")?;
    if session.expires_at > now().saturating_add(60) {
        return Ok(session);
    }

    // Access refresh tokens can be rotated on redemption. Wait for any other
    // caller to finish, then reload from disk: the first caller may already
    // have written a fresh access/refresh token while we were waiting.
    let _refresh_guard = SESSION_REFRESH_LOCK.lock().await;
    let mut session = load_session()?.context("not authenticated")?;
    if session.expires_at > now().saturating_add(60) {
        return Ok(session);
    }
    let refresh_token = match session.refresh_token.clone() {
        Some(value) if !value.trim().is_empty() => value,
        _ => {
            clear_session()?;
            bail!("login session expired; please sign in again")
        }
    };
    let mut token_form = vec![
        ("grant_type", "refresh_token"),
        ("client_id", session.client_id.as_str()),
        ("refresh_token", refresh_token.as_str()),
    ];
    if !session.resource.trim().is_empty() {
        token_form.push(("resource", session.resource.as_str()));
    }
    // A token refresh is a POST and some providers rotate refresh tokens, so
    // never replay it after a response. Retry only a connection/timeout error
    // that produced no response, keeping a transient edge blip from forcing
    // the user through browser login again.
    let token_endpoint = session.token_endpoint.clone();
    let token = send_team_request_transport_retry(
        || TEAM_HTTP_CLIENT.post(&token_endpoint).form(&token_form),
        "team OAuth token refresh failed",
    )
    .await?;
    if !token.status().is_success() {
        let status = token.status();
        let body = token.text().await.unwrap_or_default();
        let detail = body.trim().chars().take(500).collect::<String>();
        let lower = detail.to_ascii_lowercase();
        if matches!(
            status,
            reqwest::StatusCode::BAD_REQUEST | reqwest::StatusCode::UNAUTHORIZED
        ) && (lower.contains("invalid_grant")
            || lower.contains("no grant")
            || lower.contains("grant not found")
            || lower.contains("session expired"))
        {
            clear_session()?;
            bail!("login session expired; please sign in again")
        }
        if detail.is_empty() {
            bail!("team OAuth token refresh failed: {status}")
        }
        bail!("team OAuth token refresh failed: {status}: {detail}")
    }
    let token = token.json::<OAuthTokenResponse>().await?;
    session.access_token = token.access_token;
    session.refresh_token = token.refresh_token.or(Some(refresh_token));
    session.token_type = token.token_type;
    session.expires_at = now().saturating_add(token.expires_in);
    save_session(&session)?;
    Ok(session)
}

pub async fn status() -> Result<TeamStatus> {
    let configured = load_config().is_ok_and(|config| config.enabled);
    let mut session = load_session()?;
    // Refresh an expired access token during startup/status polling. If the
    // provider has invalidated the refresh grant, `usable_session` removes the
    // stale session so the UI can offer browser login instead of reporting a
    // generic Worker failure.
    if session
        .as_ref()
        .is_some_and(|value| value.expires_at <= now().saturating_add(60))
    {
        match usable_session().await {
            Ok(refreshed) => session = Some(refreshed),
            Err(error) => {
                logging!(
                    debug,
                    Type::Config,
                    "team session refresh during status failed: {error:#}"
                );
                session = load_session()?;
            }
        }
    }
    let profiles = Config::profiles().await;
    let latest = profiles.latest_arc();
    let managed_profile_installed = latest.get_item(MANAGED_PROFILE_UID).is_ok();
    let managed_profile_active = latest.is_current_profile_index(&MANAGED_PROFILE_UID.into());
    // The two local network clients are independent. Probe them together so a
    // slow WARP trace does not add its latency to every Tailscale status read.
    let (mut tailscale, cloudflare_one) = tokio::join!(tailscale_status_snapshot(), cloudflare_one_status_snapshot(),);
    let netcheck_cache = NETCHECK_CACHE.lock().clone();
    if let Some((checked_at, netcheck)) = netcheck_cache {
        tailscale.netcheck = Some(netcheck);
        tailscale.netcheck_at = Some(checked_at);
    }
    // A role/tag update made in the remote admin page only reaches the local
    // session after reconcile. Do that opportunistically, but no more than
    // once per short interval so ordinary status reads stay fast.
    let reconcile_result = if tailscale.logged_in {
        maybe_reconcile_tailscale(&tailscale, &session).await
    } else {
        None
    };
    if reconcile_result.is_some() {
        // `team_post` may refresh the OAuth access token while reconciling.
        // Reload the session so both the refreshed token and new role/tag are
        // reflected in the response below.
        session = load_session()?;
    }
    // Removing a device in the team management page revokes its server-side
    // record, but Tailscale deliberately leaves the local CLI in Running
    // state. If reconcile failed, retain the old lightweight validation check
    // as a fallback and force a local logout when access was revoked.
    if reconcile_result == Some(false)
        && tailscale.logged_in
        && let Some(node_id) = tailscale.node_id.as_deref()
        && session.as_ref().is_some_and(|value| !value.access_token.is_empty())
        && matches!(
            tokio::time::timeout(TAILSCALE_VALIDATE_TIMEOUT, async {
                tailscale_validate(&device_id()?, node_id).await
            })
            .await,
            Ok(Ok(false))
        )
    {
        let _ = tailscale_output(&["logout"]).await;
        if let Some(mut invalid_session) = load_session()? {
            invalid_session.tailscale = None;
            let _ = save_session(&invalid_session);
            session = load_session()?;
        }
        tailscale = tailscale_status_snapshot().await;
    }
    if let Some(info) = session.as_ref().and_then(|value| value.tailscale.as_ref()) {
        if tailscale.node_id.is_none() {
            tailscale.node_id = info.node_id.clone();
        }
        tailscale.key_issued_at = info.key_issued_at;
        tailscale.key_expires_at = info.key_expires_at;
        tailscale.role = info.role.clone();
        tailscale.tag = info.tag.clone();
    }
    Ok(TeamStatus {
        configured,
        authenticated: session.as_ref().is_some_and(|value| !value.access_token.is_empty()),
        account: session.as_ref().and_then(|value| value.account.clone()),
        last_sync_at: session.as_ref().and_then(|value| value.last_sync_at),
        managed_profile_installed,
        managed_profile_active,
        tailscale,
        cloudflare_one,
    })
}

/// Start the locally installed Tailscale service without changing its login
/// state. Authentication remains an explicit operation in
/// `tailscale_connect`.
pub async fn tailscale_start() -> Result<TeamStatus> {
    let snapshot = tailscale_status_snapshot_fast().await;
    if !snapshot.installed {
        bail!("Tailscale CLI is not installed or is unavailable");
    }
    if snapshot.running {
        return status().await;
    }
    start_tailscale_service().await?;
    for _ in 0..20 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if tailscale_status_snapshot_fast().await.running {
            return status().await;
        }
    }
    bail!("Tailscale service did not become available after start");
}

/// Run `tailscale netcheck` on demand and cache the result for subsequent
/// status reads. The probe takes several seconds (it contacts the DERP
/// regions), so it never runs on the periodic status polling path.
pub async fn tailscale_netcheck() -> Result<TeamStatus> {
    let snapshot = tailscale_status_snapshot_fast().await;
    if !snapshot.installed {
        bail!("Tailscale CLI is not installed or is unavailable");
    }
    if !snapshot.running {
        bail!("Tailscale service is not running");
    }
    let report = tailscale_netcheck_snapshot().await;
    *NETCHECK_CACHE.lock() = Some((now(), report));
    status().await
}

/// Probe the Cloudflare One Client without requiring a team login.
pub async fn cloudflare_one_status() -> Result<CloudflareOneStatus> {
    Ok(cloudflare_one_status_snapshot().await)
}

/// Start the locally installed Cloudflare One Client service without changing
/// its connection state. The user can then explicitly connect it from the UI.
pub async fn cloudflare_one_start() -> Result<TeamStatus> {
    let snapshot = cloudflare_one_status_snapshot().await;
    if !snapshot.installed {
        bail!("Cloudflare One Client is not installed or is unavailable");
    }
    if snapshot.running {
        return status().await;
    }
    start_cloudflare_service().await?;
    for _ in 0..20 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if cloudflare_one_status_snapshot().await.running {
            return status().await;
        }
    }
    bail!("Cloudflare One Client service did not become available after start")
}

pub async fn check_tailscale_update() -> Result<TeamStatus> {
    let snapshot = tailscale_status_snapshot().await;
    let update = check_tailscale_update_snapshot(snapshot.version.as_deref()).await;
    *TAILSCALE_UPDATE_CACHE.lock() = Some(update);
    status().await
}

pub async fn check_cloudflare_one_update() -> Result<TeamStatus> {
    let snapshot = cloudflare_one_status_snapshot().await;
    let update = check_cloudflare_update_snapshot(snapshot.version.as_deref()).await;
    *CLOUDFLARE_UPDATE_CACHE.lock() = Some(update);
    status().await
}

async fn cloudflare_one_command(action: &str) -> Result<CloudflareOneStatus> {
    let (program, _) = find_warp_cli().await?;

    if action == "connect" {
        // Record both baselines before WARP takes over. The direct request is
        // the user's local-network location; the explicit localhost proxy
        // request captures the route selected by Clash TUN when available.
        let current_status = warp_cli_output(&program, &["status"]).await;
        let currently_connected = current_status
            .as_ref()
            .is_ok_and(|output| output.status.success() && parse_warp_connected(&warp_cli_text(output)));
        if !currently_connected {
            let (local_result, clash_result) = tokio::join!(
                cloudflare_trace_with_proxy(ProxyType::None),
                cloudflare_trace_with_proxy(ProxyType::Localhost),
            );
            let local_country = local_result.ok().and_then(|trace| trace.country);
            let clash_country = clash_result.ok().and_then(|trace| trace.country);
            *LOCAL_NETWORK_LOCATION.lock() = local_country.clone();
            *CLASH_TUN_LOCATION.lock() = clash_country.or(local_country);
        }
    }

    let output = warp_cli_output(&program, &[action]).await?;
    if !output.status.success() {
        let detail = warp_cli_text(&output);
        let detail = detail.trim();
        if detail.is_empty() {
            bail!("warp-cli {action} failed (exit status {})", output.status);
        }
        bail!("warp-cli {action} failed: {detail}");
    }
    Ok(cloudflare_one_status_snapshot().await)
}

pub async fn connect_cloudflare_one() -> Result<TeamStatus> {
    if tailscale_status_snapshot_fast().await.logged_in {
        bail!("Cloudflare One Client 与 Tailscale 不能同时连接，请先断开 Tailscale");
    }
    cloudflare_one_command("connect").await?;
    status().await
}

pub async fn refresh_cloudflare_one() -> Result<TeamStatus> {
    status().await
}

pub async fn disconnect_cloudflare_one() -> Result<TeamStatus> {
    cloudflare_one_command("disconnect").await?;
    *CLASH_TUN_LOCATION.lock() = None;
    *LOCAL_NETWORK_LOCATION.lock() = None;
    status().await
}

async fn issue_tailscale_key(device_id: &str, hostname: &str) -> Result<TailscaleKeyResponse> {
    let response = team_post(
        TAILSCALE_KEY_PATH,
        serde_json::json!({
            "deviceId": device_id,
            "hostname": hostname,
            "reusable": false,
            "ephemeral": true,
            "expirySeconds": TAILSCALE_KEY_EXPIRY_SECONDS,
        }),
    )
    .await?;
    let issued = response.json::<TailscaleKeyResponse>().await?;
    if issued.key.trim().is_empty() {
        bail!("Worker returned an empty Tailscale authorization key")
    }
    let expires_at = issued
        .expires_at
        .context("Worker returned a Tailscale authorization key without an expiration")?;
    if expires_at <= now() {
        bail!("Worker returned an already expired Tailscale authorization key")
    }
    Ok(issued)
}

/// Right after `tailscale up` the backend is still Starting and Self.ID is
/// absent; poll until the node identity shows up (or give up after ~10s).
async fn wait_for_node_identity() -> TailscaleStatus {
    let mut snapshot = tailscale_status_snapshot_fast().await;
    for _ in 0..20 {
        if snapshot.node_id.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        snapshot = tailscale_status_snapshot_fast().await;
    }
    snapshot
}
pub async fn tailscale_connect() -> Result<TeamStatus> {
    if cloudflare_one_status_snapshot().await.connected {
        bail!("Tailscale 与 Cloudflare One Client 不能同时连接，请先断开 Cloudflare One Client");
    }
    let device_id = device_id()?;
    let before = tailscale_status_snapshot_fast().await;
    if before.logged_in && before.node_id.is_some() {
        let node_id = before.node_id.clone();
        let response = tailscale_reconcile(&device_id, &before).await?;
        save_tailscale_reconcile(response, node_id).await?;
        return status().await;
    }
    let hostname = before
        .device_name
        .clone()
        .or_else(|| gethostname::gethostname().into_string().ok())
        .filter(|value| !value.trim().is_empty());
    let hostname = hostname.context("unable to determine the Tailscale hostname")?;
    // Mint a fresh key per attempt (keys are single-use). The retry first
    // logs out to clear stale server-side node state - e.g. an ephemeral node
    // deleted while offline - which otherwise makes `tailscale up` exit 1.
    let mut up_error = None;
    for attempt in 0..2 {
        if attempt > 0 {
            let _ = tailscale_output(&["logout"]).await;
        }
        let issued = issue_tailscale_key(&device_id, &hostname).await?;
        match tailscale_up(&issued.key).await {
            Ok(()) => {
                let after = wait_for_node_identity().await;
                let node_id = after
                    .node_id
                    .clone()
                    .context("Tailscale status did not include Self.ID")?;
                let reconcile = tailscale_reconcile(&device_id, &after).await?;
                let mut session = usable_session().await?;
                session.tailscale = Some(TailscaleInfo {
                    node_id: Some(node_id),
                    key_issued_at: issued.issued_at,
                    key_expires_at: issued.expires_at,
                    role: reconcile.role.or(issued.role),
                    tag: reconcile.tag.or(issued.tag),
                    last_reconciled_at: Some(now()),
                });
                save_session(&session)?;
                return status().await;
            }
            Err(error) => up_error = Some(error),
        }
    }
    Err(up_error.unwrap_or_else(|| anyhow::anyhow!("tailscale up failed")))
}

pub async fn tailscale_switch_account(account: &str) -> Result<TeamStatus> {
    if cloudflare_one_status_snapshot().await.connected {
        bail!("Tailscale 与 Cloudflare One Client 不能同时连接，请先断开 Cloudflare One Client");
    }
    let output = tailscale_output(&["switch", account]).await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim();
        if detail.is_empty() {
            bail!("tailscale switch failed (exit status {})", output.status);
        }
        bail!("tailscale switch failed: {detail}");
    }
    // The selected profile may point at a new node even when the CLI keeps
    // the same hostname. Force the next status read to reconcile it with the
    // authenticated team account.
    invalidate_tailscale_reconcile();
    status().await
}

pub async fn tailscale_refresh() -> Result<TeamStatus> {
    let device_id = device_id()?;
    let snapshot = tailscale_status_snapshot_fast().await;
    if !snapshot.logged_in || snapshot.node_id.is_none() {
        return tailscale_connect().await;
    }
    let node_id = snapshot.node_id.clone();
    let response = tailscale_reconcile(&device_id, &snapshot).await?;
    save_tailscale_reconcile(response, node_id).await?;
    status().await
}

pub async fn tailscale_logout() -> Result<TeamStatus> {
    let snapshot = tailscale_status_snapshot_fast().await;
    let session = load_session()?;
    let node_id = snapshot.node_id.or_else(|| {
        session
            .as_ref()
            .and_then(|value| value.tailscale.as_ref())
            .and_then(|value| value.node_id.clone())
    });
    let cli_result = tailscale_output(&["logout"]).await;
    let worker_result = team_post(TAILSCALE_LOGOUT_PATH, serde_json::json!({ "nodeId": node_id })).await;
    if let Err(error) = cli_result {
        // Still notify the Worker so its device record is revoked when the
        // local CLI is unavailable or already logged out.
        worker_result?;
        return Err(error);
    }
    let cli_output = cli_result?;
    if !cli_output.status.success() {
        bail!("tailscale logout failed (exit status {})", cli_output.status);
    }
    worker_result?;
    if let Some(mut session) = load_session()? {
        session.tailscale = None;
        save_session(&session)?;
    }
    status().await
}

pub async fn logout() -> Result<()> {
    // Logout must behave like deleting the subscription: remove the managed
    // profile with the same machinery. Best-effort: a cleanup failure must
    // not trap the user in a logged-in state.
    let managed_installed = Config::profiles()
        .await
        .latest_arc()
        .get_item(MANAGED_PROFILE_UID)
        .is_ok();
    if managed_installed {
        if let Err(error) = crate::cmd::profile::delete_profile_inner(&MANAGED_PROFILE_UID.into()).await {
            logging!(error, Type::Cmd, "managed profile cleanup on logout failed: {error}");
        }
        // Deleting a non-current profile emits no frontend event; push the
        // refresh explicitly so the subscription list drops the entry at once.
        handle::Handle::refresh_profiles();
    }
    clear_session()?;
    Ok(())
}

pub async fn refresh_account() -> Result<TeamStatus> {
    let config = load_config()?;
    let mut session = usable_session().await?;
    let url = endpoint(&config.api_base_url, &config.account_path)?;
    let team_device_id = device_id()?;
    let account_response = send_team_request(
        || {
            TEAM_HTTP_CLIENT
                .get(url.clone())
                .bearer_auth(&session.access_token)
                .header("x-team-device", &team_device_id)
        },
        true,
        "team account request failed",
    )
    .await?;
    let mut account = checked_response(account_response).await?.json::<TeamAccount>().await?;
    if account.quota.is_none() {
        account.quota = session.account.as_ref().and_then(|previous| previous.quota.clone());
    }
    session.account = Some(account);
    save_session(&session)?;
    status().await
}

fn parse_subscription_info(value: Option<&reqwest::header::HeaderValue>) -> TeamQuota {
    let text = value.and_then(|value| value.to_str().ok()).unwrap_or_default();
    let field = |name: &str| {
        text.split(';')
            .find_map(|part| {
                let (key, value) = part.trim().split_once('=')?;
                (key.trim() == name).then(|| value.trim().parse::<u64>().ok()).flatten()
            })
            .unwrap_or_default()
    };
    TeamQuota {
        upload: field("upload"),
        download: field("download"),
        total: field("total"),
        expire: field("expire"),
    }
}

pub async fn sync_managed_profile() -> Result<TeamStatus> {
    let config = load_config()?;
    let mut session = usable_session().await?;
    let url = endpoint(&config.api_base_url, &config.profile_path)?;
    let team_device_id = device_id()?;
    let etag = session.etag.clone();
    let response = send_team_request(
        || {
            let mut request = TEAM_HTTP_CLIENT
                .get(url.clone())
                .bearer_auth(&session.access_token)
                .header("x-team-device", &team_device_id);
            if let Some(etag) = etag.as_deref() {
                request = request.header(reqwest::header::IF_NONE_MATCH, etag);
            }
            request
        },
        true,
        "managed profile request failed",
    )
    .await?;
    if response.status() == reqwest::StatusCode::NOT_MODIFIED {
        session.last_sync_at = Some(now());
        save_session(&session)?;
        return status().await;
    }
    let response = checked_response(response).await?;
    let headers = response.headers().clone();
    let data = response.text().await?;
    let yaml = serde_yaml_ng::from_str::<Mapping>(&data).context("managed profile is not valid YAML")?;
    if !yaml.contains_key("proxies") && !yaml.contains_key("proxy-providers") {
        bail!("managed profile contains neither proxies nor proxy-providers")
    }
    let quota = parse_subscription_info(headers.get("subscription-userinfo"));
    let exists = Config::profiles()
        .await
        .latest_arc()
        .get_item(MANAGED_PROFILE_UID)
        .is_ok();
    if exists {
        let mut item = PrfItem {
            extra: Some(PrfExtra {
                upload: quota.upload,
                download: quota.download,
                total: quota.total,
                expire: quota.expire,
            }),
            updated: Some(now() as usize),
            file_data: Some(data.into()),
            ..PrfItem::default()
        };
        profiles::profiles_draft_update_item_safe(&MANAGED_PROFILE_UID.into(), &mut item).await?;
    } else {
        let mut item = PrfItem {
            uid: Some(MANAGED_PROFILE_UID.into()),
            itype: Some("remote".into()),
            name: Some(config.managed_profile_name.into()),
            file: Some(format!("{MANAGED_PROFILE_UID}.yaml").into()),
            desc: Some("Managed by the authenticated team resource API".into()),
            url: None,
            selected: None,
            extra: Some(PrfExtra {
                upload: quota.upload,
                download: quota.download,
                total: quota.total,
                expire: quota.expire,
            }),
            updated: Some(now() as usize),
            option: Some(PrfOption::default()),
            home: None,
            file_data: Some(data.into()),
        };
        profiles::profiles_append_item_safe(&mut item).await?;
        profiles::profiles_save_file_safe().await?;
    }
    if config.auto_activate {
        Config::profiles()
            .await
            .with_data_modify(|mut profiles| async move {
                profiles.current = Some(MANAGED_PROFILE_UID.into());
                profiles.save_file().await?;
                Ok((profiles, ()))
            })
            .await?;
    }
    session.etag = headers
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    session.last_sync_at = Some(now());
    if let Some(account) = session.account.as_mut() {
        account.quota = Some(quota);
    }
    save_session(&session)?;
    let is_current = Config::profiles()
        .await
        .latest_arc()
        .is_current_profile_index(&MANAGED_PROFILE_UID.into());
    if is_current {
        match CoreManager::global().update_config_with_force(false).await {
            Ok(outcome) if outcome.is_valid() => handle::Handle::refresh_clash(),
            Ok(outcome) => logging!(warn, Type::Config, "managed profile refresh skipped: {}", outcome),
            Err(error) => logging!(error, Type::Config, "managed profile refresh failed: {error}"),
        }
    }
    handle::Handle::refresh_profiles();
    status().await
}

#[allow(clippy::unused_async)]
pub async fn init_background_sync() {
    if BACKGROUND_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let Ok(config) = load_config() else {
        return;
    };
    if !config.enabled {
        return;
    }
    // Presence heartbeat between full syncs: feeds the worker's online-device
    // counter and keeps the account page's quota display fresh.
    AsyncHandler::spawn(|| async move {
        loop {
            tokio::time::sleep(Duration::from_secs(300)).await;
            if load_session().ok().flatten().is_none() {
                continue;
            }
            if let Err(error) = refresh_account().await {
                logging!(debug, Type::Config, "team presence heartbeat failed: {error:#}");
            }
        }
    });
    AsyncHandler::spawn(move || async move {
        tokio::time::sleep(Duration::from_secs(15)).await;
        loop {
            if load_session().ok().flatten().is_some()
                && let Err(error) = async {
                    refresh_account().await?;
                    sync_managed_profile().await
                }
                .await
            {
                logging!(warn, Type::Config, "managed profile background sync failed: {error:#}");
            }
            tokio::time::sleep(Duration::from_secs(
                config.sync_interval_minutes.max(1).saturating_mul(60),
            ))
            .await;
        }
    });
}
