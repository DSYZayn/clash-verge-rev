import LoginOutlinedIcon from '@mui/icons-material/LoginOutlined'
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from '@mui/material'
import { useCallback, useState } from 'react'

import { getTeamStatus, loginTeam, syncTeamProfile } from '@/services/cmds'
import { errorDetail } from '@/services/notice-service'
import { useQuery } from '@/services/query-client'

// 启动引导：团队功能已配置但未登录时弹出一次，可关闭；关闭后本次运行内不再出现。
export const TeamLoginDialog = () => {
  const { data, refetch } = useQuery({
    queryKey: ['getTeamStatus'],
    queryFn: getTeamStatus,
    refetchOnWindowFocus: false,
  })
  const [dismissed, setDismissed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const open = Boolean(data?.configured && !data?.authenticated && !dismissed)

  const handleLogin = useCallback(async () => {
    setBusy(true)
    setError(undefined)
    try {
      await loginTeam()
      await refetch()
      setDismissed(true)
      syncTeamProfile().catch(() => {})
    } catch (reason) {
      setError(errorDetail(reason) || String(reason))
    } finally {
      setBusy(false)
    }
  }, [refetch])

  return (
    <Dialog open={open} onClose={() => setDismissed(true)}>
      <DialogTitle>登录团队账户</DialogTitle>
      <DialogContent>
        <DialogContentText>
          当前为团队版应用，登录后才能同步团队配置并查看流量与到期信息。点击“浏览器登录”完成身份认证。
        </DialogContentText>
        {error && (
          <Alert severity="error" sx={{ mt: 1.5 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setDismissed(true)}>以后再说</Button>
        <Button
          variant="contained"
          startIcon={<LoginOutlinedIcon />}
          disabled={busy}
          onClick={handleLogin}
        >
          {busy ? '等待浏览器认证…' : '浏览器登录'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
