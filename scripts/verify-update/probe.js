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
      // 进度环：满进度时 dashoffset 归零。
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

  // 手动检查会弹出一张更新卡片（成功或失败都会弹）。截图要的是侧栏图标和
  // “关于”页，所以卡片出现后逐个关掉，直到屏幕稳定——同一张卡片可能因为
  // 一次新的结果被重新挂载。
  const dismissCards = async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const card = document.querySelector('.app-update-card')
      if (!card) return true
      const dismiss = Array.from(card.querySelectorAll('button')).find(
        (b) => /not now|暂不更新|close|关闭|got it|知道了/i.test(b.innerText || '')
      )
      if (dismiss) dismiss.click()
      else card.closest('.modal-layer')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      await wait(400)
    }
    return !document.querySelector('.app-update-card')
  }

  if (manualCheck) {
    const checkButton = Array.from(document.querySelectorAll('.settings-content button')).find(
      (b) => /check now|立即检查/i.test(b.innerText || '')
    )
    if (checkButton) {
      checkButton.click()
      // 等卡片出现（结果落定）再关；侧栏图标也是这时才出现的。
      for (let attempt = 0; attempt < 40 && !document.querySelector('.app-update-card'); attempt += 1) {
        await wait(250)
      }
    }
  }
  const cardDismissed = await dismissCards()
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
    cardDismissed,
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
