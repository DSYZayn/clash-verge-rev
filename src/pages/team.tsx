import CloudSyncOutlinedIcon from '@mui/icons-material/CloudSyncOutlined'
import DeviceHubOutlinedIcon from '@mui/icons-material/DeviceHubOutlined'
import LaunchOutlinedIcon from '@mui/icons-material/LaunchOutlined'
import LoginOutlinedIcon from '@mui/icons-material/LoginOutlined'
import LogoutOutlinedIcon from '@mui/icons-material/LogoutOutlined'
import PersonOutlineOutlinedIcon from '@mui/icons-material/PersonOutlineOutlined'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  LinearProgress,
  Stack,
  Typography,
} from '@mui/material'
import dayjs from 'dayjs'
import { useCallback, useState } from 'react'

import { BasePage } from '@/components/base'
import {
  activateTeamProfile,
  connectTailscale,
  getTeamStatus,
  loginTeam,
  logoutTeam,
  logoutTailscale,
  refreshTeamAccount,
  refreshTailscale,
  syncTeamProfile,
  switchTailscaleAccount,
} from '@/services/cmds'
import { useQuery } from '@/services/query-client'
import { errorDetail } from '@/services/notice-service'
import parseTraffic from '@/utils/parse-traffic'

const formatTraffic = (value: number) => parseTraffic(value).join(' ')

// Tauri commands reject with a structured CommandFailure; String() on it
// renders "[object Object]", so unwrap the human-readable detail first.
const reasonText = (reason: unknown) => errorDetail(reason) || String(reason)

const TeamPage = () => {
  const { data, refetch, isFetching } = useQuery({
    queryKey: ['getTeamStatus'],
    queryFn: getTeamStatus,
    refetchOnWindowFocus: false,
  })
  const [action, setAction] = useState<string>()
  const [error, setError] = useState<string>()

  const run = useCallback(
    async (name: string, operation: () => Promise<unknown>, errorPrefix = '') => {
      setAction(name)
      setError(undefined)
      try {
        await operation()
        await refetch()
      } catch (reason) {
        setError(errorPrefix + reasonText(reason))
      } finally {
        setAction(undefined)
      }
    },
    [refetch],
  )

  // 登录与同步解耦：登录成功即刷新账户页；配置同步转入后台，失败时单独提示，
  // 不再阻塞或混淆登录结果。
  const handleLogin = useCallback(async () => {
    setAction('login')
    setError(undefined)
    try {
      await loginTeam()
    } catch (reason) {
      setError(`登录失败：${reasonText(reason)}`)
      setAction(undefined)
      return
    }
    await refetch()
    setAction(undefined)
    void run('sync', syncTeamProfile, '配置同步失败：')
  }, [refetch, run])

  const quota = data?.account?.quota
  const used = (quota?.upload ?? 0) + (quota?.download ?? 0)
  const percent = quota?.total
    ? Math.min(100, Math.round((used / quota.total) * 100))
    : 0
  const tailscale = data?.tailscale
  const tailscaleDate = (value?: number) =>
    value ? dayjs(value * 1000).format('YYYY-MM-DD HH:mm') : '未提供'

  return (
    <BasePage title="团队账户">
      <Stack spacing={2} sx={{ maxWidth: 760, mx: 'auto' }}>
        {!data?.configured && (
          <Alert severity="warning">
            团队功能尚未配置。请填写打包资源中的 team-config.json，并将 enabled 改为 true。
          </Alert>
        )}
        {error && <Alert severity="error">{error}</Alert>}

        <Card variant="outlined">
          <CardContent>
            <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
              <PersonOutlineOutlinedIcon fontSize="large" />
              <Box sx={{ flex: 1 }}>
                <Typography variant="h6">
                  {data?.account?.displayName || data?.account?.email || '未登录'}
                </Typography>
                <Typography color="text.secondary">
                  {data?.account?.team || '使用 Cloudflare Access 完成团队身份认证'}
                </Typography>
              </Box>
              <Chip
                color={data?.authenticated ? 'success' : 'default'}
                label={data?.authenticated ? '已认证' : '未认证'}
              />
            </Stack>

            {quota && (
              <>
                <Divider sx={{ my: 2 }} />
                <Stack spacing={1}>
                  <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                    <Typography>流量使用</Typography>
                    <Typography>
                      {formatTraffic(used)} / {formatTraffic(quota.total)}
                    </Typography>
                  </Stack>
                  <LinearProgress variant="determinate" value={percent} />
                  <Typography variant="body2" color="text.secondary">
                    到期时间：
                    {quota.expire
                      ? dayjs(quota.expire * 1000).format('YYYY-MM-DD HH:mm')
                      : '未提供'}
                  </Typography>
                </Stack>
              </>
            )}

            {data?.account?.devicesOnline !== undefined && (
              <>
                <Divider sx={{ my: 2 }} />
                <Typography variant="body2" color="text.secondary">
                  在线设备：{data.account.devicesOnline} 台（最近 10 分钟内活跃）
                </Typography>
              </>
            )}

            <Divider sx={{ my: 2 }} />
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
              {!data?.authenticated ? (
                <Button
                  variant="contained"
                  startIcon={action === 'login' ? <CircularProgress size={16} /> : <LoginOutlinedIcon />}
                  disabled={!data?.configured || Boolean(action)}
                  onClick={handleLogin}
                >
                  浏览器登录
                </Button>
              ) : (
                <>
                  <Button
                    variant="contained"
                    startIcon={<CloudSyncOutlinedIcon />}
                    disabled={Boolean(action)}
                    onClick={() => run('sync', syncTeamProfile)}
                  >
                    同步团队配置
                  </Button>
                  {data?.managedProfileInstalled && !data?.managedProfileActive && (
                    <Button
                      disabled={Boolean(action)}
                      onClick={() => run('activate', activateTeamProfile)}
                    >
                      使用团队配置
                    </Button>
                  )}
                  <Button
                    disabled={Boolean(action)}
                    onClick={() => run('account', refreshTeamAccount)}
                  >
                    刷新账户
                  </Button>
                  <Button
                    color="inherit"
                    startIcon={<LogoutOutlinedIcon />}
                    disabled={Boolean(action)}
                    onClick={() => run('logout', logoutTeam)}
                  >
                    退出登录
                  </Button>
                </>
              )}
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ mt: 2, display: 'block' }}>
              {isFetching
                ? '正在读取状态…'
                : `受管配置：${data?.managedProfileInstalled ? '已安装' : '未安装'}；最后同步：${data?.lastSyncAt ? dayjs(data.lastSyncAt * 1000).format('YYYY-MM-DD HH:mm:ss') : '从未'}`}
            </Typography>
          </CardContent>
        </Card>

        <Card variant="outlined">
          <CardContent>
            <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
              <DeviceHubOutlinedIcon fontSize="large" />
              <Box sx={{ flex: 1 }}>
                <Typography variant="h6">Tailscale</Typography>
                <Typography color="text.secondary">
                  {tailscale?.installed
                    ? `版本 ${tailscale.version || '未知'}`
                    : '未检测到本机 Tailscale CLI'}
                </Typography>
              </Box>
              <Chip
                color={tailscale?.loggedIn ? 'success' : 'default'}
                label={tailscale?.loggedIn ? '已连接' : '未连接'}
              />
            </Stack>

            {tailscale?.installed && tailscale.loggedIn && (
              <>
                <Divider sx={{ my: 2 }} />
                <Stack spacing={0.75}>
                  <Typography>设备：{tailscale.deviceName || '未知'}</Typography>
                  <Typography>IP：{tailscale.ipv4 || '未分配'}</Typography>
                  <Typography>
                    在线：{tailscale.online ? '是' : '否'}；角色：{tailscale.role || '未提供'}；Tag：
                    {tailscale.tag || '未提供'}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Key 签发：{tailscaleDate(tailscale.keyIssuedAt)}；有效期至：
                    {tailscaleDate(tailscale.keyExpiresAt)}
                  </Typography>
                </Stack>
              </>
            )}

            {tailscale?.installed && tailscale.profiles && tailscale.profiles.length > 1 && (
              <>
                <Divider sx={{ my: 2 }} />
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                  本地 Tailscale 账号切换：
                </Typography>
                <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                  {tailscale.profiles.map((p) => (
                    <Chip
                      key={p.id}
                      label={`${p.name || p.id}${p.active ? ' (当前)' : ''}`}
                      color={p.active ? 'primary' : 'default'}
                      variant={p.active ? 'filled' : 'outlined'}
                      onClick={
                        p.active
                          ? undefined
                          : () =>
                              run(
                                'tailscale-switch',
                                () => switchTailscaleAccount(p.id),
                                '切换 Tailscale 账号失败：',
                              )
                      }
                      disabled={Boolean(action)}
                      clickable={!p.active}
                    />
                  ))}
                </Stack>
              </>
            )}

            <Divider sx={{ my: 2 }} />
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
              {!tailscale?.loggedIn ? (
                <Button
                  variant="contained"
                  startIcon={action === 'tailscale-connect' ? <CircularProgress size={16} /> : <DeviceHubOutlinedIcon />}
                  disabled={!data?.authenticated || !tailscale?.installed || Boolean(action)}
                  onClick={() => run('tailscale-connect', connectTailscale, 'Tailscale 连接失败：')}
                >
                  连接
                </Button>
              ) : (
                <>
                  <Button
                    startIcon={action === 'tailscale-refresh' ? <CircularProgress size={16} /> : <CloudSyncOutlinedIcon />}
                    disabled={Boolean(action)}
                    onClick={() => run('tailscale-refresh', refreshTailscale, 'Tailscale 刷新失败：')}
                  >
                    刷新
                  </Button>
                  <Button
                    color="inherit"
                    startIcon={<LogoutOutlinedIcon />}
                    disabled={Boolean(action)}
                    onClick={() => run('tailscale-logout', logoutTailscale, 'Tailscale 退出失败：')}
                  >
                    退出登录
                  </Button>
                </>
              )}
              <Button
                variant="text"
                endIcon={<LaunchOutlinedIcon />}
                onClick={() => window.open('https://tailscale.com/download', '_blank', 'noopener,noreferrer')}
              >
                官方下载
              </Button>
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ mt: 2, display: 'block' }}>
              {!data?.authenticated
                ? '请先完成团队账户认证，再连接 Tailscale。'
                : tailscale?.installed
                  ? '状态来自本机 tailscale CLI。'
                  : '请从 Tailscale 官方下载并安装客户端。'}
            </Typography>
          </CardContent>
        </Card>
      </Stack>
    </BasePage>
  )
}

export default TeamPage
