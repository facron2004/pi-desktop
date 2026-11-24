// 在渲染进程里读取界面上真实显示的更新信息：侧栏图标 + “关于”页。
// MANUAL_CHECK 占位符由验证脚本替换成 true/false：第一次启动需要点一次“立即检查”，
// 第二次启动只读取上次留下的结果。
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const manualCheck = __MANUAL_CHECK__

  const updateButton = () => document.querySelector('.sidebar__update-btn')
  const readBadge = () => {
    const node = updateButton()
    if (!node) return { exists: false }
    return {
      exists: true,
      aria: node.getAttribute('aria-label'),
      state: node.getAttribute('data-state'),
      hasRing: Boolean(node.querySelector('.sidebar__update-ring')),
      ringOffset: node.querySelector('.sidebar__update-ring-fill')?.getAttribute('stroke-dashoffset') ?? null
    }
  }

  // 打开设置 → 关于。手动检查也在这里点，避免从菜单里绕。
  let settingsBtn = null
  for (let attempt = 0; attempt < 20 && !settingsBtn; attempt += 1) {
    settingsBtn = Array.from(document.querySelectorAll('.sidebar__foot-btn')).find((b) => {
      const t = (b.getAttribute('title') || '') + ' ' + (b.innerText || '')
      return /settings|设置/i.test(t)
    })
    if (!settingsBtn) await wait(300)
  }
  if (settingsBtn) settingsBtn.click()

  let aboutBtn = null
  for (let attempt = 0; attempt < 30 && !aboutBtn; attempt += 1) {
    aboutBtn = Array.from(document.querySelectorAll('.settings-nav button')).find(
      (b) => (b.innerText || '').trim() === 'About'
    )
    if (!aboutBtn) await wait(300)
  }
  if (aboutBtn) aboutBtn.click()

  let aboutText = ''
  for (let attempt = 0; attempt < 30; attempt += 1) {
    aboutText = document.querySelector('.settings-content')?.innerText || ''
    if (/Check for updates/i.test(aboutText)) break
    await wait(300)
  }

  // 手动检查不弹卡片：结果直接落在侧栏的更新按钮上，所以只等图标出现。
  if (manualCheck) {
    const checkButton = Array.from(document.querySelectorAll('.settings-content button')).find(
      (b) => /check now|立即检查/i.test(b.innerText || '')
    )
    if (checkButton) checkButton.click()
  }
  for (let attempt = 0; attempt < 40 && !updateButton(); attempt += 1) await wait(250)
  await wait(300)

  // 等“关于”页的内容渲染出来
  let badges = []
  for (let attempt = 0; attempt < 30; attempt += 1) {
    badges = Array.from(document.querySelectorAll('.settings-badge')).map((b) => b.innerText.trim())
    if (badges.length > 0) break
    await wait(300)
  }

  const content = document.querySelector('.settings-content')
  const finalText = content ? content.innerText : aboutText
  const snapshot = {
    sidebarBadge: readBadge(),
    // A manual check answers on the sidebar button now; nothing may pop up.
    updateButtonShown: Boolean(updateButton()),
    aboutBadges: badges,
    aboutHasVersion: /0\.11\.9/.test(finalText),
    aboutHasAutoCheck: /Automatically check for updates|自动检查更新/i.test(finalText),
    aboutText: finalText.slice(0, 400)
  }

  // 有些截图要看的是侧栏本身：设置对话框是一层带遮罩的全窗口层，开着它
  // 侧栏会被压暗。读完读数后关掉它，让截图里是真实的强调色。
  if (__CLOSE_SETTINGS__) {
    const dismissButton = document.querySelector('.settings-modal .modal__head .icon-btn')
    if (dismissButton) dismissButton.click()
    for (let attempt = 0; attempt < 20 && document.querySelector('.settings-modal'); attempt += 1) {
      await wait(100)
    }
    await wait(300)
  }

  return snapshot
})()
