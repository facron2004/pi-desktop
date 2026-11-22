// 在渲染进程里读取界面上真实显示的更新信息：侧栏徽标 + “关于”页徽标。
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  // 侧栏底部的更新控件
  const sidebarUpdate = document.querySelector('.sidebar__update-btn')
  const sidebarBadge = sidebarUpdate
    ? {
        exists: true,
        aria: sidebarUpdate.getAttribute('aria-label'),
        state: sidebarUpdate.getAttribute('data-state')
      }
    : { exists: false }

  // 打开设置：设置对话框是懒加载的，按钮可能还没挂上，所以等它出现。
  let settingsBtn = null
  for (let attempt = 0; attempt < 20 && !settingsBtn; attempt += 1) {
    settingsBtn = Array.from(document.querySelectorAll('.sidebar__foot-btn')).find((b) => {
      const t = (b.getAttribute('title') || '') + ' ' + (b.innerText || '')
      return /settings|设置/i.test(t)
    })
    if (!settingsBtn) await wait(300)
  }
  if (settingsBtn) settingsBtn.click()

  // 等导航出现，再点“关于”。对话框和页面都是懒加载的。
  let aboutBtn = null
  for (let attempt = 0; attempt < 30 && !aboutBtn; attempt += 1) {
    aboutBtn = Array.from(document.querySelectorAll('.settings-nav button')).find(
      (b) => (b.innerText || '').trim() === 'About'
    )
    if (!aboutBtn) await wait(300)
  }
  if (aboutBtn) aboutBtn.click()

  // 等“关于”页的内容渲染出来
  let badges = []
  for (let attempt = 0; attempt < 30; attempt += 1) {
    badges = Array.from(document.querySelectorAll('.settings-badge')).map((b) => b.innerText.trim())
    if (badges.length > 0) break
    await wait(300)
  }

  const content = document.querySelector('.settings-content')
  const aboutText = content ? content.innerText : ''

  return {
    sidebarBadge,
    aboutBadges: badges,
    aboutHasVersion: /0\.11\.9/.test(aboutText),
    aboutText: aboutText.slice(0, 300)
  }
})()
