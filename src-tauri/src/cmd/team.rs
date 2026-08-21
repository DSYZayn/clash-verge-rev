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
pub async fn refresh_tailscale() -> CmdResult<team::TeamStatus> {
    team::tailscale_refresh().await.stringify_err()
}

#[tauri::command]
pub async fn logout_tailscale() -> CmdResult<team::TeamStatus> {
    team::tailscale_logout().await.stringify_err()
}
