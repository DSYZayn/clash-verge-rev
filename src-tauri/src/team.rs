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
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt as _, AsyncWriteExt as _},
    net::TcpListener,
};

pub const MANAGED_PROFILE_UID: &str = "RTEAMMANAGED";
const SESSION_FILE: &str = "team-session.enc";
static BACKGROUND_STARTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Deserialize)]
pub struct TeamConfig {
    #[serde(default)]
    pub enabled: bool,
    pub api_base_url: String,
    #[serde(default)]
    pub oauth_discovery_url: String,
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

fn default_scopes() -> Vec<String> {
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamStatus {
    pub configured: bool,
    pub authenticated: bool,
    pub account: Option<TeamAccount>,
    pub last_sync_at: Option<u64>,
    pub managed_profile_installed: bool,
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

fn endpoint(base: &str, path: &str) -> Result<reqwest::Url> {
    let mut url = reqwest::Url::parse(base)?;
    url.set_path(path);
    url.set_query(None);
    Ok(url)
}

async fn metadata(config: &TeamConfig) -> Result<OAuthMetadata> {
    let url = if config.oauth_discovery_url.trim().is_empty() {
        endpoint(&config.api_base_url, "/.well-known/oauth-authorization-server")?
    } else {
        reqwest::Url::parse(&config.oauth_discovery_url)?
    };
    reqwest::Client::new()
        .get(url)
        .send()
        .await?
        .error_for_status()?
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
        .await?
        .error_for_status()?;
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
        .await?
        .error_for_status()?
        .json::<OAuthTokenResponse>()
        .await?;
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
    refresh_account().await?;
    sync_managed_profile().await
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
        .await?
        .error_for_status()?
        .json::<OAuthTokenResponse>()
        .await?;
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
    let managed_profile_installed = Config::profiles()
        .await
        .latest_arc()
        .get_item(MANAGED_PROFILE_UID)
        .is_ok();
    Ok(TeamStatus {
        configured,
        authenticated: session.as_ref().is_some_and(|value| !value.access_token.is_empty()),
        account: session.as_ref().and_then(|value| value.account.clone()),
        last_sync_at: session.as_ref().and_then(|value| value.last_sync_at),
        managed_profile_installed,
    })
}

pub fn logout() -> Result<()> {
    let path = session_path()?;
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

pub async fn refresh_account() -> Result<TeamStatus> {
    let config = load_config()?;
    let mut session = usable_session().await?;
    let account = reqwest::Client::new()
        .get(endpoint(&config.api_base_url, &config.account_path)?)
        .bearer_auth(&session.access_token)
        .send()
        .await?
        .error_for_status()?
        .json::<TeamAccount>()
        .await?;
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
        .bearer_auth(&session.access_token);
    if let Some(etag) = session.etag.as_ref() {
        request = request.header(reqwest::header::IF_NONE_MATCH, etag);
    }
    let response = request.send().await?;
    if response.status() == reqwest::StatusCode::NOT_MODIFIED {
        session.last_sync_at = Some(now());
        save_session(&session)?;
        return status().await;
    }
    let response = response.error_for_status()?;
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
