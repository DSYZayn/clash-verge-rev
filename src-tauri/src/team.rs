//! Minimal Cloudflare Access / Managed OAuth integration for the team edition.
//!
//! Deployment-specific values live in `resources/team-config.json`. No upstream
//! subscription URL is ever accepted from the UI or persisted in profiles.yaml.

use crate::{
    config::{Config, PrfExtra, PrfItem, PrfOption, decrypt_data, encrypt_data, profiles},
    core::{CoreManager, handle},
    process::AsyncHandler,
    utils::dirs,
};
use anyhow::{Context as _, Result, bail};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use clash_verge_logging::{Type, logging};
use serde::{Deserialize, Serialize};
use serde_yaml_ng::Mapping;
use sha2::{Digest as _, Sha256};
use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::Write as _,
    path::PathBuf,
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
const TAILSCALE_LOGOUT_PATH: &str = "/v1/desktop/tailscale/logout";
static BACKGROUND_STARTED: AtomicBool = AtomicBool::new(false);

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
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleInfo {
    pub node_id: Option<String>,
    pub key_issued_at: Option<u64>,
    pub key_expires_at: Option<u64>,
    pub role: Option<String>,
    pub tag: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleStatus {
    pub installed: bool,
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

fn save_session(session: &TeamSession) -> Result<()> {
    let path = session_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let encrypted =
        encrypt_data(&serde_json::to_string(session)?).map_err(|error| anyhow::anyhow!(error.to_string()))?;
    std::fs::write(path, encrypted)?;
    Ok(())
}

const fn tailscale_program() -> &'static str {
    if cfg!(windows) { "tailscale.exe" } else { "tailscale" }
}

fn tailscale_command() -> Command {
    let mut command = Command::new(tailscale_program());
    // CREATE_NO_WINDOW: spawning the console-subsystem tailscale CLI from the
    // GUI app would otherwise flash a console window on every status poll.
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}

async fn tailscale_output(args: &[&str]) -> Result<std::process::Output> {
    tailscale_command()
        .args(args)
        .stdin(Stdio::null())
        .output()
        .await
        .with_context(|| format!("{} is not installed or is unavailable", tailscale_program()))
}

async fn tailscale_status_snapshot() -> TailscaleStatus {
    let Ok(version) = tailscale_output(&["version"]).await else {
        return TailscaleStatus::default();
    };
    if !version.status.success() {
        return TailscaleStatus::default();
    }
    let version = String::from_utf8_lossy(&version.stdout)
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

    if let Ok(status) = tailscale_output(&["status", "--json"]).await
        && status.status.success()
    {
        match serde_json::from_slice::<TailscaleStatusJson>(&status.stdout) {
            Ok(value) => {
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
    if let Ok(ip) = tailscale_output(&["ip", "-4"]).await
        && ip.status.success()
        && result.ipv4.is_none()
    {
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
    let result = tailscale_command()
        .arg("up")
        .arg(path_arg)
        .args(if cfg!(windows) { &["--unattended"][..] } else { &[][..] })
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|error| anyhow::anyhow!("failed to start tailscale up: {error}"));
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

async fn team_post(path: &str, body: serde_json::Value) -> Result<reqwest::Response> {
    let config = load_config()?;
    let session = usable_session().await?;
    let response = reqwest::Client::new()
        .post(endpoint(&config.api_base_url, path)?)
        .bearer_auth(&session.access_token)
        .header("x-team-device", device_id()?)
        .json(&body)
        .send()
        .await
        .context("team Worker request failed")?;
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

async fn save_tailscale_reconcile(response: TailscaleReconcileResponse, node_id: Option<String>) -> Result<()> {
    let mut session = usable_session().await?;
    session.tailscale = Some(TailscaleInfo {
        node_id,
        key_issued_at: session.tailscale.as_ref().and_then(|info| info.key_issued_at),
        key_expires_at: session.tailscale.as_ref().and_then(|info| info.key_expires_at),
        role: response.role,
        tag: response.tag,
    });
    save_session(&session)
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
    let response = reqwest::Client::new().get(url).send().await?;
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
    let response = reqwest::Client::new()
        .post(registration_endpoint)
        .json(&serde_json::json!({
            "client_name": "Clash Verge Team Desktop",
            "redirect_uris": [redirect_uri],
            "grant_types": ["authorization_code"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "resource": resource
        }))
        .send()
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
    let token = reqwest::Client::new()
        .post(&metadata.token_endpoint)
        .form(&token_form)
        .send()
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
    let mut session = load_session()?.context("not authenticated")?;
    if session.expires_at > now().saturating_add(60) {
        return Ok(session);
    }
    let refresh_token = session.refresh_token.clone().context("login session expired")?;
    let token_form = vec![
        ("grant_type", "refresh_token"),
        ("client_id", session.client_id.as_str()),
        ("refresh_token", refresh_token.as_str()),
    ];
    let token = reqwest::Client::new()
        .post(&session.token_endpoint)
        .form(&token_form)
        .send()
        .await?;
    let token = checked_response(token).await?.json::<OAuthTokenResponse>().await?;
    session.access_token = token.access_token;
    session.refresh_token = token.refresh_token.or(Some(refresh_token));
    session.token_type = token.token_type;
    session.expires_at = now().saturating_add(token.expires_in);
    save_session(&session)?;
    Ok(session)
}

pub async fn status() -> Result<TeamStatus> {
    let configured = load_config().is_ok_and(|config| config.enabled);
    let session = load_session()?;
    let profiles = Config::profiles().await;
    let latest = profiles.latest_arc();
    let managed_profile_installed = latest.get_item(MANAGED_PROFILE_UID).is_ok();
    let managed_profile_active = latest.is_current_profile_index(&MANAGED_PROFILE_UID.into());
    let mut tailscale = tailscale_status_snapshot().await;
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
    })
}

async fn issue_tailscale_key(device_id: &str, hostname: &str) -> Result<TailscaleKeyResponse> {
    let response = team_post(
        TAILSCALE_KEY_PATH,
        serde_json::json!({
            "deviceId": device_id,
            "hostname": hostname,
            "reusable": false,
            "ephemeral": true,
        }),
    )
    .await?;
    let issued = response.json::<TailscaleKeyResponse>().await?;
    if issued.key.trim().is_empty() {
        bail!("Worker returned an empty Tailscale authorization key")
    }
    Ok(issued)
}

/// Right after `tailscale up` the backend is still Starting and Self.ID is
/// absent; poll until the node identity shows up (or give up after ~10s).
async fn wait_for_node_identity() -> TailscaleStatus {
    let mut snapshot = tailscale_status_snapshot().await;
    for _ in 0..20 {
        if snapshot.node_id.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        snapshot = tailscale_status_snapshot().await;
    }
    snapshot
}
pub async fn tailscale_connect() -> Result<TeamStatus> {
    let device_id = device_id()?;
    let before = tailscale_status_snapshot().await;
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
                });
                save_session(&session)?;
                return status().await;
            }
            Err(error) => up_error = Some(error),
        }
    }
    Err(up_error.unwrap_or_else(|| anyhow::anyhow!("tailscale up failed")))
}

pub async fn tailscale_refresh() -> Result<TeamStatus> {
    let device_id = device_id()?;
    let snapshot = tailscale_status_snapshot().await;
    if !snapshot.logged_in || snapshot.node_id.is_none() {
        return tailscale_connect().await;
    }
    let node_id = snapshot.node_id.clone();
    let response = tailscale_reconcile(&device_id, &snapshot).await?;
    save_tailscale_reconcile(response, node_id).await?;
    status().await
}

pub async fn tailscale_logout() -> Result<TeamStatus> {
    let snapshot = tailscale_status_snapshot().await;
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
    let path = session_path()?;
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

pub async fn refresh_account() -> Result<TeamStatus> {
    let config = load_config()?;
    let mut session = usable_session().await?;
    let account_response = reqwest::Client::new()
        .get(endpoint(&config.api_base_url, &config.account_path)?)
        .bearer_auth(&session.access_token)
        .header("x-team-device", device_id()?)
        .send()
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
    let mut request = reqwest::Client::new()
        .get(endpoint(&config.api_base_url, &config.profile_path)?)
        .bearer_auth(&session.access_token)
        .header("x-team-device", device_id()?);
    if let Some(etag) = session.etag.as_ref() {
        request = request.header(reqwest::header::IF_NONE_MATCH, etag);
    }
    let response = request.send().await?;
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
