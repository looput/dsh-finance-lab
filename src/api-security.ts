import type { IncomingMessage } from 'node:http'
/** Single-user local prototype. A public host requires an explicitly trusted, authenticated proxy. */
export function accessError(req: IncomingMessage, trustedOrigin = process.env.DSH_FINANCE_TRUSTED_ORIGIN): string | undefined {
  let host: URL
  try { host = new URL(`http://${req.headers.host}`) } catch { return '无效Host' }
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)
  const remote = req.socket.remoteAddress ?? ''
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)
  let trusted: URL | undefined
  try { trusted = trustedOrigin ? new URL(trustedOrigin) : undefined } catch { return '可信代理Origin配置无效' }
  if (!(localHost && loopback) && (!trusted || host.host !== trusted.host)) return '仅允许本机访问；公网部署须设置认证代理及DSH_FINANCE_TRUSTED_ORIGIN'
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site']))) return '跨站访问被拒绝'
  if (req.headers.origin) {
    try {
      const origin = new URL(req.headers.origin)
      if (origin.host !== host.host || (trusted && !localHost && origin.origin !== trusted.origin)) return 'Origin不匹配'
    } catch { return '无效Origin' }
  }
}
