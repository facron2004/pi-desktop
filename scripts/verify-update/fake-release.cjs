// 把 GitHub 的 latest-release 重定向改成一个更高的版本，模拟"上游确实有新版"。
// 只在验证脚本里使用，不改任何生产代码。
const realFetch = globalThis.fetch
globalThis.fetch = function (input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || ''
  if (url.includes('github.com/facron2004/pi-desktop/releases/latest')) {
    console.log('[fake-release] redirecting to v0.11.9')
    return Promise.resolve(new Response(null, {
      status: 302,
      headers: { location: 'https://github.com/facron2004/pi-desktop/releases/tag/v0.11.9' }
    }))
  }
  return realFetch.apply(this, arguments)
}
