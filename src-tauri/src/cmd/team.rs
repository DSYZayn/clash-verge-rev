use super::{CmdResult, StringifyErr as _};
use crate::team::{self, TeamStatus};

#[tauri::command]
pub async fn get_team_status() -> CmdResult<TeamStatus> {
    team::status().await.stringify_err()
}

#[tauri::command]
pub async fn login_team() -> CmdResult<TeamStatus> {
    team::login().await.stringify_err()
}

#[tauri::command]
pub async fn refresh_team_account() -> CmdResult<TeamStatus> {
    team::refresh_account().await.stringify_err()
}

#[tauri::command]
pub async fn sync_team_profile() -> CmdResult<TeamStatus> {
    team::sync_managed_profile().await.stringify_err()
}

#[tauri::command]
pub async fn logout_team() -> CmdResult {
    team::logout().await.stringify_err()
}

#[tauri::command]
pub async fn connect_tailscale() -> CmdResult<team::TeamStatus> {
    team::tailscale_connect().await.stringify_err()
}

#[tauri::command]
pub async fn start_tailscale() -> CmdResult<team::TeamStatus> {
    team::tailscale_start().await.stringify_err()
}

#[tauri::command]
pub async fn netcheck_tailscale() -> CmdResult<team::TeamStatus> {
    team::tailscale_netcheck().await.stringify_err()
}

#[tauri::command]
pub async fn refresh_tailscale() -> CmdResult<team::TeamStatus> {
    team::tailscale_refresh().await.stringify_err()
}

#[tauri::command]
pub async fn logout_tailscale() -> CmdResult<team::TeamStatus> {
    team::tailscale_logout().await.stringify_err()
}

#[tauri::command]
pub async fn switch_tailscale_account(account: String) -> CmdResult<team::TeamStatus> {
    team::tailscale_switch_account(&account).await.stringify_err()
}

#[tauri::command]
pub async fn get_cloudflare_one_status() -> CmdResult<team::CloudflareOneStatus> {
    team::cloudflare_one_status().await.stringify_err()
}

#[tauri::command]
pub async fn connect_cloudflare_one() -> CmdResult<team::TeamStatus> {
    team::connect_cloudflare_one().await.stringify_err()
}

#[tauri::command]
pub async fn refresh_cloudflare_one() -> CmdResult<team::TeamStatus> {
    team::refresh_cloudflare_one().await.stringify_err()
}

#[tauri::command]
pub async fn disconnect_cloudflare_one() -> CmdResult<team::TeamStatus> {
    team::disconnect_cloudflare_one().await.stringify_err()
}
