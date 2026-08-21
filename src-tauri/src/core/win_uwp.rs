#![cfg(target_os = "windows")]

use crate::utils::dirs;
use anyhow::{Result, bail};
use deelevate::{PrivilegeLevel, Token};
use runas::Command as RunasCommand;
use std::os::windows::process::CommandExt as _;
use std::process::Command as StdCommand;

pub fn invoke_uwptools() -> Result<()> {
    let resource_dir = dirs::app_resources_dir()?;
    let tool_path = resource_dir.join("enableLoopback.exe");

    if !tool_path.exists() {
        bail!("enableLoopback exe not found");
    }

    let token = Token::with_current_process()?;
    let level = token.privilege_level()?;

    // enableLoopback is a console-subsystem tool; avoid flashing a console
    // window from the GUI. runas has no creation-flags API, so the elevated
    // path relies on ShellExecuteEx SW_HIDE via show(false).
    match level {
        PrivilegeLevel::NotPrivileged => RunasCommand::new(tool_path).show(false).status()?,
        _ => StdCommand::new(tool_path).creation_flags(0x08000000).status()?,
    };

    Ok(())
}
