import CheckCircleOutlineOutlinedIcon from '@mui/icons-material/CheckCircleOutlineOutlined'
import CloudOutlinedIcon from '@mui/icons-material/CloudOutlined'
import CloudSyncOutlinedIcon from '@mui/icons-material/CloudSyncOutlined'
import DeviceHubOutlinedIcon from '@mui/icons-material/DeviceHubOutlined'
import ErrorOutlineOutlinedIcon from '@mui/icons-material/ErrorOutlineOutlined'
import LaunchOutlinedIcon from '@mui/icons-material/LaunchOutlined'
import LoginOutlinedIcon from '@mui/icons-material/LoginOutlined'
import LogoutOutlinedIcon from '@mui/icons-material/LogoutOutlined'
import NetworkCheckOutlinedIcon from '@mui/icons-material/NetworkCheckOutlined'
import PersonOutlineOutlinedIcon from '@mui/icons-material/PersonOutlineOutlined'
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined'
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  LinearProgress,
  Stack,
  Switch,
  Typography,
} from '@mui/material'
import dayjs from 'dayjs'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'

import { BasePage } from '@/components/base'
import { useVerge } from '@/hooks/use-verge'
import {
  activateTeamProfile,
  connectCloudflareOne,
  checkCloudflareOneUpdate,
  checkTailscaleUpdate,
  connectTailscale,
  disconnectCloudflareOne,
  getTeamStatus,
  loginTeam,
  netcheckTailscale,
  logoutTeam,
  logoutTailscale,
  refreshTeamAccount,
  refreshCloudflareOne,
  refreshTailscale,
  startCloudflareOne,
  startTailscale,
  syncTeamProfile,
  switchTailscaleAccount,
} from '@/services/cmds'
import { errorDetail } from '@/services/notice-service'
import { useQuery } from '@/services/query-client'
import parseTraffic from '@/utils/parse-traffic'

const formatTraffic = (value: number) => parseTraffic(value).join(' ')

// Tauri commands reject with a structured CommandFailure; String() on it
// renders "[object Object]", so unwrap the human-readable detail first.
const reasonText = (reason: unknown) => errorDetail(reason) || String(reason)

const NETCHECK_FIELDS: Array<{
  key: keyof ITailscaleNetcheck
  label: string
}> = [
  { key: 'udp', label: 'UDP' },
  { key: 'ipv4', label: 'IPv4' },
  { key: 'ipv6', label: 'IPv6' },
  { key: 'mappingVariesByDestIp', label: '目标 IP 映射变化' },
  { key: 'portMapping', label: '端口映射' },
  { key: 'hairPinning', label: 'Hairpin NAT' },
  { key: 'captivePortal', label: '强制门户' },
  { key: 'nearestDerp', label: '最近 DERP' },
  { key: 'globalV6', label: '全局 IPv6' },
  { key: 'available', label: '探测可用' },
]

const formatNetcheckValue = (value: unknown): string => {
  if (typeof value === 'boolean') return value ? '支持' : '不支持'
  if (typeof value === 'string' || typeof value === 'number')
    return String(value)
  if (Array.isArray(value)) return value.join(', ')
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .map(([key, item]) => `${key}: ${formatNetcheckValue(item)}`)
      .join('； ')
  }
  return '未提供'
}

const netcheckEntries = (netcheck?: ITailscaleNetcheck) => {
  if (!netcheck) return []
  const known = new Set<string>()
  const entries: Array<[string, string]> = []
  for (const { key, label } of NETCHECK_FIELDS) {
    if (netcheck[key] !== undefined) {
      known.add(String(key))
      entries.push([label, formatNetcheckValue(netcheck[key])])
    }
  }
  for (const [key, value] of Object.entries(netcheck)) {
    if (
      !known.has(key) &&
      key !== 'derpLatency' &&
      key !== 'error' &&
      value !== undefined
    ) {
      entries.push([key, formatNetcheckValue(value)])
    }
  }
  if (netcheck.derpLatency) {
    entries.push(['DERP 延迟', formatNetcheckValue(netcheck.derpLatency)])
  }
  return entries
}

const TeamPage = () => {
  const navigate = useNavigate()
  const { verge, patchVerge } = useVerge()
  const { data, refetch, isFetching } = useQuery({
    queryKey: ['getTeamStatus'],
    queryFn: getTeamStatus,
    refetchOnWindowFocus: false,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  })
  const [action, setAction] = useState<string>()
  const [error, setError] = useState<string>()
  const [connectionConflict, setConnectionConflict] = useState<
    'tailscale' | 'cloudflare'
  >()

  const run = useCallback(
    async (
      name: string,
      operation: () => Promise<unknown>,
      errorPrefix = '',
    ) => {
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

  const tailscaleAutoUpdateCheck = verge?.tailscale_auto_update_check !== false
  const cloudflareAutoUpdateCheck =
    verge?.cloudflare_one_auto_update_check !== false

  useEffect(() => {
    if (!tailscaleAutoUpdateCheck || !data?.tailscale?.installed) return
    const checkedAt = data?.tailscale?.update?.checkedAt
    if (checkedAt && Date.now() / 1000 - checkedAt < 24 * 60 * 60) return
    void checkTailscaleUpdate()
      .then(() => refetch())
      .catch((reason) =>
        setError(`Tailscale 自动检查更新失败：${reasonText(reason)}`),
      )
  }, [
    data?.tailscale?.installed,
    data?.tailscale?.update?.checkedAt,
    refetch,
    tailscaleAutoUpdateCheck,
  ])

  useEffect(() => {
    if (!cloudflareAutoUpdateCheck || !data?.cloudflareOne?.installed) return
    const checkedAt = data?.cloudflareOne?.update?.checkedAt
    if (checkedAt && Date.now() / 1000 - checkedAt < 24 * 60 * 60) return
    void checkCloudflareOneUpdate()
      .then(() => refetch())
      .catch((reason) =>
        setError(
          `Cloudflare One Client 自动检查更新失败：${reasonText(reason)}`,
        ),
      )
  }, [
    data?.cloudflareOne?.installed,
    data?.cloudflareOne?.update?.checkedAt,
    refetch,
    cloudflareAutoUpdateCheck,
  ])

  const connectAfterConflictResolution = useCallback(async () => {
    const target = connectionConflict
    if (!target) return
    setConnectionConflict(undefined)
    setAction(`resolve-${target}`)
    setError(undefined)
    try {
      if (target === 'tailscale') {
        await disconnectCloudflareOne()
        await connectTailscale()
      } else {
        await logoutTailscale()
        await connectCloudflareOne()
      }
      await refetch()
    } catch (reason) {
      setError(`切换网络客户端失败：${reasonText(reason)}`)
    } finally {
      setAction(undefined)
    }
  }, [connectionConflict, refetch])

  const openOfficialDownload = useCallback(async (url: string) => {
    try {
      await openUrl(url)
    } catch (reason) {
      setError(`打开官方下载页面失败：${reasonText(reason)}`)
    }
  }, [])

  const quota = data?.account?.quota
  const used = (quota?.upload ?? 0) + (quota?.download ?? 0)
  const percent = quota?.total
    ? Math.min(100, Math.round((used / quota.total) * 100))
    : 0
  const tailscale = data?.tailscale
  const tailscaleRunning = tailscale?.running
  const cloudflareOne =
    data?.cloudflareOne ?? data?.cloudflareOneClient ?? data?.cloudflare
  const cloudflareLocationMatch = cloudflareOne?.locationMatch
  const cloudflareLocalLocationMatch = cloudflareOne?.localLocationMatch
  const cloudflareLocationVerified =
    cloudflareLocationMatch === true || cloudflareLocalLocationMatch === true
  const tailscaleDate = (value?: number) =>
    value ? dayjs(value * 1000).format('YYYY-MM-DD HH:mm') : '未提供'

  return (
    <BasePage title="团队账户">
      <Stack spacing={2} sx={{ maxWidth: 760, mx: 'auto' }}>
        {!data?.configured && (
          <Alert severity="warning">
            团队功能尚未配置。请填写打包资源中的 team-config.json，并将 enabled
            改为 true。
          </Alert>
        )}
        {error && <Alert severity="error">{error}</Alert>}
        {tailscale?.loggedIn && cloudflareOne?.connected && (
          <Alert severity="error">
            Tailscale 与 Cloudflare One Client
            不能同时连接。请断开其中一个客户端后再继续使用。
          </Alert>
        )}

        <Card variant="outlined">
          <CardContent>
            <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
              <PersonOutlineOutlinedIcon fontSize="large" />
              <Box sx={{ flex: 1 }}>
                <Typography variant="h6">
                  {data?.account?.displayName ||
                    data?.account?.email ||
                    '未登录'}
                </Typography>
                <Typography color="text.secondary">
                  {data?.account?.team ||
                    '使用 Cloudflare Access 完成团队身份认证'}
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
                  <Stack
                    direction="row"
                    sx={{ justifyContent: 'space-between' }}
                  >
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
                  在线设备：{data.account.devicesOnline} 台（最近 10
                  分钟内活跃）
                </Typography>
              </>
            )}

            <Divider sx={{ my: 2 }} />
            <Stack
              direction="row"
              spacing={1}
              useFlexGap
              sx={{ flexWrap: 'wrap' }}
            >
              {!data?.authenticated ? (
                <Button
                  variant="contained"
                  startIcon={
                    action === 'login' ? (
                      <CircularProgress size={16} />
                    ) : (
                      <LoginOutlinedIcon />
                    )
                  }
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
                  {data?.managedProfileInstalled &&
                    !data?.managedProfileActive && (
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
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ mt: 2, display: 'block' }}
            >
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
                    ? `版本 ${tailscale.version || '未知'}${tailscaleRunning === false ? ' · 服务未启动' : ''}`
                    : '未检测到本机 Tailscale CLI'}
                </Typography>
              </Box>
              <Chip
                color={
                  !tailscale?.installed
                    ? 'default'
                    : tailscaleRunning === false
                      ? 'warning'
                      : tailscale.loggedIn
                        ? 'success'
                        : 'default'
                }
                label={
                  !tailscale?.installed
                    ? '未安装'
                    : tailscaleRunning === false
                      ? '未启动'
                      : tailscale.loggedIn
                        ? '已连接'
                        : '未连接'
                }
              />
            </Stack>

            {tailscale?.installed && tailscaleRunning === false && (
              <Alert severity="warning" sx={{ mt: 2 }}>
                已检测到 Tailscale
                CLI，但后台服务尚未启动。请先启动服务，再进行连接或网络探测。
              </Alert>
            )}

            {tailscale?.installed && tailscale.loggedIn && (
              <>
                <Divider sx={{ my: 2 }} />
                <Stack spacing={0.75}>
                  <Typography>
                    设备：{tailscale.deviceName || '未知'}
                  </Typography>
                  <Typography>IP：{tailscale.ipv4 || '未分配'}</Typography>
                  <Typography>
                    在线：{tailscale.online ? '是' : '否'}；角色：
                    {tailscale.role || '未提供'}；Tag：
                    {tailscale.tag || '未提供'}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Key 签发：{tailscaleDate(tailscale.keyIssuedAt)}；有效期至：
                    {tailscaleDate(tailscale.keyExpiresAt)}
                  </Typography>
                </Stack>
              </>
            )}

            {tailscale?.installed &&
              tailscaleRunning !== false &&
              tailscale.netcheck && (
                <>
                  <Divider sx={{ my: 2 }} />
                  <Stack
                    direction="row"
                    spacing={1}
                    sx={{ alignItems: 'center', mb: 1 }}
                  >
                    <NetworkCheckOutlinedIcon color="primary" />
                    <Typography variant="subtitle1">当前网络状况</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {tailscale.netcheckAt
                        ? `检测于 ${dayjs(tailscale.netcheckAt * 1000).format('MM-DD HH:mm:ss')}`
                        : 'tailscale netcheck'}
                    </Typography>
                  </Stack>
                  {tailscale.netcheck.error && (
                    <Alert severity="warning" sx={{ mb: 1 }}>
                      网络探测未完整成功：{tailscale.netcheck.error}
                    </Alert>
                  )}
                  <Box
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: {
                        xs: '1fr',
                        sm: 'repeat(2, minmax(0, 1fr))',
                      },
                      gap: 1,
                    }}
                  >
                    {netcheckEntries(tailscale.netcheck).map(
                      ([label, value]) => (
                        <Box
                          key={label}
                          sx={{
                            borderRadius: 1,
                            bgcolor: 'action.hover',
                            px: 1.5,
                            py: 1,
                          }}
                        >
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{ display: 'block' }}
                          >
                            {label}
                          </Typography>
                          <Typography
                            variant="body2"
                            sx={{ wordBreak: 'break-word' }}
                          >
                            {value}
                          </Typography>
                        </Box>
                      ),
                    )}
                  </Box>
                </>
              )}

            {tailscale?.installed &&
              tailscale.profiles &&
              tailscale.profiles.length > 1 && (
                <>
                  <Divider sx={{ my: 2 }} />
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ mb: 1 }}
                  >
                    本地 Tailscale 账号切换：
                  </Typography>
                  <Stack
                    direction="row"
                    spacing={1}
                    useFlexGap
                    sx={{ flexWrap: 'wrap' }}
                  >
                    {tailscale.profiles.map((p) => (
                      <Chip
                        key={p.id}
                        label={`${p.accountName || p.name || p.id}${p.active ? ' (当前)' : ''}`}
                        color={p.active ? 'primary' : 'default'}
                        variant={p.active ? 'filled' : 'outlined'}
                        onClick={
                          p.active
                            ? undefined
                            : () =>
                                run(
                                  'tailscale-switch',
                                  () =>
                                    switchTailscaleAccount(
                                      p.accountName || p.name || p.id,
                                    ),
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
            <Stack
              direction="row"
              spacing={1}
              useFlexGap
              sx={{ flexWrap: 'wrap' }}
            >
              {tailscale?.installed && tailscaleRunning === false && (
                <Button
                  variant="contained"
                  startIcon={
                    action === 'tailscale-start' ? (
                      <CircularProgress size={16} />
                    ) : (
                      <PlayArrowOutlinedIcon />
                    )
                  }
                  disabled={Boolean(action)}
                  onClick={() =>
                    run(
                      'tailscale-start',
                      startTailscale,
                      'Tailscale 服务启动失败：',
                    )
                  }
                >
                  启动服务
                </Button>
              )}
              {tailscale?.installed &&
              tailscaleRunning !== false &&
              !tailscale?.loggedIn ? (
                <Button
                  variant="contained"
                  startIcon={
                    action === 'tailscale-connect' ? (
                      <CircularProgress size={16} />
                    ) : (
                      <DeviceHubOutlinedIcon />
                    )
                  }
                  disabled={!data?.authenticated || Boolean(action)}
                  onClick={() => {
                    if (cloudflareOne?.connected) {
                      setConnectionConflict('tailscale')
                    } else {
                      void run(
                        'tailscale-connect',
                        connectTailscale,
                        'Tailscale 连接失败：',
                      )
                    }
                  }}
                >
                  连接
                </Button>
              ) : tailscale?.installed &&
                tailscaleRunning !== false &&
                tailscale?.loggedIn ? (
                <>
                  <Button
                    startIcon={
                      action === 'tailscale-refresh' ? (
                        <CircularProgress size={16} />
                      ) : (
                        <CloudSyncOutlinedIcon />
                      )
                    }
                    disabled={Boolean(action)}
                    onClick={() =>
                      run(
                        'tailscale-refresh',
                        refreshTailscale,
                        'Tailscale 刷新失败：',
                      )
                    }
                  >
                    刷新
                  </Button>
                  <Button
                    color="inherit"
                    startIcon={<LogoutOutlinedIcon />}
                    disabled={Boolean(action)}
                    onClick={() =>
                      run(
                        'tailscale-logout',
                        logoutTailscale,
                        'Tailscale 退出失败：',
                      )
                    }
                  >
                    退出登录
                  </Button>
                </>
              ) : null}
              {tailscale?.installed && tailscaleRunning !== false && (
                <Button
                  startIcon={
                    action === 'tailscale-netcheck' ? (
                      <CircularProgress size={16} />
                    ) : (
                      <NetworkCheckOutlinedIcon />
                    )
                  }
                  disabled={Boolean(action)}
                  onClick={() =>
                    run(
                      'tailscale-netcheck',
                      netcheckTailscale,
                      'Tailscale 网络探测失败：',
                    )
                  }
                >
                  探测网络
                </Button>
              )}
              <Button
                startIcon={
                  action === 'tailscale-update' ? (
                    <CircularProgress size={16} />
                  ) : (
                    <RefreshOutlinedIcon />
                  )
                }
                disabled={Boolean(action)}
                onClick={() =>
                  run(
                    'tailscale-update',
                    checkTailscaleUpdate,
                    'Tailscale 检查更新失败：',
                  )
                }
              >
                检查更新
              </Button>
              <FormControlLabel
                control={
                  <Switch
                    size="small"
                    checked={tailscaleAutoUpdateCheck}
                    onChange={(_, checked) => {
                      void patchVerge({
                        tailscale_auto_update_check: checked,
                      }).catch((reason) =>
                        setError(
                          `保存 Tailscale 自动检查设置失败：${reasonText(reason)}`,
                        ),
                      )
                    }}
                  />
                }
                label="自动检查更新"
              />
              <Button
                variant="text"
                endIcon={<LaunchOutlinedIcon />}
                onClick={() =>
                  void openOfficialDownload('https://tailscale.com/download')
                }
              >
                官方下载
              </Button>
            </Stack>
            {tailscale?.update?.latestVersion && (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ mt: 1, display: 'block' }}
              >
                最新稳定版本：{tailscale.update.latestVersion}
                {tailscale.update.updateAvailable
                  ? ' · 有可用更新'
                  : ' · 已是最新版本'}
                {tailscale.update.checkedAt
                  ? ` · 检查于 ${dayjs(tailscale.update.checkedAt * 1000).format('MM-DD HH:mm')}`
                  : ''}
              </Typography>
            )}
            {tailscale?.update?.error && (
              <Alert severity="warning" sx={{ mt: 1 }}>
                Tailscale 更新检查提示：{tailscale.update.error}
              </Alert>
            )}
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ mt: 2, display: 'block' }}
            >
              {!data?.authenticated
                ? '请先完成团队账户认证，再连接 Tailscale。'
                : tailscale?.installed
                  ? '状态来自本机 tailscale CLI。'
                  : '请从 Tailscale 官方下载并安装客户端。'}
            </Typography>
          </CardContent>
        </Card>

        <Card variant="outlined">
          <CardContent>
            <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
              <CloudOutlinedIcon fontSize="large" />
              <Box sx={{ flex: 1 }}>
                <Typography variant="h6">Cloudflare One Client</Typography>
                <Typography color="text.secondary">
                  {cloudflareOne?.installed
                    ? `版本 ${cloudflareOne.version || '未知'}`
                    : cloudflareOne
                      ? '未检测到本机 Cloudflare One Client'
                      : '正在读取 Cloudflare One Client 状态'}
                </Typography>
              </Box>
              <Chip
                color={
                  !cloudflareOne
                    ? 'default'
                    : !cloudflareOne.installed
                      ? 'default'
                      : cloudflareOne.running === false
                        ? 'warning'
                        : cloudflareOne.connected
                          ? 'success'
                          : 'default'
                }
                label={
                  !cloudflareOne
                    ? '状态未知'
                    : !cloudflareOne.installed
                      ? '未安装'
                      : cloudflareOne.running === false
                        ? '未启动'
                        : cloudflareOne.connected
                          ? '已连接'
                          : '未连接'
                }
              />
            </Stack>

            {cloudflareOne?.installed && (
              <>
                <Divider sx={{ my: 2 }} />
                <Stack spacing={0.75}>
                  <Typography>
                    客户端：
                    {cloudflareOne.running === false ? '未启动' : '运行中'}
                    ；连接：
                    {cloudflareOne.connected ? '已连接' : '未连接'}
                  </Typography>
                  {(cloudflareOne.accountType || cloudflareOne.mode) && (
                    <Typography variant="body2" color="text.secondary">
                      模式：{cloudflareOne.mode || '未提供'}；账户：
                      {cloudflareOne.accountType || '未提供'}
                    </Typography>
                  )}
                  {(cloudflareOne.exitIp ||
                    cloudflareOne.exitCountry ||
                    cloudflareOne.exitCity) && (
                    <Typography>
                      当前出口：{cloudflareOne.exitIp || '未知'} ·{' '}
                      {[
                        cloudflareOne.exitCountry,
                        cloudflareOne.exitColo,
                        cloudflareOne.exitRegion,
                        cloudflareOne.exitCity,
                      ]
                        .filter(Boolean)
                        .join(' / ') || '位置未知'}
                    </Typography>
                  )}
                  {cloudflareOne.clashTunLocation && (
                    <Typography variant="body2" color="text.secondary">
                      Clash TUN 节点位置：{cloudflareOne.clashTunLocation}
                    </Typography>
                  )}
                  {cloudflareOne.localNetworkLocation && (
                    <Typography variant="body2" color="text.secondary">
                      本机网络位置：{cloudflareOne.localNetworkLocation}
                    </Typography>
                  )}
                </Stack>
              </>
            )}

            {cloudflareOne?.installed && cloudflareOne.running === false && (
              <Alert severity="warning" sx={{ mt: 2 }}>
                已检测到 Cloudflare One
                Client，但后台服务尚未启动。请先启动服务，再进行连接或出口检测。
              </Alert>
            )}

            {cloudflareOne?.error && (
              <Alert severity="warning" sx={{ mt: 2 }}>
                Cloudflare One Client 状态提示：{cloudflareOne.error}
              </Alert>
            )}

            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle1" sx={{ mb: 1 }}>
              连接校验流程
            </Typography>
            <Stack spacing={1}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                {verge?.enable_tun_mode ? (
                  <CheckCircleOutlineOutlinedIcon
                    color="success"
                    fontSize="small"
                  />
                ) : (
                  <ErrorOutlineOutlinedIcon color="warning" fontSize="small" />
                )}
                <Typography variant="body2" sx={{ flex: 1 }}>
                  1. 开启 Clash TUN 模式（当前：
                  {verge?.enable_tun_mode ? '已开启' : '未开启'}）
                </Typography>
                {!verge?.enable_tun_mode && (
                  <Button
                    size="small"
                    onClick={() =>
                      run(
                        'enable-tun',
                        () => patchVerge({ enable_tun_mode: true }),
                        '开启 TUN 模式失败：',
                      )
                    }
                    disabled={Boolean(action)}
                  >
                    开启 TUN
                  </Button>
                )}
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Typography variant="body2" sx={{ flex: 1 }}>
                  2. 在代理页选择延迟最低、位置最近的节点。
                </Typography>
                <Button size="small" onClick={() => navigate('/proxies')}>
                  打开代理页
                </Button>
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                {cloudflareOne?.connected ? (
                  <CheckCircleOutlineOutlinedIcon
                    color="success"
                    fontSize="small"
                  />
                ) : (
                  <ErrorOutlineOutlinedIcon color="warning" fontSize="small" />
                )}
                <Typography variant="body2" sx={{ flex: 1 }}>
                  3. 开启 Cloudflare One Client 连接。
                </Typography>
                {cloudflareOne?.installed && !cloudflareOne.connected && (
                  <Button
                    size="small"
                    onClick={() => {
                      if (tailscale?.loggedIn) {
                        setConnectionConflict('cloudflare')
                      } else {
                        void run(
                          'cloudflare-connect',
                          connectCloudflareOne,
                          'Cloudflare One Client 连接失败：',
                        )
                      }
                    }}
                    disabled={
                      Boolean(action) ||
                      cloudflareOne.running === false ||
                      !verge?.enable_tun_mode
                    }
                  >
                    连接
                  </Button>
                )}
              </Box>
            </Stack>

            {cloudflareOne?.connected &&
              (cloudflareLocationMatch !== undefined ||
                cloudflareLocalLocationMatch !== undefined) && (
                <Stack spacing={1} sx={{ mt: 2 }}>
                  <Alert
                    severity={cloudflareLocationVerified ? 'success' : 'error'}
                    icon={
                      cloudflareLocationVerified ? (
                        <CheckCircleOutlineOutlinedIcon fontSize="inherit" />
                      ) : (
                        <ErrorOutlineOutlinedIcon fontSize="inherit" />
                      )
                    }
                  >
                    {cloudflareLocationVerified
                      ? '出口节点位置校验通过（Clash TUN 或本机网络至少一项匹配）。'
                      : '出口节点位置校验未通过，请检查 TUN、节点选择和 Cloudflare One Client 路由。'}
                  </Alert>
                  {cloudflareLocationMatch !== undefined && (
                    <Alert
                      severity={cloudflareLocationMatch ? 'success' : 'error'}
                      icon={
                        cloudflareLocationMatch ? (
                          <CheckCircleOutlineOutlinedIcon fontSize="inherit" />
                        ) : (
                          <ErrorOutlineOutlinedIcon fontSize="inherit" />
                        )
                      }
                    >
                      {cloudflareLocationMatch
                        ? 'Clash TUN 节点与 Cloudflare 出口位置一致。'
                        : 'Clash TUN 节点与 Cloudflare 出口位置不一致。'}
                    </Alert>
                  )}
                  {cloudflareLocalLocationMatch !== undefined && (
                    <Alert
                      severity={
                        cloudflareLocalLocationMatch ? 'success' : 'error'
                      }
                      icon={
                        cloudflareLocalLocationMatch ? (
                          <CheckCircleOutlineOutlinedIcon fontSize="inherit" />
                        ) : (
                          <ErrorOutlineOutlinedIcon fontSize="inherit" />
                        )
                      }
                    >
                      {cloudflareLocalLocationMatch
                        ? '本机网络与 Cloudflare 出口位置一致。'
                        : '本机网络与 Cloudflare 出口位置不一致。'}
                    </Alert>
                  )}
                </Stack>
              )}

            <Divider sx={{ my: 2 }} />
            <Stack
              direction="row"
              spacing={1}
              useFlexGap
              sx={{ flexWrap: 'wrap' }}
            >
              {cloudflareOne?.installed && (
                <>
                  {cloudflareOne.running === false && (
                    <Button
                      variant="contained"
                      startIcon={
                        action === 'cloudflare-start' ? (
                          <CircularProgress size={16} />
                        ) : (
                          <PlayArrowOutlinedIcon />
                        )
                      }
                      disabled={Boolean(action)}
                      onClick={() =>
                        run(
                          'cloudflare-start',
                          startCloudflareOne,
                          'Cloudflare One Client 服务启动失败：',
                        )
                      }
                    >
                      启动服务
                    </Button>
                  )}
                  <Button
                    startIcon={
                      action === 'cloudflare-refresh' ? (
                        <CircularProgress size={16} />
                      ) : (
                        <RefreshOutlinedIcon />
                      )
                    }
                    disabled={Boolean(action)}
                    onClick={() =>
                      run(
                        'cloudflare-refresh',
                        refreshCloudflareOne,
                        'Cloudflare One Client 检测失败：',
                      )
                    }
                  >
                    检测出口
                  </Button>
                  {cloudflareOne.connected && (
                    <Button
                      color="inherit"
                      disabled={Boolean(action)}
                      onClick={() =>
                        run(
                          'cloudflare-disconnect',
                          disconnectCloudflareOne,
                          'Cloudflare One Client 断开失败：',
                        )
                      }
                    >
                      断开连接
                    </Button>
                  )}
                </>
              )}
              <Button
                startIcon={
                  action === 'cloudflare-update' ? (
                    <CircularProgress size={16} />
                  ) : (
                    <RefreshOutlinedIcon />
                  )
                }
                disabled={Boolean(action)}
                onClick={() =>
                  run(
                    'cloudflare-update',
                    checkCloudflareOneUpdate,
                    'Cloudflare One Client 检查更新失败：',
                  )
                }
              >
                检查更新
              </Button>
              <FormControlLabel
                control={
                  <Switch
                    size="small"
                    checked={cloudflareAutoUpdateCheck}
                    onChange={(_, checked) => {
                      void patchVerge({
                        cloudflare_one_auto_update_check: checked,
                      }).catch((reason) =>
                        setError(
                          `保存 Cloudflare One Client 自动检查设置失败：${reasonText(reason)}`,
                        ),
                      )
                    }}
                  />
                }
                label="自动检查更新"
              />
              <Button
                variant="text"
                endIcon={<LaunchOutlinedIcon />}
                onClick={() =>
                  void openOfficialDownload(
                    'https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/download',
                  )
                }
              >
                官方下载
              </Button>
            </Stack>
            {cloudflareOne?.update?.latestVersion && (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ mt: 1, display: 'block' }}
              >
                最新稳定版本：{cloudflareOne.update.latestVersion}
                {cloudflareOne.update.updateAvailable
                  ? ' · 有可用更新'
                  : ' · 已是最新版本'}
                {cloudflareOne.update.checkedAt
                  ? ` · 检查于 ${dayjs(cloudflareOne.update.checkedAt * 1000).format('MM-DD HH:mm')}`
                  : ''}
              </Typography>
            )}
            {cloudflareOne?.update?.error && (
              <Alert severity="warning" sx={{ mt: 1 }}>
                Cloudflare One Client 更新检查提示：{cloudflareOne.update.error}
              </Alert>
            )}
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ mt: 2, display: 'block' }}
            >
              {!cloudflareOne
                ? '状态接口暂未返回 Cloudflare One Client 信息。'
                : !cloudflareOne.installed
                  ? '请从 Cloudflare 官方页面下载并安装 Cloudflare One Client。'
                  : '连接后点击“检测出口”，确认出口节点与 Clash TUN 节点或本机网络位置一致。'}
            </Typography>
          </CardContent>
        </Card>
        <Dialog
          open={Boolean(connectionConflict)}
          onClose={() => setConnectionConflict(undefined)}
        >
          <DialogTitle>网络客户端不能同时连接</DialogTitle>
          <DialogContent>
            {connectionConflict === 'tailscale'
              ? 'Cloudflare One Client 当前已连接。Tailscale 与 Cloudflare One Client 会争用系统路由，不能同时连接。是否先断开 Cloudflare One Client，再连接 Tailscale？'
              : 'Tailscale 当前已连接。Tailscale 与 Cloudflare One Client 会争用系统路由，不能同时连接。是否先退出 Tailscale，再连接 Cloudflare One Client？'}
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setConnectionConflict(undefined)}>
              取消
            </Button>
            <Button
              variant="contained"
              onClick={() => void connectAfterConflictResolution()}
              disabled={Boolean(action)}
            >
              断开并连接
            </Button>
          </DialogActions>
        </Dialog>
      </Stack>
    </BasePage>
  )
}

export default TeamPage
