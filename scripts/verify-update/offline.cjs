// 让主进程里对 github.com 的请求失败，模拟离线。不改任何生产代码。
const realFetch = globalThis.fetch
globalThis.fetch = function (input) {
  const url = typeof input === 'string' ? input : (input && input.url) || ''
  if (url.includes('github.com')) {
    console.log('[offline] blocked ' + url)
    return Promise.reject(new Error('simulated offline'))
  }
  return realFetch.apply(this, arguments)
}
