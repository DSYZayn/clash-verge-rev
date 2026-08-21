import CloudSyncOutlinedIcon from '@mui/icons-material/CloudSyncOutlined'
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
  getTeamStatus,
  loginTeam,
  logoutTeam,
  refreshTeamAccount,
  syncTeamProfile,
} from '@/services/cmds'
import { useQuery } from '@/services/query-client'
import parseTraffic from '@/utils/parse-traffic'

const formatTraffic = (value: number) => parseTraffic(value).join(' ')

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
        setError(errorPrefix + String(reason))
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
      setError(`登录失败：${String(reason)}`)
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
      </Stack>
    </BasePage>
  )
}

export default TeamPage
